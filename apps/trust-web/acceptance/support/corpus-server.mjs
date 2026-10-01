// Disposable TRUST runtime with the Corpus extension installed from its current sources, a governed thread whose
// document holds Mermaid diagrams, and a framework Plan whose missions are in every state a mission card shows.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  CORPUS_RUNTIME_PORT,
  CORPUS_WEB_PORT,
  DIAGRAM_THREAD,
  FRAMEWORK_PLAN,
  MISSION_PROCEDURE,
  MISSIONS,
  THREAD_BODY,
} from "./corpus-fixture.ts";

// The isolated runtime, its Runner and its Corpus store never inherit an installation's configuration.
for (const key of Object.keys(process.env)) if (key.startsWith("TRUST_")) delete process.env[key];

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const corpus = path.join(root, "trust-extension/extensions/corpus");
const temporary = await mkdtemp(path.join(tmpdir(), "trust-corpus-browser-"));
const runtimeUrl = `http://127.0.0.1:${CORPUS_RUNTIME_PORT}`;
const base = `${runtimeUrl}/extensions/corpus`;
const children = [];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }),
  );
  await rm(temporary, { recursive: true, force: true });
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void close());
process.on("uncaughtException", (error) => {
  console.error(error);
  void close();
});
process.on("unhandledRejection", (error) => {
  console.error(error);
  void close();
});
function start(args, cwd, environment) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...environment }, stdio: "inherit" });
  children.push(child);
  child.once("exit", () => {
    if (!closing) void close();
  });
  return child;
}
async function build(args, cwd, environment = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...environment }, stdio: "inherit" });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`Build failed with exit code ${code}: ${args.join(" ")}`);
}
async function wait(url) {
  for (let index = 0; index < 300; index++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server unavailable: ${url}`);
}
async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url} refused: ${JSON.stringify(payload)}`);
  return payload;
}
async function rpc(method, params) {
  const payload = await post(`${runtimeUrl}/rpc`, { jsonrpc: "2.0", id: method, method, params });
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}
const command = (name, args) => post(`${base}/commands`, { command: name, arguments: args });
const readPlan = (plan) => rpc("plan.read", { plan });
async function declare(plan, values, missions) {
  const current = await readPlan(plan);
  await rpc("plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan,
    expectedRevision: current.revision,
    declarations: { ...current.declarations, ...values },
    ...(missions ? { missionDeclarations: { ...current.missionDeclarations, ...missions } } : {}),
  });
}
/** Runs one Check through the Runner, the only path by which Facts reach TRUST. */
async function runCheck(plan, name) {
  const check = (await readPlan(plan)).checks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`Check ${name} is absent from ${plan}`);
  const { stdout } = await exec(
    process.execPath,
    [path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"), check.checkUri, "--json"],
    {
      env: { ...process.env, TRUST_RPC_ENDPOINT: `${runtimeUrl}/rpc`, TRUST_OTLP_ENDPOINT: `${runtimeUrl}/v1/traces` },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60000,
    },
  );
  const output = JSON.parse(stdout);
  if (output.result?.status !== "COMPLETED") throw new Error(`${name} did not complete: ${stdout}`);
  return output.result;
}
async function expectVerdict(plan, name, verdict) {
  const result = await runCheck(plan, name);
  if (result.qualification.verdict !== verdict)
    throw new Error(`${name} in ${plan}: expected ${verdict}, got ${JSON.stringify(result.qualification)}`);
  return result;
}
/** A mission refused by its verification is escalated by its worker, as the coordination methodology requires. */
async function escalate(plan, name, attemptHandle) {
  const check = (await readPlan(plan)).checks.find((candidate) => candidate.name === name);
  await rpc("check.escalate", {
    contract: "trust.check-escalation-request@1",
    checkUri: check.checkUri,
    attemptHandle,
    blockingReason: "The verification refuses the delivered work.",
    forbiddenFurtherAction: "Do not rerun the verification before the operator decides.",
  });
  return (await readPlan(plan)).activeEscalation;
}
const childOf = async (id) => (await readPlan(FRAMEWORK_PLAN)).invocations.find((i) => i.mission?.id === id).childPlan;

