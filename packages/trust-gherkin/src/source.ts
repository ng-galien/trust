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

export function sourceLineRange(
  source: string,
  location?: { readonly line: number; readonly column?: number },
): SourceRange {
  const lines = source.split("\n");
  const line = Math.min(Math.max(location?.line ?? 1, 1), Math.max(lines.length - 1, 1));
  const text = lines[line - 1] ?? "";
  const column = Math.min(Math.max(location?.column ?? 1, 1), text.length + 1);
  return {
    start: { line, column },
    end: { line, column: Math.max(column + 1, text.length + 1) },
  };
}

export function sourceValueRange(
  source: string,
  located: Located,
  value: string,
  columnOffset = 0,
): SourceRange {
  const lines = source.split("\n");
  const line = Math.min(
    Math.max(located.location?.line ?? 1, 1),
    Math.max(lines.length - 1, 1),
  );
  const text = lines[line - 1] ?? "";
  const from = Math.max((located.location?.column ?? 1) - 1 + columnOffset, 0);
  const found = text.indexOf(value, from);
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
