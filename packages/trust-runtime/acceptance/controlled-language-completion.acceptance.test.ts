import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll } from "vitest";
import { test } from "./support/fixtures.js";

const LISTEN_TIMEOUT_MS = 60_000;
const LSP_TIMEOUT_MS = 20_000;
const RUNNER_TIMEOUT_MS = 20_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const runtimeEntry = path.join(packageRoot, "dist/src/index.js");
const runtimeServer = path.join(packageRoot, "dist/src/server.js");
const accessProvider = path.join(repositoryRoot, "environments/trust-test/auth/provider.mjs");
const runnerEntry = path.join(repositoryRoot, "packages/trust-runner/dist/skill/trust/scripts/run.js");
const runnerMcpEntry = path.join(repositoryRoot, "packages/trust-runner/dist/skill/trust/scripts/mcp-stdio.js");
const fixtures = path.join(packageRoot, "acceptance/fixtures/controlled-language");
const execute = promisify(execFile);

interface Finding {
  readonly rule: string;
  readonly field: string;
  readonly message: string;
}

interface RpcEnvelope {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

interface PlanView {
  readonly currentIntent: string | null;
  readonly nextIntent: string | null;
  readonly revision: number;
  readonly checks: readonly { readonly name: string; readonly checkUri: string }[];
}

interface Term {
  readonly term: string;
  readonly kind: string;
  readonly definition: string;
}

interface Vocabulary {
  readonly vocabulary: string;
  readonly version: string;
  readonly definitionDigest: string;
  readonly terms: readonly Term[];
  readonly rejectedWords: readonly { readonly word: string; readonly use: string }[];
}

interface Lookup {
  readonly contract: string;
  readonly word: string;
  readonly vocabularies: readonly { readonly vocabulary: string; readonly version: string }[];
  readonly terms: readonly (Term & { readonly vocabulary: string; readonly version: string })[];
  readonly rejectedWords: readonly {
    readonly vocabulary: string;
    readonly word: string;
    readonly use: string;
    readonly term?: Term & { readonly vocabulary: string };
  }[];
}

interface RunnerRefusal {
  readonly checkUri: string;
  readonly result: {
    readonly status: string;
    readonly reasonCode: string;
    readonly reason: string;
    readonly findings?: readonly Finding[];
  };
  readonly next: { readonly action: string };
}

interface Caller {
  readonly token: string | undefined;
}

interface Endpoint {
  readonly endpoint: string;
}

interface Runtime extends Endpoint {
  readonly close: () => Promise<void>;
}

interface AccessCallers extends Endpoint {
  /** Holds `trust.vocabulary.publish` and `trust.vocabulary.list`. */
  readonly publisher: Caller;
  /** Holds the read rights `trust.vocabulary.list` and `trust.vocabulary.read`, and no publish right. */
  readonly reader: Caller;
  /** Holds only Procedure read rights. */
  readonly outsider: Caller;
}

interface AccessRuntime extends Endpoint {
  readonly issue: (subject: string, scope: string) => Promise<Caller>;
  readonly close: () => Promise<void>;
}

const local: Caller = { token: undefined };
let runtime: Runtime;
let accessRuntime: AccessRuntime;
let sequence = 0;

/** A nextIntent that breaks two structure rules: a semicolon and a sentence of 28 words. */
const BROKEN_INTENT = `Inspect the request; ${words(24)} now`;

beforeAll(async () => {
  [runtime, accessRuntime] = await Promise.all([startRuntime(), startAccessRuntime()]);
  await publishVocabulary(runtime, local, deliveryTerms("1.0.0"));
  await publishProcedure(procedure({ name: "completion-structure", tag: "@controlled-language" }));
});

afterAll(async () => {
  await Promise.all([runtime?.close(), accessRuntime?.close()]);
});

test("LANG-100 AC1 the Runner result of a refused next intent holds each finding with its rule, its field and its message", async () => {
  const plan = await engage("completion-structure", "runner-refusal");
  const started = await read(plan);
  const uri = new URL(checkNamed(started, "first run").checkUri);
  uri.searchParams.set("intent", started.currentIntent ?? "");
  uri.searchParams.set("nextIntent", BROKEN_INTENT);
  const expected = ["next-intent structure.semicolon", "next-intent structure.sentence-length"];

  const cli = await runRunner(uri.href, false);
  const command = JSON.parse(cli) as RunnerRefusal;
  assert.equal(command.result.status, "REFUSED", cli);
  assert.equal(command.result.reasonCode, "controlled-language");
  assert.equal(command.next.action, "READ_PLAN");
  assert.deepEqual(
    command.result.findings?.map(({ field, rule }) => `${field} ${rule}`),
    expected,
  );
  for (const finding of command.result.findings ?? []) {
    assert.equal(typeof finding.message, "string");
    assert.ok(finding.message.length > 0);
    assert.ok(command.result.reason.includes(`[${finding.field} ${finding.rule}] ${finding.message}`));
  }
  assert.match(command.result.findings?.[1]?.message ?? "", /The limit is 25\./);

  const text = await runRunner(uri.href, true);
  assert.match(text, /^Status: REFUSED$/m);
  assert.match(text, /^Findings:$/m);
  for (const finding of command.result.findings ?? [])
    assert.ok(
      text.includes(`- field ${finding.field}, rule ${finding.rule}: ${finding.message}`),
      `the text result lists ${finding.rule}`,
    );

  const tool = await runRunnerMcp(uri.href);
  assert.equal(tool.result.status, "REFUSED");
  assert.deepEqual(tool.result.findings, command.result.findings, "the Runner MCP tool holds the same findings");

  const unchanged = await read(plan);
  assert.equal(unchanged.revision, started.revision);
  assert.equal(unchanged.currentIntent, started.currentIntent);
  assert.equal(unchanged.nextIntent, started.nextIntent);
});

test("LANG-120 AC1 an MCP tool lists the published vocabularies with identity, version, term count and rejected word count", async () => {
  const catalog = (await rpcResult(runtime, local, "vocabulary.list", {})) as {
    vocabularies: readonly { vocabulary: Vocabulary }[];
  };
  const published = catalog.vocabularies.map(({ vocabulary }) => vocabulary);
  assert.deepEqual(published.map(({ vocabulary, version }) => `${vocabulary}@${version}`).sort(), [
    "delivery-terms@1.0.0",
    "trust-base@1.0.0",
  ]);
  const text = await mcpText(runtime, local, "trust_vocabulary_list", {});
  assert.match(text, /^VOCABULARY CATALOG$/m);
  assert.match(text, /^Count: 2$/m);
  for (const vocabulary of published) {
    const entry = text
      .split("\n- ")
      .find((block) => block.startsWith(`${vocabulary.vocabulary}@${vocabulary.version}:`));
    assert.ok(entry, `the list names ${vocabulary.vocabulary}@${vocabulary.version}`);
    assert.match(entry, new RegExp(`^  Terms: ${vocabulary.terms.length}$`, "m"));
    assert.match(entry, new RegExp(`^  Rejected words: ${vocabulary.rejectedWords.length}$`, "m"));
    assert.match(entry, new RegExp(`^  Definition digest: ${vocabulary.definitionDigest}$`, "m"));
  }
  const delivery = text.split("\n- ").find((block) => block.startsWith("delivery-terms@1.0.0:"));
  assert.match(delivery ?? "", /^ {2}Terms: 2$/m);
  assert.match(delivery ?? "", /^ {2}Rejected words: 2$/m);
});

test("LANG-120 AC2 an MCP tool returns each term with its kind and definition and each rejected word with its term", async () => {
  for (const [name, version] of [
    ["delivery-terms", "1.0.0"],
    ["trust-base", "1.0.0"],
  ] as const) {
    const published = (await rpcResult(runtime, local, "vocabulary.read", { vocabulary: name, version })) as {
      vocabulary: Vocabulary;
    };
    const text = await mcpText(runtime, local, "trust_published_vocabulary_read", { vocabulary: name, version });
    assert.match(text, new RegExp(`^Vocabulary: ${name}@${version}$`, "m"));
    const lines = new Set(text.split("\n"));
    assert.ok(published.vocabulary.terms.length > 0);
    for (const { term, kind, definition } of published.vocabulary.terms)
      assert.ok(lines.has(`- ${term} (${kind}): ${definition}`), `term ${term} of ${name}`);
    assert.ok(published.vocabulary.rejectedWords.length > 0);
    for (const { word, use } of published.vocabulary.rejectedWords)
      assert.ok(lines.has(`- ${word}: use "${use}"`), `rejected word ${word} of ${name}`);
  }
  const delivery = await mcpText(runtime, local, "trust_published_vocabulary_read", {
    vocabulary: "delivery-terms",
    version: "1.0.0",
  });
  assert.match(delivery, /^- repository \(noun\): A store of files with their version history\.$/m);
  assert.match(delivery, /^- repo: use "repository"$/m);
});

test("LANG-120 AC3 an MCP tool looks a word up in the base vocabulary and in a named vocabulary", async () => {
  const base = (await rpcResult(runtime, local, "vocabulary.read", { vocabulary: "trust-base", version: "1.0.0" })) as {
    vocabulary: Vocabulary;
  };
  const check = base.vocabulary.terms.find(({ term }) => term === "Check");
  const intent = base.vocabulary.terms.find(({ term }) => term === "intent");
  assert.ok(check && intent);

  const term = await lookup({ word: "check" });
  assert.deepEqual(term.rpc.vocabularies, [
    { vocabulary: "trust-base", version: "1.0.0", digest: base.vocabulary.definitionDigest },
  ]);
  assert.deepEqual(
    term.rpc.terms.map(({ vocabulary, term, kind, definition }) => ({ vocabulary, term, kind, definition })),
    [{ vocabulary: "trust-base", term: "Check", kind: check.kind, definition: check.definition }],
  );
  assert.deepEqual(term.rpc.rejectedWords, []);
  assert.match(term.text, /^Searched: trust-base@1\.0\.0$/m);
  assert.match(term.text, /^Result: found$/m);
  assert.ok(term.text.includes(`- term "Check" (${check.kind}) in trust-base@1.0.0: ${check.definition}`), term.text);

  const rejected = await lookup({ word: "Intention" });
  assert.deepEqual(
    rejected.rpc.rejectedWords.map(({ vocabulary, word, use, term }) => ({
      vocabulary,
      word,
      use,
      definition: term?.definition,
    })),
    [{ vocabulary: "trust-base", word: "intention", use: "intent", definition: intent.definition }],
  );
  assert.ok(
    rejected.text.includes(
      `- rejected word "intention" in trust-base@1.0.0: use the term "intent" (noun) from trust-base@1.0.0: ${intent.definition}`,
    ),
    rejected.text,
  );

  const domain = await lookup({ word: "REPO", vocabulary: "delivery-terms" });
  assert.match(domain.text, /^Searched: trust-base@1\.0\.0, delivery-terms@1\.0\.0$/m);
  assert.deepEqual(
    domain.rpc.rejectedWords.map(({ vocabulary, word, use, term }) => ({
      vocabulary,
      word,
      use,
      definition: term?.definition,
    })),
    [
      {
        vocabulary: "delivery-terms",
        word: "repo",
        use: "repository",
        definition: "A store of files with their version history.",
      },
    ],
  );
  assert.ok(
    domain.text.includes(
      '- rejected word "repo" in delivery-terms@1.0.0: use the term "repository" (noun) from delivery-terms@1.0.0: A store of files with their version history.',
    ),
    domain.text,
  );
  const domainTerm = await lookup({ word: "pipeline", vocabulary: "delivery-terms" });
  assert.deepEqual(
    domainTerm.rpc.terms.map(({ vocabulary, term, definition }) => `${vocabulary} ${term} ${definition}`),
    ["delivery-terms pipeline A sequence of jobs that builds and ships a release."],
  );
  const baseThroughDomain = await lookup({ word: "intention", vocabulary: "delivery-terms" });
  assert.deepEqual(
    baseThroughDomain.rpc.rejectedWords.map(({ vocabulary, use }) => `${vocabulary} ${use}`),
    ["trust-base intent"],
    "a lookup with a named vocabulary also searches the base vocabulary",
  );

  for (const request of [{ word: "repo" }, { word: "banana", vocabulary: "delivery-terms" }]) {
    const absent = await lookup(request);
    assert.deepEqual([absent.rpc.terms, absent.rpc.rejectedWords], [[], []], JSON.stringify(request));
    assert.match(absent.text, /^Result: absent$/m);
    assert.ok(absent.text.includes(`No searched vocabulary declares "${request.word}".`));
  }

  const unknown = await mcp(runtime, local, "trust_vocabulary_lookup", { word: "repo", vocabulary: "unknown-terms" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Vocabulary unknown-terms is not published\./);
  const unknownRpc = await rpc(runtime, local, "vocabulary.lookup", { word: "repo", vocabulary: "unknown-terms" });
  assert.equal(unknownRpc.result, undefined);
  assert.match(unknownRpc.error?.message ?? "", /Vocabulary unknown-terms is not published\./);
});

test("LANG-130 AC1 a caller without the right to publish is refused through RPC and MCP and nothing is published", async () => {
  const access = await accessCallers();
  const source = deliveryTerms("2.0.0");
  const refusedRpc = await rpc(access, access.reader, "vocabulary.publish", { source, sourceName: "delivery.feature" });
  assert.equal(refusedRpc.result, undefined);
  assert.equal(refusedRpc.error?.code, -32001, JSON.stringify(refusedRpc));
  assert.equal(refusedRpc.error?.message, "Access denied");
  const refusedMcp = await mcp(access, access.reader, "trust_vocabulary_publish", {
    source,
    sourceName: "delivery.feature",
  });
  assert.equal(refusedMcp.isError, true);
  assert.equal(refusedMcp.text, "Access denied");
  const outsider = await rpc(access, access.outsider, "vocabulary.publish", { source, sourceName: "delivery.feature" });
  assert.equal(outsider.error?.code, -32001, JSON.stringify(outsider));
  const anonymous = await fetch(`${access.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "anonymous",
      method: "vocabulary.publish",
      params: { source, sourceName: "delivery.feature" },
    }),
  });
  assert.equal(anonymous.status, 401, "a caller without a credential is refused");

  const catalog = (await rpcResult(access, access.reader, "vocabulary.list", {})) as {
    vocabularies: readonly { vocabulary: Vocabulary }[];
  };
  assert.deepEqual(
    catalog.vocabularies.map(({ vocabulary }) => `${vocabulary.vocabulary}@${vocabulary.version}`),
    ["delivery-terms@1.0.0", "trust-base@1.0.0"],
    "nothing is published",
  );
  const missing = await rpc(access, access.reader, "vocabulary.read", {
    vocabulary: "delivery-terms",
    version: "2.0.0",
  });
  assert.equal(missing.result, undefined);

  const allowed = await rpc(access, access.publisher, "vocabulary.publish", { source, sourceName: "delivery.feature" });
  assert.equal(allowed.error, undefined, JSON.stringify(allowed));
  assert.equal((allowed.result as { vocabulary: Vocabulary }).vocabulary.version, "2.0.0");
});

test("LANG-130 AC2 a caller with the right to read lists, reads and looks up and a caller without it is refused", async () => {
  const access = await accessCallers();
  const calls = [
    ["vocabulary.list", "trust_vocabulary_list", {}],
    ["vocabulary.read", "trust_published_vocabulary_read", { vocabulary: "delivery-terms", version: "1.0.0" }],
    ["vocabulary.lookup", "trust_vocabulary_lookup", { word: "repo", vocabulary: "delivery-terms" }],
  ] as const;
  for (const [method, tool, params] of calls) {
    const allowed = await rpc(access, access.reader, method, params);
    assert.equal(allowed.error, undefined, `${method}: ${JSON.stringify(allowed.error)}`);
    assert.ok(allowed.result);
    const allowedTool = await mcp(access, access.reader, tool, params);
    assert.equal(allowedTool.isError, false, `${tool}: ${allowedTool.text}`);

    const refused = await rpc(access, access.outsider, method, params);
    assert.equal(refused.result, undefined, method);
    assert.equal(refused.error?.code, -32001, `${method}: ${JSON.stringify(refused)}`);
    const refusedTool = await mcp(access, access.outsider, tool, params);
    assert.equal(refusedTool.isError, true, tool);
    assert.equal(refusedTool.text, "Access denied");

    const anonymous = await fetch(`${access.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
    assert.equal(anonymous.status, 401, `${method} without a credential`);
  }
  const lookup = (await rpcResult(access, access.reader, "vocabulary.lookup", {
    word: "repo",
    vocabulary: "delivery-terms",
  })) as unknown as Lookup;
  assert.deepEqual(
    lookup.rejectedWords.map(({ word, use }) => `${word} ${use}`),
    ["repo repository"],
  );
});

test("LANG-140 AC1 the language server returns the same document symbols for a lexical Procedure as for the same Procedure without the tag", async () => {
  const lexical = procedure({ name: "completion-symbols", tag: "@controlled-language:delivery-terms" });
  const untagged = procedure({ name: "completion-symbols" });
  const client = await LanguageClient.connect(runtime.endpoint);
  try {
    const lexicalDiagnostics = await client.open("file:///workspace/lexical.feature", lexical);
    assert.deepEqual(lexicalDiagnostics, [], "the lexical Procedure compiles against the published vocabulary");
    await client.open("file:///workspace/untagged.feature", untagged);
    const tagged = await client.symbols("file:///workspace/lexical.feature");
    const plain = await client.symbols("file:///workspace/untagged.feature");
    assert.ok(Array.isArray(plain) && plain.length === 1, JSON.stringify(plain));
    assert.deepEqual(outline(plain), [
      "Procedure completion-symbols",
      "  Context role request",
      "  Scenario Execute the first Operation",
      "  Check first run",
      "  Scenario Execute the final Operation",
      "  Check final run",
    ]);
    assert.deepEqual(tagged, plain);
  } finally {
    await client.close();
  }
});

interface ProcedureOptions {
  readonly name: string;
  readonly tag?: string;
}

/** Two chained Checks: "first run" needs a nextIntent, "final run" completes the Plan. */
function procedure(options: ProcedureOptions): string {
  const tags = ["@trust-dsl:1", `@procedure:${options.name}`, "@version:1.0.0", "@intent-chaining"];
  if (options.tag) tags.push(options.tag);
  return `# language: en
${tags.join(" ")}
Feature: Complete the controlled language

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Run the declared Operation. | Change the Operation definition. |
    And one string "request" fixed as "run"

  @scenario:first
  Scenario: Execute the first Operation
    Then Check "first run" runs Operation "test.language-check@*" on "request" as Input "request" and must establish "the first Operation completed"
      """js
      fact.completed === "yes" || fail("the first Operation did not complete")
      """

  @scenario:final
  Scenario: Execute the final Operation
    Given scenario "first" is validated
    Then Check "final run" runs Operation "test.language-check@*" on "request" as Input "request" and must establish "the final Operation completed"
      """js
      fact.completed === "yes" || fail("the final Operation did not complete")
      """
`;
}

function deliveryTerms(version: string): string {
  return [
    "# language: en",
    `@trust-dsl:1 @vocabulary:delivery-terms @version:${version}`,
    "Feature: Delivery terms",
    "",
    "  Background: Vocabulary",
    "    Given Terms",
    "      | term       | kind | definition                                          |",
    "      | repository | noun | A store of files with their version history.        |",
    "      | pipeline   | noun | A sequence of jobs that builds and ships a release. |",
    "    And Rejected words",
    "      | word     | use        |",
    "      | repo     | repository |",
    "      | workflow | pipeline   |",
    "",
  ].join("\n");
}

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
}

function outline(symbols: readonly { name: string; detail?: string; children?: unknown[] }[], depth = 0): string[] {
  return symbols.flatMap((symbol) => [
    `${"  ".repeat(depth)}${symbol.detail} ${symbol.name}`,
    ...outline((symbol.children ?? []) as { name: string; detail?: string; children?: unknown[] }[], depth + 1),
  ]);
}

/** Fresh tokens for the three callers of the access runtime; development tokens live 120 seconds. */
async function accessCallers(): Promise<AccessCallers> {
  const [publisher, reader, outsider] = await Promise.all([
    accessRuntime.issue("admin", "trust.vocabulary.publish trust.vocabulary.list"),
    accessRuntime.issue("alice", "trust.vocabulary.list trust.vocabulary.read"),
    accessRuntime.issue("bob", "trust.procedure.list trust.procedure.read"),
  ]);
  return { endpoint: accessRuntime.endpoint, publisher, reader, outsider };
}

function checkNamed(view: PlanView, name: string): { readonly checkUri: string } {
  const check = view.checks.find((value) => value.name === name);
  assert.ok(check, `Missing Check ${name}`);
  return check;
}

async function lookup(params: { readonly word: string; readonly vocabulary?: string }) {
  const result = (await rpcResult(runtime, local, "vocabulary.lookup", params)) as unknown as Lookup;
  assert.equal(result.contract, "trust.vocabulary-lookup@1");
  assert.equal(result.word, params.word);
  const text = await mcpText(runtime, local, "trust_vocabulary_lookup", params);
  assert.match(text, /^VOCABULARY LOOKUP$/m);
  assert.ok(text.includes(`Word: ${params.word}`));
  return { rpc: result, text };
}

async function publishVocabulary(target: Endpoint, caller: Caller, source: string): Promise<void> {
  await rpcResult(target, caller, "vocabulary.publish", { source, sourceName: "delivery-terms.feature" });
}

async function publishProcedure(source: string): Promise<void> {
  await rpcResult(runtime, local, "procedure.publish", { source, sourceName: "completion.feature" });
}

/** Engage a live Plan and start its intent chain with an MCP read. */
async function engage(procedureName: string, plan: string): Promise<string> {
  sequence += 1;
  const slug = `${plan}-${sequence}`;
  await rpcResult(runtime, local, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: procedureName,
    procedureVersion: "1.0.0",
    plan: slug,
    environment: "local",
    mode: "live",
    rootInputs: {},
  });
  await mcpText(runtime, local, "trust_plan_read", { plan: slug });
  return slug;
}

async function read(plan: string): Promise<PlanView> {
  return (await rpcResult(runtime, local, "plan.read", { plan })) as unknown as PlanView;
}

function runnerEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
    TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
  };
}

