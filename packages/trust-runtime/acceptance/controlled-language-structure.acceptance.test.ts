import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

/** Definition digest recorded from the untagged fixture before the controlled language tag existed. */
const RECORDED_UNTAGGED_DIGEST = "91d771102705666629954474a9a02cee89b308b85626b29c95986d777594cb5c";
const EXTERNAL_MARKER = "TRUST-ACCEPTANCE-EXTERNAL";
const LISTEN_TIMEOUT_MS = 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");
const runtimeEntry = path.join(packageRoot, "dist/src/index.js");
const fixtures = path.join(packageRoot, "acceptance/fixtures/controlled-language");

/** Records every outbound socket and every external program started by the runtime process. */
const externalAccessProbe = `
const net = process.getBuiltinModule("node:net");
const childProcess = process.getBuiltinModule("node:child_process");
const { syncBuiltinESMExports } = process.getBuiltinModule("node:module");
const report = (kind) => process.stderr.write("${EXTERNAL_MARKER} " + kind + "\\n");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { report("network"); return connect.apply(this, args); };
const start = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function (...args) { report("program"); return start.apply(this, args); };
for (const name of ["spawnSync", "execSync", "execFileSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (...args) { report("program"); return original.apply(this, args); };
}
syncBuiltinESMExports();
report("probe-loaded");
`;

interface Runtime {
  readonly endpoint: string;
  readonly stderr: () => string;
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
      readonly location?: { readonly line: number; readonly column: number } | null;
      readonly diagnostics?: readonly LanguageDiagnostic[];
    };
  };
}

let runtime: Runtime;

before(async () => {
  runtime = await startRuntime();
});

after(async () => {
  await runtime?.close();
});

