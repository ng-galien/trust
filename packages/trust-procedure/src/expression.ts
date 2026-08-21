import jsep, { type Expression } from "jsep";
import arrowPlugin, { type ArrowExpression } from "@jsep-plugin/arrow";
import templatePlugin, { type TemplateLiteral } from "@jsep-plugin/template";

import type { CompiledOperation, ValueSchema } from "@trust/operation";

import type {
  CompiledExpressionReference,
  CompiledProcedureGuard,
  JsonLogicRule,
  ProcedureCompilationErrorCode,
} from "./procedure.js";
import { procedureLanguage } from "./language.js";

jsep.plugins.register(templatePlugin, arrowPlugin);

type ScalarKind = "boolean" | "number" | "string" | "instant" | "reference";

interface ScalarType {
  readonly kind: ScalarKind;
  readonly enum?: readonly string[];
}

interface ArrayType {
  readonly kind: "array";
  readonly item: ExpressionType;
}

type ExpressionType = ScalarType | ArrayType;

interface CompiledExpression {
  readonly type: ExpressionType;
  readonly logic: JsonLogicRule;
  readonly references: readonly CompiledExpressionReference[];
  readonly literal?: string | number | boolean;
}

interface LocalValue {
  readonly type: ExpressionType;
  readonly logic: JsonLogicRule;
}

type ExpressionReferenceIdentity =
  | { readonly kind: "fact"; readonly field: string }
  | { readonly kind: "context"; readonly role: string }
  | { readonly kind: "check"; readonly check: string; readonly field: string };

export class QualificationExpressionError extends Error {
  constructor(
    readonly code: ProcedureCompilationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QualificationExpressionError";
  }
}

export interface QualificationExpressionInput {
  readonly source: string;
  readonly operation: CompiledOperation;
  readonly contextRoles: ReadonlyMap<string, ValueSchema>;
  readonly checks: ReadonlyMap<string, { readonly operation: CompiledOperation; readonly scenario: string }>;
  readonly canReferenceCheck: (scenario: string) => boolean;
}

interface CompileEnvironment extends QualificationExpressionInput {
  readonly locals: ReadonlyMap<string, LocalValue>;
  readonly iteratorDepth: number;
}

export function compileQualificationExpression(input: QualificationExpressionInput): readonly CompiledProcedureGuard[] {
  let expression: Expression;
  try {
    expression = jsep(input.source);
  } catch (error) {
    throw new QualificationExpressionError("invalid-procedure", `Qualification is not a valid JavaScript expression: ${String(error)}`);
  }
  const guardNodes = extractGuards(expression);
  return guardNodes.map(({ condition, reason }) => {
    const environment: CompileEnvironment = { ...input, locals: new Map(), iteratorDepth: 0 };
    const compiledCondition = compileExpression(condition, environment);
    requireType(compiledCondition, "boolean", "Qualification guard condition");
    const compiledReason = compileExpression(reason, environment);
    requireType(compiledReason, "string", "fail reason");
    if (compiledReason.literal === "") {
      throw new QualificationExpressionError("invalid-procedure", "Failure reason cannot be empty");
    }
    return {
      conditionLogic: compiledCondition.logic,
      failureReasonLogic: compiledReason.logic,
      references: uniqueReferences([...compiledCondition.references, ...compiledReason.references]),
    } satisfies CompiledProcedureGuard;
  });
}

function extractGuards(expression: Expression): readonly { readonly condition: Expression; readonly reason: Expression }[] {
  if (isBinary(expression, "&&") && containsFail(expression)) {
    return [...extractGuards(expression.left), ...extractGuards(expression.right)];
  }
  if (!isBinary(expression, "||") || !isFailCall(expression.right)) {
    throw new QualificationExpressionError(
      "invalid-procedure",
      "Qualification must use booleanExpression || fail(stringExpression)",
    );
  }
  if (containsFail(expression.left)) {
    throw new QualificationExpressionError("invalid-procedure", "fail may appear only at the end of one qualification guard");
  }
  const args = callArguments(expression.right);
  if (args.length !== 1 || !args[0]) {
    throw new QualificationExpressionError("invalid-procedure", "fail requires exactly one reason expression");
  }
  return [{ condition: expression.left, reason: args[0] }];
}

