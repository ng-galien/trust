import type { SentenceToken } from "./sentence.js";

export type StepGrammarExpression =
  | { readonly kind: "literal"; readonly value: string; readonly detail: string; readonly capture?: string }
  | { readonly kind: "quoted"; readonly slot: string; readonly detail: string }
  | { readonly kind: "one-of"; readonly slot: string; readonly values: readonly string[]; readonly detail: string; readonly quoted: boolean }
  | { readonly kind: "sequence"; readonly expressions: readonly StepGrammarExpression[] }
  | { readonly kind: "choice"; readonly expressions: readonly StepGrammarExpression[] }
  | { readonly kind: "optional"; readonly expression: StepGrammarExpression }
  | { readonly kind: "repeat"; readonly expression: StepGrammarExpression };

export interface StepGrammarProduction {
  readonly name: string;
  readonly context: "background" | "scenario";
  readonly expression: StepGrammarExpression;
}

export interface StepGrammar {
  readonly productions: readonly StepGrammarProduction[];
}

export type StepGrammarExpectation =
  | { readonly kind: "literal"; readonly value: string; readonly detail: string }
  | { readonly kind: "quoted"; readonly slot: string; readonly detail: string }
  | { readonly kind: "one-of"; readonly slot: string; readonly values: readonly string[]; readonly detail: string; readonly quoted: boolean };

export interface StepGrammarCapture {
  readonly slot: string;
  readonly value: string;
}

export interface StepGrammarMatch {
  readonly production: string;
  readonly captures: readonly StepGrammarCapture[];
}

export interface StepGrammarFailure {
  readonly tokenIndex: number;
  readonly found?: SentenceToken;
  readonly expectations: readonly StepGrammarExpectation[];
  readonly expectedEnd: boolean;
}

export interface StepGrammarPrefix {
  readonly production: string;
  readonly captures: readonly StepGrammarCapture[];
  readonly consumedTokens: number;
}

export const stepLiteral = (value: string, detail: string, capture?: string): StepGrammarExpression => ({ kind: "literal", value, detail, ...(capture === undefined ? {} : { capture }) });
export const stepQuoted = (slot: string, detail: string): StepGrammarExpression => ({ kind: "quoted", slot, detail });
export const stepOneOf = (slot: string, values: readonly string[], detail: string, quoted = false): StepGrammarExpression => ({ kind: "one-of", slot, values, detail, quoted });
export const stepSequence = (...expressions: readonly StepGrammarExpression[]): StepGrammarExpression => ({ kind: "sequence", expressions });
export const stepChoice = (...expressions: readonly StepGrammarExpression[]): StepGrammarExpression => ({ kind: "choice", expressions });
export const stepOptional = (expression: StepGrammarExpression): StepGrammarExpression => ({ kind: "optional", expression });
export const stepRepeat = (expression: StepGrammarExpression): StepGrammarExpression => ({ kind: "repeat", expression });

interface SymbolEdge {
  readonly from: number;
  readonly to: number;
  readonly symbol: StepGrammarExpectation;
  readonly word?: string;
  readonly capture?: string;
  readonly captureValue?: string;
}

interface CompiledGrammar {
  readonly start: number;
  readonly accept: ReadonlyMap<number, string>;
  readonly epsilon: ReadonlyMap<number, readonly number[]>;
  readonly symbols: ReadonlyMap<number, readonly SymbolEdge[]>;
  readonly productionByState: ReadonlyMap<number, string>;
}

const compiledGrammars = new WeakMap<StepGrammar, Map<string, CompiledGrammar>>();

export function matchStepGrammar(grammar: StepGrammar, tokens: readonly SentenceToken[], context?: StepGrammarProduction["context"]): string | undefined {
  return parseStepGrammar(grammar, tokens, context)?.production;
}

export function parseStepGrammar(grammar: StepGrammar, tokens: readonly SentenceToken[], context?: StepGrammarProduction["context"]): StepGrammarMatch | undefined {
  const compiled = compileGrammar(grammar, context);
  for (const path of consumePaths(compiled, tokens)) {
    const production = compiled.accept.get(path.state);
    if (production !== undefined) return { production, captures: path.captures };
  }
  return undefined;
}

