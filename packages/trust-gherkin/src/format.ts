import { continuationLineIndexes, splitLines } from "./continuation.js";

/* Formatter: re-flows long steps onto continuation lines, breaking before the connective words of the
   TRUST sentences (`with`, `from`, `and`, `where`, …) like a SQL pretty-printer, never inside a quoted
   value. Tables, doc strings, comments and short steps are left untouched; formatting is idempotent. */

const STEP_LINE = /^(\s*)((?:Given|When|Then|And|But|\*)\s+)(.*)$/u;
const CONNECTIVES = new Set(["with", "from", "and", "where", "on", "as", "into", "then", "for", "in", "of", "when", "using", "to", "at", "over", "through", "under"]);

export interface FormatOptions {
  /** Maximum width of a physical line before a step is broken (default 88). */
  readonly width?: number;
  /** Extra indentation of continuation lines relative to the step keyword. */
  readonly continuationIndent?: number;
}

export function formatGherkinSource(source: string, options: FormatOptions = {}): string {
  const width = options.width ?? 88;
  const extra = options.continuationIndent ?? 4;
  const lines = splitLines(source);
  const output: string[] = [];
  let index = 0;
  let fence: string | undefined;
  while (index < lines.length) {
    const line = lines[index]!;
    const text = line.trimStart();
    if (fence !== undefined) {
      if (text.startsWith(fence)) fence = undefined;
      output.push(line);
      index += 1;
      continue;
    }
    if (text.startsWith('"""') || text.startsWith("```")) {
      fence = text.slice(0, 3);
      output.push(line);
      index += 1;
      continue;
    }
    const step = STEP_LINE.exec(line);
    if (!step) {
      output.push(line);
      index += 1;
      continue;
    }
    const continued = continuationLineIndexes(lines, index);
    const sentence = [step[3]!.trim(), ...continued.map((at) => lines[at]!.trim())].join(" ");
    output.push(...reflow(step[1]!, step[2]!, sentence, width, extra));
    index += continued.length + 1;
  }
  return output.join("\n");
}

/** Whitespace-separated words, quoted values kept whole. */
function words(sentence: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of sentence) {
    if (character === '"') quoted = !quoted;
    if (!quoted && /\s/u.test(character)) {
      if (current) result.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) result.push(current);
  return result;
}

function reflow(indent: string, keyword: string, sentence: string, width: number, extra: number): string[] {
  const head = `${indent}${keyword}`;
  if (head.length + sentence.length <= width) return [`${head}${sentence}`];
  const tokens = words(sentence);
  const continuation = " ".repeat(indent.length + extra);
  const lines: string[] = [];
  let current = head;
  let currentIsHead = true;
  let lastConnective = -1;
  let filled: string[] = [];
  const flush = () => {
    lines.push(current + filled.join(" "));
    current = continuation;
    currentIsHead = false;
    filled = [];
    lastConnective = -1;
  };
  for (const token of tokens) {
    const candidate = [...filled, token].join(" ");
    if (filled.length > 0 && current.length + candidate.length > width) {
      if (CONNECTIVES.has(token) || lastConnective <= 0) {
        // Break right before this token: it is a connective, or nothing better precedes it.
        flush();
      } else {
        // Break before the last connective seen on this line.
        const carried = filled.slice(lastConnective);
        filled = filled.slice(0, lastConnective);
        flush();
        filled = carried;
      }
    }
    if (CONNECTIVES.has(token) && filled.length > 0) lastConnective = filled.length;
    filled.push(token);
  }
  if (filled.length > 0 || currentIsHead) lines.push(current + filled.join(" "));
  return lines;
}
