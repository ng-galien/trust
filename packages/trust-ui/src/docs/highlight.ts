/* Static syntax colouring for documentation snippets — the same token classes as the Monaco theme
   (`--color-editor-*`), computed once at render, no editor instance. Languages: gherkin (TRUST DSL,
   JSONata doc strings included), json, jsonata, shell and plain text. */

export type TokenClass = "comment" | "tag" | "keyword" | "keyword-control" | "title" | "type" | "verb" | "string" | "number" | "delimiter" | "table-header" | "table-cell" | "function" | "root" | "operator" | "variable" | "";

export interface Token { text: string; cls: TokenClass }
export type Line = Token[];

const CELL_TYPES = new Set(["string", "number", "instant", "reference", "directory", "url", "one", "many", "literal", "any", "JSON", "Text"]);
const TYPES = /^(Environment|Input|Produced fields|Shell|File|HTTP|Check|Plan input|Operation|Plan context)\b/;
const VERBS = /^(runs|with cwd from|accepts exits|gets|appending|posts|as JSON to|as|from|reads|and reads|and Input|and materializes|and must establish|Produce with JSONata|runs Operation|on each|on all|on|using all|using|is validated|is satisfied when every Check is validated|declared by agent for|for each|for|fixed as|scenario|must establish|equals|at least|has at least|is in|before|after|value|number|valid rfc3339|context|field|from Check|failure reason)\b/;

export function highlight(code: string, language: string): Line[] {
  const lines = code.replace(/\n$/, "").split("\n");
  switch (language) {
    case "gherkin":
      return highlightGherkin(lines);
    case "json":
    case "jsonata":
      return lines.map((line) => tokenizeExpression(line));
    case "shell":
    case "bash":
    case "sh":
      return lines.map((line) => tokenizeShell(line));
    default:
      return lines.map((line) => [{ text: line, cls: "" }]);
  }
}

