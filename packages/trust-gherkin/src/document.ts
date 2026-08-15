import { AstBuilder, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { IdGenerator, type GherkinDocument } from "@cucumber/messages";

export class GherkinSyntaxError extends Error {
  constructor(
    message: string,
    readonly location?: { readonly line: number; readonly column: number },
  ) {
    super(message);
    this.name = "GherkinSyntaxError";
  }
}

export function normalizeGherkinSource(source: string): string {
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd() + "\n";
}

export function parseGherkin(source: string): GherkinDocument {
  const parser = new Parser(
    new AstBuilder(IdGenerator.incrementing()),
    new GherkinClassicTokenMatcher("en"),
  );
  try {
    return parser.parse(source);
  } catch (error) {
    const parserError = record(error);
    const nested = Array.isArray(parserError?.errors) ? record(parserError.errors[0]) : undefined;
    const location = record(nested?.location);
    throw new GherkinSyntaxError(
      error instanceof Error ? error.message : String(error),
      location && typeof location.line === "number" && typeof location.column === "number"
        ? { line: location.line, column: location.column }
        : undefined,
    );
  }
}

export function hasGherkinTag(source: string, prefix: string): boolean {
  let docString: '"""' | "```" | undefined;
  for (const line of source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const text = line.trimStart();
    if (docString) {
      if (text.startsWith(docString)) docString = undefined;
      continue;
    }
    if (text.startsWith('"""')) {
      docString = '"""';
      continue;
    }
    if (text.startsWith("```")) {
      docString = "```";
      continue;
    }
    if (!text.startsWith("@")) continue;
    for (const token of text.split(/\s+/)) {
      if (token.startsWith("#")) break;
      if (!token.startsWith("@")) break;
      if (token.startsWith(prefix)) return true;
    }
  }
  return false;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