test("LANG-010 AC1 a Procedure without the tag keeps its compiled definition and digest and gets no language diagnostic", async () => {
  const source = await readFile(path.join(fixtures, "untagged.feature"), "utf8");
  const recorded = JSON.parse(await readFile(path.join(fixtures, "untagged.compiled.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const compiled = await rpc("procedure.compile", { source, sourceName: "untagged.feature" });
  assert.equal(compiled.error, undefined, JSON.stringify(compiled.error));
  assert.equal(compiled.result?.definitionDigest, RECORDED_UNTAGGED_DIGEST);
  assert.equal(recorded.definitionDigest, RECORDED_UNTAGGED_DIGEST);
  assert.deepEqual(compiled.result, recorded);
  assert.equal("controlledLanguage" in (compiled.result ?? {}), false);

  const mcpCompiled = await mcp("trust_procedure_compile", { source, sourceName: "untagged.feature" });
  assert.equal(mcpCompiled.isError, false, mcpCompiled.text);
  assert.match(mcpCompiled.text, new RegExp(`Definition digest: ${RECORDED_UNTAGGED_DIGEST}`));
  assert.doesNotMatch(mcpCompiled.text, /Language diagnostics|Controlled language|structure\./);

  const published = await rpc("procedure.publish", { source, sourceName: "untagged.feature" });
  assert.equal(published.error, undefined, JSON.stringify(published.error));
  assert.equal(
    (published.result?.procedure as { definitionDigest?: string } | undefined)?.definitionDigest,
    RECORDED_UNTAGGED_DIGEST,
  );
});

test("LANG-010 AC2 a Procedure with the tag alone gets the structure rules on its prose fields", async () => {
  const untagged = await readFile(path.join(fixtures, "untagged.feature"), "utf8");
  const source = untagged.replace("@version:1.0.0", "@version:1.0.0 @controlled-language");
  assert.notEqual(source, untagged);
  const diagnostics = await rejectedDiagnostics(source);
  assert.deepEqual(summary(diagnostics), [
    "9 authorized structure.semicolon",
    "10 authorized structure.sentence-length",
    "10 forbidden structure.sentence-length",
    "11 role-name structure.name-length",
    "15 check-name structure.name-length",
    "15 success-reason structure.single-sentence",
    "17 failure-reason structure.semicolon",
  ]);

  const clean = await rpc("procedure.compile", { source: procedure({}), sourceName: "clean.feature" });
  assert.equal(clean.error, undefined, JSON.stringify(clean.error));
  assert.deepEqual(clean.result?.controlledLanguage, { level: "structure" });
  assert.notEqual(clean.result?.definitionDigest, RECORDED_UNTAGGED_DIGEST);
});

test("LANG-020 AC1 a sentence above the word limit of its field produces a diagnostic", async () => {
  const twenty = words(20);
  const twentyFive = words(25);
  assert.deepEqual(
    await acceptedOrDiagnostics(
      procedure({
        authorized: `${twenty}.`,
        forbidden: `${twenty}. ${twenty}.`,
        successReason: twentyFive,
        failure: `\`${words(12)} \${fact.completed} ${words(13)}\``,
      }),
    ),
    [],
  );
  assert.deepEqual(summary(await rejectedDiagnostics(procedure({ authorized: `${words(21)}.` }))), [
    "8 authorized structure.sentence-length",
  ]);
  assert.deepEqual(summary(await rejectedDiagnostics(procedure({ forbidden: `Stop now. ${words(21)}.` }))), [
    "8 forbidden structure.sentence-length",
  ]);
  assert.deepEqual(summary(await rejectedDiagnostics(procedure({ successReason: words(26) }))), [
    "13 success-reason structure.sentence-length",
  ]);
  assert.deepEqual(
    summary(await rejectedDiagnostics(procedure({ failure: `\`${words(13)} \${fact.completed} ${words(13)}\`` }))),
    ["15 failure-reason structure.sentence-length"],
  );
});

test("LANG-020 AC2 a semicolon in a prose field produces a diagnostic", async () => {
  const cases: ReadonlyArray<readonly [Partial<ProseFields>, string]> = [
    [{ authorized: "Run the Operation; observe it." }, "8 authorized structure.semicolon"],
    [{ forbidden: "Change the Operation; edit Facts." }, "8 forbidden structure.semicolon"],
    [{ roleName: "run;request" }, "9 role-name structure.semicolon"],
    [{ checkName: "confirm;run" }, "13 check-name structure.semicolon"],
    [{ successReason: "the Operation ran; it completed" }, "13 success-reason structure.semicolon"],
    [{ failure: '"the Operation failed; retry"' }, "15 failure-reason structure.semicolon"],
  ];
  for (const [fields, expected] of cases)
    assert.deepEqual(summary(await rejectedDiagnostics(procedure(fields))), [expected], JSON.stringify(fields));
});

test("LANG-020 AC3 a success reason or a failure reason with more than one sentence produces a diagnostic", async () => {
  assert.deepEqual(
    await acceptedOrDiagnostics(
      procedure({ successReason: "the Operation completed.", failure: '"the Operation did not complete!"' }),
    ),
    [],
  );
  assert.deepEqual(summary(await rejectedDiagnostics(procedure({ successReason: "it ran. It completed" }))), [
    "13 success-reason structure.single-sentence",
  ]);
  assert.deepEqual(
    summary(await rejectedDiagnostics(procedure({ failure: '"it did not run? Retry the Operation."' }))),
    ["15 failure-reason structure.single-sentence"],
  );
  assert.deepEqual(
    summary(await rejectedDiagnostics(procedure({ failure: "`it returned ${fact.completed}. Retry it`" }))),
    ["15 failure-reason structure.single-sentence"],
  );
});

test("LANG-020 AC4 a Check name or a role name above three words produces a diagnostic", async () => {
  assert.deepEqual(
    await acceptedOrDiagnostics(procedure({ checkName: "confirm the run", roleName: "requested run value" })),
    [],
  );
  assert.deepEqual(summary(await rejectedDiagnostics(procedure({ checkName: "confirm the requested run" }))), [
    "13 check-name structure.name-length",
  ]);
  assert.deepEqual(summary(await rejectedDiagnostics(procedure({ roleName: "the requested run value" }))), [
    "9 role-name structure.name-length",
  ]);
});

test("LANG-020 AC5 each diagnostic gives the line, the field and the rule identifier and a clean Procedure publishes", async () => {
  const source = procedure({
    name: "language-violations",
    authorized: `${words(21)}.`,
    forbidden: "Change it; edit it.",
    roleName: "the requested run value",
    checkName: "confirm the requested run",
    successReason: "it ran. It completed",
    failure: '"it failed; retry"',
  });
  const diagnostics = await rejectedDiagnostics(source);
  for (const diagnostic of diagnostics) {
    assert.ok(Number.isInteger(diagnostic.location.line) && diagnostic.location.line > 0, JSON.stringify(diagnostic));
    assert.ok(Number.isInteger(diagnostic.location.column) && diagnostic.location.column > 0);
    assert.match(diagnostic.rule, /^structure\.[a-z-]+$/);
    assert.ok(diagnostic.field.length > 0);
    assert.ok(diagnostic.message.length > 0);
  }
  assert.deepEqual(summary(diagnostics), [
    "8 authorized structure.sentence-length",
    "8 forbidden structure.semicolon",
    "9 role-name structure.name-length",
    "13 check-name structure.name-length",
    "13 success-reason structure.single-sentence",
    "15 failure-reason structure.semicolon",
  ]);
  const refused = await rpc("procedure.publish", { source, sourceName: "language-violations.feature" });
  assert.equal(refused.error?.data?.reason, "controlled-language");
  assert.deepEqual(refused.error?.data?.diagnostics, diagnostics);

  const clean = procedure({ name: "language-clean" });
  const published = await rpc("procedure.publish", { source: clean, sourceName: "language-clean.feature" });
  assert.equal(published.error, undefined, JSON.stringify(published.error));
  const definition = published.result?.procedure as { procedure?: string; controlledLanguage?: unknown } | undefined;
  assert.equal(definition?.procedure, "language-clean");
  assert.deepEqual(definition?.controlledLanguage, { level: "structure" });
  const read = await mcp("trust_published_procedure_read", { procedure: "language-clean", version: "1.0.0" });
  assert.equal(read.isError, false, read.text);
  assert.match(read.text, /Controlled language: structure/);
});

test("LANG-070 AC2 the MCP Procedure compilation returns the language diagnostics with line, field and rule identifier", async () => {
  const source = procedure({
    authorized: "Run it; observe it.",
    roleName: "the requested run value",
    successReason: `${words(26)}`,
  });
  const expected = await rejectedDiagnostics(source);
  const compiled = await mcp("trust_procedure_compile", { source, sourceName: "language.feature" });
  assert.equal(compiled.isError, true, compiled.text);
  assert.match(compiled.text, /Reason: controlled-language/);
  const reported = [...compiled.text.matchAll(/^- line (\d+), field ([a-z-]+), rule ([a-z.-]+): (.+)$/gm)].map(
    ([, line, field, rule, message]) => ({ line: Number(line), field, rule, message }),
  );
  assert.deepEqual(
    reported,
    expected.map(({ location, field, rule, message }) => ({ line: location.line, field, rule, message })),
  );
  assert.deepEqual(
    reported.map(({ line, field, rule }) => `${line} ${field} ${rule}`),
    [
      "8 authorized structure.semicolon",
      "9 role-name structure.name-length",
      "13 success-reason structure.sentence-length",
    ],
  );
});

test("LANG-090 AC1 the same source produces the same diagnostics twice without network or external program", async () => {
  const source = procedure({
    authorized: "Run it; observe it.",
    forbidden: `${words(22)}.`,
    checkName: "confirm the requested run",
    failure: "`it returned ${fact.completed}. Retry it`",
  });
  const observedFrom = runtime.stderr().length;
  const first = await rejectedDiagnostics(source);
  const second = await rejectedDiagnostics(source);
  const firstMcp = await mcp("trust_procedure_compile", { source, sourceName: "language.feature" });
  const secondMcp = await mcp("trust_procedure_compile", { source, sourceName: "language.feature" });
  assert.ok(first.length >= 4);
  assert.deepEqual(second, first);
  assert.equal(secondMcp.text, firstMcp.text);
  assert.equal(firstMcp.isError, true);
  const externalAccess = runtime
    .stderr()
    .slice(observedFrom)
    .split("\n")
    .filter((line) => line.startsWith(EXTERNAL_MARKER));
  assert.deepEqual(externalAccess, []);
  assert.ok(runtime.stderr().includes(`${EXTERNAL_MARKER} probe-loaded`), "the external access probe must be active");
});

interface ProseFields {
  readonly name: string;
  readonly authorized: string;
  readonly forbidden: string;
  readonly roleName: string;
  readonly checkName: string;
  readonly successReason: string;
  /** JavaScript expression passed to `fail(...)`. */
  readonly failure: string;
}

/** A tagged Procedure. Lines: 8 scope row, 9 role, 13 Check and success reason, 15 failure reason. */
function procedure(fields: Partial<ProseFields>): string {
  const value: ProseFields = {
    name: "language-structure",
    authorized: "Run the declared Operation.",
    forbidden: "Change the Operation definition.",
    roleName: "request",
    checkName: "confirm run",
    successReason: "the Operation completed",
    failure: '"the Operation did not complete"',
    ...fields,
  };
  return `# language: en
@trust-dsl:1 @procedure:${value.name} @version:1.0.0 @controlled-language
Feature: Control the prose structure of a Procedure

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | ${value.authorized} | ${value.forbidden} |
    And one string "${value.roleName}" fixed as "run"

  @scenario:execute
  Scenario: Execute the Operation
    Then Check "${value.checkName}" runs Operation "test.language-check@*" on "${value.roleName}" as Input "request" and must establish "${value.successReason}"
      """js
      fact.completed === "yes" || fail(${value.failure})
      """
`;
}

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
}

function summary(diagnostics: readonly LanguageDiagnostic[]): readonly string[] {
  return diagnostics.map(({ location, field, rule }) => `${location.line} ${field} ${rule}`);
}

async function rejectedDiagnostics(source: string): Promise<readonly LanguageDiagnostic[]> {
  const envelope = await rpc("procedure.compile", { source, sourceName: "language.feature" });
  assert.equal(envelope.result, undefined, "the tagged Procedure must be rejected");
  assert.equal(envelope.error?.data?.reason, "controlled-language", JSON.stringify(envelope.error));
  const diagnostics = envelope.error?.data?.diagnostics ?? [];
  assert.equal(envelope.error?.data?.location?.line, diagnostics[0]?.location.line);
  return diagnostics;
}

async function acceptedOrDiagnostics(source: string): Promise<readonly string[]> {
  const envelope = await rpc("procedure.compile", { source, sourceName: "language.feature" });
  if (envelope.error)
    return envelope.error.data?.diagnostics
      ? summary(envelope.error.data.diagnostics)
      : [JSON.stringify(envelope.error)];
  assert.deepEqual(envelope.result?.controlledLanguage, { level: "structure" });
  return [];
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

/** An isolated runtime with a disposable PGlite store and a private copy of the fixture Operation. */
async function startRuntime(): Promise<Runtime> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "trust-controlled-language-"));
  const operationsDirectory = path.join(dataDirectory, "operations");
  await cp(path.join(fixtures, "operations"), operationsDirectory, { recursive: true });
  const environment: Record<string, string | undefined> = { ...process.env };
  delete environment.TRUST_DATABASE_PATH;
  delete environment.TRUST_DATABASE_URL;
  delete environment.TRUST_PGLITE_DIRECTORY;
  const child = spawn(
    process.execPath,
    [`--import=data:text/javascript,${encodeURIComponent(externalAccessProbe)}`, runtimeEntry],
    {
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
    },
  );
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
    return { endpoint: await listeningEndpoint(child, () => stderr), stderr: () => stderr, close };
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
