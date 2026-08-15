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
