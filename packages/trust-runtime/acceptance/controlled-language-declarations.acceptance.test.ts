import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const LISTEN_TIMEOUT_MS = 60_000;
const LSP_TIMEOUT_MS = 20_000;
const RUNNER_TIMEOUT_MS = 20_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const runtimeEntry = path.join(packageRoot, "dist/src/index.js");
const runnerEntry = path.join(repositoryRoot, "packages/trust-runner/dist/skill/trust/scripts/run.js");
const fixtures = path.join(packageRoot, "acceptance/fixtures/controlled-language");
const execute = promisify(execFile);

interface Finding {
  readonly rule: string;
  readonly field: string;
  readonly message: string;
}

interface RpcEnvelope {
  readonly result?: Record<string, unknown>;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: {
      readonly reason?: string;
      readonly message?: string;
      readonly findings?: readonly Finding[];
      readonly diagnostics?: readonly (Finding & { readonly location: { readonly line: number } })[];
    };
  };
}

interface CheckView {
  readonly name: string;
  readonly checkUri: string;
  readonly escalatable?: boolean;
  readonly attemptHandle?: string | null;
}

interface PlanView {
  readonly revision: number;
  readonly workState: string;
  readonly currentIntent: string | null;
  readonly nextIntent: string | null;
  readonly currentIntentCheckUri: string | null;
  readonly activeEscalation: unknown;
  readonly controlledLanguage?: unknown;
  readonly checks: readonly CheckView[];
}

interface Admission {
  readonly status: string;
  readonly attemptKey: string;
  readonly attemptHandle: string;
  readonly executionId: string;
  readonly checkUri: string;
  readonly reasonCode?: string;
  readonly reason?: string;
  readonly findings?: readonly Finding[];
  readonly operation: { readonly operation: string };
}

