import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/* Registry interface acceptance: a disposable PGlite runtime, the web interface built from the current sources,
   and three local registry sources (a Git repository created with git init, a local index file and an HTTP index)
   whose packages offer one or several extensions; one published version fails its build. */

const RUNTIME_PORT = 4393;
const WEB_PORT = 4183;
const FIXTURE_PORT = 4394;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "trust-registry-ui-"));
const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const log = (...values) => console.error("[registry-acceptance]", ...values);
const children = [];
let closing = false;
let fixtures;

async function close() {
  if (closing) return;
  closing = true;
  fixtures?.close();
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

const cleanEnvironment = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TRUST_")));
function start(args, cwd, env, stdio = ["ignore", "inherit", "inherit"]) {
  const child = spawn(process.execPath, args, { cwd, env: { ...cleanEnvironment(), ...env }, stdio });
  children.push(child);
  child.once("exit", (code) => {
    if (!closing) {
      log(`child exited with ${code}: ${args.join(" ")}`);
      void close();
    }
  });
  return child;
}
function run(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...cleanEnvironment(), ...env },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited ${code}`))));
  });
}
async function wait(url) {
  for (let index = 0; index < 600; index++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.text();
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server unavailable: ${url}`);
}

// --- Fixture contents ---------------------------------------------------------------------------------------

const operationTemplate = await readFile(path.join(root, "assets/operations/git.head-read.feature"), "utf8");
const procedureTemplate = await readFile(path.join(root, "assets/procedures/00-git-status.feature"), "utf8");
const operationSource = (name, version) =>
  operationTemplate.replace("@operation:git.head-read @version:1.0.0", `@operation:${name} @version:${version}`);
const procedureSource = (name, version, operation) =>
  procedureTemplate
    .replace("@procedure:git-status @version:2.0.0", `@procedure:${name} @version:${version}`)
    .replace('"git.head-read@*"', `"${operation}"`);

const extensionServer = (label) => `
import { rm, writeFile } from "node:fs/promises";
export function createExtension({ configuration }) {
  return {
    async prepare() { if (configuration.dataPath) await writeFile(configuration.dataPath, "fixture data"); },
    async start() {},
    async stop() {},
    async read() { return { status: 200, body: { label: ${JSON.stringify(label)} } }; },
    async deleteData() { if (configuration.dataPath) await rm(configuration.dataPath, { force: true }); },
  };
}
`;
const dataPathSettings = {
  type: "object",
  additionalProperties: false,
  properties: { dataPath: { type: "string", format: "absolute-path", description: "Extension data file" } },
};
const localKitSettings = {
  type: "object",
  additionalProperties: false,
  properties: {
    databaseUrl: { type: "string", format: "uri", description: "PostgreSQL database URL" },
    databasePath: { type: "string", format: "absolute-path", description: "PGlite directory" },
    poolSize: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Connection pool size" },
    verbose: { type: "boolean", default: false },
    passwordVariable: { type: "string", format: "environment-credential", enum: ["LOCAL_KIT_PASSWORD"] },
  },
  oneOf: [{ required: ["databaseUrl"] }, { required: ["databasePath"] }],
  dependentRequired: { passwordVariable: ["databaseUrl"] },
};
const manifest = (id, title, version, settings, server = "./server.mjs") =>
  JSON.stringify({
    contract: "trust.extension@1",
    id,
    title,
    version,
    server,
    settings,
    requestedCapabilities: ["plans.read"],
  });
const buildScript = `
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await writeFile("dist/server.mjs", await readFile("src/server.mjs"));
`;
const buildPackage = (build) =>
  JSON.stringify({ name: "fixture-extension", version: "0.0.0", private: true, type: "module", scripts: { build } });

/** Write files below a directory and return their SHA-256 digests by relative path. */
async function writeContents(directory, files) {
  const digests = {};
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(directory, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    digests[relative] = sha256(content);
  }
  return digests;
}
const content = (digests, relative, name, version) => ({ path: relative, name, version, sha256: digests[relative] });
const extension = (digests, directory, id, version, files) => ({
  path: `${directory}/extension.json`,
  name: id,
  version,
  sha256: digests[`${directory}/extension.json`],
  files: files.map((file) => ({ path: `${directory}/${file}`, sha256: digests[`${directory}/${file}`] })),
});