function containsFail(expression: Expression): boolean {
  if (isFailCall(expression)) return true;
  switch (expression.type) {
    case "BinaryExpression": {
      const binary = expression as jsep.BinaryExpression;
      return containsFail(binary.left) || containsFail(binary.right);
    }
    case "UnaryExpression": return containsFail((expression as jsep.UnaryExpression).argument);
    case "ConditionalExpression": {
      const conditional = expression as jsep.ConditionalExpression;
      return containsFail(conditional.test) || containsFail(conditional.consequent) || containsFail(conditional.alternate);
    }
    case "ArrayExpression": return (expression as jsep.ArrayExpression).elements.some((item) => item !== null && containsFail(item));
    case "CallExpression": {
      const call = expression as jsep.CallExpression;
      return containsFail(call.callee) || call.arguments.some(containsFail);
    }
    case "MemberExpression": {
      const member = expression as jsep.MemberExpression;
      return containsFail(member.object) || containsFail(member.property);
    }
    case "TemplateLiteral": return (expression as TemplateLiteral).expressions.some(containsFail);
    case "ArrowFunctionExpression": return containsFail((expression as ArrowExpression).body);
    default: return false;
  }
}

function compileExpression(expression: Expression, environment: CompileEnvironment): CompiledExpression {
  switch (expression.type) {
    case "Literal": return compileLiteral(expression as jsep.Literal);
    case "Identifier": return compileIdentifier(expression as jsep.Identifier, environment);
    case "MemberExpression": return compileMember(expression as jsep.MemberExpression, environment);
    case "UnaryExpression": return compileUnary(expression as jsep.UnaryExpression, environment);
    case "BinaryExpression": return compileBinary(expression as jsep.BinaryExpression, environment);
    case "ConditionalExpression": return compileConditional(expression as jsep.ConditionalExpression, environment);
    case "ArrayExpression": return compileArray(expression as jsep.ArrayExpression, environment);
    case "CallExpression": return compileCall(expression as jsep.CallExpression, environment);
    case "TemplateLiteral": return compileTemplate(expression as TemplateLiteral, environment);
    case "TaggedTemplateExpression":
      throw unsupported("Tagged templates");
    case "ArrowFunctionExpression":
      throw unsupported("Arrow functions outside admitted collection methods");
    case "Compound":
    case "SequenceExpression":
      throw unsupported("Several unguarded expressions");
    case "ThisExpression":
      throw unsupported("this");
    default:
      throw unsupported(`JavaScript AST node ${expression.type}`);
  }
}

function compileLiteral(expression: jsep.Literal): CompiledExpression {
  if (expression.value === null || expression.value instanceof RegExp) throw unsupported("null and regular-expression literals");
  if (typeof expression.value === "number" && !Number.isFinite(expression.value)) {
    throw new QualificationExpressionError("incompatible-type", "Numbers must be finite");
  }
  const kind = typeof expression.value;
  if (kind !== "boolean" && kind !== "number" && kind !== "string") throw unsupported(`Literal ${kind}`);
  return {
    type: { kind },
    logic: expression.value,
    references: [],
    literal: expression.value,
  } as CompiledExpression;
}

function compileIdentifier(expression: jsep.Identifier, environment: CompileEnvironment): CompiledExpression {
  const local = environment.locals.get(expression.name);
  if (local) return { ...local, references: [] };
  if (Object.values(procedureLanguage.qualification.roots).includes(expression.name as never)) {
    throw new QualificationExpressionError("invalid-procedure", `Root "${expression.name}" must be accessed through a declared property`);
  }
  if (expression.name === procedureLanguage.qualification.fail) {
    throw new QualificationExpressionError("invalid-procedure", "fail may appear only as the right-hand side of a qualification guard");
  }
  throw new QualificationExpressionError("invalid-procedure", `Identifier "${expression.name}" is not available`);
}

function compileMember(expression: jsep.MemberExpression, environment: CompileEnvironment): CompiledExpression {
  const rootPath = readRootPath(expression);
  const { checks } = procedureLanguage.qualification.roots;
  if (rootPath && ((rootPath[0] === checks && rootPath.length === 3) || (rootPath[0] !== checks && rootPath.length === 2))) {
    return compileRootPath(rootPath, environment);
  }

  const property = staticProperty(expression);
  const object = compileExpression(expression.object, environment);
  const propertySpec = own(procedureLanguage.qualification.properties, property);
  if (propertySpec && (object.type.kind === "array" || object.type.kind === "string")) {
    return {
      type: { kind: "number" },
      logic: { [propertySpec.opcode]: [object.logic] },
      references: object.references,
    };
  }
  throw new QualificationExpressionError("incompatible-type", `Property "${property}" is not available on ${describeType(object.type)}`);
}

