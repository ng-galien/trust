import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeEntry = path.join(repository, "packages/trust-runtime/dist/src/index.js");
const cliEntry = path.join(repository, "packages/trust-shell/bin/trust.js");
const BUILD_SECRET = "registry-build-secret-5c1e";

let root;
let packagesRoot;
let gitRepository;
let localIndex;
let workspace;
let runtime;
let registry;
let httpFiles = {};
const installed = {};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// --- Fixture sources -------------------------------------------------------------------------------------

let operationTemplate;
let procedureTemplate;
const operationSource = (name, version) =>
  operationTemplate.replace("@operation:git.head-read @version:1.0.0", `@operation:${name} @version:${version}`);
const procedureSource = (name, version, operation) =>
  procedureTemplate
    .replace("@procedure:git-status @version:2.0.0", `@procedure:${name} @version:${version}`)
    .replace('"git.head-read@*"', `"${operation}"`);

const extensionServer = (label, { failStart = false, deleteData = true } = {}) => `
import { rm, writeFile } from "node:fs/promises";
export function createExtension({ configuration }) {
  return {
    async prepare() { if (configuration.dataPath) await writeFile(configuration.dataPath, "fixture data"); },
    async start() { ${failStart ? 'throw new Error("fixture start failure");' : ""} },
    async stop() {},
    async read() { return { status: 200, body: { label: ${JSON.stringify(label)}, pid: process.pid } }; },
    ${deleteData ? "async deleteData() { if (configuration.dataPath) await rm(configuration.dataPath, { force: true }); }," : ""}
  };
}
`;
const extensionManifest = (id, version, server = "./server.mjs") =>
  JSON.stringify({
    contract: "trust.extension@1",
    id,
    title: `Fixture ${id}`,
    version,
    server,
    settings: {
      type: "object",
      additionalProperties: false,
      properties: { dataPath: { type: "string", format: "absolute-path" } },
    },
    requestedCapabilities: ["plans.read"],
  });
const buildScript = `
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await writeFile("dist/server.mjs", await readFile("src/server.mjs"));
await writeFile("build-environment.json", JSON.stringify(Object.keys(process.env)));
`;
const buildPackage = (build) =>
  JSON.stringify({ name: "fixture-extension", version: "0.0.0", private: true, type: "module", scripts: { build } });

/** Write files below a base directory and return their index declarations relative to that base. */
async function writeContents(baseDirectory, files) {
  const declarations = {};
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(baseDirectory, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    declarations[relative] = sha256(content);
  }
  return declarations;
}
const content = (digests, relative, name, version) => ({ path: relative, name, version, sha256: digests[relative] });
const extension = (digests, directory, id, version, files) => ({
  path: `${directory}/extension.json`,
  name: id,
  version,
  sha256: digests[`${directory}/extension.json`],
  files: files.map((file) => ({ path: `${directory}/${file}`, sha256: digests[`${directory}/${file}`] })),
});

