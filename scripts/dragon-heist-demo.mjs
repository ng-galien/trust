import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Separate persistent demonstration state: never reset or reuse the dogfooding database.
const root = fileURLToPath(new URL("../", import.meta.url));
const data = path.join(root, ".trust/dragon-heist");
const endpoint = "http://127.0.0.1:4497";
const children = [];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }),
  );
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void close());
function launch(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  children.push(child);
  child.once("exit", () => {
    if (!closing) {
      process.exitCode = 1;
      void close();
    }
  });
  return child;
}
async function wait(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (closing) throw new Error("Demo process stopped during startup");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Demo server did not become ready");
}
async function rpc(method, params) {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const envelope = await response.json();
  // Never print Environment values or the move credential on failure.
  if (!response.ok || envelope.error) throw new Error(`Demo setup failed at ${method}`);
  return envelope.result;
}
try {
  for (const port of [4497, 4187]) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      throw new Error(`Port ${port} is already serving; stop its owner explicitly before launching this demo`);
    } catch (error) {
      if (error.message?.startsWith("Port ")) throw error;
    }
  }
  await mkdir(data, { recursive: true });
  const credentialFile = path.join(data, "move-token");
  let token;
  try {
    token = await readFile(credentialFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    token = randomBytes(32).toString("hex");
    await writeFile(credentialFile, token, { flag: "wx", mode: 0o600 });
  }
  const installationFile = path.join(data, "extensions.json");
  await writeFile(
    installationFile,
    JSON.stringify(
      {
        extensions: [
          {
            manifest: path.join(root, "extensions/dragon-heist/extension.json"),
            configuration: {
              dataDirectory: path.join(data, "game"),
              trustBaseUrl: `${endpoint}/extensions/dragon-heist/trust`,
            },
            environment: "dragon-heist",
            grants: ["plans.read", "plans.subscribe"],
            credentialEnvironment: ["DRAGON_HEIST_TOKEN"],
            autoStart: false,
          },
        ],
      },
      null,
      2,
    ),
  );
  launch([path.join(root, "packages/trust-runtime/dist/src/index.js")], root, {
    TRUST_HOST: "127.0.0.1",
    TRUST_PORT: "4497",
    TRUST_SEMANTIC_AUTHORITY: "127.0.0.1:4497",
    TRUST_DATABASE_PATH: path.join(data, "runtime.sqlite"),
    TRUST_EXTENSIONS_FILE: installationFile,
    TRUST_OPERATIONS_DIRECTORY: path.join(root, "assets/operations"),
    DRAGON_HEIST_TOKEN: token,
  });
  await wait(`${endpoint}/health`);
  for (const transition of ["prepare", "start"]) {
    const response = await fetch(`${endpoint}/extensions/dragon-heist/${transition}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`Demo extension ${transition} failed`);
  }
  await rpc("environment.save", {
    environment: "dragon-heist",
    values: {
      gameUrl: `${endpoint}/extensions/dragon-heist/commands`,
      gameToken: token,
    },
  });
  const catalog = path.join(root, "assets/procedures/dragon-heist");
  for (const file of (await readdir(catalog)).filter((file) => file.endsWith(".feature")).sort()) {
    await rpc("procedure.publish", { source: await readFile(path.join(catalog, file), "utf8"), sourceName: file });
  }
  // Serve workspace UI sources with HMR instead of a stale compiled preview.
  launch(
    [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "4187"],
    path.join(root, "apps/trust-web"),
    {
      TRUST_RUNTIME_URL: endpoint,
      TRUST_WEB_PORT: "4187",
    },
  );
  await wait("http://127.0.0.1:4187/health");
  process.stdout.write("Dragon Heist table: http://127.0.0.1:4187/extensions/dragon-heist\n");
  // No Plan is engaged or played by startup. The game master uses the published Procedures.
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
  await close();
}
