import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll } from "vitest";
import { test } from "./support/fixtures.js";

const LISTEN_TIMEOUT_MS = 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");
const runtimeEntry = path.join(packageRoot, "dist/src/index.js");
const fixtures = path.join(packageRoot, "acceptance/fixtures/controlled-language");
const documentationMessages = path.resolve(packageRoot, "../trust-ui/src/i18n");

const BASE = "trust-base";
const BASE_VERSION = "1.0.0";

/** The terms of the TRUST languages that the base vocabulary completes, with the meaning their definition must carry. */
const LANGUAGE_TERMS: ReadonlyArray<readonly [term: string, meaning: RegExp]> = [
  ["Feature", /^The Gherkin block that defines one Operation, Procedure or vocabulary\b.*\btags\b.*\bidentity\b/],
  ["Background", /\bblock of a Feature\b.*\binterface of an Operation\b.*\bscope and roles of a Procedure\b/],
  ["Produce", /^The last step of every Operation\b.*\bJSONata\b.*\bProduced fields\b/],
  ["Shell step", /^A step that runs one executable\b.*\bEnvironment directory\b.*\bexit codes\b/],
  ["HTTP step", /^A step that sends one registered HTTP method to an Environment URL\b/],
  ["File step", /^A step that reads one file at a fixed relative path below an Environment directory\b/],
  ["cardinality", /\bone value of its type or a collection of that type\b/],
  ["prerequisite", /^A Scenario that must be validated before\b.*\banother Scenario\b/],
];

interface Runtime {
  readonly endpoint: string;
  readonly stop: () => Promise<void>;
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
      readonly contract?: string;
      readonly reason?: string;
      readonly message?: string;
      readonly location?: { readonly line: number; readonly column: number } | null;
      readonly diagnostics?: readonly LanguageDiagnostic[];
    };
  };
}

interface VocabularyTerm {
  readonly term: string;
  readonly kind: string;
  readonly definition: string;
}

interface VocabularyDefinition {
  readonly vocabulary: string;
  readonly version: string;
  readonly definitionDigest: string;
  readonly terms: readonly VocabularyTerm[];
  readonly rejectedWords: readonly { readonly word: string; readonly use: string }[];
}

interface LookupTerm extends VocabularyTerm {
  readonly vocabulary: string;
  readonly version: string;
}

interface Lookup {
  readonly word: string;
  readonly terms: readonly LookupTerm[];
  readonly rejectedWords: readonly {
    readonly vocabulary: string;
    readonly word: string;
    readonly use: string;
    readonly term?: LookupTerm;
  }[];
}

interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
}

let dataDirectory: string;
let runtime: Runtime;

beforeAll(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "trust-base-completion-"));
  await cp(path.join(fixtures, "operations"), path.join(dataDirectory, "operations"), { recursive: true });
  await mkdir(path.join(dataDirectory, "workspace"));
  runtime = await startRuntime();
});

afterAll(async () => {
  await runtime?.stop();
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5 });
});