async function createGitRegistry() {
  gitRepository = path.join(root, "git-registry");
  const base = path.join(gitRepository, "packages");
  const digests = await writeContents(base, {
    "code-kit/extension.json": extensionManifest("code-kit", "1.0.0"),
    "code-kit/server.mjs": extensionServer("code-kit"),
    "ops-kit/echo.operation.feature": operationSource("regfix.echo", "1.0.0"),
    "ops-kit/package.json": buildPackage("node -e \"require('fs').writeFileSync('BUILD-MARKER','built')\""),
    "ops-kit/UNDECLARED.txt": "not part of the package",
    "flow-kit/flow.procedure.feature": procedureSource("regfix-flow", "1.0.0", "regfix.echo@*"),
    "full-kit/extension.json": extensionManifest("full-kit", "1.0.0", "./dist/server.mjs"),
    "full-kit/package.json": buildPackage("node build.mjs"),
    "full-kit/build.mjs": buildScript,
    "full-kit/src/server.mjs": extensionServer("full-kit"),
    "full-kit/operations/full.operation.feature": operationSource("regfix.full", "1.0.0"),
    "full-kit/procedures/full.procedure.feature": procedureSource("regfix-full", "1.0.0", "regfix.full@^1"),
    "broken-kit/extension.json": extensionManifest("broken-kit", "1.0.0"),
    "broken-kit/package.json": buildPackage(
      "node -e \"console.error('compile error: broken fixture'); process.exit(2)\"",
    ),
    "broken-kit/server.mjs": extensionServer("broken-kit"),
    "broken-kit/broken.operation.feature": operationSource("regfix.broken", "1.0.0"),
    "broken-kit/broken.procedure.feature": procedureSource("regfix-broken", "1.0.0", "regfix.echo@*"),
  });
  const index = {
    contract: "trust.registry-index@2",
    base: "packages",
    packages: [
      {
        name: "code-kit",
        version: "1.0.0",
        extension: extension(digests, "code-kit", "code-kit", "1.0.0", ["server.mjs"]),
      },
      {
        name: "ops-kit",
        version: "1.0.0",
        operations: [content(digests, "ops-kit/echo.operation.feature", "regfix.echo", "1.0.0")],
      },
      {
        name: "flow-kit",
        version: "1.0.0",
        procedures: [content(digests, "flow-kit/flow.procedure.feature", "regfix-flow", "1.0.0")],
      },
      {
        name: "full-kit",
        version: "1.0.0",
        title: "Full kit",
        extension: extension(digests, "full-kit", "full-kit", "1.0.0", ["package.json", "build.mjs", "src/server.mjs"]),
        operations: [content(digests, "full-kit/operations/full.operation.feature", "regfix.full", "1.0.0")],
        procedures: [content(digests, "full-kit/procedures/full.procedure.feature", "regfix-full", "1.0.0")],
      },
      {
        name: "broken-kit",
        version: "1.0.0",
        extension: extension(digests, "broken-kit", "broken-kit", "1.0.0", ["package.json", "server.mjs"]),
        operations: [content(digests, "broken-kit/broken.operation.feature", "regfix.broken", "1.0.0")],
        procedures: [content(digests, "broken-kit/broken.procedure.feature", "regfix-broken", "1.0.0")],
      },
    ],
  };
  await writeFile(path.join(gitRepository, "trust-registry.json"), JSON.stringify(index, null, 2));
  const git = (...args) =>
    execFileAsync("git", ["-c", "user.name=Registry Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd: gitRepository,
    });
  await git("init", "--quiet", "--initial-branch=main");
  await git("add", "--all");
  await git("commit", "--quiet", "-m", "registry fixture");
}

async function createLocalRegistry() {
  const directory = path.join(root, "local-registry");
  const digests = await writeContents(path.join(directory, "content"), {
    "local-kit/extension.json": extensionManifest("local-kit", "1.0.0"),
    "local-kit/server.mjs": extensionServer("local-kit", { deleteData: false }),
  });
  localIndex = path.join(directory, "trust-registry.json");
  await writeFile(
    localIndex,
    JSON.stringify({
      contract: "trust.registry-index@2",
      base: "content",
      packages: [
        {
          name: "local-kit",
          version: "1.0.0",
          extension: extension(digests, "local-kit", "local-kit", "1.0.0", ["server.mjs"]),
        },
      ],
    }),
  );
}

/** data-kit versions served over HTTP: 2.0.0 works, 3.0.0 fails its build, 4.0.0 fails to start. */
function dataKit(version, { build, failStart = false } = {}) {
  const files = {
    [`data-kit-${version}/extension.json`]: extensionManifest(
      "data-kit",
      version,
      build ? "./dist/server.mjs" : "./server.mjs",
    ),
    [`data-kit-${version}/data.operation.feature`]: operationSource("regfix.data", version),
    [`data-kit-${version}/data.procedure.feature`]: procedureSource(
      "regfix-data",
      version,
      `regfix.data@^${version.split(".")[0]}`,
    ),
  };
  if (build) {
    files[`data-kit-${version}/package.json`] = buildPackage(build);
    files[`data-kit-${version}/build.mjs`] = buildScript;
    files[`data-kit-${version}/src/server.mjs`] = extensionServer(`data-kit ${version}`, { failStart });
  } else files[`data-kit-${version}/server.mjs`] = extensionServer(`data-kit ${version}`, { failStart });
  const digests = Object.fromEntries(Object.entries(files).map(([file, text]) => [file, sha256(text)]));
  const directory = `data-kit-${version}`;
  const extensionFiles = Object.keys(files)
    .filter((file) => !file.endsWith("extension.json") && !file.endsWith(".feature"))
    .map((file) => file.slice(directory.length + 1));
  return {
    files,
    declaration: {
      name: "data-kit",
      version,
      extension: extension(digests, directory, "data-kit", version, extensionFiles),
      operations: [content(digests, `${directory}/data.operation.feature`, "regfix.data", version)],
      procedures: [content(digests, `${directory}/data.procedure.feature`, "regfix-data", version)],
    },
  };
}
function serveHttpIndex(versions) {
  const packages = versions.map((value) => dataKit(...value));
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

// --- Runtime and public surfaces --------------------------------------------------------------------------

async function launch() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TRUST_")));
  const child = spawn(process.execPath, [runtimeEntry], {
    env: {
      ...environment,
      REGISTRY_TEST_SECRET: BUILD_SECRET,
      TRUST_HOST: "127.0.0.1",
      TRUST_PORT: "0",
      TRUST_STORAGE: "pglite",
      TRUST_PGLITE_DIRECTORY: path.join(root, "pglite"),
      TRUST_OPERATIONS_DIRECTORY: path.join(root, "operations"),
      TRUST_PACKAGES_DIRECTORY: packagesRoot,
    },
    stdio: "pipe",
  });
  let output = "";
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime did not listen: ${output}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/TRUST runtime listening on (127\.0\.0\.1):(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`runtime exited (${code}): ${output}`));
    });
  });
  return { child, endpoint };
}

