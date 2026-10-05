import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";
import { test } from "./support/fixtures.js";
import { startPublicRuntime } from "./support/runtime-process.js";

const LISTEN_TIMEOUT_MS = 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const runtimeEntry = path.join(packageRoot, "dist/src/index.js");
const contentRoot = path.join(repositoryRoot, "packages/trust-ui/src/docs/content");
const operationSource = path.join(repositoryRoot, "assets/operations/git.head-read.feature");
/** The reference page of the controlled language, below the language of the documentation. */
const REFERENCE_PAGE = "language/procedures/controlled-language.mdx";
const LANGUAGES = ["en", "fr"] as const;

/** The fields that each rule controls, as the controlled language engine defines them. */
const RULE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "structure.sentence-length": [
    "authorized",
    "forbidden",
    "success-reason",
    "failure-reason",
    "definition",
    "next-intent",
    "blocking-reason",
    "forbidden-further-action",
  ],
  "structure.semicolon": [
    "authorized",
    "forbidden",
    "success-reason",
    "failure-reason",
    "check-name",
    "role-name",
    "definition",
    "next-intent",
    "blocking-reason",
    "forbidden-further-action",
  ],
  "structure.single-sentence": [
    "success-reason",
    "failure-reason",
    "definition",
    "next-intent",
    "forbidden-further-action",
  ],
  "structure.name-length": ["check-name", "role-name"],
  "lexical.rejected-word": [
    "authorized",
    "forbidden",
    "success-reason",
    "failure-reason",
    "check-name",
    "role-name",
    "next-intent",
    "blocking-reason",
    "forbidden-further-action",
  ],
};

interface Runtime {
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

interface LanguageDiagnostic {
  readonly rule: string;
  readonly field: string;
  readonly message: string;
  readonly location: { readonly line: number; readonly column: number };
}

interface RpcEnvelope {
  readonly result?: Record<string, unknown>;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: {
      readonly reason?: string;
      readonly message?: string;
      readonly diagnostics?: readonly LanguageDiagnostic[];
    };
  };
}

interface Fence {
  readonly line: number;
  readonly language: string;
  readonly meta: string;
  readonly code: string;
}

interface RuleRow {
  readonly rule: string;
  readonly fields: readonly string[];
  readonly refusedField: string;
  readonly refusedExample: string;
}

let runtime: Runtime;

beforeAll(async () => {
  runtime = await startRuntime();
});

afterAll(async () => {
  await runtime?.close();
});

test("LANG-080 AC1 a reference page gives the vocabulary grammar and the Procedure tag and its marked examples compile", async () => {
  const page = await readPage("en", REFERENCE_PAGE);
  assert.match(page, /^title: "Controlled language"$/m);
  assert.match(page, /\| `@controlled-language` \| `structure` \|/, "the tag alone gives the structure level");
  assert.match(
    page,
    /\| `@controlled-language:<vocabulary>` \| `lexical` \|/,
    "the tag with a vocabulary name gives the lexical level",
  );

  const fences = pageFences(page);
  const grammar = fences.find(
    (fence) => fence.language === "gherkin" && fence.meta === "fragment" && fence.code.includes("@vocabulary:<slug>"),
  );
  assert.ok(grammar, "the page gives the vocabulary grammar");
  for (const line of [
    "@trust-dsl:1 @vocabulary:<slug> @version:<x.y.z>",
    "Feature: <title>",
    "Background: <name>",
    "Given Terms",
    "| term | kind | definition |",
    "| <term> | noun|verb | <definition> |",
    "[And Rejected words",
    "| word | use |",
  ])
    assert.ok(grammar.code.includes(line), `the vocabulary grammar holds "${line}"`);

  const vocabularies = marked(fences, "vocabulary");
  const structure = marked(fences, "procedure");
  const lexical = marked(fences, "lexical");
  assert.ok(vocabularies.length > 0, "the page has a marked vocabulary example");
  assert.ok(structure.length > 0, "the page has a marked structure level example");
  assert.ok(lexical.length > 0, "the page has a marked lexical level example");

  for (const fence of vocabularies) {
    const compiled = await rpc("vocabulary.compile", { source: fence.code, sourceName: sourceName(fence) });
    assert.equal(compiled.error, undefined, `${sourceName(fence)}: ${JSON.stringify(compiled.error)}`);
    const published = await rpc("vocabulary.publish", { source: fence.code, sourceName: sourceName(fence) });
    assert.equal(published.error, undefined, `${sourceName(fence)}: ${JSON.stringify(published.error)}`);
  }
  for (const fence of structure) {
    const compiled = await rpc("procedure.compile", { source: fence.code, sourceName: sourceName(fence) });
    assert.equal(compiled.error, undefined, `${sourceName(fence)}: ${JSON.stringify(compiled.error)}`);
    assert.deepEqual(compiled.result?.controlledLanguage, { level: "structure" });
  }
  for (const fence of lexical) {
    const compiled = await rpc("procedure.compile", { source: fence.code, sourceName: sourceName(fence) });
    assert.equal(compiled.error, undefined, `${sourceName(fence)}: ${JSON.stringify(compiled.error)}`);
    const language = compiled.result?.controlledLanguage as {
      readonly level: string;
      readonly vocabularies: readonly { readonly vocabulary: string; readonly version: string }[];
    };
    assert.equal(language.level, "lexical");
    assert.deepEqual(
      language.vocabularies.map(({ vocabulary, version }) => `${vocabulary}@${version}`),
      ["trust-base@1.0.0", "delivery-terms@1.0.0"],
    );
  }
});

