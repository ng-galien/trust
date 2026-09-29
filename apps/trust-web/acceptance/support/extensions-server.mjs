import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "trust-federation-"));
const children = [];
let closing = false;
let restarting = false;
let restartControl;
async function close() {
  if (closing) return;
  closing = true;
  restartControl?.close();
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once("exit", resolve);
          child.kill("SIGTERM");
        }),
    ),
  );
  await rm(temporary, { recursive: true, force: true });
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void close());
process.on("uncaughtException", (error) => {
  console.error(error);
  void close();
});
function start(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  children.push(child);
  child.once("exit", () => {
    if (!closing && !restarting) void close();
  });
  return child;
}
async function wait(url) {
  for (let index = 0; index < 300; index++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.text();
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server unavailable: ${url}`);
}
await cp(path.join(root, "extensions/coordination/dist"), path.join(temporary, "dist"), { recursive: true });
await cp(
  path.join(root, "apps/trust-web/acceptance/fixtures/extension-server.mjs"),
  path.join(temporary, "server.mjs"),
);
await writeFile(
  path.join(temporary, "extension.json"),
  JSON.stringify({
    contract: "trust.extension@1",
    id: "coordination",
    title: "Agent coordination",
    version: "1.0.0",
    server: "./server.mjs",
    configuration: {},
    requestedCapabilities: ["plans.read", "plans.subscribe"],
    mcp: {
      description: "Coordination acceptance commands",
      commands: [
        { name: "missions.list", description: "List missions", inputSchema: { type: "object" }, readOnly: true },
        {
          name: "missions.suggest",
          description: "Suggest mission values",
          inputSchema: { type: "object" },
          readOnly: true,
        },
        { name: "tags.replace", description: "Replace tags", inputSchema: { type: "object" }, readOnly: false },
      ],
    },
    ui: { name: "trust_coordination", entry: "remoteEntry.js", module: "./Page", assets: "./dist" },
  }),
);
await writeFile(
  path.join(temporary, "installations.json"),
  JSON.stringify({
    extensions: [
      {
        manifest: path.join(temporary, "extension.json"),
        configuration: {},
        environment: "local",
        grants: ["plans.read", "plans.subscribe"],
        credentialEnvironment: [],
        autoStart: false,
      },
    ],
  }),
);
const startRuntime = () =>
  start([path.join(root, "packages/trust-runtime/dist/src/index.js")], root, {
    TRUST_HOST: "127.0.0.1",
    TRUST_PORT: "4397",
    TRUST_STORAGE: "pglite",
    TRUST_PGLITE_DIRECTORY: path.join(temporary, "runtime-pglite"),
    TRUST_OPERATIONS_DIRECTORY: path.join(root, "assets/operations"),
    TRUST_EXTENSIONS_FILE: path.join(temporary, "installations.json"),
    TRUST_SKILL_POLICY: "local",
  });
let runtime = startRuntime();
await wait("http://127.0.0.1:4397/health");
async function rpc(method, params) {
  const payload = await (
    await fetch("http://127.0.0.1:4397/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    })
  ).json();
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload.result;
}
await rpc("environment.save", { environment: "local", values: { workspaceRoot: path.dirname(root) } });
await rpc("procedure.publish", {
  source: await readFile(path.join(root, "assets/procedures/00-git-status.feature"), "utf8"),
  sourceName: "git-status.feature",
});
await rpc("procedure.publish", {
  source: await readFile(path.join(root, "packages/trust-runtime/acceptance/fixtures/intent-chaining.feature"), "utf8"),
  sourceName: "intent-chaining.feature",
});
await rpc("procedure.publish", {
  source: await readFile(path.join(root, "apps/trust-web/acceptance/fixtures/coordination-checklist.feature"), "utf8"),
  sourceName: "coordination-checklist.feature",
});
await rpc("plan.engage", {
  contract: "trust.plan-engagement-request@1",
  procedure: "git-status",
  procedureVersion: "2.0.0",
  plan: "interface-acceptance",
  environment: "local",
  metadata: { labels: ["interface"] },
  rootInputs: { repository: "trust" },
});
// The interface under test is built from the current sources into this disposable directory, never a stale dist.
const webEnvironment = { TRUST_RUNTIME_URL: "http://127.0.0.1:4397", TRUST_WEB_PORT: "4177" };
const webDist = path.join(temporary, "web-dist");
const vite = path.join(root, "node_modules/vite/bin/vite.js");
const build = spawn(process.execPath, [vite, "build", "--outDir", webDist, "--emptyOutDir"], {
  cwd: path.join(root, "apps/trust-web"),
  env: { ...process.env, ...webEnvironment },
  stdio: "inherit",
});
const [code] = await once(build, "exit");
if (code !== 0) throw new Error(`Interface build failed with exit code ${code}`);
start(
  [vite, "preview", "--host", "127.0.0.1", "--port", "4177", "--outDir", webDist],
  path.join(root, "apps/trust-web"),
  webEnvironment,
);
// Dedicated acceptance only: restart this test-owned process with the same temporary database.
if (process.env.TRUST_ACCEPTANCE_RESTART_CONTROL) {
  restartControl = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/restart" || restarting) {
      response.writeHead(404).end();
      return;
    }
    restarting = true;
    try {
      const exited = once(runtime, "exit");
      runtime.kill("SIGTERM");
      await exited;
      runtime = startRuntime();
      await wait("http://127.0.0.1:4397/health");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ restarted: true }));
    } catch (error) {
      response.writeHead(500).end(String(error));
    } finally {
      restarting = false;
    }
  }).listen(Number(process.env.TRUST_ACCEPTANCE_RESTART_CONTROL), "127.0.0.1");
}
await new Promise(() => {});