interface Runtime {
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

let runtime: Runtime;
let sequence = 0;

/** A nextIntent that breaks two structure rules: a semicolon and a sentence of 28 words. */
const BROKEN_INTENT = `Inspect the request; ${words(24)} now`;
/** A sentence of 26 words that also uses the rejected word "repo" of delivery-terms 1.0.0. */
const BROKEN_LEXICAL = `Inspect the repo; ${words(23)}`;

before(async () => {
  runtime = await startRuntime();
  await publishVocabulary(vocabulary("1.0.0", [["repo", "repository"]]));
  await publishProcedure(procedure({ name: "declarations-structure", tag: "@controlled-language" }));
  await publishProcedure(procedure({ name: "declarations-lexical", tag: "@controlled-language:delivery-terms" }));
  await publishProcedure(procedure({ name: "declarations-free" }));
});

after(async () => {
  await runtime?.close();
});

test("LANG-060 AC1 an intent, a blocking reason or a forbidden action that breaks a rule is refused at the call with its diagnostics and changes nothing", async () => {
  const plan = await engage("declarations-structure", "structure-plan", "dry-run");
  const started = await read(plan);
  assert.deepEqual(started.controlledLanguage, { level: "structure" });
  assert.match(
    await mcpText("trust_plan_read", { plan }),
    /CONTROLLED LANGUAGE[\s\S]*nextIntent \(field next-intent\): one sentence of 25 words or less, without a semicolon\.[\s\S]*blockingReason \(field blocking-reason\): sentences of 25 words or less[\s\S]*forbiddenFurtherAction \(field forbidden-further-action\): one sentence of 25 words or less/,
  );

  const refusedKey = nextKey();
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    [BROKEN_INTENT, ["next-intent structure.semicolon", "next-intent structure.sentence-length"]],
    ["Inspect the request. Report the state.", ["next-intent structure.single-sentence"]],
  ];
  for (const [nextIntent, expected] of cases) {
    const refused = await admit(plan, "first run", { nextIntent, attemptKey: refusedKey });
    assert.equal(refused.status, "REFUSED", JSON.stringify(refused));
    assert.equal(refused.reasonCode, "controlled-language");
    assert.deepEqual(
      refused.findings?.map(({ field, rule }) => `${field} ${rule}`),
      expected,
    );
    for (const finding of refused.findings ?? [])
      assert.ok(refused.reason?.includes(`[${finding.field} ${finding.rule}] ${finding.message}`), refused.reason);
    assert.deepEqual(intentState(await read(plan)), intentState(started), "a refused nextIntent changes nothing");
  }

  const runnerPlan = await engage("declarations-structure", "structure-live", "live");
  const live = await read(runnerPlan);
  const uri = new URL(checkNamed(live, "first run").checkUri);
  uri.searchParams.set("intent", live.currentIntent ?? "");
  uri.searchParams.set("nextIntent", BROKEN_INTENT);
  const runner = await runRunner(uri.href);
  assert.equal(runner.result.status, "REFUSED", JSON.stringify(runner));
  assert.equal(runner.result.reasonCode, "controlled-language");
  assert.match(runner.result.reason, /\[next-intent structure\.semicolon\] /);
  assert.match(runner.result.reason, /\[next-intent structure\.sentence-length\] .*The limit is 25\./);
  assert.deepEqual(intentState(await read(runnerPlan)), intentState(live));

  const admitted = await admit(plan, "first run", { nextIntent: "Run the final Check.", attemptKey: refusedKey });
  assert.equal(admitted.status, "ADMITTED", "a refused admission does not bind its attempt key");
  await finalize(admitted, "no");
  const negative = await read(plan);
  assert.equal(checkNamed(negative, "first run").escalatable, true);

  const broken = {
    contract: "trust.check-escalation-request@1",
    checkUri: admitted.checkUri,
    attemptHandle: admitted.attemptHandle,
    blockingReason: `The request stays open. ${words(26)}.`,
    forbiddenFurtherAction: "Change the Operation; then run it. Publish it.",
  };
  const rpcRefusal = await rpc("check.escalate", broken);
  assert.equal(rpcRefusal.result, undefined);
  assert.equal(rpcRefusal.error?.data?.reason, "controlled-language", JSON.stringify(rpcRefusal.error));
  assert.deepEqual(
    rpcRefusal.error?.data?.findings?.map(({ field, rule }) => `${field} ${rule}`),
    [
      "blocking-reason structure.sentence-length",
      "forbidden-further-action structure.semicolon",
      "forbidden-further-action structure.single-sentence",
    ],
  );
  const mcpRefusal = await mcp("trust_check_escalate", {
    checkUri: broken.checkUri,
    attemptHandle: broken.attemptHandle,
    blockingReason: broken.blockingReason,
    forbiddenFurtherAction: broken.forbiddenFurtherAction,
  });
  assert.equal(mcpRefusal.isError, true);
  assert.match(mcpRefusal.text, /TRUST Check escalation refused/);
  for (const finding of rpcRefusal.error?.data?.findings ?? [])
    assert.ok(mcpRefusal.text.includes(`[${finding.field} ${finding.rule}] ${finding.message}`), mcpRefusal.text);
  const unchanged = await read(plan);
  assert.deepEqual(intentState(unchanged), intentState(negative), "a refused escalation changes nothing");
  assert.equal(unchanged.workState, "IN_PROGRESS");
  assert.equal(unchanged.activeEscalation, null);
  assert.equal(checkNamed(unchanged, "first run").escalatable, true);

  const rewritten = await rpc("check.escalate", {
    ...broken,
    blockingReason: "The request stays open. The Operation reports no completion.",
    forbiddenFurtherAction: "Change the Operation definition.",
  });
  assert.equal(rewritten.error, undefined, JSON.stringify(rewritten.error));
  assert.equal(rewritten.result?.status, "ESCALATED");
  assert.equal((await read(plan)).workState, "ESCALATED");
});