test("LANG-080 AC2 each rule is listed with its identifier, the fields it controls and a refused example", async () => {
  await publishMarkedVocabularies();
  for (const language of LANGUAGES) {
    const page = await readPage(language, REFERENCE_PAGE);
    const rows = ruleRows(page);
    assert.deepEqual(
      rows.map(({ rule }) => rule).sort(),
      Object.keys(RULE_FIELDS).sort(),
      `${language}: the rules table lists each rule once`,
    );
    const fences = pageFences(page);
    const [structure] = marked(fences, "procedure");
    const [lexical] = marked(fences, "lexical");
    assert.ok(structure && lexical, `${language}: the page has both marked Procedure examples`);
    for (const row of rows) {
      assert.deepEqual(
        [...row.fields].sort(),
        [...(RULE_FIELDS[row.rule] ?? [])].sort(),
        `${language}: the fields that ${row.rule} controls`,
      );
      assert.ok(row.fields.includes(row.refusedField), `${language}: ${row.rule} controls ${row.refusedField}`);
      const example = row.rule.startsWith("lexical.") ? lexical : structure;
      const source = withField(example.code, row.refusedField, row.refusedExample);
      const refused = await rpc("procedure.compile", { source, sourceName: `${row.rule}.feature` });
      assert.equal(refused.result, undefined, `${language}: ${row.rule} refuses its example`);
      assert.equal(refused.error?.data?.reason, "controlled-language", JSON.stringify(refused.error));
      const diagnostics = refused.error?.data?.diagnostics ?? [];
      assert.ok(diagnostics.length > 0, `${language}: ${row.rule} gives diagnostics`);
      for (const diagnostic of diagnostics) {
        assert.equal(diagnostic.rule, row.rule, `${language}: ${row.rule} example: ${JSON.stringify(diagnostic)}`);
        assert.equal(diagnostic.field, row.refusedField, `${language}: ${row.rule} example field`);
        assert.ok(diagnostic.location.line > 0, `${language}: ${row.rule} diagnostic has a line`);
      }
    }
  }
});