function compileRootPath(path: readonly string[], environment: CompileEnvironment): CompiledExpression {
  const [root, first, second, ...rest] = path;
  if (!root || !first || rest.length > 0) {
    throw new QualificationExpressionError("invalid-procedure", `Expression path "${path.join(".")}" is outside the injected contract`);
  }
  assertSafePath(path);
  const roots = procedureLanguage.qualification.roots;
  if (root === roots.fact) {
    if (second !== undefined) throw new QualificationExpressionError("unknown-field", `Produced field "${first}" has no nested field "${second}"`);
    const schema = environment.operation.produced.properties[first];
    if (!schema) throw new QualificationExpressionError("unknown-field", `Operation "${environment.operation.operation}" produces no field "${first}"`);
    return variable(schemaToType(schema), variablePath(environment, roots.fact, first), { kind: "fact", field: first });
  }
  if (root === roots.context) {
    if (second !== undefined) throw new QualificationExpressionError("unknown-input", `Input "${first}" has no nested field "${second}"`);
    const schema = environment.contextRoles.get(first);
    if (!schema) throw new QualificationExpressionError("unknown-role", `Plan context has no role "${first}"`);
    return variable(
      schemaToType(schema),
      variablePath(environment, roots.context, first),
      { kind: "context", role: first },
    );
  }
  if (root === roots.checks) {
    if (!second) throw new QualificationExpressionError("unknown-field", `Check reference "${first}" must select one Produced field`);
    const provider = environment.checks.get(first);
    if (!provider) throw new QualificationExpressionError("invalid-dependency", `Qualification references unknown Check "${first}"`);
    if (!environment.canReferenceCheck(provider.scenario)) {
      throw new QualificationExpressionError("invalid-dependency", `Check "${first}" is not in a prerequisite Scenario`);
    }
    const schema = provider.operation.produced.properties[second];
    if (!schema) throw new QualificationExpressionError("unknown-field", `Check "${first}" produces no field "${second}"`);
    return variable(
      schemaToType(schema),
      variablePath(environment, roots.checks, first, second),
      { kind: "check", check: first, field: second },
    );
  }
  throw new QualificationExpressionError("invalid-procedure", `Root "${root}" is not available`);
}

function compileUnary(expression: jsep.UnaryExpression, environment: CompileEnvironment): CompiledExpression {
  const argument = compileExpression(expression.argument, environment);
  const opcode = own(procedureLanguage.qualification.operators.unary, expression.operator);
  if (opcode === "!") {
    requireType(argument, "boolean", "Operator !");
    return { type: { kind: "boolean" }, logic: { [opcode]: [argument.logic] }, references: argument.references };
  }
  if (opcode === "-") {
    requireType(argument, "number", "Unary -");
    return { type: { kind: "number" }, logic: { [opcode]: [argument.logic] }, references: argument.references };
  }
  throw unsupported(`Unary operator ${expression.operator}`);
}