async function runRunner(uri: string, text: boolean): Promise<string> {
  const execution = await execute(process.execPath, [runnerEntry, uri, ...(text ? [] : ["--json"])], {
    timeout: RUNNER_TIMEOUT_MS,
    env: runnerEnvironment(),
  });
  return execution.stdout;
}

/** Call the `trust_check_run` tool of the packaged Runner MCP server over stdio. */
async function runRunnerMcp(uri: string): Promise<RunnerRefusal> {
  const child = spawn(process.execPath, [runnerMcpEntry], { env: runnerEnvironment(), stdio: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), RUNNER_TIMEOUT_MS);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const exited = once(child, "exit");
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "acceptance", version: "1" } } })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "trust_check_run", arguments: { checkUri: uri } } })}\n`,
  );
  try {
    for (let waited = 0; !stdout.includes('"id":2'); waited += 25) {
      assert.ok(waited < RUNNER_TIMEOUT_MS, `the Runner MCP server did not answer: ${stdout}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    child.stdin.end();
    await exited;
    clearTimeout(timeout);
  }
  const response = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { id: number; result?: { content: { text: string }[]; isError?: boolean } })
    .find((message) => message.id === 2);
  assert.ok(response?.result, stdout);
  assert.notEqual(response.result.isError, true, stdout);
  return JSON.parse(response.result.content[0]?.text ?? "") as RunnerRefusal;
}