export function parseStepGrammarPrefix(grammar: StepGrammar, tokens: readonly SentenceToken[], context?: StepGrammarProduction["context"]): StepGrammarPrefix | undefined {
  const compiled = compileGrammar(grammar, context);
  let paths = epsilonClosurePaths(compiled, [{ state: compiled.start, captures: [] }]);
  let consumedTokens = 0;
  for (const token of tokens) {
    const next: ParsePath[] = [];
    for (const path of paths) for (const edge of compiled.symbols.get(path.state) ?? []) {
      if (!matches(edge, token)) continue;
      next.push({
        state: edge.to,
        captures: edge.capture === undefined
          ? path.captures
          : [...path.captures, { slot: edge.capture, value: edge.captureValue ?? token.value }],
      });
    }
    if (next.length === 0) break;
    paths = epsilonClosurePaths(compiled, next);
    consumedTokens += 1;
  }
  const path = paths.find(({ state }) => compiled.productionByState.has(state));
  const production = path ? compiled.productionByState.get(path.state) : undefined;
  return path && production ? { production, captures: path.captures, consumedTokens } : undefined;
}

export function stepGrammarExpectations(grammar: StepGrammar, tokens: readonly SentenceToken[], context?: StepGrammarProduction["context"]): StepGrammarExpectation[] {
  const compiled = compileGrammar(grammar, context);
  let states = consume(compiled, tokens);
  let partial: SentenceToken | undefined;
  if (states.size === 0 && tokens.length > 0) {
    partial = tokens.at(-1);
    states = consume(compiled, tokens.slice(0, -1));
  }
  return uniqueExpectations([...states].flatMap((state) => compiled.symbols.get(state) ?? [])
    .filter(({ symbol, word }) => matchesPartial(symbol, word, partial))
    .map(({ symbol }) => symbol));
}

export function stepGrammarFailure(grammar: StepGrammar, tokens: readonly SentenceToken[], context?: StepGrammarProduction["context"]): StepGrammarFailure | undefined {
  const compiled = compileGrammar(grammar, context);
  let states = epsilonClosure(compiled, new Set([compiled.start]));
  for (const [tokenIndex, token] of tokens.entries()) {
    const next = new Set<number>();
    for (const state of states) for (const edge of compiled.symbols.get(state) ?? []) {
      if (matches(edge, token)) next.add(edge.to);
    }
    if (next.size === 0) {
      return {
        tokenIndex,
        found: token,
        expectations: uniqueExpectations([...states].flatMap((state) => compiled.symbols.get(state) ?? []).map(({ symbol }) => symbol)),
        expectedEnd: [...states].some((state) => compiled.accept.has(state)),
      };
    }
    states = epsilonClosure(compiled, next);
  }
  if ([...states].some((state) => compiled.accept.has(state))) return undefined;
  return {
    tokenIndex: tokens.length,
    expectations: uniqueExpectations([...states].flatMap((state) => compiled.symbols.get(state) ?? []).map(({ symbol }) => symbol)),
    expectedEnd: false,
  };
}

function uniqueExpectations(expectations: readonly StepGrammarExpectation[]): StepGrammarExpectation[] {
  const unique = new Map<string, StepGrammarExpectation>();
  for (const expectation of expectations) {
    const key = expectation.kind === "literal"
      ? `literal:${expectation.value}`
      : expectation.kind === "quoted"
        ? `quoted:${expectation.slot}`
        : `one-of:${expectation.slot}:${expectation.quoted}`;
    const existing = unique.get(key);
    if (existing?.kind === "one-of" && expectation.kind === "one-of") {
      unique.set(key, { ...existing, values: [...new Set([...existing.values, ...expectation.values])] });
    } else {
      unique.set(key, expectation);
    }
  }
  return [...unique.values()];
}

function matchesPartial(expectation: StepGrammarExpectation, word: string | undefined, partial: SentenceToken | undefined): boolean {
  if (!partial) return true;
  if (expectation.kind === "literal") return partial.kind === "text" && word?.startsWith(partial.value) === true;
  if (expectation.kind === "quoted") return partial.kind === "quoted";
  return partial.kind === (expectation.quoted ? "quoted" : "text")
    && expectation.values.some((value) => value.startsWith(partial.value));
}

function consume(grammar: CompiledGrammar, tokens: readonly SentenceToken[]): Set<number> {
  let states = epsilonClosure(grammar, new Set([grammar.start]));
  for (const token of tokens) {
    const next = new Set<number>();
    for (const state of states) for (const edge of grammar.symbols.get(state) ?? []) {
      if (matches(edge, token)) next.add(edge.to);
    }
    states = epsilonClosure(grammar, next);
    if (states.size === 0) break;
  }
  return states;
}

interface ParsePath {
  readonly state: number;
  readonly captures: readonly StepGrammarCapture[];
}

function consumePaths(grammar: CompiledGrammar, tokens: readonly SentenceToken[]): readonly ParsePath[] {
  let paths = epsilonClosurePaths(grammar, [{ state: grammar.start, captures: [] }]);
  for (const token of tokens) {
    const next: ParsePath[] = [];
    for (const path of paths) for (const edge of grammar.symbols.get(path.state) ?? []) {
      if (!matches(edge, token)) continue;
      next.push({
        state: edge.to,
        captures: edge.capture === undefined
          ? path.captures
          : [...path.captures, { slot: edge.capture, value: edge.captureValue ?? token.value }],
      });
    }
    paths = epsilonClosurePaths(grammar, next);
    if (paths.length === 0) break;
  }
  return paths;
}