function compileBinary(expression: jsep.BinaryExpression, environment: CompileEnvironment): CompiledExpression {
  const internal = procedureLanguage.qualification.internalOpcodes;
  const left = compileExpression(expression.left, environment);
  const right = compileExpression(expression.right, environment);
  const references = uniqueReferences([...left.references, ...right.references]);
  const booleanOpcode = own(procedureLanguage.qualification.operators.boolean, expression.operator);
  if (booleanOpcode) {
    requireType(left, "boolean", `Operator ${expression.operator}`);
    requireType(right, "boolean", `Operator ${expression.operator}`);
    return {
      type: { kind: "boolean" },
      logic: { [booleanOpcode]: [left.logic, right.logic] },
      references,
    };
  }
  const equalityOpcode = own(procedureLanguage.qualification.operators.equality, expression.operator);
  if (equalityOpcode) {
    assertComparable(left, right, expression.operator);
    assertEnumLiteral(left, right);
    assertEnumLiteral(right, left);
    return {
      type: { kind: "boolean" },
      logic: { [equalityOpcode]: [left.logic, right.logic] },
      references,
    };
  }
  const orderedOpcode = own(procedureLanguage.qualification.operators.ordered, expression.operator);
  if (orderedOpcode) {
    assertOrdered(left, right, expression.operator);
    return { type: { kind: "boolean" }, logic: { [orderedOpcode]: [left.logic, right.logic] }, references };
  }
  const arithmeticOpcode = own(procedureLanguage.qualification.operators.arithmetic, expression.operator);
  if (arithmeticOpcode) {
    if (expression.operator === "+" && left.type.kind === "string" && right.type.kind === "string") {
      return { type: { kind: "string" }, logic: { [internal.concatenate]: [left.logic, right.logic] }, references };
    }
    requireType(left, "number", `Operator ${expression.operator}`);
    requireType(right, "number", `Operator ${expression.operator}`);
    return { type: { kind: "number" }, logic: { [arithmeticOpcode]: [left.logic, right.logic] }, references };
  }
  throw unsupported(`Binary operator ${expression.operator}`);
}

function compileConditional(expression: jsep.ConditionalExpression, environment: CompileEnvironment): CompiledExpression {
  const test = compileExpression(expression.test, environment);
  requireType(test, "boolean", "Conditional test");
  const consequent = compileExpression(expression.consequent, environment);
  const alternate = compileExpression(expression.alternate, environment);
  if (!sameType(consequent.type, alternate.type)) {
    throw new QualificationExpressionError("incompatible-type", "Both conditional branches must have the same type");
  }
  return {
    type: consequent.type,
    logic: { [procedureLanguage.qualification.internalOpcodes.conditional]: [test.logic, consequent.logic, alternate.logic] },
    references: uniqueReferences([...test.references, ...consequent.references, ...alternate.references]),
  };
}

function compileArray(expression: jsep.ArrayExpression, environment: CompileEnvironment): CompiledExpression {
  if (expression.elements.length === 0 || expression.elements.some((item) => item === null)) {
    throw new QualificationExpressionError("incompatible-type", "Array literals must be non-empty and contain no holes");
  }
  const items = expression.elements.map((item) => compileExpression(item!, environment));
  const type = items[0]!.type;
  if (items.some((item) => !sameType(type, item.type))) {
    throw new QualificationExpressionError("incompatible-type", "Array literals must be homogeneous");
  }
  return {
    type: { kind: "array", item: type },
    logic: items.map((item) => item.logic),
    references: uniqueReferences(items.flatMap((item) => item.references)),
  };
}

function compileCall(expression: jsep.CallExpression, environment: CompileEnvironment): CompiledExpression {
  if (isFailCall(expression)) {
    throw new QualificationExpressionError("invalid-procedure", "fail may appear only at the end of a qualification guard");
  }
  const math = mathCall(expression);
  if (math) return compileMath(math, expression.arguments, environment);
  if (expression.callee.type !== "MemberExpression") throw unsupported("Arbitrary function calls");
  const callee = expression.callee as jsep.MemberExpression;
  const method = staticProperty(callee);
  const receiver = compileExpression(callee.object, environment);
  return compileMethod(receiver, method, expression.arguments, environment);
}

function compileMath(method: string, args: readonly Expression[], environment: CompileEnvironment): CompiledExpression {
  const spec = own(procedureLanguage.qualification.mathFunctions, method);
  if (!spec) throw unsupported(`Math.${method}`);
  assertArity(`Math.${method}`, args, spec.arity[0], spec.arity[1] ?? Number.POSITIVE_INFINITY);
  const compiled = args.map((arg) => compileExpression(arg, environment));
  compiled.forEach((item) => requireType(item, "number", `Math.${method}`));
  return {
    type: { kind: "number" },
    logic: { [spec.opcode]: compiled.map((item) => item.logic) },
    references: uniqueReferences(compiled.flatMap((item) => item.references)),
  };
}