async function call(method, params) {
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.json();
}
async function rpc(method, params) {
  const envelope = await call(method, params);
  assert.equal(envelope.error, undefined, `${method}: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}
async function rpcFailure(method, params) {
  const envelope = await call(method, params);
  assert.ok(envelope.error, `${method} unexpectedly succeeded: ${JSON.stringify(envelope.result)}`);
  return envelope.error;
}
async function mcp(name, args) {
  const response = await fetch(`${runtime.endpoint}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const envelope = await response.json();
  assert.ok(envelope.result, JSON.stringify(envelope));
  return { isError: envelope.result.isError === true, body: JSON.parse(envelope.result.content[0].text) };
}
async function extensions(suffix = "", method = "GET", body) {
  const response = await fetch(`${runtime.endpoint}/extensions/${suffix}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const descriptor = async (id) => (await extensions()).body.extensions.find((value) => value.id === id);
const installedPackages = async () => (await rpc("registry.package.list", {})).packages;
const installedPackage = async (name) => (await installedPackages()).find((value) => value.name === name);
const available = async (source, name, version) =>
  (await rpc("registry.source.read", { name: source })).packages.find(
    (value) => value.name === name && (version === undefined || value.version === version),
  );
async function filesBelow(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}
const stagingEntries = async () =>
  existsSync(path.join(packagesRoot, ".staging")) ? readdir(path.join(packagesRoot, ".staging")) : [];

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "trust-registry-packages-"));
  packagesRoot = path.join(root, "packages-root");
  workspace = path.join(root, "workspace");
  await mkdir(path.join(root, "operations"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  operationTemplate = await readFile(path.join(repository, "assets/operations/git.head-read.feature"), "utf8");
  procedureTemplate = await readFile(path.join(repository, "assets/procedures/00-git-status.feature"), "utf8");
  await createGitRegistry();
  await createLocalRegistry();
  serveHttpIndex([["1.0.0"]]);
  registry = createServer((request, response) => {
    const body = httpFiles[new URL(request.url, "http://registry").pathname];
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/octet-stream" });
    response.end(body ?? "");
  });
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  runtime = await launch();
  await rpc("environment.save", { environment: "local", values: { workspaceRoot: workspace } });
});

after(async () => {
  if (runtime && runtime.child.exitCode === null) {
    const exited = once(runtime.child, "exit");
    runtime.child.kill("SIGTERM");
    await exited;
  }
  registry?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

// --- Contract assertions ----------------------------------------------------------------------------------

test("REG-030 AC1 git and local file registry sources are accepted", async () => {
  const git = await rpc("registry.source.save", {
    name: "git-registry",
    kind: "git",
    url: gitRepository,
    reference: "main",
  });
  assert.equal(git.source.kind, "git");
  assert.equal(git.source.reference, "main");

  const relative = await rpcFailure("registry.source.save", {
    name: "relative",
    kind: "file",
    url: "registry/index.json",
  });
  assert.equal(relative.data.reason, "invalid-source");

  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TRUST_")));
  const cli = await execFileAsync(
    process.execPath,
    [cliEntry, "registry", "add", "local-registry", "file", localIndex],
    {
      cwd: root,
      env: { ...environment, TRUST_URL: runtime.endpoint },
    },
  );
  assert.match(cli.stdout, /Registry source local-registry saved/);
  assert.deepEqual(
    (await rpc("registry.source.list", {})).sources.map(({ name, kind, url }) => ({ name, kind, url })),
    [
      { name: "git-registry", kind: "git", url: gitRepository },
      { name: "local-registry", kind: "file", url: localIndex },
    ],
  );

  const unread = await rpcFailure("registry.source.read", { name: "git-registry" });
  assert.equal(unread.data.reason, "index-not-refreshed");

  const gitIndex = await rpc("registry.source.refresh", { name: "git-registry" });
  assert.equal(gitIndex.contract, "trust.registry-source-index@1");
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitRepository });
  assert.equal(gitIndex.revision, head.trim());
  assert.deepEqual(
    gitIndex.packages.map(({ name, version }) => `${name}@${version}`),
    ["code-kit@1.0.0", "ops-kit@1.0.0", "flow-kit@1.0.0", "full-kit@1.0.0", "broken-kit@1.0.0"],
  );

  const localRefresh = await mcp("trust_registry_source_refresh", { name: "local-registry" });
  assert.equal(localRefresh.isError, false);
  assert.equal(localRefresh.body.revision, sha256(await readFile(localIndex)));
  assert.deepEqual(
    localRefresh.body.packages.map(({ name }) => name),
    ["local-kit"],
  );
  assert.deepEqual(await rpc("registry.source.read", { name: "local-registry" }), localRefresh.body);
});

test("REG-030 AC2 each extension declared by a source is individually selectable", async () => {
  const result = await rpc("registry.package.install", {
    source: "git-registry",
    package: "code-kit",
    version: "1.0.0",
    extension: {
      environment: "local",
      grants: ["plans.read"],
      settings: { dataPath: path.join(root, "code-kit.data") },
    },
  });
  installed["code-kit"] = result;
  assert.equal(result.contract, "trust.registry-package-installation@1");
  assert.equal(result.extension.id, "code-kit");
  assert.equal(result.extension.state, "STOPPED");
  assert.deepEqual(
    (await installedPackages()).map(({ name }) => name),
    ["code-kit"],
  );
  const index = await rpc("registry.source.read", { name: "git-registry" });
  assert.deepEqual(Object.fromEntries(index.packages.map(({ name, installedVersion }) => [name, installedVersion])), {
    "code-kit": "1.0.0",
    "ops-kit": null,
    "flow-kit": null,
    "full-kit": null,
    "broken-kit": null,
  });
  const ids = (await extensions()).body.extensions.map(({ id }) => id);
  assert.ok(ids.includes("code-kit"));
  assert.ok(!ids.includes("full-kit") && !ids.includes("broken-kit"));
});

test("REG-040 AC1 code only, procedures only, operations only and combined packages are accepted", async () => {
  const categories = Object.fromEntries(
    (await rpc("registry.source.read", { name: "git-registry" })).packages.map(({ name, categories }) => [
      name,
      categories,
    ]),
  );
  assert.deepEqual(categories["code-kit"], ["extension"]);
  assert.deepEqual(categories["ops-kit"], ["operations"]);
  assert.deepEqual(categories["flow-kit"], ["procedures"]);
  assert.deepEqual(categories["full-kit"], ["extension", "operations", "procedures"]);

  installed["ops-kit"] = await rpc("registry.package.install", {
    source: "git-registry",
    package: "ops-kit",
    version: "1.0.0",
  });
  installed["flow-kit"] = await rpc("registry.package.install", {
    source: "git-registry",
    package: "flow-kit",
    version: "1.0.0",
  });
  installed["full-kit"] = await rpc("registry.package.install", {
    source: "git-registry",
    package: "full-kit",
    version: "1.0.0",
    extension: { environment: "local", grants: [] },
  });
  installed["local-kit"] = await rpc("registry.package.install", {
    source: "local-registry",
    package: "local-kit",
    version: "1.0.0",
    extension: { environment: "local" },
  });

  assert.equal((await rpc("operation.read", { operation: "regfix.echo", version: "1.0.0" })).operation, "regfix.echo");
  assert.equal(
    (await rpc("procedure.read", { procedure: "regfix-flow", version: "1.0.0" })).procedure.procedure,
    "regfix-flow",
  );
  assert.equal((await rpc("operation.read", { operation: "regfix.full", version: "1.0.0" })).operation, "regfix.full");
  assert.equal(
    (await rpc("procedure.read", { procedure: "regfix-full", version: "1.0.0" })).procedure.procedure,
    "regfix-full",
  );
  assert.equal((await descriptor("full-kit")).version, "1.0.0");
  assert.equal((await descriptor("local-kit")).version, "1.0.0");
  assert.deepEqual(Object.fromEntries((await installedPackages()).map(({ name, categories }) => [name, categories])), {
    "code-kit": ["extension"],
    "flow-kit": ["procedures"],
    "full-kit": ["extension", "operations", "procedures"],
    "local-kit": ["extension"],
    "ops-kit": ["operations"],
  });
});

test("REG-040 AC2 a package without code is installed without a build", async () => {
  for (const name of ["ops-kit", "flow-kit"]) {
    assert.equal(installed[name].steps.build, "skipped");
    assert.equal(installed[name].extension, null);
    assert.equal(installed[name].steps.extension, "skipped");
  }
  assert.equal(installed["code-kit"].steps.build, "skipped");
  assert.equal(installed["full-kit"].steps.build, "completed");
  const opsDirectory = installed["ops-kit"].package.directory;
  assert.deepEqual(await filesBelow(opsDirectory), ["ops-kit/echo.operation.feature"]);
  assert.equal(existsSync(path.join(gitRepository, "packages/ops-kit/BUILD-MARKER")), false);
  assert.ok(existsSync(path.join(installed["full-kit"].package.directory, "full-kit/dist/server.mjs")));
  const unbuilt = (await rpc("registry.source.read", { name: "git-registry" })).packages;
  assert.deepEqual(Object.fromEntries(unbuilt.map(({ name, buildRequired }) => [name, buildRequired])), {
    "code-kit": false,
    "ops-kit": false,
    "flow-kit": false,
    "full-kit": true,
    "broken-kit": true,
  });
});

test("REG-050 AC1 every declared package content is located by the index", async () => {
  const fullKit = await available("git-registry", "full-kit");
  assert.deepEqual(
    fullKit.contents.map(({ kind, path: relative, name, version }) =>
      name === undefined ? { kind, path: relative } : { kind, path: relative, name, version },
    ),
    [
      { kind: "extension", path: "full-kit/extension.json", name: "full-kit", version: "1.0.0" },
      { kind: "extension-file", path: "full-kit/package.json", name: undefined, version: undefined },
      { kind: "extension-file", path: "full-kit/build.mjs", name: undefined, version: undefined },
      { kind: "extension-file", path: "full-kit/src/server.mjs", name: undefined, version: undefined },
      { kind: "operation", path: "full-kit/operations/full.operation.feature", name: "regfix.full", version: "1.0.0" },
      { kind: "procedure", path: "full-kit/procedures/full.procedure.feature", name: "regfix-full", version: "1.0.0" },
    ].map((value) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))),
  );
  for (const located of fullKit.contents) {
    const bytes = await readFile(path.join(gitRepository, ...located.location.split("/")));
    assert.equal(sha256(bytes), located.sha256, located.location);
    const placed = await readFile(path.join(installed["full-kit"].package.directory, ...located.path.split("/")));
    assert.equal(sha256(placed), located.sha256, located.path);
  }
  const localKit = await available("local-registry", "local-kit");
  for (const located of localKit.contents) assert.equal(sha256(await readFile(located.location)), located.sha256);
});

test("REG-050 AC2 content paths resolve from the declared index base", async () => {
  const gitIndex = await rpc("registry.source.read", { name: "git-registry" });
  assert.equal(gitIndex.base, "packages");
  for (const value of gitIndex.packages)
    for (const located of value.contents) assert.equal(located.location, `packages/${located.path}`);
  const localIndexView = await rpc("registry.source.read", { name: "local-registry" });
  const localBase = path.join(path.dirname(localIndex), "content");
  assert.equal(localIndexView.base, localBase);
  for (const located of localIndexView.packages[0].contents)
    assert.equal(located.location, path.join(localBase, ...located.path.split("/")));

  const escaping = path.join(root, "escaping", "trust-registry.json");
  await mkdir(path.dirname(escaping), { recursive: true });
  await writeFile(escaping, JSON.stringify({ contract: "trust.registry-index@2", base: "../content", packages: [] }));
  await rpc("registry.source.save", { name: "escaping", kind: "file", url: escaping });
  assert.equal((await rpcFailure("registry.source.refresh", { name: "escaping" })).data.reason, "invalid-index");
  await rpc("registry.source.remove", { name: "escaping" });
});

test("REG-050 AC3 one source references several extensions", async () => {
  const extensionPackages = (await rpc("registry.source.read", { name: "git-registry" })).packages
    .filter(({ categories }) => categories.includes("extension"))
    .map(({ name, contents }) => ({ name, extension: contents.find(({ kind }) => kind === "extension").name }));
  assert.deepEqual(extensionPackages, [
    { name: "code-kit", extension: "code-kit" },
    { name: "full-kit", extension: "full-kit" },
    { name: "broken-kit", extension: "broken-kit" },
  ]);
  const fromGit = (await installedPackages()).filter(({ source, extension }) => source === "git-registry" && extension);
  assert.deepEqual(
    fromGit.map(({ extension }) => extension.id),
    ["code-kit", "full-kit"],
  );
  for (const { extension } of fromGit) assert.equal((await descriptor(extension.id)).version, extension.version);
});

test("REG-060 AC2 refreshing an index never updates an installed package", async () => {
  await rpc("registry.source.save", {
    name: "web",
    kind: "http",
    url: `http://127.0.0.1:${registry.address().port}/registry/index.json`,
  });
  await rpc("registry.source.refresh", { name: "web" });
  installed["data-kit"] = await rpc("registry.package.install", {
    source: "web",
    package: "data-kit",
    version: "1.0.0",
    extension: { environment: "local", settings: { dataPath: path.join(root, "data-kit.data") } },
  });
  assert.equal((await extensions("data-kit/prepare", "POST", {})).status, 200);
  assert.equal((await extensions("data-kit/start", "POST", {})).status, 200);
  const before = (await extensions("data-kit/api/")).body;

  serveHttpIndex([
    ["1.0.0"],
    ["2.0.0", { build: "node build.mjs" }],
    ["3.0.0", { build: 'node -e "process.exit(3)"' }],
    ["4.0.0", { failStart: true }],
  ]);
  const refreshed = await rpc("registry.source.refresh", { name: "web" });
  assert.deepEqual(
    refreshed.packages.map(({ version, installedVersion }) => ({ version, installedVersion })),
    ["1.0.0", "2.0.0", "3.0.0", "4.0.0"].map((version) => ({ version, installedVersion: "1.0.0" })),
  );
  await rpc("registry.source.refresh", { name: "git-registry" });

  const dataKit = await installedPackage("data-kit");
  assert.equal(dataKit.version, "1.0.0");
  assert.equal(dataKit.directory, path.join(packagesRoot, "data-kit", "1.0.0"));
  assert.equal(existsSync(path.join(packagesRoot, "data-kit", "2.0.0")), false);
  const running = await descriptor("data-kit");
  assert.deepEqual({ version: running.version, state: running.state }, { version: "1.0.0", state: "RUNNING" });
  assert.deepEqual((await extensions("data-kit/api/")).body, before);
  assert.equal((await installedPackage("code-kit")).version, "1.0.0");
  const missing = await rpcFailure("procedure.read", { procedure: "regfix-data", version: "2.0.0" });
  assert.ok(missing);
});