// 1. The Corpus installation loads the current server sources and serves a UI built from the current sources.
const installed = path.join(temporary, "extension");
await mkdir(installed);
const manifest = JSON.parse(await readFile(path.join(corpus, "extension.json"), "utf8"));
await writeFile(path.join(installed, "extension.json"), JSON.stringify({ ...manifest, server: "./server.mjs" }));
await writeFile(
  path.join(installed, "server.mjs"),
  `export { createExtension } from ${JSON.stringify(pathToFileURL(path.join(corpus, "server.mjs")).href)};\n`,
);
await build(
  [
    path.join(corpus, "node_modules/vite/bin/vite.js"),
    "build",
    "--outDir",
    path.join(installed, "dist"),
    "--emptyOutDir",
  ],
  corpus,
);
const workspace = path.join(temporary, "workspace");
await mkdir(workspace);
await writeFile(
  path.join(temporary, "extensions.json"),
  JSON.stringify({
    extensions: [
      {
        manifest: path.join(installed, "extension.json"),
        configuration: { databasePath: path.join(temporary, "corpus") },
        environment: "local",
        grants: ["plans.read", "plans.subscribe", "plans.declare"],
        autoStart: false,
      },
    ],
  }),
);
await mkdir(path.join(temporary, "operations"));
start([path.join(root, "packages/trust-runtime/dist/src/index.js")], root, {
  TRUST_HOST: "127.0.0.1",
  TRUST_PORT: String(CORPUS_RUNTIME_PORT),
  TRUST_STORAGE: "pglite",
  TRUST_PGLITE_DIRECTORY: path.join(temporary, "runtime-pglite"),
  TRUST_CREDENTIAL_KEY_FILE: path.join(temporary, "credential.key"),
  TRUST_OPERATIONS_DIRECTORY: path.join(temporary, "operations"),
  TRUST_EXTENSIONS_FILE: path.join(temporary, "extensions.json"),
});
await wait(`${runtimeUrl}/health`);
await post(`${base}/prepare`, {});
await post(`${base}/start`, {});

// 2. Corpus identity, the framework's Operations and Procedure, and the three-Check mission Procedure.
await command("corpora.create", { id: "trust", title: "TRUST", description: "Governed procedures" });
await command("facets.create", {
  id: "interface",
  corpus: "trust",
  title: "Interface",
  description: "Web interface",
  materialization: "packages/trust-ui",
});
const procedures = path.join(corpus, "procedures");
for (const file of [
  path.join(procedures, "thread-attach.operation.feature"),
  path.join(procedures, "thread-link.operation.feature"),
  path.join(procedures, "requirements-check.operation.feature"),
  path.join(procedures, "thread-revision-read.operation.feature"),
  path.join(procedures, "coverage-check-0.2.0.operation.feature"),
  path.join(procedures, "thread-complete-0.2.0.operation.feature"),
  path.join(root, "assets/operations/coordination.gate-run.feature"),
])
  await rpc("operation.save", { source: await readFile(file, "utf8"), sourceName: path.basename(file) });
await rpc("procedure.publish", {
  source: await readFile(path.join(procedures, "thread-framework-0.4.0.procedure.feature"), "utf8"),
});
await rpc("procedure.publish", { source: MISSION_PROCEDURE });
await rpc("environment.save", {
  environment: "local",
  values: {
    corpusThreadsUrl: `${base}/api/threads`,
    corpusCommandsUrl: `${base}/commands`,
    corpusEpisodesUrl: `${base}/trust/episodes`,
    workspaceRoot: workspace,
  },
});