function compileMethod(
  receiver: CompiledExpression,
  method: string,
  args: readonly Expression[],
  environment: CompileEnvironment,
): CompiledExpression {
  const collectionSpec = own(procedureLanguage.qualification.collectionMethods, method);
  if (collectionSpec?.kind === "membership") {
    assertArity(method, args, 1, 1);
    const value = compileExpression(args[0]!, environment);
    if (receiver.type.kind === "array") assertTypeCompatible(receiver.type.item, value.type, "includes argument");
    else if (receiver.type.kind === "string") requireType(value, "string", "String includes argument");
    else throw new QualificationExpressionError("incompatible-type", `includes is not available on ${describeType(receiver.type)}`);
    return {
      type: { kind: "boolean" },
      logic: { [collectionSpec.opcode]: [value.logic, receiver.logic] },
      references: uniqueReferences([...receiver.references, ...value.references]),
    };
  }
  if (collectionSpec && collectionSpec.kind !== "reduce") {
    if (receiver.type.kind !== "array") throw new QualificationExpressionError("incompatible-type", `${method} requires an array`);
    assertArity(method, args, 1, 1);
    const callback = requireArrow(args[0]!, method, 1);
    const parameter = identifierName(callback.params?.[0], `${method} callback parameter`);
    const nested = nestedEnvironment(environment, new Map([[parameter, {
      type: receiver.type.item,
      logic: { [procedureLanguage.qualification.internalOpcodes.variable]: "" },
    }]]));
    const body = compileExpression(callback.body, nested);
    if (collectionSpec.kind === "predicate" || collectionSpec.kind === "filter") requireType(body, "boolean", `${method} callback`);
    const resultType: ExpressionType = collectionSpec.kind === "predicate"
      ? { kind: "boolean" }
      : collectionSpec.kind === "filter"
        ? receiver.type
        : { kind: "array", item: body.type };
    return {
      type: resultType,
      logic: { [collectionSpec.opcode]: [receiver.logic, body.logic] },
      references: uniqueReferences([...receiver.references, ...body.references]),
    };
  }
  if (collectionSpec?.kind === "reduce") {
    if (receiver.type.kind !== "array") throw new QualificationExpressionError("incompatible-type", "reduce requires an array");
    assertArity(method, args, 2, 2);
    const callback = requireArrow(args[0]!, method, 2);
    const initial = compileExpression(args[1]!, environment);
    const accumulator = identifierName(callback.params?.[0], "reduce accumulator parameter");
    const current = identifierName(callback.params?.[1], "reduce current parameter");
    const nested = nestedEnvironment(environment, new Map([
      [accumulator, { type: initial.type, logic: { [procedureLanguage.qualification.internalOpcodes.variable]: "accumulator" } }],
      [current, { type: receiver.type.item, logic: { [procedureLanguage.qualification.internalOpcodes.variable]: "current" } }],
    ]));
    const body = compileExpression(callback.body, nested);
    assertTypeCompatible(initial.type, body.type, "reduce result");
    return {
      type: initial.type,
      logic: { [collectionSpec.opcode]: [receiver.logic, body.logic, initial.logic] },
      references: uniqueReferences([...receiver.references, ...body.references, ...initial.references]),
    };
  }
  const stringSpec = own(procedureLanguage.qualification.stringMethods, method);
  if (stringSpec) {
    requireScalar(receiver, "string", method);
    assertArity(method, args, stringSpec.arity[0], stringSpec.arity[1]);
    const compiled = args.map((argument, index) => {
      const value = compileExpression(argument, environment);
      requireType(value, stringSpec.arguments[index] ?? "string", `${method} argument`);
      return value;
    });
    return {
      type: { kind: stringSpec.result },
      logic: { [stringSpec.opcode]: [receiver.logic, ...compiled.map((value) => value.logic)] },
      references: uniqueReferences([...receiver.references, ...compiled.flatMap((value) => value.references)]),
    };
  }
  throw unsupported(`Method ${method}`);
}

function compileTemplate(expression: TemplateLiteral, environment: CompileEnvironment): CompiledExpression {
  const values: JsonLogicRule[] = [];
  const references: CompiledExpressionReference[] = [];
  expression.quasis.forEach((quasi, index) => {
    if (quasi.value.cooked !== "") values.push(quasi.value.cooked);
    const substitution = expression.expressions[index];
    if (!substitution) return;
    const compiled = compileExpression(substitution, environment);
    if (compiled.type.kind === "array") {
      throw new QualificationExpressionError("incompatible-type", "Template substitutions must be scalar values");
    }
    values.push(compiled.logic);
    references.push(...compiled.references);
  });
  if (values.length === 0) return { type: { kind: "string" }, logic: "", references: [], literal: "" };
  if (values.length === 1 && typeof values[0] === "string") {
    return { type: { kind: "string" }, logic: values[0], references: [], literal: values[0] };
  }
  return {
    type: { kind: "string" },
    logic: { [procedureLanguage.qualification.internalOpcodes.concatenate]: values },
    references: uniqueReferences(references),
  };
}