function epsilonClosurePaths(grammar: CompiledGrammar, initial: readonly ParsePath[]): readonly ParsePath[] {
  const paths: ParsePath[] = [];
  const pending = [...initial];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const path = pending.shift()!;
    const key = `${path.state}:${JSON.stringify(path.captures)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
    for (const next of grammar.epsilon.get(path.state) ?? []) pending.push({ state: next, captures: path.captures });
  }
  return paths;
}

function matches(edge: SymbolEdge, token: SentenceToken): boolean {
  if (edge.symbol.kind === "literal") return token.kind === "text" && token.value === edge.word;
  if (edge.symbol.kind === "quoted") return token.kind === "quoted";
  return token.kind === (edge.symbol.quoted ? "quoted" : "text") && edge.symbol.values.includes(token.value);
}

function epsilonClosure(grammar: CompiledGrammar, initial: ReadonlySet<number>): Set<number> {
  const states = new Set(initial);
  const pending = [...initial];
  while (pending.length > 0) {
    const state = pending.pop()!;
    for (const next of grammar.epsilon.get(state) ?? []) if (!states.has(next)) {
      states.add(next);
      pending.push(next);
    }
  }
  return states;
}

function compileGrammar(grammar: StepGrammar, context?: StepGrammarProduction["context"]): CompiledGrammar {
  const key = context ?? "*";
  const cached = compiledGrammars.get(grammar)?.get(key);
  if (cached) return cached;
  let nextState = 0;
  const productionByState = new Map<number, string>();
  const state = (production?: string): number => {
    const created = nextState++;
    if (production !== undefined) productionByState.set(created, production);
    return created;
  };
  const start = state();
  const accept = new Map<number, string>();
  const epsilon = new Map<number, number[]>();
  const symbols = new Map<number, SymbolEdge[]>();
  const addEpsilon = (from: number, to: number): void => { epsilon.set(from, [...epsilon.get(from) ?? [], to]); };
  const addSymbol = (edge: SymbolEdge): void => { symbols.set(edge.from, [...symbols.get(edge.from) ?? [], edge]); };

  const compile = (expression: StepGrammarExpression, from: number, to: number, production: string): void => {
    if (expression.kind === "literal") {
      const words = expression.value.split(/\s+/).filter(Boolean);
      let at = from;
      words.forEach((word, index) => {
        const target = index === words.length - 1 ? to : state(production);
        addSymbol({
          from: at,
          to: target,
          word,
          ...(index === words.length - 1 && expression.capture !== undefined
            ? { capture: expression.capture, captureValue: expression.value }
            : {}),
          symbol: { kind: "literal", value: words.slice(index).join(" "), detail: expression.detail },
        });
        at = target;
      });
      if (words.length === 0) addEpsilon(from, to);
      return;
    }
    if (expression.kind === "quoted") {
      addSymbol({ from, to, symbol: expression, capture: expression.slot });
      return;
    }
    if (expression.kind === "one-of") {
      addSymbol({ from, to, symbol: expression, capture: expression.slot });
      return;
    }
    if (expression.kind === "sequence") {
      if (expression.expressions.length === 0) {
        addEpsilon(from, to);
        return;
      }
      let at = from;
      expression.expressions.forEach((child, index) => {
        const target = index === expression.expressions.length - 1 ? to : state(production);
        compile(child, at, target, production);
        at = target;
      });
      return;
    }
    if (expression.kind === "choice") {
      for (const child of expression.expressions) compile(child, from, to, production);
      return;
    }
    if (expression.kind === "optional") {
      addEpsilon(from, to);
      compile(expression.expression, from, to, production);
      return;
    }
    addEpsilon(from, to);
    const repeated = state(production);
    compile(expression.expression, from, repeated, production);
    addEpsilon(repeated, from);
  };

  for (const production of grammar.productions) {
    if (context !== undefined && production.context !== context) continue;
    const productionStart = state(production.name);
    const productionEnd = state(production.name);
    addEpsilon(start, productionStart);
    compile(production.expression, productionStart, productionEnd, production.name);
    accept.set(productionEnd, production.name);
  }
  const compiled = { start, accept, epsilon, symbols, productionByState };
  const byContext = compiledGrammars.get(grammar) ?? new Map<string, CompiledGrammar>();
  byContext.set(key, compiled);
  compiledGrammars.set(grammar, byContext);
  return compiled;
}
