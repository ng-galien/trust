import { continuationLineIndexes, splitLines } from "./continuation.js";

export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface Located {
  readonly location?: { readonly line: number; readonly column?: number };
}

/** The physical lines of the located line: itself, then its continuation lines when it is a step. */
function extent(lines: readonly string[], line: number): number[] {
  return [line - 1, ...continuationLineIndexes(lines, line - 1)];
}

export function sourceLineRange(
  source: string,
  location?: { readonly line: number; readonly column?: number },
): SourceRange {
  const lines = splitLines(source);
  const line = Math.min(Math.max(location?.line ?? 1, 1), Math.max(lines.length - 1, 1));
  const text = lines[line - 1] ?? "";
  const column = Math.min(Math.max(location?.column ?? 1, 1), text.length + 1);
  const last = extent(lines, line).at(-1)!;
  const lastText = lines[last] ?? "";
  return {
    start: { line, column },
    end: { line: last + 1, column: last + 1 === line ? Math.max(column + 1, text.length + 1) : lastText.length + 1 },
  };
}

export function sourceValueRange(
  source: string,
  located: Located,
  value: string,
  columnOffset = 0,
): SourceRange {
  const lines = splitLines(source);
  const line = Math.min(
    Math.max(located.location?.line ?? 1, 1),
    Math.max(lines.length - 1, 1),
  );
  const text = lines[line - 1] ?? "";
  const from = Math.max((located.location?.column ?? 1) - 1 + columnOffset, 0);
  const found = text.indexOf(value, from);
  if (found < 0) {
    // The value may sit on one of the step's continuation lines.
    for (const index of extent(lines, line).slice(1)) {
      const at = (lines[index] ?? "").indexOf(value);
      if (at >= 0) return { start: { line: index + 1, column: at + 1 }, end: { line: index + 1, column: at + value.length + 1 } };
    }
  }
  const startIndex = found >= 0 ? found : Math.min(from, text.length);
  return {
    start: { line, column: startIndex + 1 },
    end: { line, column: startIndex + value.length + 1 },
  };
}

export function documentRange(source: string): SourceRange {
  const lines = source.split("\n");
  const line = Math.max(lines.length - 1, 1);
  return {
    start: { line: 1, column: 1 },
    end: { line, column: (lines[line - 1]?.length ?? 0) + 1 },
  };
}
