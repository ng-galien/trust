import { defaultMethods, LogicEngine } from "json-logic-engine";

import { procedureLanguage } from "./language.js";
import type { JsonLogicRule } from "./procedure.js";

const logic = createQualificationEngine();

export function evaluateQualificationRule(rule: JsonLogicRule, data: Readonly<Record<string, unknown>>): unknown {
  return logic.run(rule, data);
}

export function evaluateQualificationCondition(rule: JsonLogicRule, data: Readonly<Record<string, unknown>>): boolean {
  try {
    const result = evaluateQualificationRule(rule, data);
    if (typeof result !== "boolean") throw new TypeError("A qualification guard must evaluate to a boolean");
    return result;
  } catch (error) {
    if (error instanceof NonFiniteExpressionError) return false;
    throw error;
  }
}

function createQualificationEngine(): LogicEngine {
  const qualification = procedureLanguage.qualification;
  const everyOpcode = qualification.collectionMethods.every.opcode;
  const standard = new Set<string>([
    ...Object.values(qualification.internalOpcodes),
    ...Object.values(qualification.operators.boolean),
    ...Object.values(qualification.operators.equality),
    ...Object.values(qualification.operators.ordered),
    qualification.operators.unary["!"],
    ...Object.values(qualification.collectionMethods).map(({ opcode }) => opcode).filter((opcode) => opcode !== everyOpcode),
  ]);
  const available = defaultMethods as unknown as Record<string, unknown>;
  const methods: Record<string, unknown> = Object.fromEntries([...standard].map((name) => [name, available[name]]));
  methods[everyOpcode] = {
    ...defaultMethods.all,
    method: (args: unknown, context: unknown, above: unknown[], engine: LogicEngine): boolean => {
      if (!Array.isArray(args)) throw new TypeError("every requires an array and an expression callback");
      const selector = engine.run(args[0], context, { above });
      return Array.isArray(selector) && selector.length === 0 ? true : defaultMethods.all.method(args, context, above, engine);
    },
  };
  const engine = new LogicEngine(methods, {
    disableInline: true,
    disableInterpretedOptimization: false,
    permissive: false,
    maxDepth: 64,
    maxArrayLength: 1 << 15,
    maxStringLength: 1 << 16,
  });
  for (const opcode of new Set(Object.values(qualification.operators.arithmetic))) {
    engine.addMethod(opcode, (args: unknown[]) => evaluateArithmetic(opcode, args));
  }
  for (const spec of Object.values(qualification.mathFunctions)) {
    engine.addMethod(spec.opcode, (args: unknown[]) => evaluateMath(spec.native, args));
  }
  engine.addMethod(qualification.properties.length.opcode, ([value]) => {
    if (typeof value !== "string" && !Array.isArray(value)) throw new TypeError("length requires a string or array");
    return value.length;
  });
  for (const spec of Object.values(qualification.stringMethods)) {
    engine.addMethod(spec.opcode, (args: unknown[]) => evaluateStringMethod(spec, args));
  }
  return engine;
}

function evaluateArithmetic(operator: string, args: unknown[]): number {
  const values = args.map(number);
  if (operator === "+") return finite(values.reduce((total, value) => total + value, 0));
  if (operator === "*") return finite(values.reduce((total, value) => total * value, 1));
  if (values.length === 0) throw new TypeError(`Operator ${operator} requires an operand`);
  if (operator === "-") return finite(values.length === 1 ? -values[0]! : values.slice(1).reduce((total, value) => total - value, values[0]!));
  if (values.length < 2) throw new TypeError(`Operator ${operator} requires two operands`);
  return finite(values.slice(1).reduce((total, value) => operator === "/" ? total / value : total % value, values[0]!));
}

function evaluateMath(native: string, args: unknown[]): number {
  const method = Math[native as keyof Math] as unknown as (...values: number[]) => number;
  if (typeof method !== "function") throw new TypeError(`Math function ${native} is unavailable`);
  return finite(method(...args.map(number)));
}

function evaluateStringMethod(
  spec: (typeof procedureLanguage.qualification.stringMethods)[keyof typeof procedureLanguage.qualification.stringMethods],
  [receiver, ...args]: unknown[],
): string | boolean {
  const value = string(receiver);
  const typed = args.map((argument, index) => spec.arguments[index] === "number" ? number(argument) : string(argument));
  const method = value[spec.native as keyof string] as unknown as (...values: Array<string | number>) => string | boolean;
  if (typeof method !== "function") throw new TypeError(`String method ${spec.native} is unavailable`);
  return method.apply(value, typed);
}

class NonFiniteExpressionError extends Error {}
const finite = (value: number): number => {
  if (!Number.isFinite(value)) throw new NonFiniteExpressionError("Expression produced a non-finite number");
  return value;
};
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Numeric operator requires finite numbers");
  return value;
};
const string = (value: unknown): string => {
  if (typeof value !== "string") throw new TypeError("String operator requires strings");
  return value;
};
