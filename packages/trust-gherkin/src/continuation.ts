/* Step continuation lines.

   Standard Gherkin keeps one step on one physical line, which makes long TRUST sentences hard to read.
   TRUST lets a step continue on the following lines when they are indented deeper than the step keyword
   and are not something else Gherkin knows (table row, doc string, comment, tag, keyword line):

       When Shell "status" runs "git" with cwd
           from Environment "workspaceRoot" and Input "project"

   Before parsing, continuation lines are appended to their step with one space and replaced by blank
   lines, so every location Gherkin reports still points at the physical source. Ranges that fall
   inside the continued text are resolved back to the physical line that holds them. */

const KEYWORD_LINE = /^(?:Feature|Ability|Business Need|Background|Rule|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios):|^(?:Given|When|Then|And|But|\*)\s/u;
const STEP_LINE = /^(?:Given|When|Then|And|But|\*)\s/u;

export function splitLines(source: string): string[] {
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** True when `line` continues a step whose keyword is indented at `stepIndent`. */
export function isContinuationLine(line: string, stepIndent: number): boolean {
  const text = line.trimStart();
  if (text.length === 0 || indentOf(line) <= stepIndent) return false;
  if (text.startsWith("|") || text.startsWith('"""') || text.startsWith("```") || text.startsWith("#") || text.startsWith("@")) return false;
  return !KEYWORD_LINE.test(text);
}

/** Zero-based indexes of the lines continuing the step at `stepIndex` (contiguous, in order). */
export function continuationLineIndexes(lines: readonly string[], stepIndex: number): number[] {
  const step = lines[stepIndex];
  if (step === undefined || !STEP_LINE.test(step.trimStart())) return [];
  const indent = indentOf(step);
  const result: number[] = [];
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    if (!isContinuationLine(lines[index]!, indent)) break;
    result.push(index);
  }
  return result;
}

/** The parser input: continuation lines folded into their step, line count and other lines unchanged. */
export function joinContinuations(source: string): string {
  const lines = splitLines(source);
  let index = 0;
  let fence: string | undefined;
  while (index < lines.length) {
    const text = lines[index]!.trimStart();
    if (fence !== undefined) {
      if (text.startsWith(fence)) fence = undefined;
      index += 1;
      continue;
    }
    if (text.startsWith('"""') || text.startsWith("```")) {
      fence = text.slice(0, 3);
      index += 1;
      continue;
    }
    const continued = continuationLineIndexes(lines, index);
    if (continued.length === 0) {
      index += 1;
      continue;
    }
    lines[index] = [lines[index]!.trimEnd(), ...continued.map((at) => lines[at]!.trim())].join(" ");
    for (const at of continued) lines[at] = "";
    index = continued[continued.length - 1]! + 1;
  }
  return lines.join("\n");
}
