import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";
import { test } from "./support/fixtures.js";

const LISTEN_TIMEOUT_MS = 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");
const runtimeEntry = path.join(packageRoot, "dist/src/index.js");
const fixtures = path.join(packageRoot, "acceptance/fixtures/controlled-language");
const documentationGlossary = path.resolve(packageRoot, "../trust-ui/src/i18n/en/docs.ts");

const BASE = "trust-base";
const BASE_VERSION = "1.0.0";

/** Concepts named by the Procedure and Operation languages, beyond the documentation glossary. */
const LANGUAGE_NOUNS = [
  "scope",
  "role",
  "Invocation",
  "mission",
  "mission collection",
  "guard",
  "success reason",
  "Result",
  "Input",
  "Produced field",
  "step",
  "Product Action Contract",
  "engagement",
  "admission",
  "declaration",
  "dependency",
  "catalog",
  "vocabulary",
  "term",
  "root input",
  "child Plan",
  "Fact batch",
] as const;
const LANGUAGE_VERBS = [
  "engage",
  "admit",
  "qualify",
  "escalate",
  "resume",
  "publish",
  "declare",
  "materialize",
  "delegate",
] as const;

/** Retained terms of the approved arbitrations, with the meaning that their single definition must carry. */
const RETAINED_TERMS: ReadonlyArray<readonly [term: string, meaning: RegExp]> = [
  ["delegation", /\bwork to a child Plan\b/],
  ["admission", /^The authorization of one Attempt\b/],
  ["grant", /\bright\b.*\bextension\b/],
  ["intent", /\bthe work it plans to do next\b/],
  ["qualification", /^The evaluation\b/],
  ["verdict", /^The result of qualification\b/],
  ["Fact", /^The accepted value of one Produced field\b/],
  ["Fact batch", /\bFacts of one Attempt\b/],
  ["scope", /\bauthorized and forbidden limits\b.*\bCheck\b/],
  ["root input", /\bengagement\b/],
  ["mission", /^One entry of a mission collection\b/],
  ["child Plan", /\bPlan\b.*\bfor one mission\b/],
];

/** Rejected words of the approved arbitrations, each with the term to use. */
const REJECTED_WORDS = [
  { word: "intention", use: "intent" },
  { word: "Produced value", use: "Fact" },
  { word: "action scope", use: "scope" },
  { word: "perimeter", use: "scope" },
  { word: "Plan input", use: "root input" },
  { word: "delegated Plan", use: "child Plan" },
] as const;

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

interface RpcFailureData {
  readonly contract?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly location?: { readonly line: number; readonly column: number } | null;
  readonly diagnostics?: readonly LanguageDiagnostic[];
}

interface RpcEnvelope {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: RpcFailureData };
}

interface VocabularyDefinition {
  readonly vocabulary: string;
  readonly version: string;
  readonly definitionDigest: string;
  readonly terms: readonly { readonly term: string; readonly kind: string; readonly definition: string }[];
  readonly rejectedWords: readonly { readonly word: string; readonly use: string }[];
}

interface PublishedVocabularyResult {
  readonly vocabulary: VocabularyDefinition;
  readonly sourceName: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

type TermRow = readonly [term: string, kind: string, definition: string];
type RejectedRow = readonly [word: string, use: string];

const DOMAIN_TERMS: readonly TermRow[] = [
  ["repository", "noun", "A store of files with their version history."],
  ["deploy", "verb", "Install a release in an Environment."],
];
const DOMAIN_REJECTED: readonly RejectedRow[] = [["repo", "repository"]];

let dataDirectory: string;
let runtime: Runtime;

beforeAll(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "trust-base-vocabulary-"));
  await cp(path.join(fixtures, "operations"), path.join(dataDirectory, "operations"), { recursive: true });
  await mkdir(path.join(dataDirectory, "workspace"));
  runtime = await startRuntime();
});

afterAll(async () => {
  await runtime?.stop();
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5 });
});

test("LANG-040 AC1 the base vocabulary declares each glossary term and each listed concept of the TRUST languages", async () => {
  const published = await readBase();
  assert.equal(published.sourceName, `${BASE}.feature`);
  assert.equal(published.publishedBy, "trust-runtime");
  const base = published.vocabulary;

  const glossary = await glossaryTerms();
  assert.ok(glossary.length >= 28, JSON.stringify(glossary));
  for (const term of glossary) assert.equal(entries(base, term).length, 1, `glossary term "${term}"`);
  for (const term of LANGUAGE_NOUNS) assert.deepEqual(kinds(base, term), ["noun"], `language noun "${term}"`);
  for (const term of LANGUAGE_VERBS) assert.deepEqual(kinds(base, term), ["verb"], `language verb "${term}"`);
  for (const { term, definition } of base.terms) {
    assert.ok(definition.split(/\s+/u).length <= 25, `definition of "${term}" has more than 25 words`);
    assert.equal(definition.split(/(?<=[.?!])\s+/u).length, 1, `definition of "${term}" is one sentence`);
  }

  const mcpRead = await mcp("trust_published_vocabulary_read", { vocabulary: BASE, version: BASE_VERSION });
  assert.equal(mcpRead.isError, false, mcpRead.text);
  assert.match(mcpRead.text, new RegExp(`Definition digest: ${base.definitionDigest}`));

  await runtime.stop();
  runtime = await startRuntime();
  assert.deepEqual(await readBase(), published);
  const listed = (await rpc("vocabulary.list", {})).result?.vocabularies as PublishedVocabularyResult[];
  assert.deepEqual(
    listed.filter(({ vocabulary }) => vocabulary.vocabulary === BASE).map(({ vocabulary }) => vocabulary.version),
    [BASE_VERSION],
  );
});