test("LANG-080 AC3 the pages exist in English and in French with the same code blocks", async () => {
  const english = path.join(contentRoot, "en", REFERENCE_PAGE);
  const french = path.join(contentRoot, "fr", REFERENCE_PAGE);
  assert.ok(existsSync(english), "the English reference page exists");
  assert.ok(existsSync(french), "the French reference page exists");
  const englishPage = await readFile(english, "utf8");
  const frenchPage = await readFile(french, "utf8");
  assert.notEqual(title(frenchPage), title(englishPage), "the French page has a translated title");
  assert.deepEqual(
    pageFences(frenchPage).map(({ language, meta, code }) => ({ language, meta, code })),
    pageFences(englishPage).map(({ language, meta, code }) => ({ language, meta, code })),
    "the French reference page has the same code blocks",
  );

  const problems: string[] = [];
  for (const file of await mdxFiles(path.join(contentRoot, "en"))) {
    const relative = path.relative(path.join(contentRoot, "en"), file);
    const translation = path.join(contentRoot, "fr", relative);
    if (!existsSync(translation)) {
      problems.push(`${relative}: no French page`);
      continue;
    }
    const sources = (text: string) =>
      pageFences(text)
        .filter(({ language }) => language !== "mermaid")
        .map(({ code }) => code);
    const englishSources = sources(await readFile(file, "utf8"));
    const frenchSources = sources(await readFile(translation, "utf8"));
    if (englishSources.length !== frenchSources.length)
      problems.push(`${relative}: ${englishSources.length} code blocks in English, ${frenchSources.length} in French`);
    englishSources.forEach((source, index) => {
      if (frenchSources[index] !== source) problems.push(`${relative}: code block #${index + 1} differs`);
    });
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

/** Publish the marked vocabulary examples of the English reference page; the same source publishes again. */
async function publishMarkedVocabularies(): Promise<void> {
  for (const fence of marked(pageFences(await readPage("en", REFERENCE_PAGE)), "vocabulary")) {
    const published = await rpc("vocabulary.publish", { source: fence.code, sourceName: sourceName(fence) });
    assert.equal(published.error, undefined, JSON.stringify(published.error));
  }
}

/** The rows of the rules table: rule identifier, controlled fields, refused field and refused example. */
function ruleRows(page: string): readonly RuleRow[] {
  const rows: RuleRow[] = [];
  for (const line of page.split("\n")) {
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    const rule = /^`((?:structure|lexical)\.[a-z-]+)`$/.exec(cells[0] ?? "")?.[1];
    if (!rule || cells.length !== 4) continue;
    const fields = [...(cells[1] ?? "").matchAll(/`([a-z-]+)`/g)].map((match) => match[1] ?? "");
    const refusedField = /^`([a-z-]+)`$/.exec(cells[2] ?? "")?.[1];
    const refusedExample = /^`([^`]+)`$/.exec(cells[3] ?? "")?.[1];
    assert.ok(refusedField, `the refused field of ${rule}`);
    assert.ok(refusedExample, `the refused example of ${rule}`);
    rows.push({ rule, fields, refusedField, refusedExample });
  }
  return rows;
}

/** The example Procedure with one prose field replaced by another text. */
function withField(source: string, field: string, text: string): string {
  const replace = (pattern: RegExp, replacement: (match: string, ...groups: string[]) => string): string => {
    assert.match(source, pattern, `the example has a ${field} field`);
    return source.replace(pattern, replacement);
  };
  switch (field) {
    case "authorized":
      return replace(/^(\s*\| all \| )([^|]+?)( \|)/m, (_match, start, _value, end) => `${start}${text}${end}`);
    case "forbidden":
      return replace(
        /^(\s*\| all \| [^|]+? \| )([^|]+?)( \|)/m,
        (_match, start, _value, end) => `${start}${text}${end}`,
      );
    case "success-reason":
      return replace(/(must establish ")([^"]+)(")/, (_match, start, _value, end) => `${start}${text}${end}`);
    case "failure-reason":
      return replace(/(fail\(")([^"]+)("\))/, (_match, start, _value, end) => `${start}${text}${end}`);
    case "check-name":
      return replace(/(Check ")([^"]+)(" runs)/, (_match, start, _value, end) => `${start}${text}${end}`);
    default:
      throw new Error(`The documented refused field ${field} has no place in the example Procedure`);
  }
}

function marked(fences: readonly Fence[], kind: string): readonly Fence[] {
  return fences.filter((fence) => fence.language === "gherkin" && fence.meta.split(/\s+/)[0] === kind);
}

function sourceName(fence: Fence): string {
  return `${REFERENCE_PAGE}:${fence.line}.feature`;
}

function pageFences(text: string): readonly Fence[] {
  return [...text.matchAll(/^```(\w+)([^\n]*)\n([\s\S]*?)^```/gm)].map((match) => ({
    line: text.slice(0, match.index).split("\n").length,
    language: match[1] ?? "",
    meta: (match[2] ?? "").trim(),
    code: match[3] ?? "",
  }));
}

function title(page: string): string {
  return /^title: "([^"]+)"$/m.exec(page)?.[1] ?? "";
}

async function readPage(language: string, page: string): Promise<string> {
  return readFile(path.join(contentRoot, language, page), "utf8");
}

async function mdxFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await mdxFiles(full)));
    else if (entry.name.endsWith(".mdx")) files.push(full);
  }
  return files.sort();
}

async function rpc(method: string, params: Readonly<Record<string, unknown>>): Promise<RpcEnvelope> {
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  return (await response.json()) as RpcEnvelope;
}

async function startRuntime(): Promise<Runtime> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "trust-controlled-documentation-"));
  const operationsDirectory = path.join(dataDirectory, "operations");
  await mkdir(operationsDirectory);
  await cp(operationSource, path.join(operationsDirectory, path.basename(operationSource)));
  const started = await startPublicRuntime("trust-controlled-documentation-", { operationsDirectory });
  return {
    endpoint: started.endpoint,
    close: async () => {
      await started.close();
      await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