test("REG-070 AC1 a package installs under its package and version directory", async () => {
  for (const name of ["code-kit", "ops-kit", "flow-kit", "full-kit", "local-kit", "data-kit"]) {
    const value = await installedPackage(name);
    assert.equal(value.directory, path.join(packagesRoot, name, value.version));
    assert.equal(installed[name].package.directory, value.directory);
    assert.ok(existsSync(value.directory));
  }
  assert.deepEqual((await readdir(packagesRoot)).filter((entry) => entry !== ".staging").sort(), [
    "code-kit",
    "data-kit",
    "flow-kit",
    "full-kit",
    "local-kit",
    "ops-kit",
  ]);
  assert.deepEqual(await stagingEntries(), []);
  assert.deepEqual(await filesBelow(path.join(packagesRoot, "code-kit", "1.0.0")), [
    "code-kit/extension.json",
    "code-kit/server.mjs",
  ]);
});

test("REG-070 AC2 only the declared content categories are processed", async () => {
  assert.deepEqual(
    installed["ops-kit"].catalog.map(({ kind, name }) => `${kind}:${name}`),
    ["operation:regfix.echo"],
  );
  assert.deepEqual(
    installed["flow-kit"].catalog.map(({ kind, name }) => `${kind}:${name}`),
    ["procedure:regfix-flow"],
  );
  assert.deepEqual(installed["code-kit"].catalog, []);
  assert.equal(installed["code-kit"].steps.catalog, "skipped");
  assert.deepEqual(installed["full-kit"].steps, {
    acquisition: "completed",
    verification: "completed",
    build: "completed",
    placement: "completed",
    catalog: "completed",
    extension: "completed",
  });
  const ids = (await extensions()).body.extensions.map(({ id }) => id);
  assert.ok(!ids.includes("ops-kit") && !ids.includes("flow-kit"));
  assert.deepEqual(await filesBelow(installed["flow-kit"].package.directory), ["flow-kit/flow.procedure.feature"]);
  const operations = (await rpc("operation.list", {})).operations.map(({ operation }) => operation).sort();
  assert.deepEqual(operations, ["regfix.data", "regfix.echo", "regfix.full"]);
});