/** Git source: one repository offering several packages, index fixed at the repository root. */
async function createGitRegistry() {
  const repository = path.join(temporary, "git-registry");
  const digests = await writeContents(path.join(repository, "packages"), {
    "notes-kit/extension.json": manifest("notes-kit", "Notes kit", "1.0.0", dataPathSettings),
    "notes-kit/server.mjs": extensionServer("notes-kit 1.0.0"),
    "board-kit/extension.json": manifest("board-kit", "Board kit", "1.0.0", dataPathSettings, "./dist/server.mjs"),
    "board-kit/package.json": buildPackage("node build.mjs"),
    "board-kit/build.mjs": buildScript,
    "board-kit/src/server.mjs": extensionServer("board-kit 1.0.0"),
    "board-kit/operations/board.operation.feature": operationSource("regui.board", "1.0.0"),
    "board-kit/procedures/board.procedure.feature": procedureSource("regui-board", "1.0.0", "regui.board@^1"),
    "ops-kit/echo.operation.feature": operationSource("regui.echo", "1.0.0"),
  });
  const index = {
    contract: "trust.registry-index@2",
    base: "packages",
    packages: [
      {
        name: "notes-kit",
        version: "1.0.0",
        title: "Notes kit",
        extension: extension(digests, "notes-kit", "notes-kit", "1.0.0", ["server.mjs"]),
      },
      {
        name: "board-kit",
        version: "1.0.0",
        title: "Board kit",
        description: "Board extension with its Operation and Procedure.",
        extension: extension(digests, "board-kit", "board-kit", "1.0.0", [
          "package.json",
          "build.mjs",
          "src/server.mjs",
        ]),
        operations: [content(digests, "board-kit/operations/board.operation.feature", "regui.board", "1.0.0")],
        procedures: [content(digests, "board-kit/procedures/board.procedure.feature", "regui-board", "1.0.0")],
      },
      {
        name: "ops-kit",
        version: "1.0.0",
        title: "Operations kit",
        operations: [content(digests, "ops-kit/echo.operation.feature", "regui.echo", "1.0.0")],
      },
    ],
  };
  await writeFile(path.join(repository, "trust-registry.json"), JSON.stringify(index, null, 2));
  const git = (...args) =>
    execFileAsync("git", ["-c", "user.name=Registry Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd: repository,
    });
  await git("init", "--quiet", "--initial-branch=main");
  await git("add", "--all");
  await git("commit", "--quiet", "-m", "registry fixture");
  return repository;
}

/** Local file source: one index file offering a single extension with a settings contract. */
async function createLocalRegistry() {
  const directory = path.join(temporary, "local-registry");
  const digests = await writeContents(path.join(directory, "content"), {
    "local-kit/extension.json": manifest("local-kit", "Local kit", "1.0.0", localKitSettings),
    "local-kit/server.mjs": extensionServer("local-kit 1.0.0"),
  });
  const index = path.join(directory, "trust-registry.json");
  await writeFile(
    index,
    JSON.stringify({
      contract: "trust.registry-index@2",
      base: "content",
      packages: [
        {
          name: "local-kit",
          version: "1.0.0",
          title: "Local kit",
          extension: extension(digests, "local-kit", "local-kit", "1.0.0", ["server.mjs"]),
        },
      ],
    }),
  );
  return index;
}

/** HTTP source: data-kit 1.0.0 first; publishing adds 2.0.0 (built) and 3.0.0 (whose build fails). */
function dataKit(version, build) {
  const directory = `data-kit-${version}`;
  const files = {
    [`${directory}/extension.json`]: manifest(
      "data-kit",
      "Data kit",
      version,
      dataPathSettings,
      build ? "./dist/server.mjs" : "./server.mjs",
    ),
    [`${directory}/data.operation.feature`]: operationSource("regui.data", version),
  };
  if (build) {
    files[`${directory}/package.json`] = buildPackage(build);
    files[`${directory}/build.mjs`] = buildScript;
    files[`${directory}/src/server.mjs`] = extensionServer(`data-kit ${version}`);
  } else files[`${directory}/server.mjs`] = extensionServer(`data-kit ${version}`);
  const digests = Object.fromEntries(Object.entries(files).map(([file, text]) => [file, sha256(text)]));
  const codeFiles = Object.keys(files)
    .filter((file) => !file.endsWith("extension.json") && !file.endsWith(".feature"))
    .map((file) => file.slice(directory.length + 1));
  return {
    files,
    declaration: {
      name: "data-kit",
      version,
      title: "Data kit",
      extension: extension(digests, directory, "data-kit", version, codeFiles),
      operations: [content(digests, `${directory}/data.operation.feature`, "regui.data", version)],
    },
  };
}
let httpFiles = {};
function publishHttp(versions) {
  const packages = versions.map(([version, build]) => dataKit(version, build));
  httpFiles = {
    "/registry/index.json": JSON.stringify({
      contract: "trust.registry-index@2",
      base: "files/",
      packages: packages.map((value) => value.declaration),
    }),
  };
  for (const value of packages)
    for (const [file, text] of Object.entries(value.files)) httpFiles[`/registry/files/${file}`] = text;
}
const FAILING_BUILD = "node -e \"console.error('compile error: data-kit 3.0.0 fixture'); process.exit(2)\"";