test("LANG-060 AC2 the control uses the vocabularies that the Procedure of the Plan pins", async () => {
  const pinned = await engage("declarations-lexical", "lexical-plan", "dry-run");
  const structure = await engage("declarations-structure", "lexical-structure-plan", "dry-run");
  const delivery = await readVocabulary("delivery-terms", "1.0.0");
  const base = await readVocabulary("trust-base", "1.0.0");
  assert.deepEqual((await read(pinned)).controlledLanguage, {
    level: "lexical",
    vocabularies: [
      { vocabulary: "trust-base", version: "1.0.0", digest: base.definitionDigest },
      { vocabulary: "delivery-terms", version: "1.0.0", digest: delivery.definitionDigest },
    ],
  });
  await publishVocabulary(
    vocabulary("1.1.0", [
      ["repo", "repository"],
      ["workflow", "pipeline"],
    ]),
  );
  await publishProcedure(
    procedure({ name: "declarations-lexical", version: "2.0.0", tag: "@controlled-language:delivery-terms" }),
  );
  const newer = await engage("declarations-lexical", "lexical-newer-plan", "dry-run", "2.0.0");

  const refusals = async (plan: string, nextIntent: string) => {
    const admission = await admit(plan, "first run", { nextIntent });
    return admission.status === "REFUSED"
      ? (admission.findings ?? []).map(({ field, rule, message }) => `${field} ${rule} ${message}`)
      : [];
  };
  assert.deepEqual(await refusals(pinned, "Inspect the repo."), [
    'next-intent lexical.rejected-word The next-intent text uses the rejected word "repo". Use the term "repository".',
  ]);
  assert.deepEqual(await refusals(pinned, "Record the intention."), [
    'next-intent lexical.rejected-word The next-intent text uses the rejected word "intention". Use the term "intent".',
  ]);
  assert.deepEqual(await refusals(newer, "Inspect the workflow."), [
    'next-intent lexical.rejected-word The next-intent text uses the rejected word "workflow". Use the term "pipeline".',
  ]);
  assert.deepEqual(await refusals(structure, "Inspect the repo."), [], "the structure level has no lexical rule");
  assert.deepEqual(
    await refusals(pinned, "Inspect the workflow."),
    [],
    "the Plan keeps delivery-terms 1.0.0 after 1.1.0 is published",
  );

  const admitted = await admit(newer, "first run", { nextIntent: "Run the final Check." });
  assert.equal(admitted.status, "ADMITTED", JSON.stringify(admitted));
  await finalize(admitted, "no");
  const refused = await rpc("check.escalate", {
    contract: "trust.check-escalation-request@1",
    checkUri: admitted.checkUri,
    attemptHandle: admitted.attemptHandle,
    blockingReason: "The workflow stays open.",
    forbiddenFurtherAction: "Leave the perimeter.",
  });
  assert.equal(refused.error?.data?.reason, "controlled-language", JSON.stringify(refused.error));
  assert.deepEqual(
    refused.error?.data?.findings?.map(({ field, rule, message }) => `${field} ${rule} ${message}`),
    [
      'blocking-reason lexical.rejected-word The blocking-reason text uses the rejected word "workflow". Use the term "pipeline".',
      'forbidden-further-action lexical.rejected-word The forbidden-further-action text uses the rejected word "perimeter". Use the term "scope".',
    ],
  );
  assert.equal((await read(newer)).workState, "IN_PROGRESS");
});

test("LANG-060 AC3 a Plan whose Procedure has no tag accepts these texts as before", async () => {
  const plan = await engage("declarations-free", "free-plan", "dry-run");
  const started = await read(plan);
  assert.equal(Object.hasOwn(started, "controlledLanguage"), false);
  assert.doesNotMatch(await mcpText("trust_plan_read", { plan }), /CONTROLLED LANGUAGE/);
  const admitted = await admit(plan, "first run", { nextIntent: BROKEN_LEXICAL });
  assert.equal(admitted.status, "ADMITTED", JSON.stringify(admitted));
  assert.equal((await read(plan)).nextIntent, BROKEN_LEXICAL);
  await finalize(admitted, "no");
  const escalated = await mcp("trust_check_escalate", {
    checkUri: admitted.checkUri,
    attemptHandle: admitted.attemptHandle,
    blockingReason: `The repo stays open; ${words(30)}. A second sentence follows.`,
    forbiddenFurtherAction: BROKEN_LEXICAL,
  });
  assert.equal(escalated.isError, false, escalated.text);
  const view = await read(plan);
  assert.equal(view.workState, "ESCALATED");
});