test("REG-070 AC3 a failed build installs nothing", async () => {
  const failure = await rpcFailure("registry.package.install", {
    source: "git-registry",
    package: "broken-kit",
    version: "1.0.0",
    extension: { environment: "local" },
  });
  assert.equal(failure.code, -32_050);
  assert.equal(failure.data.reason, "build-failed");
  assert.equal(failure.data.step, "build");
  assert.match(failure.data.output, /compile error: broken fixture/);
  assert.equal(await installedPackage("broken-kit"), undefined);
  assert.equal(existsSync(path.join(packagesRoot, "broken-kit")), false);
  assert.deepEqual(await stagingEntries(), []);
  assert.equal(await descriptor("broken-kit"), undefined);
  assert.ok(await rpcFailure("operation.read", { operation: "regfix.broken", version: "1.0.0" }));
  assert.ok(await rpcFailure("procedure.read", { procedure: "regfix-broken", version: "1.0.0" }));

  const buildEnvironment = JSON.parse(
    await readFile(path.join(installed["full-kit"].package.directory, "full-kit/build-environment.json"), "utf8"),
  );
  assert.ok(buildEnvironment.includes("PATH"));
  assert.deepEqual(
    buildEnvironment.filter((name) => name.startsWith("TRUST_") || name === "REGISTRY_TEST_SECRET"),
    [],
  );
});

