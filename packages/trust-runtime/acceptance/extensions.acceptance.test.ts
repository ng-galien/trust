import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./support/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("installed extensions expose bounded lifecycle, confined assets, filtered Plan reads and live invalidation through HTTP", {
  timeout: 40_000,
}, async ({ startRuntime }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extensions-"));
  await mkdir(path.join(directory, "dist"));
  await writeFile(path.join(directory, "outside.txt"), "private-data");
  await writeFile(path.join(directory, "dist", "remoteEntry.js"), "export const remote = true;");
  await symlink(path.join(directory, "outside.txt"), path.join(directory, "dist", "escape.txt"));
  await writeFile(
    path.join(directory, "server.mjs"),
    `
export function createExtension({ publishChanged, configuration }) {
  return {
    async prepare() { if (configuration.mode === 'auto') throw new Error('autoStart must not prepare'); }, async start() {}, async stop() {},
    async read({path}) {
      if (path === '/crash') process.exit(1);
      if (path === '/hang') return new Promise(() => {});
      if (path === '/block') for (;;) {}
      if (path === '/signal') publishChanged();
      if (path === '/error') throw new Error('private-data secret stack');
      return { status: 200, body: { ok: true, leaked: process.env.TRUST_DATABASE_URL ?? process.env.TRUST_PGLITE_DIRECTORY ?? null } };
    }
  };
}`,
  );
  const installations = [];
  for (const id of ["example", "denied", "auto"]) {
    const manifest = path.join(directory, `${id}.json`);
    await writeFile(
      manifest,
      JSON.stringify({
        contract: "trust.extension@1",
        id,
        title: "Example",
        version: "1.0.0",
        server: "./server.mjs",
        configuration: { mode: { type: "string" } },
        requestedCapabilities: ["plans.read", "plans.subscribe"],
        ui: { name: "example", entry: "remoteEntry.js", module: "./Page", assets: "./dist" },
      }),
    );
    installations.push({
      manifest,
      configuration: { mode: id },
      environment: "local",
      grants: id === "example" ? ["plans.read", "plans.subscribe"] : [],
      autoStart: id === "auto",
    });
  }
  const registry = path.join(directory, "installations.json");
  await writeFile(registry, JSON.stringify({ extensions: installations }));
  const runtime = await startRuntime("trust-extension-runtime-", {
    extensionsFile: registry,
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root }, foreign: { workspaceRoot: root } },
  });
  const get = (suffix: string) => fetch(`${runtime.endpoint}/extensions/${suffix}`);
  const post = (suffix: string) =>
    fetch(`${runtime.endpoint}/extensions/${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { error?: unknown; result: unknown };
    assert.equal(body.error, undefined, JSON.stringify(body));
    return body.result;
  };
  const extensionStates = async () =>
    ((await (await get("")).json()) as { extensions: { state: string; ui?: unknown }[] }).extensions;
  const reading = (response: Response) => {
    if (!response.body) throw new Error("The event stream has no body");
    return response.body.getReader();
  };
  const deniedEventsAbort = new AbortController();
  try {
    const initial = await extensionStates();
    assert.equal(initial[0]?.state, "STOPPED");
    assert.equal(initial[0]?.ui, undefined);
    assert.equal(initial[2]?.state, "RUNNING", "autoStart must run without calling the failing prepare hook");
    assert.equal((await get("example/api/data")).status, 409);
    assert.equal((await post("example/prepare")).status, 200);
    assert.equal((await post("example/start")).status, 200);
    assert.equal((await post("example/prepare")).status, 409);
    assert.deepEqual(await (await get("example/api/data")).json(), { ok: true, leaked: null });
    assert.equal((await post("example/api/data")).status, 405);
    assert.equal((await get("example/assets/remoteEntry.js")).status, 200);
    assert.equal((await get("example/assets/escape.txt")).status, 404);
    assert.equal((await get("example/assets/%2e%2e%2foutside.txt")).status, 404);
    assert.equal((await post("denied/start")).status, 200);
    assert.equal((await get("denied/trust/plans")).status, 403);
    const deniedEvents = await fetch(`${runtime.endpoint}/extensions/denied/events`, {
      signal: deniedEventsAbort.signal,
    });
    assert.equal(deniedEvents.status, 200, "extension-owned events do not require Plan installation grants");
    let deniedEventsText = "";
    const deniedReader = reading(deniedEvents);
    const readingDeniedEvents = (async () => {
      try {
        for (;;) {
          const next = await deniedReader.read();
          if (next.done) return;
          deniedEventsText += new TextDecoder().decode(next.value);
        }
      } catch {
        /* Aborted after the assertions below. */
      }
    })();
    await get("denied/api/signal");
    const source = await readFile(path.join(root, "assets/procedures/00-git-status.feature"), "utf8");
    await rpc("procedure.publish", { source, sourceName: "00-git-status.feature" });
    for (const environment of ["local", "foreign"])
      await rpc("plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: "git-status",
        procedureVersion: "2.0.0",
        plan: `${environment}-plan`,
        environment,
        rootInputs: { repository: "trust" },
      });
    const plans = (await (await get("example/trust/plans")).json()) as { plans: { plan: string }[] };
    assert.deepEqual(
      plans.plans.map((plan) => plan.plan),
      ["local-plan"],
    );
    assert.equal((await get("example/trust/plans/foreign-plan")).status, 404);
    assert.equal((await get("example/trust/plans/local-plan")).status, 200);
    const events = await get("example/events");
    const reader = reading(events);
    const next = async () => new TextDecoder().decode((await reader.read()).value);
    assert.match(await next(), /resync/);
    await get("example/api/signal");
    assert.match(await next(), /extension.changed/);
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "local-next",
      environment: "local",
      rootInputs: { repository: "trust" },
    });
    assert.match(await next(), /plan.changed.*local-next/);
    for (let count = 0; count < 100 && !deniedEventsText.includes("extension.changed"); count++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(deniedEventsText, /resync/);
    assert.match(deniedEventsText, /extension.changed/);
    assert.doesNotMatch(deniedEventsText, /plan.changed|local-plan|local-next|foreign-plan/);
    deniedEventsAbort.abort();
    await readingDeniedEvents;
    assert.equal((await post("example/stop")).status, 200);
    while (!(await reader.read()).done) {
      /* Drain already-buffered invalidations before EOF. */
    }
    await post("example/start");
    const error = await get("example/api/error");
    assert.equal(error.status, 502);
    assert.doesNotMatch(await error.text(), /private-data|secret|stack/);
    assert.equal((await get("example/api/crash")).status, 502);
    assert.equal((await extensionStates())[0]?.state, "FAILED");
    await post("example/start");
    // A slow read fails alone while the process still answers; a frozen process is failed.
    assert.equal((await get("example/api/hang")).status, 504);
    assert.equal((await extensionStates())[0]?.state, "RUNNING");
    assert.equal((await get("example/api/")).status, 200);
    assert.equal((await get("example/api/block")).status, 504);
    for (let count = 0; count < 50 && (await extensionStates())[0]?.state !== "FAILED"; count++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await extensionStates())[0]?.state, "FAILED");
    const publicText = JSON.stringify(await (await get("")).json());
    assert.doesNotMatch(publicText, /private-data|configuration|credentialEnvironment|server.mjs/);
  } finally {
    deniedEventsAbort.abort();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