test("LANG-090 AC2 the compiler, the runtime and the language server return the same findings for the same text", async () => {
  const source = procedure({
    name: "declarations-same-text",
    tag: "@controlled-language:delivery-terms",
    successReason: BROKEN_LEXICAL,
  });
  const compiled = await rpc("procedure.compile", { source, sourceName: "same-text.feature" });
  assert.equal(compiled.error?.data?.reason, "controlled-language", JSON.stringify(compiled.error));
  const compiler = (compiled.error?.data?.diagnostics ?? []).filter(({ field }) => field === "success-reason");
  assert.deepEqual(
    compiler.map(({ rule }) => rule),
    ["structure.semicolon", "structure.sentence-length", "lexical.rejected-word"],
  );

  const lsp = await LanguageClient.connect(runtime.endpoint);
  let server: readonly Finding[];
  try {
    server = (await lsp.diagnostics("file:///workspace/same-text.feature", source))
      .filter(({ field }) => field === "success-reason")
      .map(({ rule, field, message }) => ({ rule: rule ?? "", field: field ?? "", message }));
  } finally {
    await lsp.close();
  }

  const plan = await engage("declarations-lexical", "same-text-plan", "dry-run");
  const admission = await admit(plan, "first run", { nextIntent: BROKEN_LEXICAL });
  assert.equal(admission.status, "REFUSED", JSON.stringify(admission));
  const admitted = await admit(plan, "first run", { nextIntent: "Run the final Check." });
  await finalize(admitted, "no");
  const escalation = await rpc("check.escalate", {
    contract: "trust.check-escalation-request@1",
    checkUri: admitted.checkUri,
    attemptHandle: admitted.attemptHandle,
    blockingReason: BROKEN_LEXICAL,
    forbiddenFurtherAction: BROKEN_LEXICAL,
  });
  const runtimeFindings = escalation.error?.data?.findings ?? [];

  /** The same rules and messages, with the field identifier set aside. */
  const neutral = (findings: readonly Finding[]) =>
    findings.map(({ rule, field, message }) => `${rule} ${message.replaceAll(field, "<field>")}`);
  const expected = neutral(compiler);
  assert.deepEqual(neutral(server), expected, "the language server");
  assert.deepEqual(neutral(admission.findings ?? []), expected, "the runtime at admission");
  for (const field of ["blocking-reason", "forbidden-further-action"])
    assert.deepEqual(
      neutral(runtimeFindings.filter((finding) => finding.field === field)),
      expected,
      `the runtime at escalation for ${field}`,
    );
});

interface ProcedureOptions {
  readonly name: string;
  readonly version?: string;
  readonly tag?: string;
  readonly successReason?: string;
}