test("REG-080 AC1 installed and target versions are reported before update", async () => {
  const dataKit = await installedPackage("data-kit");
  assert.equal(dataKit.version, "1.0.0");
  assert.deepEqual(dataKit.availableVersions, ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]);
  assert.equal(dataKit.latestVersion, "4.0.0");
  assert.equal((await available("web", "data-kit", "2.0.0")).installedVersion, "1.0.0");
  const same = await rpcFailure("registry.package.update", { package: "data-kit", version: "1.0.0" });
  assert.equal(same.data.reason, "package-version-installed");
  const unknown = await rpcFailure("registry.package.update", { package: "data-kit", version: "9.0.0" });
  assert.equal(unknown.data.reason, "unknown-package");
  assert.equal((await installedPackage("data-kit")).version, "1.0.0");
});

test("REG-080 AC2 existing Plans keep their pinned versions after update", async () => {
  await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "regfix-data",
    procedureVersion: "1.0.0",
    plan: "registry-pinned",
    environment: "local",
    rootInputs: { repository: "fixture" },
    mode: "dry-run",
  });
  const pinned = (plan) => ({
    procedure: plan.procedure,
    procedureVersion: plan.procedureVersion,
    revision: plan.revision,
    checks: plan.checks.map(({ checkUri, operation, state }) => ({ checkUri, operation, state })),
  });
  const beforeUpdate = pinned(await rpc("plan.read", { plan: "registry-pinned" }));
  const update = await rpc("registry.package.update", { package: "data-kit", version: "2.0.0" });
  assert.equal(update.contract, "trust.registry-package-update@1");
  assert.equal(update.previousVersion, "1.0.0");
  assert.equal(update.package.version, "2.0.0");
  assert.equal(update.steps.build, "completed");
  assert.deepEqual(update.extension && { version: update.extension.version, state: update.extension.state }, {
    version: "2.0.0",
    state: "RUNNING",
  });
  assert.deepEqual(update.removed, [
    { kind: "files", name: path.join(packagesRoot, "data-kit", "1.0.0"), version: "1.0.0" },
  ]);
  assert.equal((await extensions("data-kit/api/")).body.label, "data-kit 2.0.0");

  const plan = pinned(await rpc("plan.read", { plan: "registry-pinned" }));
  assert.deepEqual(plan, beforeUpdate);
  assert.equal(plan.procedure, "regfix-data");
  assert.equal(plan.procedureVersion, "1.0.0");
  assert.deepEqual(
    plan.checks.map(({ operation, state }) => ({ operation, state })),
    [{ operation: "regfix.data", state: "OPEN" }],
  );
  assert.equal(
    (await rpc("procedure.read", { procedure: "regfix-data", version: "1.0.0" })).procedure.version,
    "1.0.0",
  );
  assert.equal(
    (await rpc("procedure.read", { procedure: "regfix-data", version: "2.0.0" })).procedure.version,
    "2.0.0",
  );
  assert.equal((await rpc("operation.read", { operation: "regfix.data", version: "1.0.0" })).version, "1.0.0");
});