/** Operator installation file: one extension installed from a local manifest, outside any registry. */
async function createLocalManifest() {
  const directory = path.join(temporary, "manual-kit");
  await mkdir(directory, { recursive: true });
  // A declared workspace: its navigation entry is what the interface shows, the remote module is never loaded.
  await mkdir(path.join(directory, "ui"), { recursive: true });
  await writeFile(path.join(directory, "ui", "remoteEntry.js"), "export {};\n");
  await writeFile(
    path.join(directory, "extension.json"),
    JSON.stringify({
      ...JSON.parse(
        manifest("manual-kit", "Manual kit", "0.1.0", { type: "object", additionalProperties: false, properties: {} }),
      ),
      ui: { name: "manual_kit", entry: "remoteEntry.js", module: "./Page", assets: "./ui" },
    }),
  );
  await writeFile(path.join(directory, "server.mjs"), extensionServer("manual-kit 0.1.0"));
  const installations = path.join(temporary, "installations.json");
  await writeFile(
    installations,
    JSON.stringify({
      extensions: [
        {
          manifest: path.join(directory, "extension.json"),
          environment: "local",
          grants: [],
          credentialEnvironment: [],
          autoStart: false,
        },
      ],
    }),
  );
  return installations;
}

const gitRepository = await createGitRegistry();
const localIndex = await createLocalRegistry();
const installations = await createLocalManifest();
publishHttp([["1.0.0"]]);
const workspace = path.join(temporary, "workspace");
const dataDirectory = path.join(temporary, "data");
await mkdir(workspace, { recursive: true });
await mkdir(dataDirectory, { recursive: true });
await mkdir(path.join(temporary, "operations"), { recursive: true });

const fixtureDescription = {
  gitRepository,
  localIndex,
  httpIndex: `http://127.0.0.1:${FIXTURE_PORT}/registry/index.json`,
  dataDirectory,
  runtime: `http://127.0.0.1:${RUNTIME_PORT}`,
};
fixtures = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixtures");
  const json = (status, value) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  if (request.method === "GET" && url.pathname === "/control/fixture") return json(200, fixtureDescription);
  if (request.method === "POST" && url.pathname === "/control/publish") {
    publishHttp([["1.0.0"], ["2.0.0", "node build.mjs"], ["3.0.0", FAILING_BUILD]]);
    return json(200, { published: ["1.0.0", "2.0.0", "3.0.0"] });
  }
  if (request.method === "GET" && url.pathname === "/control/data") {
    const name = url.searchParams.get("name") ?? "";
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return json(400, { error: "invalid name" });
    return json(200, { exists: existsSync(path.join(dataDirectory, `${name}.data`)) });
  }
  const body = request.method === "GET" ? httpFiles[url.pathname] : undefined;
  response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/octet-stream" });
  response.end(body ?? "");
});
fixtures.listen(FIXTURE_PORT, "127.0.0.1");

// --- Runtime and interface ---------------------------------------------------------------------------------

start([path.join(root, "packages/trust-runtime/dist/src/index.js")], root, {
  TRUST_HOST: "127.0.0.1",
  TRUST_PORT: String(RUNTIME_PORT),
  TRUST_STORAGE: "pglite",
  TRUST_PGLITE_DIRECTORY: path.join(temporary, "runtime-pglite"),
  TRUST_OPERATIONS_DIRECTORY: path.join(temporary, "operations"),
  TRUST_PACKAGES_DIRECTORY: path.join(temporary, "packages"),
  TRUST_EXTENSIONS_FILE: installations,
  TRUST_SKILL_POLICY: "local",
});
await wait(`http://127.0.0.1:${RUNTIME_PORT}/health`);
const saved = await fetch(`http://127.0.0.1:${RUNTIME_PORT}/rpc`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "environment.save",
    params: { environment: "local", values: { workspaceRoot: workspace } },
  }),
}).then((response) => response.json());
if (saved.error) throw new Error(JSON.stringify(saved.error));

// The interface under test is built from the current sources into this disposable directory.
const webEnvironment = { TRUST_RUNTIME_URL: `http://127.0.0.1:${RUNTIME_PORT}`, TRUST_WEB_PORT: String(WEB_PORT) };
const webDist = path.join(temporary, "web-dist");
const vite = path.join(root, "node_modules/vite/bin/vite.js");
await run([vite, "build", "--outDir", webDist, "--emptyOutDir"], path.join(root, "apps/trust-web"), webEnvironment);
start(
  [vite, "preview", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--outDir", webDist],
  path.join(root, "apps/trust-web"),
  webEnvironment,
);
log(`ready: runtime ${RUNTIME_PORT}, web ${WEB_PORT}, fixtures ${FIXTURE_PORT}`);
await new Promise(() => {});