async function rpc(
  target: Endpoint,
  caller: Caller,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<RpcEnvelope> {
  const response = await fetch(`${target.endpoint}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(caller.token === undefined ? {} : { authorization: `Bearer ${caller.token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  return (await response.json()) as RpcEnvelope;
}

async function rpcResult(
  target: Endpoint,
  caller: Caller,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const envelope = await rpc(target, caller, method, params);
  assert.equal(envelope.error, undefined, `${method}: ${JSON.stringify(envelope.error)}`);
  assert.ok(envelope.result);
  return envelope.result;
}

async function mcp(
  target: Endpoint,
  caller: Caller,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ text: string; isError: boolean }> {
  const response = await fetch(`${target.endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...(caller.token === undefined ? {} : { authorization: `Bearer ${caller.token}` }),
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

async function mcpText(
  target: Endpoint,
  caller: Caller,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const result = await mcp(target, caller, name, args);
  assert.equal(result.isError, false, result.text);
  return result.text;
}

/** A minimal LSP client over the runtime's public `/lsp` WebSocket. */
class LanguageClient {
  #nextId = 1;
  #version = 1;
  readonly #socket: WebSocket;
  readonly #responses = new Map<number, (value: unknown) => void>();
  readonly #diagnostics = new Map<string, (value: { version?: number; diagnostics: unknown[] }) => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        params?: { uri: string; version?: number; diagnostics: unknown[] };
      };
      if (typeof message.id === "number" && message.method === undefined) {
        this.#responses.get(message.id)?.(message.result);
        this.#responses.delete(message.id);
      }
      if (message.method === "textDocument/publishDiagnostics" && message.params)
        this.#diagnostics.get(message.params.uri)?.(message.params);
    });
  }

  static async connect(endpoint: string): Promise<LanguageClient> {
    const socket = new WebSocket(`${endpoint.replace("http://", "ws://")}/lsp`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("LSP WebSocket failed to open")), { once: true });
    });
    const client = new LanguageClient(socket);
    await client.#request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.#send({ jsonrpc: "2.0", method: "initialized", params: {} });
    return client;
  }

  /** Open a document and return the messages of its first published diagnostics. */
  async open(uri: string, text: string): Promise<readonly string[]> {
    const version = this.#version++;
    const published = new Promise<{ diagnostics: unknown[] }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No diagnostics for ${uri}`)), LSP_TIMEOUT_MS);
      this.#diagnostics.set(uri, (value) => {
        if (value.version !== undefined && value.version !== version) return;
        clearTimeout(timeout);
        this.#diagnostics.delete(uri);
        resolve(value);
      });
    });
    this.#send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "trust-procedure", version, text } },
    });
    const { diagnostics } = await published;
    return (diagnostics as { message: string }[]).map(({ message }) => message);
  }

  async symbols(uri: string): Promise<{ name: string; detail?: string; children?: unknown[] }[]> {
    return (await this.#request("textDocument/documentSymbol", { textDocument: { uri } })) as {
      name: string;
      detail?: string;
      children?: unknown[];
    }[];
  }

  async close(): Promise<void> {
    await this.#request("shutdown", null);
    const closed = new Promise<void>((resolve) => this.#socket.addEventListener("close", () => resolve()));
    this.#send({ jsonrpc: "2.0", method: "exit", params: null });
    await closed;
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`LSP ${method} timed out`)), LSP_TIMEOUT_MS);
      this.#responses.set(id, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  #send(message: unknown): void {
    this.#socket.send(JSON.stringify(message));
  }
}