/** Two chained Checks: "first run" needs a nextIntent, "final run" completes the Plan. */
function procedure(options: ProcedureOptions): string {
  const tags = ["@trust-dsl:1", `@procedure:${options.name}`, `@version:${options.version ?? "1.0.0"}`];
  tags.push("@intent-chaining");
  if (options.tag) tags.push(options.tag);
  return `# language: en
${tags.join(" ")}
Feature: Control the declarations of an agent

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Run the declared Operation. | Change the Operation definition. |
    And one string "request" fixed as "run"

  @scenario:first
  Scenario: Execute the first Operation
    Then Check "first run" runs Operation "test.language-check@*" on "request" as Input "request" and must establish "${options.successReason ?? "the first Operation completed"}"
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

function vocabulary(version: string, rejected: readonly (readonly [string, string])[]): string {
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
    "      | word | use |",
    ...rejected.map(([word, use]) => `      | ${word} | ${use} |`),
    "",
  ].join("\n");
}

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
}

function nextKey(): string {
  sequence += 1;
  return `declarations-${sequence}`;
}

function checkNamed(view: PlanView, name: string): CheckView {
  const check = view.checks.find((value) => value.name === name);
  assert.ok(check, `Missing Check ${name}`);
  return check;
}

function intentState(view: PlanView) {
  return {
    revision: view.revision,
    workState: view.workState,
    currentIntent: view.currentIntent,
    nextIntent: view.nextIntent,
    currentIntentCheckUri: view.currentIntentCheckUri,
    activeEscalation: view.activeEscalation,
  };
}

async function publishVocabulary(source: string): Promise<void> {
  const published = await rpc("vocabulary.publish", { source, sourceName: "delivery-terms.feature" });
  assert.equal(published.error, undefined, JSON.stringify(published.error));
}

async function publishProcedure(source: string): Promise<void> {
  const published = await rpc("procedure.publish", { source, sourceName: "declarations.feature" });
  assert.equal(published.error, undefined, JSON.stringify(published.error));
}

async function readVocabulary(name: string, version: string): Promise<{ readonly definitionDigest: string }> {
  const read = await rpc("vocabulary.read", { vocabulary: name, version });
  assert.equal(read.error, undefined, JSON.stringify(read.error));
  return (read.result as { vocabulary: { definitionDigest: string } }).vocabulary;
}

/** Engage a Plan and start its intent chain with an MCP read. */
async function engage(procedureName: string, plan: string, mode: "live" | "dry-run", version = "1.0.0") {
  const engaged = await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: procedureName,
    procedureVersion: version,
    plan,
    environment: "local",
    mode,
    rootInputs: {},
  });
  assert.equal(engaged.error, undefined, JSON.stringify(engaged.error));
  await mcpText("trust_plan_read", { plan });
  return plan;
}

async function read(plan: string): Promise<PlanView> {
  const envelope = await rpc("plan.read", { plan });
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result as unknown as PlanView;
}

async function admit(
  plan: string,
  checkName: string,
  options: { readonly nextIntent?: string; readonly attemptKey?: string },
): Promise<Admission> {
  const view = await read(plan);
  const envelope = await rpc("check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    checkUri: checkNamed(view, checkName).checkUri,
    attemptKey: options.attemptKey ?? nextKey(),
    intent: view.currentIntent,
    ...(options.nextIntent === undefined ? {} : { nextIntent: options.nextIntent }),
  });
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result as unknown as Admission;
}

/** Submit dry-run Facts for an admitted Attempt and finalize it. */
async function finalize(attempt: Admission, completed: "yes" | "no"): Promise<void> {
  assert.equal(attempt.status, "ADMITTED", JSON.stringify(attempt));
  const at = new Date().toISOString();
  const facts = await rpc("check.attempt.facts", {
    contract: "trust.fact-batch-request@1",
    attemptKey: attempt.attemptKey,
    attemptHandle: attempt.attemptHandle,
    executionId: attempt.executionId,
    checkUri: attempt.checkUri,
    recordedAt: at,
    facts: [{ kind: attempt.operation.operation, observedAt: at, values: { completed } }],
  });
  assert.equal(facts.error, undefined, JSON.stringify(facts.error));
  const finalized = await rpc("check.attempt.finalize", {
    contract: "trust.attempt-finalization-request@1",
    attemptHandle: attempt.attemptHandle,
  });
  assert.equal(finalized.error, undefined, JSON.stringify(finalized.error));
  assert.equal(finalized.result?.verdict, completed === "yes" ? "VALIDATED" : "NOT_VALIDATED");
}

async function runRunner(uri: string): Promise<{
  readonly result: { readonly status: string; readonly reasonCode: string; readonly reason: string };
}> {
  const execution = await execute(process.execPath, [runnerEntry, uri, "--json"], {
    timeout: RUNNER_TIMEOUT_MS,
    env: {
      ...process.env,
      TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
      TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
    },
  });
  return JSON.parse(execution.stdout);
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

async function mcpText(name: string, args: Readonly<Record<string, unknown>>): Promise<string> {
  const result = await mcp(name, args);
  assert.equal(result.isError, false, result.text);
  return result.text;
}

interface ObservedDiagnostic {
  readonly message: string;
  readonly rule?: string;
  readonly field?: string;
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

  async diagnostics(uri: string, text: string): Promise<readonly ObservedDiagnostic[]> {
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
    return (diagnostics as { message: string; data?: { rule?: string; field?: string } }[]).map(
      ({ message, data }) => ({
        message,
        ...(data?.rule === undefined ? {} : { rule: data.rule }),
        ...(data?.field === undefined ? {} : { field: data.field }),
      }),
    );
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

/** An isolated runtime with a disposable PGlite store, a private copy of the fixture Operation and one Environment. */
async function startRuntime(): Promise<Runtime> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "trust-controlled-declarations-"));
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
    const saved = await fetch(`${endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "environment",
        method: "environment.save",
        params: { environment: "local", values: { workspaceRoot } },
      }),
    });
    const envelope = (await saved.json()) as { error?: unknown };
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
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
