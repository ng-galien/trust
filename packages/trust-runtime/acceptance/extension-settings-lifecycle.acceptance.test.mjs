import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeEntry = path.join(repository, "packages/trust-runtime/dist/src/index.js");
const corpusManifest = path.join(repository, "trust-extension/extensions/corpus/extension.json");
const SECRET = "probe-secret-value-7f3a";

let directory;
let runtimeDatabase;
let runtime;
const stores = {};
let corpusBefore;

const probeServer = `
export function createExtension({ configuration, publishChanged }) {
  return {
    async prepare() {}, async start() {}, async stop() {},
    async read({ path }) {
      if (path === "/instance") {
        const { token, ...visible } = configuration;
        return { status: 200, body: { pid: process.pid, configuration: visible, tokenResolved: token === ${JSON.stringify(SECRET)}, tokenAbsent: token === undefined } };
      }
      if (path === "/signal") { publishChanged(); return { status: 200, body: { signalled: true } }; }
      return { status: 404, body: {} };
    },
  };
}`;

const probeSettings = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["fast", "safe"], default: "safe" },
    port: { type: "integer", minimum: 1, maximum: 65535, default: 8080 },
    verbose: { type: "boolean", default: false },
    dataPath: { type: "string", format: "absolute-path" },
    endpoint: { type: "string", format: "uri" },
    logPath: { type: "string", format: "absolute-path" },
    token: { type: "string", format: "environment-credential", enum: ["PROBE_TOKEN"] },
  },
  required: ["token"],
  oneOf: [{ required: ["dataPath"] }, { required: ["endpoint"] }],
  dependentRequired: { logPath: ["verbose"] },
};

async function writeManifest(id, settings) {
  const file = path.join(directory, `${id}.json`);
  await writeFile(
    file,
    JSON.stringify({
      contract: "trust.extension@1",
      id,
      title: id,
      version: "1.0.0",
      server: "./probe.mjs",
      settings,
      requestedCapabilities: ["plans.read", "plans.subscribe"],
    }),
  );
  return file;
}

function runtimeEnvironment(extensionsFile) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TRUST_")));
  return {
    ...environment,
    PROBE_TOKEN: SECRET,
    TRUST_HOST: "127.0.0.1",
    TRUST_PORT: "0",
    TRUST_STORAGE: "pglite",
    TRUST_PGLITE_DIRECTORY: runtimeDatabase,
    TRUST_EXTENSIONS_FILE: extensionsFile,
  };
}

async function launch(extensionsFile) {
  const child = spawn(process.execPath, [runtimeEntry], { env: runtimeEnvironment(extensionsFile), stdio: "pipe" });
  let output = "";
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime did not listen: ${output}`)), 20_000);
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
      reject(Object.assign(new Error(`runtime exited (${code}): ${output}`), { output }));
    });
  });
  return { child, endpoint };
}

async function stopRuntime() {
  if (runtime && runtime.child.exitCode === null && runtime.child.signalCode === null) {
    const exited = once(runtime.child, "exit");
    runtime.child.kill("SIGTERM");
    const timer = setTimeout(() => runtime?.child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timer);
  }
  runtime = undefined;
}

async function http(method, suffix, body) {
  const response = await fetch(`${runtime.endpoint}/extensions/${suffix}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}
const updateSettings = (id, expectedRevision, settings) =>
  http("PUT", `${id}/settings`, { expectedRevision, settings });
const readSettings = async (id) => (await http("GET", `${id}/settings`)).body.settings;
const lifecycle = (id, action) => http("POST", `${id}/${action}`, {});
const descriptor = async (id) => (await http("GET", "")).body.extensions.find((value) => value.id === id);
async function corpusCommand(command, args) {
  const result = await http("POST", "corpus/commands", { command, arguments: args });
  assert.equal(result.status, 200, result.text);
  return result.body;
}