// 3. The thread, attached and linked through its governed framework Checks, its first framing approved.
await command("threads.open", { id: DIAGRAM_THREAD, title: "Document diagrams", body: THREAD_BODY });
await rpc("plan.engage", {
  contract: "trust.plan-engagement-request@1",
  procedure: "corpus-thread-framework",
  procedureVersion: "0.4.0",
  plan: FRAMEWORK_PLAN,
  environment: "local",
  rootInputs: { thread: DIAGRAM_THREAD },
});
await declare(FRAMEWORK_PLAN, { "target corpus": "trust", "thread revision": 1 });
for (const name of ["attach thread", "link framework", "check requirements"])
  await expectVerdict(FRAMEWORK_PLAN, name, "VALIDATED");
const { revision: checked } = await command("threads.read", { id: DIAGRAM_THREAD });
await declare(FRAMEWORK_PLAN, { "refinement choice": "continue", "approved revision": checked });
await expectVerdict(FRAMEWORK_PLAN, "approve framing", "VALIDATED");

// 4. The missions; the order of their Checks below fixes their latest activity, oldest first.
await declare(
  FRAMEWORK_PLAN,
  {},
  {
    work: MISSIONS.map((mission) => ({
      id: mission.id,
      rootInputs: { thread: DIAGRAM_THREAD, mission: mission.id, verdict: mission.verdict },
      definition: { kind: "published", reference: "corpus-ui-mission@0.1.0" },
    })),
  },
);
const [complete, running, refusedMission, relaunched, escalated] = MISSIONS.map((mission) => mission.id);
// Escalated: its verification refuses the work and the worker escalates.
const escalatedPlan = await childOf(escalated);
await expectVerdict(escalatedPlan, "claim work", "VALIDATED");
const refusal = await expectVerdict(escalatedPlan, "verify work", "NOT_VALIDATED");
await escalate(escalatedPlan, "verify work", refusal.attemptHandle);
// Relaunched: escalated, then relaunched by the operator; its second generation claims the work again.
const firstGeneration = await childOf(relaunched);
await expectVerdict(firstGeneration, "claim work", "VALIDATED");
const refused = await expectVerdict(firstGeneration, "verify work", "NOT_VALIDATED");
const escalation = await escalate(firstGeneration, "verify work", refused.attemptHandle);
await rpc("plan.relaunch", {
  plan: firstGeneration,
  escalationId: escalation.escalationId,
  relaunchReason: "Retry the mission with a corrected environment.",
});
await expectVerdict(await childOf(relaunched), "claim work", "VALIDATED");
// Refused: its verification refuses the work, not escalated yet.
const refusedPlan = await childOf(refusedMission);
await expectVerdict(refusedPlan, "claim work", "VALIDATED");
await expectVerdict(refusedPlan, "verify work", "NOT_VALIDATED");
// Running: claimed, its verification is next.
await expectVerdict(await childOf(running), "claim work", "VALIDATED");
// Complete: every Check validated; the most recent activity.
const completePlan = await childOf(complete);
for (const name of ["claim work", "verify work", "review work"]) await expectVerdict(completePlan, name, "VALIDATED");

// 5. The web host built from the current sources.
const webEnvironment = { TRUST_RUNTIME_URL: runtimeUrl, TRUST_WEB_PORT: String(CORPUS_WEB_PORT) };
const webDist = path.join(temporary, "web-dist");
const vite = path.join(root, "node_modules/vite/bin/vite.js");
await build([vite, "build", "--outDir", webDist, "--emptyOutDir"], path.join(root, "apps/trust-web"), webEnvironment);
start(
  [vite, "preview", "--host", "127.0.0.1", "--port", String(CORPUS_WEB_PORT), "--outDir", webDist],
  path.join(root, "apps/trust-web"),
  webEnvironment,
);
await wait(`http://127.0.0.1:${CORPUS_WEB_PORT}/health`);
await new Promise(() => {});