test("LANG-150 AC1 the base vocabulary declares Feature, Background, Produce, Shell step, HTTP step, File step, cardinality and prerequisite", async () => {
  const base = await readBase();
  assert.equal(base.version, BASE_VERSION);
  for (const [term, meaning] of LANGUAGE_TERMS) {
    const found = base.terms.filter((entry) => entry.term.toLowerCase() === term.toLowerCase());
    assert.equal(found.length, 1, `term "${term}"`);
    assert.equal(found[0]?.term, term);
    assert.equal(found[0]?.kind, "noun", `kind of "${term}"`);
    const definition = found[0]?.definition ?? "";
    assert.match(definition, meaning, `definition of "${term}"`);
    assert.ok(definition.split(/\s+/u).length <= 25, `definition of "${term}" has more than 25 words`);
    assert.equal(definition.split(/(?<=[.?!])\s+/u).length, 1, `definition of "${term}" is one sentence`);

    const lookup = (await rpcResult("vocabulary.lookup", { word: term.toUpperCase() })) as unknown as Lookup;
    assert.deepEqual(lookup.terms, [{ vocabulary: BASE, version: BASE_VERSION, ...found[0] }], `lookup of "${term}"`);
    const tool = await mcp("trust_vocabulary_lookup", { word: term });
    assert.equal(tool.isError, false, tool.text);
    assert.ok(tool.text.includes(definition), `MCP lookup of "${term}"\n${tool.text}`);
  }

  for (const [term] of LANGUAGE_TERMS) {
    const refused = await rpc("vocabulary.compile", {
      source: vocabulary({
        terms: [["repository", "noun", "A store of files with their version history."]],
        rejected: [[term.toLowerCase(), "repository"]],
      }),
      sourceName: "domain.feature",
    });
    assert.equal(refused.result, undefined, term);
    assert.equal(refused.error?.data?.reason, "base-vocabulary-conflict", JSON.stringify(refused.error));
    assert.match(
      refused.error?.data?.message ?? "",
      new RegExp(`is the term "${term}" of the base vocabulary ${BASE}`),
    );
  }
});

test("LANG-150 AC2 a rejected word of a domain vocabulary can name a term of the base vocabulary", async () => {
  const source = vocabulary({
    name: "release-terms",
    terms: [["repository", "noun", "A store of files with their version history."]],
    rejected: [
      ["repo", "repository"],
      ["precondition", "prerequisite"],
      ["job", "operation"],
      ["build stage", "Shell step"],
    ],
  });
  const compiled = await rpc("vocabulary.compile", { source, sourceName: "release-terms.feature" });
  assert.equal(compiled.error, undefined, JSON.stringify(compiled.error));
  const published = await rpc("vocabulary.publish", { source, sourceName: "release-terms.feature" });
  assert.equal(published.error, undefined, JSON.stringify(published.error));
  const domain = (published.result as unknown as { vocabulary: VocabularyDefinition }).vocabulary;
  assert.deepEqual(
    domain.terms.map(({ term }) => term),
    ["repository"],
  );
  assert.deepEqual(domain.rejectedWords, [
    { word: "repo", use: "repository" },
    { word: "precondition", use: "prerequisite" },
    { word: "job", use: "Operation" },
    { word: "build stage", use: "Shell step" },
  ]);

  const base = await readBase();
  const prerequisite = base.terms.find(({ term }) => term === "prerequisite");
  assert.ok(prerequisite);
  const lookup = (await rpcResult("vocabulary.lookup", {
    word: "Precondition",
    vocabulary: "release-terms",
  })) as unknown as Lookup;
  assert.deepEqual(lookup.terms, []);
  assert.deepEqual(lookup.rejectedWords, [
    {
      vocabulary: "release-terms",
      version: "1.0.0",
      word: "precondition",
      use: "prerequisite",
      term: { vocabulary: BASE, version: BASE_VERSION, ...prerequisite },
    },
  ]);
  const tool = await mcp("trust_vocabulary_lookup", { word: "precondition", vocabulary: "release-terms" });
  assert.equal(tool.isError, false, tool.text);
  assert.ok(tool.text.includes(prerequisite.definition), tool.text);

  const diagnostics = await rejectedDiagnostics(
    procedure({
      authorized: "Check the precondition first.",
      forbidden: "Start the job twice.",
      successReason: "the build stage completed",
    }),
  );
  assert.deepEqual(
    diagnostics.map(({ location, field, rule, message }) => [
      location.line,
      field,
      rule,
      /rejected word "([^"]+)"/.exec(message)?.[1],
      /Use the term "([^"]+)"/.exec(message)?.[1],
    ]),
    [
      [8, "authorized", "lexical.rejected-word", "precondition", "prerequisite"],
      [8, "forbidden", "lexical.rejected-word", "job", "Operation"],
      [13, "success-reason", "lexical.rejected-word", "build stage", "Shell step"],
    ],
  );
  const clean = await rpc("procedure.compile", { source: procedure({}), sourceName: "release.feature" });
  assert.equal(clean.error, undefined, JSON.stringify(clean.error));

  const unknown = await rpc("vocabulary.compile", {
    source: vocabulary({ rejected: [["precondition", "requirement"]] }),
    sourceName: "unknown.feature",
  });
  assert.equal(unknown.result, undefined);
  assert.equal(unknown.error?.data?.reason, "unknown-term", JSON.stringify(unknown.error));
  assert.match(unknown.error?.data?.message ?? "", /"requirement"/);
  const baseWord = await rpc("vocabulary.compile", {
    source: vocabulary({ rejected: [["intention", "prerequisite"]] }),
    sourceName: "base-word.feature",
  });
  assert.equal(baseWord.error?.data?.reason, "base-vocabulary-conflict", JSON.stringify(baseWord.error));
});