async function mcp(name, args) {
  const response = await fetch(`${runtime.endpoint}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const envelope = await response.json();
  return { isError: envelope.result.isError === true, body: JSON.parse(envelope.result.content[0].text) };
}

function childProcesses() {
  try {
    return execFileSync("pgrep", ["-P", String(runtime.child.pid)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

function openEvents(id) {
  const abort = new AbortController();
  const stream = { text: "", ended: false, abort: () => abort.abort() };
  stream.done = fetch(`${runtime.endpoint}/extensions/${id}/events`, { signal: abort.signal })
    .then(async (response) => {
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        stream.text += new TextDecoder().decode(next.value);
      }
      stream.ended = true;
    })
    .catch(() => {});
  return stream;
}

/** Logical content of every table of one store, read directly while no runtime owns it. */
async function dumpStore(dataDir, schema = "trust_corpus") {
  const database = await PGlite.create(dataDir);
  try {
    const tables = await database.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    const dump = {};
    for (const { table_name: table } of tables.rows) {
      const rows = await database.query(`SELECT row_to_json(t)::text AS row FROM ${schema}."${table}" t ORDER BY 1`);
      dump[table] = rows.rows.map((row) => row.row);
    }
    return dump;
  } finally {
    await database.close();
  }
}

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "trust-extension-settings-"));
  runtimeDatabase = path.join(directory, "runtime-db");
  for (const name of ["a", "b", "d"]) stores[name] = path.join(directory, "stores", name, "corpus-db");
  await writeFile(path.join(directory, "probe.mjs"), probeServer);
  const installations = [
    {
      manifest: await writeManifest("probe", probeSettings),
      configuration: { token: "PROBE_TOKEN", dataPath: "/srv/probe-initial" },
      environment: "local",
      grants: [],
      autoStart: false,
    },
    {
      manifest: await writeManifest("bystander", { type: "object", additionalProperties: false, properties: {} }),
      configuration: {},
      environment: "local",
      grants: [],
      autoStart: true,
    },
    {
      manifest: corpusManifest,
      configuration: { databasePath: stores.a },
      environment: "local",
      grants: [],
      autoStart: false,
    },
  ];
  await writeFile(path.join(directory, "extensions.json"), JSON.stringify({ extensions: installations }));
  runtime = await launch(path.join(directory, "extensions.json"));
});

after(async () => {
  await stopRuntime();
  await rm(directory, { recursive: true, force: true });
});

test("REG-100 AC1 settings schema types, required fields, defaults and cross-field constraints are validated with understandable errors", async () => {
  const initial = await readSettings("probe");
  assert.equal(initial.revision, 0);
  assert.equal(initial.source, "installation");
  assert.deepEqual(initial.schema.oneOf, probeSettings.oneOf);
  assert.deepEqual(initial.effective, {
    mode: "safe",
    port: 8080,
    verbose: false,
    dataPath: "/srv/probe-initial",
    token: "PROBE_TOKEN",
  });
  const token = "PROBE_TOKEN";
  const rejected = [
    [{ token, dataPath: "/srv/p", port: "8080" }, "/port", /port must be an integer/],
    [{ token, dataPath: "/srv/p", port: 70000 }, "/port", /port must be at most 65535/],
    [{ dataPath: "/srv/p" }, "/token", /token is required/],
    [
      { token, dataPath: "/srv/p", endpoint: "https://probe.example" },
      "",
      /exactly one of dataPath, endpoint must be configured \(2 are configured\)/,
    ],
    [{ token }, "", /exactly one of dataPath, endpoint must be configured \(none is configured\)/],
    [
      { token: "HOME", dataPath: "/srv/p" },
      "/token",
      /token must name one of the allowed environment variables: PROBE_TOKEN/,
    ],
    [{ token, dataPath: "relative/dir" }, "/dataPath", /dataPath must be an absolute path/],
    [
      { token, endpoint: "https://user:pw@probe.example" },
      "/endpoint",
      /must not embed a password; declare a credential reference/,
    ],
    [
      { token, dataPath: "/srv/p", logPath: "/var/log/p" },
      "/verbose",
      /verbose is required when logPath is configured/,
    ],
    [{ token, dataPath: "/srv/p", verbose: "yes" }, "/verbose", /verbose must be a boolean/],
    [{ token, dataPath: "/srv/p", unknown: 1 }, "/unknown", /unknown is not a declared setting/],
  ];
  for (const [settings, pointer, message] of rejected) {
    const result = await updateSettings("probe", 0, settings);
    assert.equal(result.status, 400, result.text);
    assert.equal(result.body.error.code, "invalid-extension-settings");
    assert.match(result.body.error.message, /^Extension settings are invalid: /);
    const issue = result.body.error.issues.find((value) => value.path === pointer);
    assert.ok(issue, `${JSON.stringify(settings)} -> ${result.text}`);
    assert.match(issue.message, message);
  }
  const several = await updateSettings("probe", 0, { dataPath: "rel", mode: "turbo" });
  assert.deepEqual(
    several.body.error.issues.map((value) => value.path).sort(),
    ["/dataPath", "/mode", "/token"],
    "every issue is reported at once",
  );
  assert.equal((await readSettings("probe")).revision, 0, "a refused update stores nothing");

  const mcpRejected = await mcp("trust_extension_settings_update", {
    extension: "probe",
    expectedRevision: 0,
    settings: { token, endpoint: "https://probe.example", port: 0 },
  });
  assert.equal(mcpRejected.isError, true);
  assert.equal(mcpRejected.body.error, "invalid-extension-settings");
  assert.match(mcpRejected.body.message, /port must be at least 1/);

  const accepted = await mcp("trust_extension_settings_update", {
    extension: "probe",
    expectedRevision: 0,
    settings: { token, endpoint: "https://probe.example/api", port: 9090 },
  });
  assert.equal(accepted.isError, false, JSON.stringify(accepted.body));
  assert.equal(accepted.body.settings.revision, 1);
  assert.deepEqual(accepted.body.settings.settings, { token, endpoint: "https://probe.example/api", port: 9090 });
  assert.deepEqual(accepted.body.settings.effective, {
    mode: "safe",
    port: 9090,
    verbose: false,
    endpoint: "https://probe.example/api",
    token,
  });
  const stale = await updateSettings("probe", 0, { token, dataPath: "/srv/p" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "extension-settings-conflict");

  // A manifest whose declaration contradicts itself is refused with the offending keyword named.
  const invalidManifest = path.join(directory, "invalid");
  await mkdir(invalidManifest);
  await writeFile(path.join(invalidManifest, "probe.mjs"), probeServer);
  await writeFile(
    path.join(invalidManifest, "extension.json"),
    JSON.stringify({
      contract: "trust.extension@1",
      id: "invalid",
      title: "invalid",
      version: "1.0.0",
      server: "./probe.mjs",
      settings: {
        ...probeSettings,
        properties: { ...probeSettings.properties, port: { type: "integer", default: "80" } },
      },
      requestedCapabilities: [],
    }),
  );
  const invalidFile = path.join(invalidManifest, "extensions.json");
  await writeFile(
    invalidFile,
    JSON.stringify({
      extensions: [
        { manifest: path.join(invalidManifest, "extension.json"), configuration: {}, environment: "local", grants: [] },
      ],
    }),
  );
  const saved = runtimeDatabase;
  runtimeDatabase = path.join(directory, "invalid-runtime-db");
  try {
    await assert.rejects(launch(invalidFile), (error) => {
      assert.match(error.output, /Invalid settings schema: settings\.properties\.port\.default must be an integer/);
      return true;
    });
  } finally {
    runtimeDatabase = saved;
  }
});

test("REG-100 AC3 settings values are stored by the runtime without credentials and applied to a new extension instance", async () => {
  const token = "PROBE_TOKEN";
  const stored = await updateSettings("probe", 1, { token, dataPath: "/srv/probe", mode: "fast" });
  assert.equal(stored.status, 200, stored.text);
  assert.equal((await lifecycle("probe", "prepare")).status, 200);
  assert.equal((await lifecycle("probe", "start")).status, 200);
  const first = (await http("GET", "probe/api/instance")).body;
  assert.deepEqual(first.configuration, { mode: "fast", port: 8080, verbose: false, dataPath: "/srv/probe" });
  assert.equal(first.tokenResolved, true, "the credential reference is resolved for the extension instance");

  const view = await http("GET", "probe/settings");
  assert.equal(view.body.settings.settings.token, token);
  assert.doesNotMatch(view.text, new RegExp(SECRET));
  const mcpView = await mcp("trust_extension_settings_read", { extension: "probe" });
  assert.equal(mcpView.body.settings.revision, 2);
  assert.doesNotMatch(JSON.stringify(mcpView.body), new RegExp(SECRET));

  const renewed = await updateSettings("probe", 2, { token, dataPath: "/srv/probe", mode: "safe" });
  assert.equal(renewed.status, 200, renewed.text);
  assert.equal(renewed.body.extension.state, "RUNNING");
  assert.equal(renewed.body.preparationRequired, false);
  const second = (await http("GET", "probe/api/instance")).body;
  assert.notEqual(second.pid, first.pid, "new settings run in a new extension instance");
  assert.equal(second.configuration.mode, "safe");
  await eventually(() => !alive(first.pid), "the previous instance process must exit");

  await stopRuntime();
  const database = await PGlite.create(runtimeDatabase);
  try {
    const rows = (await database.query("SELECT installation_id, settings_json, revision FROM extension_settings")).rows;
    assert.deepEqual(rows, [
      { installation_id: "probe", settings_json: { token, dataPath: "/srv/probe", mode: "safe" }, revision: 3 },
    ]);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(SECRET), "the runtime stores the reference, not the secret");
  } finally {
    await database.close();
  }
  runtime = await launch(path.join(directory, "extensions.json"));
  const restored = await readSettings("probe");
  assert.equal(restored.source, "runtime");
  assert.equal(restored.revision, 3);
  assert.equal((await lifecycle("probe", "start")).status, 200);
  const third = (await http("GET", "probe/api/instance")).body;
  assert.equal(third.configuration.mode, "safe");
  assert.equal(third.tokenResolved, true);
  assert.equal((await lifecycle("probe", "stop")).status, 200);
});

test("REG-120 AC2 start refuses an unprepared store and creates nothing", async () => {
  const refused = await lifecycle("corpus", "start");
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.error.code, "extension-storage-unprepared");
  assert.match(refused.body.error.message, /not prepared\. Run explicit preparation/);
  const state = await descriptor("corpus");
  assert.equal(state.state, "STOPPED");
  assert.equal(state.error.code, "extension-storage-unprepared");
  assert.equal(existsSync(stores.a), false, "start must not create the store");
  assert.equal(existsSync(path.dirname(stores.a)), false, "start must not create the store parent");
  const mcpRefused = await mcp("trust_extension_start", { extension: "corpus" });
  assert.equal(mcpRefused.isError, true);
  assert.equal(mcpRefused.body.error, "extension-storage-unprepared");
  assert.equal(existsSync(stores.a), false);
});

test("REG-120 AC1 explicit preparation creates an absent schema", async () => {
  const prepared = await lifecycle("corpus", "prepare");
  assert.equal(prepared.status, 200, prepared.text);
  assert.equal(prepared.body.extension.state, "STOPPED");
  assert.equal(prepared.body.extension.error, undefined);
  const dump = await dumpStore(stores.a);
  assert.deepEqual(dump.schema_version, ['{"version":5}']);
  assert.deepEqual(dump.corpora, []);
  assert.equal((await lifecycle("corpus", "start")).status, 200);
  assert.equal((await descriptor("corpus")).state, "RUNNING");
  await corpusCommand("corpora.create", { id: "alpha", title: "Alpha", description: "Kept in store A" });
  assert.deepEqual(
    (await corpusCommand("workspace.read", {})).corpora.map((value) => value.id),
    ["alpha"],
  );
});

test("REG-110 AC1 a reconfigured extension uses only the newly selected database", async () => {
  assert.equal((await lifecycle("corpus", "stop")).status, 200);
  corpusBefore = await dumpStore(stores.a);
  assert.equal((await lifecycle("corpus", "start")).status, 200);

  const reconfigured = await updateSettings("corpus", 0, { databasePath: stores.b });
  assert.equal(reconfigured.status, 200, reconfigured.text);
  assert.equal(reconfigured.body.preparationRequired, true);
  assert.equal(reconfigured.body.extension.state, "STOPPED");
  assert.equal(reconfigured.body.extension.error.code, "extension-storage-unprepared");
  assert.equal(existsSync(stores.b), false, "reconfiguration never prepares implicitly");
  assert.equal((await lifecycle("corpus", "prepare")).status, 200);
  assert.equal((await lifecycle("corpus", "start")).status, 200);
  assert.deepEqual((await corpusCommand("workspace.read", {})).corpora, [], "store A content is not visible");
  await corpusCommand("corpora.create", { id: "beta", title: "Beta", description: "Kept in store B" });
  assert.deepEqual(
    (await corpusCommand("workspace.read", {})).corpora.map((value) => value.id),
    ["beta"],
  );
  assert.equal((await lifecycle("corpus", "stop")).status, 200);
  const selected = await dumpStore(stores.b);
  assert.deepEqual(
    selected.corpora.map((row) => JSON.parse(row).id),
    ["beta"],
  );
  assert.equal((await lifecycle("corpus", "start")).status, 200);
});

test("REG-110 AC2 the previous database remains unchanged after reconfiguration", async () => {
  assert.equal((await readSettings("corpus")).settings.databasePath, stores.b);
  const previous = await dumpStore(stores.a);
  assert.deepEqual(previous, corpusBefore);
  assert.deepEqual(
    previous.corpora.map((row) => JSON.parse(row).id),
    ["alpha"],
  );
});

test("REG-110 AC3 reconfiguration releases the previous connections and subscriptions", async () => {
  const bystander = (await http("GET", "bystander/api/instance")).body.pid;
  const before = childProcesses().filter((pid) => pid !== bystander);
  assert.equal(before.length, 1, `only the corpus instance remains besides the bystander: ${before}`);
  const [previous] = before;
  const events = openEvents("corpus");
  await eventually(() => events.text.includes("resync"), "the corpus subscription must open");

  const reconfigured = await mcp("trust_extension_settings_update", {
    extension: "corpus",
    expectedRevision: 1,
    settings: { databasePath: stores.a },
  });
  assert.equal(reconfigured.isError, false, JSON.stringify(reconfigured.body));
  assert.equal(reconfigured.body.preparationRequired, false, "store A already has its schema");
  assert.equal(reconfigured.body.extension.state, "RUNNING");

  await eventually(() => events.ended, "the previous extension subscription must be closed");
  await eventually(() => !alive(previous), "the previous instance and its database connections must be released");
  const current = childProcesses().filter((pid) => pid !== bystander);
  assert.equal(current.length, 1);
  assert.notEqual(current[0], previous);
  assert.deepEqual(
    (await corpusCommand("workspace.read", {})).corpora.map((value) => value.id),
    ["alpha"],
  );
  events.abort();
});

test("REG-110 AC4 other running extensions are not interrupted by a reconfiguration", async () => {
  const before = (await http("GET", "bystander/api/instance")).body.pid;
  assert.equal((await descriptor("bystander")).state, "RUNNING");
  assert.equal((await descriptor("probe")).state, "STOPPED");
  const events = openEvents("bystander");
  await eventually(() => events.text.includes("resync"), "the bystander subscription must open");

  const reads = [];
  let reconfiguring = true;
  const reading = (async () => {
    while (reconfiguring) {
      reads.push((await http("GET", "bystander/api/instance")).status);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  const reconfigured = await updateSettings("corpus", 2, { databasePath: stores.b });
  reconfiguring = false;
  await reading;
  assert.equal(reconfigured.status, 200, reconfigured.text);
  assert.equal(reconfigured.body.extension.state, "RUNNING");
  assert.ok(reads.length > 0);
  assert.deepEqual([...new Set(reads)], [200], "the bystander served every request during the reconfiguration");

  assert.equal((await http("GET", "bystander/api/instance")).body.pid, before, "same bystander instance");
  assert.ok(childProcesses().includes(before));
  assert.equal((await descriptor("bystander")).state, "RUNNING");
  assert.equal((await descriptor("probe")).state, "STOPPED");
  assert.equal(events.ended, false, "the bystander subscription stays open");
  await http("GET", "bystander/api/signal");
  await eventually(() => events.text.includes("extension.changed"), "the bystander subscription keeps delivering");
  events.abort();
});

test("REG-120 AC3 an incompatible schema is reported and never replaced", async () => {
  await mkdir(path.dirname(stores.d), { recursive: true });
  const foreign = await PGlite.create(stores.d);
  await foreign.exec(`
    CREATE SCHEMA trust_corpus;
    CREATE TABLE trust_corpus.schema_version (version INTEGER NOT NULL);
    INSERT INTO trust_corpus.schema_version VALUES (99);
    CREATE TABLE trust_corpus.operator_notes (note TEXT NOT NULL);
    INSERT INTO trust_corpus.operator_notes VALUES ('keep this');
  `);
  await foreign.close();
  const original = await dumpStore(stores.d);

  const reconfigured = await updateSettings("corpus", 3, { databasePath: stores.d });
  assert.equal(reconfigured.status, 200, reconfigured.text);
  assert.equal(reconfigured.body.preparationRequired, false);
  assert.equal(reconfigured.body.extension.state, "STOPPED");
  assert.equal(reconfigured.body.extension.error.code, "extension-storage-incompatible");
  assert.match(reconfigured.body.extension.error.message, /incompatible schema\. It was left unchanged/);

  for (const action of ["prepare", "start"]) {
    const refused = await lifecycle("corpus", action);
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.error.code, "extension-storage-incompatible");
  }
  const status = await mcp("trust_extension_status", { extension: "corpus" });
  assert.equal(status.body.extension.error.code, "extension-storage-incompatible");
  assert.deepEqual(await dumpStore(stores.d), original, "the incompatible store is never replaced");
  assert.deepEqual((await dumpStore(stores.d)).schema_version, ['{"version":99}']);
});
