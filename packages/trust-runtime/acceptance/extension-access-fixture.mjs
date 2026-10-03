import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAccessTestProvider, DEVELOPMENT_SCOPES } from "../../../environments/trust-test/auth/provider.mjs";
import { startRuntime } from "../dist/src/server.js";
import { engage, root, rpc, scopes, seed } from "./access-ownership-support.mjs";

// Disposable host-contract probes. No product extension or external database is required.
export async function createExtensionAccessFixture({ start = startRuntime } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-access-"));
  const provider = await createAccessTestProvider();
  let runtime;
  const close = async () => {
    await runtime?.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(
      path.join(directory, "probe.mjs"),
      `
export function createExtension({publishChanged}) {
 const records = new Map();
 return {async prepare(){},async start(){},async stop(){},
 async read(){return {status:200,body:{records:[...records.values()]}};},
 async command(input, invocation){
  await new Promise(resolve=>setTimeout(resolve,input.arguments.delay??0));
  if(input.command==='records.put'){records.set(input.arguments.id,input.arguments);publishChanged();}
  const body=input.command==='identity.read'?{principal:invocation.principal,extensionId:invocation.extensionId}:{records:[...records.values()]};
  return {status:200,body,text:JSON.stringify(body)};
 }};
}
`,
    );
    const installations = [];
    for (const id of ["extension-a", "extension-b"]) {
      const manifest = path.join(directory, `${id}.json`);
      await writeFile(
        manifest,
        JSON.stringify({
          contract: "trust.extension@1",
          id,
          title: "Disposable access probe",
          version: "1.0.0",
          server: "./probe.mjs",
          configuration: {},
          requestedCapabilities: ["plans.read", "plans.subscribe"],
          mcp: {
            description: "Exercise the public host contract",
            commands: [
              {
                name: "records.read",
                description: "Read probe records",
                readOnly: true,
                inputSchema: { type: "object" },
              },
              {
                name: "records.put",
                description: "Write a probe record",
                readOnly: false,
                inputSchema: { type: "object" },
              },
              {
                name: "identity.read",
                description: "Read the host identity",
                readOnly: true,
                inputSchema: { type: "object" },
              },
            ],
          },
        }),
      );
      installations.push({
        manifest,
        configuration: {},
        environment: "local",
        grants: ["plans.read", "plans.subscribe"],
        autoStart: true,
      });
    }
    const registry = path.join(directory, "extensions.json");
    await writeFile(registry, JSON.stringify({ extensions: installations }));
    runtime = await start({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "data") },
      extensionsFile: registry,
      operationsDirectory: path.join(root, "assets/operations"),
      accessConfiguration: provider.configuration,
      accessResourceUrl: "http://127.0.0.1/mcp",
    });
    const endpoint = `http://127.0.0.1:${runtime.port}`;
    const [alice, bob, admin] = await Promise.all([
      provider.issue({
        subject: "alice",
        scope: [...scopes(), "trust.extension.extension-a.use", "trust.extension.extension-b.use"].join(" "),
      }),
      provider.issue({
        subject: "bob",
        scope: [...scopes(), "trust.extension.extension-a.use", "trust.extension.extension-b.use"].join(" "),
      }),
      provider.issue({ subject: "admin", scope: DEVELOPMENT_SCOPES.join(" ") }),
    ]);
    await seed(endpoint, admin.token);
    await rpc(endpoint, alice.token, "plan.engage", engage("alice-plan"));
    await rpc(endpoint, bob.token, "plan.engage", engage("bob-plan"));
    const request = async (url, token, { method = "GET", body } = {}) => {
      const response = await fetch(endpoint + url, {
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    return {
      endpoint,
      provider,
      alice,
      bob,
      admin,
      close,
      request,
      command: (id, token, command, args) =>
        request(`/extensions/${id}/commands`, token, { method: "POST", body: { command, arguments: args } }),
      read: (id, token, resource) => request(`/extensions/${id}/api${resource}`, token),
      okay: (result) => {
        assert.equal(result.status, 200, JSON.stringify(result));
        return result.body;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