test("LANG-150 AC3 the English glossary gives the base vocabulary definition for each common term and the French glossary has the same terms", async () => {
  const base = await readBase();
  const english = await glossary("en");
  const french = await glossary("fr");

  const common = Object.entries(english).flatMap(([id, entry]) => {
    const term = base.terms.find((candidate) => candidate.term.toLowerCase() === entry.term.toLowerCase());
    return term === undefined ? [] : [{ id, entry, term }];
  });
  assert.ok(common.length >= 28, `common terms: ${common.map(({ id }) => id).join(", ")}`);
  for (const { id, entry, term } of common)
    assert.equal(entry.definition, term.definition, `English glossary definition of "${id}"`);
  for (const id of ["delegation", "grant", "intent", "fact"])
    assert.ok(
      common.some((candidate) => candidate.id === id),
      `"${id}" is a common term`,
    );

  assert.deepEqual(Object.keys(french).sort(), Object.keys(english).sort());
  for (const { id, entry } of common) {
    const translated = french[id];
    assert.ok(translated, `French glossary entry "${id}"`);
    assert.ok(translated.term.trim().length > 0, `French term "${id}"`);
    assert.ok(translated.definition.trim().length > 0, `French definition "${id}"`);
    assert.notEqual(translated.definition, entry.definition, `French definition of "${id}" is a translation`);
  }
});

/** The glossary entries of one documentation language, keyed by their term identifier. */
async function glossary(language: "en" | "fr"): Promise<Readonly<Record<string, GlossaryEntry>>> {
  const module = (await import(pathToFileURL(path.join(documentationMessages, language, "docs.ts")).href)) as {
    docs: { glossary: Readonly<Record<string, unknown>> };
  };
  const entries: Record<string, GlossaryEntry> = {};
  for (const [id, value] of Object.entries(module.docs.glossary)) {
    if (id === "label") continue;
    const entry = value as GlossaryEntry;
    assert.equal(typeof entry.term, "string", `${language} glossary term "${id}"`);
    assert.equal(typeof entry.definition, "string", `${language} glossary definition "${id}"`);
    entries[id] = entry;
  }
  return entries;
}

async function readBase(): Promise<VocabularyDefinition> {
  const read = await rpcResult("vocabulary.read", { vocabulary: BASE, version: BASE_VERSION });
  return (read as unknown as { vocabulary: VocabularyDefinition }).vocabulary;
}

interface ProseFields {
  readonly authorized: string;
  readonly forbidden: string;
  readonly successReason: string;
}

/** A Procedure tagged with the release-terms vocabulary. Lines: 2 tags, 8 scope row, 13 Check and success reason. */
function procedure(fields: Partial<ProseFields>): string {
  const value: ProseFields = {
    authorized: "Check the prerequisite first.",
    forbidden: "Start the Operation twice.",
    successReason: "the Shell step completed",
    ...fields,
  };
  return `# language: en
@trust-dsl:1 @procedure:base-completion @version:1.0.0 @controlled-language:release-terms
Feature: Control the prose words of a Procedure

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | ${value.authorized} | ${value.forbidden} |
    And one string "request" fixed as "run"

  @scenario:execute
  Scenario: Execute the Operation
    Then Check "confirm run" runs Operation "test.language-check@*" on "request" as Input "request" and must establish "${value.successReason}"
      """js
      fact.completed === "yes" || fail("the Operation did not complete")
      """
`;
}