test("REG-080 AC3 a failed update keeps the previous version running", async () => {
  const before = (await extensions("data-kit/api/")).body;
  const failedBuild = await rpcFailure("registry.package.update", { package: "data-kit", version: "3.0.0" });
  assert.equal(failedBuild.data.reason, "build-failed");
  assert.deepEqual((await extensions("data-kit/api/")).body, before);

  const failedStart = await rpcFailure("registry.package.update", { package: "data-kit", version: "4.0.0" });
  assert.equal(failedStart.data.reason, "extension-start-failed");
  assert.equal(failedStart.data.step, "extension");
  const running = await descriptor("data-kit");
  assert.deepEqual({ version: running.version, state: running.state }, { version: "2.0.0", state: "RUNNING" });
  assert.equal((await extensions("data-kit/api/")).body.label, "data-kit 2.0.0");

  const dataKit = await installedPackage("data-kit");
  assert.equal(dataKit.version, "2.0.0");
  assert.deepEqual(await readdir(path.join(packagesRoot, "data-kit")), ["2.0.0"]);
  assert.deepEqual(await stagingEntries(), []);
  assert.ok(await rpcFailure("procedure.read", { procedure: "regfix-data", version: "4.0.0" }));
  assert.ok(await rpcFailure("operation.read", { operation: "regfix.data", version: "3.0.0" }));
});