function readRootPath(expression: Expression): readonly string[] | undefined {
  if (expression.type === "Identifier") {
    const name = (expression as jsep.Identifier).name;
    const roots = procedureLanguage.qualification.roots;
    return name === roots.fact || name === roots.context || name === roots.checks ? [name] : undefined;
  }
  if (expression.type !== "MemberExpression") return undefined;
  const member = expression as jsep.MemberExpression;
  const prefix = readRootPath(member.object);
  if (!prefix) return undefined;
  return [...prefix, staticProperty(member)];
}

function staticProperty(expression: jsep.MemberExpression): string {
  if (expression.optional) throw unsupported("Optional chaining");
  if (!expression.computed && expression.property.type === "Identifier") return (expression.property as jsep.Identifier).name;
  if (expression.computed && expression.property.type === "Literal") {
    const value = (expression.property as jsep.Literal).value;
    if (typeof value === "string") return value;
  }
  throw new QualificationExpressionError("invalid-procedure", "Property names must be statically known strings");
}

function mathCall(expression: jsep.CallExpression): string | undefined {
  if (expression.callee.type !== "MemberExpression") return undefined;
  const callee = expression.callee as jsep.MemberExpression;
  if (callee.object.type !== "Identifier" || (callee.object as jsep.Identifier).name !== procedureLanguage.qualification.roots.math) return undefined;
  return staticProperty(callee);
}

function callArguments(expression: Expression): readonly Expression[] {
  return (expression as jsep.CallExpression).arguments;
}

function isFailCall(expression: Expression): boolean {
  return expression.type === "CallExpression"
    && (expression as jsep.CallExpression).callee.type === "Identifier"
    && ((expression as jsep.CallExpression).callee as jsep.Identifier).name === procedureLanguage.qualification.fail;
}

function isBinary(expression: Expression, operator: string): expression is jsep.BinaryExpression {
  return expression.type === "BinaryExpression" && (expression as jsep.BinaryExpression).operator === operator;
}

function requireArrow(expression: Expression, label: string, parameters: number): ArrowExpression {
  if (expression.type !== "ArrowFunctionExpression") throw new QualificationExpressionError("invalid-procedure", `${label} requires an expression callback`);
  const arrow = expression as ArrowExpression;
  if (arrow.async || arrow.params?.length !== parameters) {
    throw new QualificationExpressionError("invalid-procedure", `${label} callback requires exactly ${parameters} parameter${parameters === 1 ? "" : "s"}`);
  }
  return arrow;
}

function identifierName(expression: Expression | null | undefined, label: string): string {
  if (!expression || expression.type !== "Identifier") throw new QualificationExpressionError("invalid-procedure", `${label} must be an identifier`);
  return (expression as jsep.Identifier).name;
}

function nestedEnvironment(environment: CompileEnvironment, locals: ReadonlyMap<string, LocalValue>): CompileEnvironment {
  return { ...environment, locals: new Map([...environment.locals, ...locals]), iteratorDepth: environment.iteratorDepth + 1 };
}

function variable(type: ExpressionType, path: string, reference: ExpressionReferenceIdentity): CompiledExpression {
  const value = type.kind === "array" ? type.item : type;
  if (value.kind === "array" || value.kind === "boolean") {
    throw new QualificationExpressionError("incompatible-type", "Injected values must use a Product Action Contract value type");
  }
  return {
    type,
    logic: { [procedureLanguage.qualification.internalOpcodes.variable]: path },
    references: [{
      ...reference,
      valueType: value.kind,
      cardinality: type.kind === "array" ? "many" : "one",
    }],
  };
}

function variablePath(environment: CompileEnvironment, ...segments: readonly string[]): string {
  const path = segments.map((segment) => segment.replaceAll("\\", "\\\\").replaceAll(".", "\\.").replaceAll("/", "\\/"))
    .join(".");
  return environment.iteratorDepth === 0 ? path : `${"../".repeat(environment.iteratorDepth * 2)}${path}`;
}

