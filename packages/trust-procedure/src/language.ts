import { isExpressionIdentifierPart, isExpressionIdentifierStart } from "@trust/gherkin";
import { operationLanguage } from "@trust/operation/language";

export const procedureLanguage = {
  tags: {
    procedure: "@procedure:",
    version: "@version:",
    dsl: "@trust-dsl:",
    intentChaining: "@intent-chaining",
    scenario: "@scenario:",
  },
  dslVersion: "1",
  valueTypes: operationLanguage.valueTypes,
  cardinalities: operationLanguage.cardinalities,
  phrases: { context: "Plan context", check: "Check", dependency: "scenario", operation: "runs Operation" },
  qualification: {
    mediaType: "js",
    roots: { fact: "fact", context: "context", checks: "checks", math: "Math" } as const,
    fail: "fail",
    operators: {
      unary: { "!": "!", "-": "-" },
      boolean: { "&&": "and", "||": "or" },
      equality: { "===": "===", "!==": "!==" },
      ordered: { "<": "<", "<=": "<=", ">": ">", ">=": ">=" },
      arithmetic: { "+": "+", "-": "-", "*": "*", "/": "/", "%": "%" },
    } as const,
    mathFunctions: {
      min: { arity: [1], opcode: "min", native: "min" }, max: { arity: [1], opcode: "max", native: "max" },
      abs: { arity: [1, 1], opcode: "trust.abs", native: "abs" }, floor: { arity: [1, 1], opcode: "trust.floor", native: "floor" },
      ceil: { arity: [1, 1], opcode: "trust.ceil", native: "ceil" }, round: { arity: [1, 1], opcode: "trust.round", native: "round" },
      sqrt: { arity: [1, 1], opcode: "trust.sqrt", native: "sqrt" }, pow: { arity: [2, 2], opcode: "trust.pow", native: "pow" },
    } as const,
    collectionMethods: {
      includes: { opcode: "in", kind: "membership" },
      some: { opcode: "some", kind: "predicate" }, every: { opcode: "all", kind: "predicate" },
      filter: { opcode: "filter", kind: "filter" }, map: { opcode: "map", kind: "map" },
      reduce: { opcode: "reduce", kind: "reduce" },
    } as const,
    properties: { length: { opcode: "trust.length" } } as const,
    stringMethods: {
      startsWith: { arity: [1, 1], opcode: "trust.starts-with", native: "startsWith", result: "boolean", arguments: ["string"] },
      endsWith: { arity: [1, 1], opcode: "trust.ends-with", native: "endsWith", result: "boolean", arguments: ["string"] },
      substring: { arity: [1, 2], opcode: "trust.substring", native: "substring", result: "string", arguments: ["number", "number"] },
      toLowerCase: { arity: [0, 0], opcode: "trust.lower", native: "toLowerCase", result: "string", arguments: [] },
      toUpperCase: { arity: [0, 0], opcode: "trust.upper", native: "toUpperCase", result: "string", arguments: [] },
      trim: { arity: [0, 0], opcode: "trust.trim", native: "trim", result: "string", arguments: [] },
    } as const,
    internalOpcodes: { variable: "var", conditional: "if", concatenate: "cat" } as const,
  },
  syntax: {
    types: ["Check", "Plan", "Operation"] as const,
    verbs: ["runs", "on", "using", "materializes", "establish", "validated", "declared", "fixed"] as const,
  },
  template: `# language: en
@trust-dsl:1 @procedure:domain-action @version:1.0.0
Feature: Describe what this procedure establishes

  Background: Plan context
    Given one reference "repository"

  @scenario:repository-status
  Scenario: Read the repository status
    Then Check "repository status" runs Operation "git.head-read"
        on "repository" as Input "project"
        and must establish "the repository has local changes"
      """js
      fact.workingTree === "dirty" ||
      fail("the repository has no local changes")
      """
`,
} as const;

export const procedureHighlightVocabulary = {
  roots: Object.values(procedureLanguage.qualification.roots),
  functions: [
    ...Object.keys(procedureLanguage.qualification.mathFunctions),
    ...Object.keys(procedureLanguage.qualification.collectionMethods),
    ...Object.keys(procedureLanguage.qualification.stringMethods),
    procedureLanguage.qualification.fail,
  ],
  types: procedureLanguage.syntax.types,
  verbs: procedureLanguage.syntax.verbs,
} as const;

export function expressionMember(name: string): string {
  const [first, ...rest] = name;
  const identifier = first !== undefined && isExpressionIdentifierStart(first) && rest.every(isExpressionIdentifierPart);
  return identifier ? `.${name}` : `[${JSON.stringify(name)}]`;
}

export interface QualificationCompletionPath {
  readonly root: string;
  readonly members: readonly string[];
  readonly partial: string;
  readonly replaceOffset: number;
}

/** Read the incomplete static member path at the cursor, including bracket-quoted natural names. */
export function qualificationCompletionPath(source: string, offset: number): QualificationCompletionPath | undefined {
  const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const line = source.slice(lineStart, offset);
  const roots = Object.values(procedureLanguage.qualification.roots);
  let root = "";
  let rootAt = -1;
  for (const candidate of roots) {
    const at = line.lastIndexOf(candidate);
    const before = at > 0 ? line[at - 1] : undefined;
    if (at >= rootAt && (before === undefined || !isExpressionIdentifierPart(before))) {
      root = candidate;
      rootAt = at;
    }
  }
  if (rootAt < 0) return undefined;

  const path = line.slice(rootAt);
  const members: string[] = [];
  let at = root.length;
  while (at < path.length) {
    if (path[at] === ".") {
      const start = at + 1;
      at = start;
      while (at < path.length && isExpressionIdentifierPart(path[at]!)) at += 1;
      if (at === path.length) {
        return { root, members, partial: path.slice(start), replaceOffset: lineStart + rootAt + start };
      }
      if (path[at] !== ".") return undefined;
      members.push(path.slice(start, at));
      continue;
    }
    if (path[at] !== "[" || (path[at + 1] !== '"' && path[at + 1] !== "'")) return undefined;
    const quote = path[at + 1]!;
    const accessorStart = at;
    const valueStart = at + 2;
    at = valueStart;
    while (at < path.length && (path[at] !== quote || path[at - 1] === "\\")) at += 1;
    if (at >= path.length || path[at + 1] !== "]") {
      return {
        root,
        members,
        partial: path.slice(valueStart),
        replaceOffset: lineStart + rootAt + accessorStart,
      };
    }
    const raw = path.slice(valueStart, at);
    try {
      members.push(quote === '"' ? JSON.parse(`"${raw}"`) as string : raw.replaceAll("\\'", "'"));
    } catch {
      return undefined;
    }
    at += 2;
  }
  return { root, members, partial: "", replaceOffset: offset };
}