test("LANG-040 AC2 each approved arbitration has its retained term with one definition and its rejected words", async () => {
  const base = (await readBase()).vocabulary;
  for (const [term, meaning] of RETAINED_TERMS) {
    const found = entries(base, term);
    assert.equal(found.length, 1, `retained term "${term}"`);
    assert.equal(found[0]?.term, term);
    assert.match(found[0]?.definition ?? "", meaning, `definition of "${term}"`);
  }
  assert.deepEqual(base.rejectedWords, REJECTED_WORDS);
  assert.ok(!base.rejectedWords.some(({ word }) => word.toLowerCase() === "grant"));

  const domain = await rpc("vocabulary.publish", { source: vocabulary({ name: "arbitration-terms" }) });
  assert.equal(domain.error, undefined, JSON.stringify(domain.error));
  const domainDefinition = (domain.result as unknown as PublishedVocabularyResult).vocabulary;
  const diagnostics = await rejectedDiagnostics(
    procedure({
      authorized: "Read the intention and the perimeter.",
      forbidden: "Change the Plan input or the delegated Plan.",
      successReason: "the action scope is known",
      failure: '"the Produced value is missing"',
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
      [8, "authorized", "lexical.rejected-word", "intention", "intent"],
      [8, "authorized", "lexical.rejected-word", "perimeter", "scope"],
      [8, "forbidden", "lexical.rejected-word", "Plan input", "root input"],
      [8, "forbidden", "lexical.rejected-word", "delegated Plan", "child Plan"],
      [13, "success-reason", "lexical.rejected-word", "action scope", "scope"],
      [15, "failure-reason", "lexical.rejected-word", "Produced value", "Fact"],
    ],
  );

  const clean = await rpc("procedure.compile", { source: procedure({}), sourceName: "arbitration.feature" });
  assert.equal(clean.error, undefined, JSON.stringify(clean.error));
  assert.deepEqual(clean.result?.controlledLanguage, {
    level: "lexical",
    vocabularies: [
      { vocabulary: BASE, version: BASE_VERSION, digest: base.definitionDigest },
      { vocabulary: "arbitration-terms", version: "1.0.0", digest: domainDefinition.definitionDigest },
    ],
  });
});

test("LANG-040 AC3 a domain vocabulary that declares a term or a rejected word of the base vocabulary is refused", async () => {
  const accepted = await rpc("vocabulary.compile", { source: vocabulary({ name: "accepted-terms" }) });
  assert.equal(accepted.error, undefined, JSON.stringify(accepted.error));

  const cases: ReadonlyArray<readonly [source: string, reason: string, line: number, message: RegExp]> = [
    [
      vocabulary({ terms: [...DOMAIN_TERMS, ["operation", "noun", "A task of the team."]] }),
      "base-vocabulary-conflict",
      10,
      /"operation" is the term "Operation" of the base vocabulary trust-base/,
    ],
    [
      vocabulary({ terms: [...DOMAIN_TERMS, ["Intention", "noun", "A plan of the team."]] }),
      "base-vocabulary-conflict",
      10,
      /"Intention" is the rejected word "intention" of the base vocabulary trust-base/,
    ],
    [
      vocabulary({ rejected: [...DOMAIN_REJECTED, ["perimeter", "repository"]] }),
      "base-vocabulary-conflict",
      13,
      /"perimeter" is the rejected word "perimeter" of the base vocabulary trust-base/,
    ],
    [
      vocabulary({ rejected: [...DOMAIN_REJECTED, ["Check", "repository"]] }),
      "base-vocabulary-conflict",
      13,
      /"Check" is the term "Check" of the base vocabulary trust-base/,
    ],
    [vocabulary({ name: BASE, version: "2.0.0" }), "reserved-vocabulary", 2, /base vocabulary of TRUST/],
  ];
  for (const [source, reason, line, message] of cases) {
    for (const method of ["vocabulary.compile", "vocabulary.publish"]) {
      const refused = await rpc(method, { source, sourceName: "domain.feature" });
      assert.equal(refused.result, undefined, `${method}\n${source}`);
      assert.equal(refused.error?.data?.contract, "trust.vocabulary-compilation-error@1");
      assert.equal(refused.error?.data?.reason, reason, JSON.stringify(refused.error));
      assert.equal(refused.error?.data?.location?.line, line, JSON.stringify(refused.error));
      assert.match(refused.error?.data?.message ?? "", message);
    }
    const mcpRefused = await mcp("trust_vocabulary_publish", { source });
    assert.equal(mcpRefused.isError, true);
    assert.match(mcpRefused.text, new RegExp(`Reason: ${reason}`));
  }

  const listed = (await rpc("vocabulary.list", {})).result?.vocabularies as PublishedVocabularyResult[];
  assert.deepEqual(
    listed
      .map(({ vocabulary }) => `${vocabulary.vocabulary}@${vocabulary.version}`)
      .filter((id) => id !== "arbitration-terms@1.0.0"),
    [`${BASE}@${BASE_VERSION}`],
  );
  const named = await rpc("procedure.compile", { source: procedure({ tag: BASE }), sourceName: "base-tag.feature" });
  assert.equal(named.result, undefined);
  assert.equal(named.error?.data?.reason, "invalid-procedure", JSON.stringify(named.error));
  assert.equal(named.error?.data?.location?.line, 2);
});

/** Each term of the documentation glossary, as written in its English source. */
async function glossaryTerms(): Promise<readonly string[]> {
  const source = await readFile(documentationGlossary, "utf8");
  const glossary = source.slice(source.indexOf("  glossary: {"));
  assert.ok(glossary.length < source.length, "the documentation glossary is missing");
  return [...glossary.matchAll(/\bterm: "([^"]+)"/g)].map(([, term]) => term ?? "");
}

function entries(base: VocabularyDefinition, term: string) {
  return base.terms.filter((entry) => entry.term.toLowerCase() === term.toLowerCase());
}

function kinds(base: VocabularyDefinition, term: string): readonly string[] {
  return entries(base, term).map(({ kind }) => kind);
}

async function readBase(): Promise<PublishedVocabularyResult> {
  const read = await rpc("vocabulary.read", { vocabulary: BASE, version: BASE_VERSION });
  assert.equal(read.error, undefined, JSON.stringify(read.error));
  const { contract, ...published } = read.result as unknown as PublishedVocabularyResult & { contract: string };
  assert.equal(contract, "trust.published-vocabulary@1");
  return published;
}

interface ProseFields {
  readonly tag: string;
  readonly authorized: string;
  readonly forbidden: string;
  readonly successReason: string;
  /** JavaScript expression passed to `fail(...)`. */
  readonly failure: string;
}

/** A tagged Procedure. Lines: 2 tags, 8 scope row, 9 role, 13 Check and success reason, 15 failure reason. */
function procedure(fields: Partial<ProseFields>): string {
  const value: ProseFields = {
    tag: "arbitration-terms",
    authorized: "Run the declared Operation.",
    forbidden: "Change the Operation definition.",
    successReason: "the Operation completed",
    failure: '"the Operation did not complete"',
    ...fields,
  };
  return `# language: en
@trust-dsl:1 @procedure:base-vocabulary @version:1.0.0 @controlled-language:${value.tag}
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
      fact.completed === "yes" || fail(${value.failure})
      """
`;
}

/** Lines: 2 tags, 6 Terms, 7 header, 8 first term, one line per term, then the Rejected words step, its header and rows. */
function vocabulary(
  options: {
    readonly name?: string;
    readonly version?: string;
    readonly terms?: readonly TermRow[];
    readonly rejected?: readonly RejectedRow[];
  } = {},
): string {
  const terms = options.terms ?? DOMAIN_TERMS;
  const rejected = options.rejected ?? DOMAIN_REJECTED;
  return [
    "# language: en",
    `@trust-dsl:1 @vocabulary:${options.name ?? "domain-terms"} @version:${options.version ?? "1.0.0"}`,
    "Feature: Domain terms",
    "",
    "  Background: Vocabulary",
    "    Given Terms",
    "      | term | kind | definition |",
    ...terms.map(([term, kind, definition]) => `      | ${term} | ${kind} | ${definition} |`),
    "    And Rejected words",
    "      | word | use |",
    ...rejected.map(([word, use]) => `      | ${word} | ${use} |`),
    "",
  ].join("\n");
}

async function rejectedDiagnostics(source: string): Promise<readonly LanguageDiagnostic[]> {
  const envelope = await rpc("procedure.compile", { source, sourceName: "language.feature" });
  assert.equal(envelope.result, undefined, "the tagged Procedure must be rejected");
  assert.equal(envelope.error?.data?.reason, "controlled-language", JSON.stringify(envelope.error));
  return envelope.error?.data?.diagnostics ?? [];
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

/** An isolated runtime over the disposable store of this file; a restart reuses the same store. */
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
    const endpoint = await listeningEndpoint(child, () => stderr);
    const saved = await fetch(`${endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "environment",
        method: "environment.save",
        params: { environment: "local", values: { workspaceRoot: path.join(dataDirectory, "workspace") } },
      }),
    });
    const envelope = (await saved.json()) as { error?: unknown };
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return { endpoint, stop };
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