function vocabulary(options: {
  readonly name?: string;
  readonly terms?: readonly (readonly [string, string, string])[];
  readonly rejected?: readonly (readonly [string, string])[];
}): string {
  const terms = options.terms ?? [["repository", "noun", "A store of files with their version history."]];
  const rejected = options.rejected ?? [];
  return [
    "# language: en",
    `@trust-dsl:1 @vocabulary:${options.name ?? "domain-terms"} @version:1.0.0`,
    "Feature: Domain terms",
    "",
    "  Background: Vocabulary",
    "    Given Terms",
    "      | term | kind | definition |",
    ...terms.map(([term, kind, definition]) => `      | ${term} | ${kind} | ${definition} |`),
    ...(rejected.length === 0
      ? []
      : [
          "    And Rejected words",
          "      | word | use |",
          ...rejected.map(([word, use]) => `      | ${word} | ${use} |`),
        ]),
    "",
  ].join("\n");
}

async function rejectedDiagnostics(source: string): Promise<readonly LanguageDiagnostic[]> {
  const envelope = await rpc("procedure.compile", { source, sourceName: "language.feature" });
  assert.equal(envelope.result, undefined, "the tagged Procedure must be rejected");
  assert.equal(envelope.error?.data?.reason, "controlled-language", JSON.stringify(envelope.error));
  return envelope.error?.data?.diagnostics ?? [];
}

async function rpcResult(method: string, params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const envelope = await rpc(method, params);
  assert.equal(envelope.error, undefined, `${method}: ${JSON.stringify(envelope.error)}`);
  assert.ok(envelope.result, method);
  return envelope.result;
}

async function rpc(method: string, params: Readonly<Record<string, unknown>>): Promise<RpcEnvelope> {
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  return (await response.json()) as RpcEnvelope;
}

async function mcp(name: string, args: Readonly<Record<string, unknown>>): Promise<{ text: string; isError: boolean }> {
  const response = await fetch(`${runtime.endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const envelope = (await response.json()) as {
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    error?: unknown;
  };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return { text: text ?? "", isError: envelope.result?.isError === true };
}

/** An isolated runtime over the disposable store of this file. */
async function startRuntime(): Promise<Runtime> {
  const environment: Record<string, string | undefined> = { ...process.env };
  delete environment.TRUST_DATABASE_PATH;
  delete environment.TRUST_DATABASE_URL;
  delete environment.TRUST_PGLITE_DIRECTORY;
  const child = spawn(process.execPath, [runtimeEntry], {
    env: {
      ...environment,
      TRUST_HOST: "127.0.0.1",
      TRUST_PORT: "0",
      TRUST_STORAGE: "pglite",
      TRUST_PGLITE_DIRECTORY: path.join(dataDirectory, "pglite"),
      TRUST_OPERATIONS_DIRECTORY: path.join(dataDirectory, "operations"),
      TRUST_CREDENTIAL_KEY_FILE: path.join(dataDirectory, "credential.key"),
    },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  };
  try {
    return { endpoint: await listeningEndpoint(child, () => stderr), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function listeningEndpoint(child: ChildProcessWithoutNullStreams, stderr: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`TRUST runtime did not listen within ${LISTEN_TIMEOUT_MS} ms. stderr=${stderr()}`));
    }, LISTEN_TIMEOUT_MS);
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      const match = /TRUST runtime listening on (127\.0\.0\.1):(\d+)/.exec(stdout);
      if (!match) return;
      cleanup();
      resolve(`http://${match[1]}:${match[2]}`);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`TRUST runtime stopped before listening (code=${String(code)}). stderr=${stderr()}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.once("exit", onExit);
  });
}
