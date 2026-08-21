export type SentenceToken =
  | {
      readonly kind: "text";
      readonly value: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "quoted";
      readonly value: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "comma";
      readonly value: ",";
      readonly start: number;
      readonly end: number;
    };

export class SentenceSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
    this.name = "SentenceSyntaxError";
  }
}

export function tokenizeSentence(source: string): readonly SentenceToken[] {
  const tokens: SentenceToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset];
    if (/\s/u.test(character ?? "")) {
      offset += 1;
      continue;
    }
    if (character === ",") {
      const previous = tokens.at(-1);
      let next = offset + 1;
      if (!previous || previous.kind === "comma" || previous.end !== offset
        || next >= source.length || !/\s/u.test(source[next] ?? "")) {
        throw new SentenceSyntaxError("Comma must follow a value and be followed by whitespace", offset);
      }
      while (next < source.length && /\s/u.test(source[next] ?? "")) next += 1;
      if (next >= source.length || source[next] === ",") {
        throw new SentenceSyntaxError("Comma must be followed by a value", offset);
      }
      tokens.push({ kind: "comma", value: ",", start: offset, end: offset + 1 });
      offset += 1;
      continue;
    }
    if (character === '"') {
      const start = offset;
      offset += 1;
      const end = source.indexOf('"', offset);
      if (end < 0) throw new SentenceSyntaxError("Quoted value is not closed", start);
      if (start > 0 && !/[\s,]/u.test(source[start - 1] ?? "")) {
        throw new SentenceSyntaxError("Quoted value must be separated from the previous token", start);
      }
      if (end + 1 < source.length && !/[\s,]/u.test(source[end + 1] ?? "")) {
        throw new SentenceSyntaxError("Quoted value must be separated from the next token", end + 1);
      }
      tokens.push({ kind: "quoted", value: source.slice(offset, end), start, end: end + 1 });
      offset = end + 1;
      continue;
    }
    const start = offset;
    while (offset < source.length && !/[\s,"]/u.test(source[offset] ?? "")) offset += 1;
    if (offset === start) throw new SentenceSyntaxError("Sentence contains an unsupported token", offset);
    tokens.push({ kind: "text", value: source.slice(start, offset), start, end: offset });
  }
  return tokens;
}

/** Shared sequential reader for sentences already tokenized by the Gherkin authority. */
export class SentenceCursor {
  #index = 0;

  constructor(
    readonly tokens: readonly SentenceToken[],
    readonly reject?: (expectation: string) => never,
  ) {}

  get done(): boolean { return this.#index >= this.tokens.length; }
  peek(): SentenceToken | undefined { return this.tokens[this.#index]; }

  peekText(value: string): boolean {
    const token = this.peek();
    return token?.kind === "text" && token.value === value;
  }

  takeText(value: string): boolean {
    if (!this.peekText(value)) return false;
    this.#index += 1;
    return true;
  }

  takeWords(...values: readonly string[]): boolean {
    const start = this.#index;
    if (values.every((value) => this.takeText(value))) return true;
    this.#index = start;
    return false;
  }

  takeOneOf(values: readonly string[]): string | undefined {
    const token = this.peek();
    if (token?.kind !== "text" || !values.includes(token.value)) return undefined;
    this.#index += 1;
    return token.value;
  }

  takeQuoted(accept: (value: string) => boolean = (value) => value.length > 0): string | undefined {
    const token = this.peek();
    if (token?.kind !== "quoted" || !accept(token.value)) return undefined;
    this.#index += 1;
    return token.value;
  }

  requireText(value: string): void {
    if (!this.takeText(value)) this.failure(`Expected ${value}`);
  }

  requireOneOf(values: readonly string[]): string {
    return this.takeOneOf(values) ?? this.failure(`Expected one of: ${values.join(", ")}`);
  }

  requireQuoted(): string {
    return this.takeQuoted() ?? this.failure("Expected a quoted value");
  }

  private failure(expectation: string): never {
    if (this.reject) return this.reject(expectation);
    throw new SentenceSyntaxError(expectation, this.peek()?.start ?? this.tokens.at(-1)?.end ?? 0);
  }
}

export const isExpressionIdentifierStart = (character: string): boolean => character === "_" || character === "$"
  || (character >= "A" && character <= "Z") || (character >= "a" && character <= "z");
export const isExpressionIdentifierPart = (character: string): boolean => isExpressionIdentifierStart(character)
  || (character >= "0" && character <= "9");