/**
 * An isolated runtime that validates bearer tokens of a disposable development authority, with a
 * disposable PGlite store. Each caller is one token with the exact scopes of its rights.
 */
async function startAccessRuntime(): Promise<AccessRuntime> {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-controlled-access-"));
  const operationsDirectory = path.join(directory, "operations");
  await cp(path.join(fixtures, "operations"), operationsDirectory, { recursive: true });
  const { createAccessTestProvider } = (await import(pathToFileURL(accessProvider).href)) as {
    createAccessTestProvider: () => Promise<{
      configuration: unknown;
      issue: (input: { subject: string; scope: string }) => Promise<{ token: string }>;
      close: () => Promise<void>;
    }>;
  };
  const { startRuntime: startInProcess } = (await import(pathToFileURL(runtimeServer).href)) as {
    startRuntime: (options: Record<string, unknown>) => Promise<{ port: number; close: () => Promise<void> }>;
  };
  const provider = await createAccessTestProvider();
  let instance: { port: number; close: () => Promise<void> } | undefined;
  const close = async (): Promise<void> => {
    await instance?.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    instance = await startInProcess({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "data") },
      operationsDirectory,
      credentialKeyFile: path.join(directory, "credential.key"),
      accessConfiguration: provider.configuration,
      accessResourceUrl: "http://127.0.0.1/mcp",
    });
    const endpoint = { endpoint: `http://127.0.0.1:${instance.port}` };
    const issue = async (subject: string, scope: string): Promise<Caller> => ({
      token: (await provider.issue({ subject, scope })).token,
    });
    await publishVocabulary(endpoint, await issue("admin", "trust.vocabulary.publish"), deliveryTerms("1.0.0"));
    return { ...endpoint, issue, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** An isolated runtime with a disposable PGlite store, a private copy of the fixture Operation and one Environment. */
async function startRuntime(): Promise<Runtime> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "trust-controlled-completion-"));
  const operationsDirectory = path.join(dataDirectory, "operations");
  const workspaceRoot = path.join(dataDirectory, "workspace");
  await cp(path.join(fixtures, "operations"), operationsDirectory, { recursive: true });
  await mkdir(workspaceRoot);
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
      TRUST_OPERATIONS_DIRECTORY: operationsDirectory,
      TRUST_CREDENTIAL_KEY_FILE: path.join(dataDirectory, "credential.key"),
    },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const close = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    const endpoint = await listeningEndpoint(child, () => stderr);
    await rpcResult({ endpoint }, local, "environment.save", { environment: "local", values: { workspaceRoot } });
    return { endpoint, close };
  } catch (error) {
    await close();
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
