import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = path.resolve(applicationRoot, "../..");
const runtimePort = 4390;
const webPort = 4174;
const stateDirectory = await mkdtemp(path.join(tmpdir(), "trust-web-acceptance-"));
const children = [];

const runtime = spawn(
  process.execPath,
  [path.join(repositoryRoot, "packages/trust-runtime/dist/src/index.js")],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TRUST_HOST: "127.0.0.1",
      TRUST_PORT: String(runtimePort),
      TRUST_DATABASE_PATH: path.join(stateDirectory, "runtime.sqlite"),
      TRUST_OPERATIONS_DIRECTORY: path.join(repositoryRoot, "assets/operations"),
      TRUST_SKILL_POLICY: "local",
    },
    // Never leave runtime output unread: a full child pipe blocks the seeded public RPC boundary.
    stdio: ["ignore", "inherit", "inherit"],
  },
);
children.push(runtime);
await waitFor(`http://127.0.0.1:${runtimePort}/health`);
await seedRuntime();

const vite = spawn(
  process.execPath,
  [path.join(repositoryRoot, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(webPort)],
  {
    cwd: applicationRoot,
    env: { ...process.env, TRUST_RUNTIME_URL: `http://127.0.0.1:${runtimePort}` },
    stdio: "inherit",
  },
);
children.push(vite);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void close(signal));
}
vite.once("exit", () => void close("SIGTERM"));
runtime.once("exit", () => void close("SIGTERM"));
await new Promise(() => {});

async function seedRuntime() {
  await rpc("environment.save", {
    environment: "local",
    values: { workspaceRoot: path.dirname(repositoryRoot) },
  });
  // A second environment so the interface can switch the current one.
  await rpc("environment.save", {
    environment: "staging",
    values: { workspaceRoot: path.dirname(repositoryRoot) },
  });
  const procedureDirectory = path.join(repositoryRoot, "assets/procedures");
  const names = (await readdir(procedureDirectory)).filter((name) => name.endsWith(".feature")).sort();
  for (const name of names) {
    await rpc("procedure.publish", {
      source: await readFile(path.join(procedureDirectory, name), "utf8"),
      sourceName: name,
    });
  }
  await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan: "interface-acceptance",
    environment: "local",
    rootInputs: { repository: path.basename(repositoryRoot) },
  });
}

async function rpc(method, params) {
  const response = await fetch(`http://127.0.0.1:${runtimePort}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

async function waitFor(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function close(signal) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  await rm(stateDirectory, { recursive: true, force: true });
  process.exit(0);
}