function schemaToType(schema: ValueSchema): ExpressionType {
  if (schema.type === "array") return { kind: "array", item: schemaToType(schema.items) };
  if (schema.type === "number") return { kind: "number" };
  if (schema.format === "date-time") return { kind: "instant" };
  if (schema.minLength === 1) return { kind: "reference" };
  return { kind: "string", ...(schema.enum ? { enum: schema.enum } : {}) };
}

function requireType(expression: CompiledExpression, kind: ScalarKind, label: string): void {
  requireScalar(expression, kind, label);
}

function requireScalar(expression: CompiledExpression, kind: ScalarKind, label: string): void {
  if (expression.type.kind !== kind) {
    throw new QualificationExpressionError("incompatible-type", `${label} requires ${kind}, received ${describeType(expression.type)}`);
  }
}

function assertComparable(left: CompiledExpression, right: CompiledExpression, operator: string): void {
  if (left.type.kind === "array" || right.type.kind === "array" || !compatibleKinds(left.type.kind, right.type.kind)) {
    throw new QualificationExpressionError(
      "incompatible-type",
      `${operator} requires compatible scalar values, received ${describeType(left.type)} and ${describeType(right.type)}`,
    );
  }
}

function assertOrdered(left: CompiledExpression, right: CompiledExpression, operator: string): void {
  const admitted = (left.type.kind === "number" && right.type.kind === "number")
    || (left.type.kind === "instant" && right.type.kind === "instant")
    || (left.type.kind === "string" && right.type.kind === "string");
  if (!admitted) {
    throw new QualificationExpressionError(
      "incompatible-type",
      `${operator} requires two numbers, instants or strings of the same type`,
    );
  }
}

function assertTypeCompatible(expected: ExpressionType, actual: ExpressionType, label: string): void {
  if (!sameType(expected, actual)) {
    throw new QualificationExpressionError("incompatible-type", `${label} requires ${describeType(expected)}, received ${describeType(actual)}`);
  }
}

function assertEnumLiteral(typed: CompiledExpression, candidate: CompiledExpression): void {
  if (typed.type.kind !== "string" || !typed.type.enum || typeof candidate.literal !== "string") return;
  if (!typed.type.enum.includes(candidate.literal)) {
    throw new QualificationExpressionError("incompatible-type", `Value "${candidate.literal}" is outside the declared domain`);
  }
}

function sameType(left: ExpressionType, right: ExpressionType): boolean {
  if (left.kind === "array" || right.kind === "array") {
    return left.kind === "array" && right.kind === "array" && sameType(left.item, right.item);
  }
  return compatibleKinds(left.kind, right.kind);
}

function compatibleKinds(left: ScalarKind, right: ScalarKind): boolean {
  if (left === right) return true;
  return (left === "reference" && right === "string") || (left === "string" && right === "reference");
}

function describeType(type: ExpressionType): string {
  return type.kind === "array" ? `array of ${describeType(type.item)}` : type.kind;
}

function assertArity(label: string, args: readonly Expression[], min: number, max: number): void {
  if (args.length < min || args.length > max) {
    const expected = min === max ? String(min) : max === Number.POSITIVE_INFINITY ? `at least ${min}` : `${min} to ${max}`;
    throw new QualificationExpressionError("invalid-procedure", `${label} requires ${expected} argument${min === 1 && max === 1 ? "" : "s"}`);
  }
}

function assertSafePath(path: readonly string[]): void {
  const forbidden = new Set(["__proto__", "prototype", "constructor"]);
  const unsafe = path.find((segment) => forbidden.has(segment));
  if (unsafe) throw new QualificationExpressionError("invalid-procedure", `Property "${unsafe}" is not available`);
}

function uniqueReferences(references: readonly CompiledExpressionReference[]): readonly CompiledExpressionReference[] {
  const unique = new Map<string, CompiledExpressionReference>();
  for (const reference of references) unique.set(JSON.stringify(reference), reference);
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function unsupported(label: string): QualificationExpressionError {
  return new QualificationExpressionError("invalid-procedure", `${label} is outside the closed qualification expression language`);
}

function own<const T extends object>(object: T, key: string): T[keyof T] | undefined {
  return Object.hasOwn(object, key) ? object[key as keyof T] : undefined;
}