test("REG-090 AC1 uninstall reports removed and kept items", async () => {
  const result = await mcp("trust_registry_package_uninstall", { package: "full-kit" });
  assert.equal(result.isError, false);
  assert.equal(result.body.contract, "trust.registry-package-uninstallation@1");
  assert.deepEqual(result.body.package, { name: "full-kit", version: "1.0.0", source: "git-registry" });
  assert.deepEqual(result.body.removed, [
    { kind: "extension", name: "full-kit", version: "1.0.0" },
    { kind: "extension-settings", name: "full-kit" },
    { kind: "files", name: path.join(packagesRoot, "full-kit", "1.0.0"), version: "1.0.0" },
  ]);
  assert.deepEqual(
    result.body.kept.map(({ kind, name, version }) => ({ kind, name, version })),
    [
      { kind: "extension-data", name: "full-kit", version: undefined },
      { kind: "operation", name: "regfix.full", version: "1.0.0" },
      { kind: "procedure", name: "regfix-full", version: "1.0.0" },
      { kind: "plans", name: "*", version: undefined },
      { kind: "source", name: "git-registry", version: undefined },
    ],
  );
  assert.ok(result.body.kept.every(({ reason }) => typeof reason === "string" && reason.length > 0));
  assert.equal(existsSync(path.join(packagesRoot, "full-kit")), false);
  assert.equal(await descriptor("full-kit"), undefined);
  assert.equal(await installedPackage("full-kit"), undefined);
  assert.equal((await rpc("operation.read", { operation: "regfix.full", version: "1.0.0" })).operation, "regfix.full");
  assert.equal((await available("git-registry", "full-kit")).installedVersion, null);
});

test("REG-090 AC2 removing a source does not uninstall its packages", async () => {
  const removal = await rpc("registry.source.remove", { name: "web" });
  assert.deepEqual(removal, {
    contract: "trust.registry-source-removal@1",
    name: "web",
    removed: true,
    keptPackages: ["data-kit"],
  });
  assert.equal((await rpcFailure("registry.source.read", { name: "web" })).data.reason, "unknown-source");
  const dataKit = await installedPackage("data-kit");
  assert.deepEqual(
    { version: dataKit.version, source: dataKit.source, availableVersions: dataKit.availableVersions },
    { version: "2.0.0", source: "web", availableVersions: [] },
  );
  assert.ok(existsSync(dataKit.directory));
  const running = await descriptor("data-kit");
  assert.deepEqual({ version: running.version, state: running.state }, { version: "2.0.0", state: "RUNNING" });
  assert.equal((await extensions("data-kit/api/")).body.label, "data-kit 2.0.0");
});

test("REG-090 AC3 package data is deleted only on explicit request", async () => {
  const dataFile = path.join(root, "code-kit.data");
  assert.equal((await extensions("code-kit/prepare", "POST", {})).status, 200);
  assert.equal(await readFile(dataFile, "utf8"), "fixture data");

  const kept = await rpc("registry.package.uninstall", { package: "code-kit" });
  assert.deepEqual(kept.kept[0], {
    kind: "extension-data",
    name: "code-kit",
    reason: "data is deleted only on explicit request",
  });
  assert.ok(!kept.removed.some(({ kind }) => kind === "extension-data"));
  assert.equal(await readFile(dataFile, "utf8"), "fixture data");

  await rpc("registry.package.install", {
    source: "git-registry",
    package: "code-kit",
    version: "1.0.0",
    extension: { environment: "local", settings: { dataPath: dataFile } },
  });
  const deleted = await rpc("registry.package.uninstall", { package: "code-kit", deleteData: true });
  assert.deepEqual(
    deleted.removed.find(({ kind }) => kind === "extension-data"),
    { kind: "extension-data", name: "code-kit" },
  );
  assert.ok(!deleted.kept.some(({ kind }) => kind === "extension-data"));
  assert.equal(existsSync(dataFile), false);

  const unsupported = await rpcFailure("registry.package.uninstall", { package: "local-kit", deleteData: true });
  assert.equal(unsupported.data.reason, "data-deletion-unsupported");
  assert.equal((await installedPackage("local-kit")).version, "1.0.0");
  assert.equal((await descriptor("local-kit")).version, "1.0.0");

  const dataKitFile = path.join(root, "data-kit.data");
  assert.ok(existsSync(dataKitFile));
  const dataKit = await rpc("registry.package.uninstall", { package: "data-kit" });
  assert.ok(dataKit.kept.some(({ kind }) => kind === "extension-data"));
  assert.ok(!dataKit.kept.some(({ kind }) => kind === "source"));
  assert.ok(existsSync(dataKitFile));
});