function highlightGherkin(lines: string[]): Line[] {
  const out: Line[] = [];
  let inDoc = false;
  let tableHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inDoc) {
      if (/^"""\s*$/.test(trimmed) || /^```\s*$/.test(trimmed)) { inDoc = false; out.push([{ text: line, cls: "string" }]); continue; }
      out.push(tokenizeExpression(line));
      continue;
    }
    if (/^"""\s*$/.test(trimmed) || /^```\s*$/.test(trimmed)) { inDoc = true; tableHeader = false; out.push([{ text: line, cls: "string" }]); continue; }
    if (trimmed.startsWith("|")) {
      out.push(tokenizeTableRow(line, tableHeader));
      tableHeader = false;
      continue;
    }
    tableHeader = true;
    if (trimmed.startsWith("#")) { out.push([{ text: line, cls: "comment" }]); continue; }
    if (trimmed.startsWith("@")) {
      out.push(splitTokens(line, /(@[\w.:-]+)/g, (part) => (part.startsWith("@") ? "tag" : "")));
      continue;
    }
    const section = /^(\s*)(Feature|Background|Scenario Outline|Scenario|Rule|Examples)(:)(.*)$/.exec(line);
    if (section) {
      out.push([{ text: section[1]!, cls: "" }, { text: section[2]!, cls: "keyword-control" }, { text: ":", cls: "delimiter" }, { text: section[4]!, cls: "title" }]);
      continue;
    }
    const step = /^(\s*)(Given|When|Then|And|But)(\b.*)$/.exec(line);
    if (step) {
      out.push([{ text: step[1]!, cls: "" }, { text: step[2]!, cls: "keyword" }, ...tokenizeSentence(step[3]!)]);
      continue;
    }
    // Continuation lines and free description text.
    out.push(/^\s{2,}\S/.test(line) && out.length && out[out.length - 1]!.some((token) => token.cls === "keyword") ? tokenizeSentence(line) : [{ text: line, cls: "" }]);
  }
  return out;
}

function tokenizeSentence(text: string): Line {
  const tokens: Line = [];
  let rest = text;
  while (rest.length) {
    const space = /^\s+/.exec(rest);
    if (space) { tokens.push({ text: space[0], cls: "" }); rest = rest.slice(space[0].length); continue; }
    const quoted = /^"[^"]*"/.exec(rest);
    if (quoted) { tokens.push({ text: quoted[0], cls: "string" }); rest = rest.slice(quoted[0].length); continue; }
    const type = TYPES.exec(rest);
    if (type) { tokens.push({ text: type[0], cls: "type" }); rest = rest.slice(type[0].length); continue; }
    const verb = VERBS.exec(rest);
    if (verb) { tokens.push({ text: verb[0], cls: "verb" }); rest = rest.slice(verb[0].length); continue; }
    const number = /^\d+(?:\.\d+)?\b/.exec(rest);
    if (number) { tokens.push({ text: number[0], cls: "number" }); rest = rest.slice(number[0].length); continue; }
    const placeholder = /^<[^>]+>/.exec(rest);
    if (placeholder) { tokens.push({ text: placeholder[0], cls: "variable" }); rest = rest.slice(placeholder[0].length); continue; }
    const word = /^[^\s"<]+/.exec(rest);
    tokens.push({ text: word ? word[0] : rest[0]!, cls: "" });
    rest = rest.slice(word ? word[0].length : 1);
  }
  return tokens;
}

function tokenizeTableRow(line: string, header: boolean): Line {
  const tokens: Line = [];
  const parts = line.split("|");
  parts.forEach((part, index) => {
    if (index > 0) tokens.push({ text: "|", cls: "delimiter" });
    if (!part) return;
    if (header) { tokens.push({ text: part, cls: "table-header" }); return; }
    tokens.push(...splitTokens(part, /("[^"]*"|\b\d+(?:\.\d+)?\b|\benum\b|[A-Za-z][\w-]*)/g, (word) => {
      if (word.startsWith("\"")) return "string";
      if (/^\d/.test(word)) return "number";
      if (word === "enum") return "verb";
      return CELL_TYPES.has(word) ? "type" : "table-cell";
    }));
  });
  return tokens;
}

function tokenizeExpression(line: string): Line {
  return splitTokens(line, /("[^"\\]*(?:\\.[^"\\]*)*"|\$[a-zA-Z]+|\b(?:input|environment|steps)\b|\b(?:true|false|null)\b|\b\d+(?:\.\d+)?\b|[{}[\]()]|[?:=<>!&|+\-*/%]+|[A-Za-z_]\w*)/g, (word, next) => {
    if (word.startsWith("\"")) return /^\s*:/.test(next) ? "table-cell" : "string";
    if (word.startsWith("$")) return "function";
    if (word === "input" || word === "environment" || word === "steps") return "root";
    if (word === "true" || word === "false" || word === "null") return "keyword";
    if (/^\d/.test(word)) return "number";
    if (/^[{}[\]()]$/.test(word)) return "delimiter";
    if (/^[?:=<>!&|+\-*/%]+$/.test(word)) return "operator";
    return "";
  });
}

function tokenizeShell(line: string): Line {
  if (line.trim().startsWith("#")) return [{ text: line, cls: "comment" }];
  return splitTokens(line, /("[^"]*"|'[^']*'|\s--?[\w-]+|\$\w+|\|)/g, (word) => {
    if (word.startsWith("\"") || word.startsWith("'")) return "string";
    if (word.startsWith("$")) return "variable";
    if (word === "|") return "operator";
    return word.trim().startsWith("-") ? "verb" : "";
  });
}

function splitTokens(text: string, pattern: RegExp, classify: (match: string, next: string) => TokenClass): Line {
  const tokens: Line = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) tokens.push({ text: text.slice(last, at), cls: "" });
    tokens.push({ text: match[0], cls: classify(match[0], text.slice(at + match[0].length)) });
    last = at + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), cls: "" });
  return tokens;
}
