import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resources, root, scopes } from "./access-ownership-support.mjs";
import { cleanEnvironment, setupConfiguration } from "./server-configuration-support.mjs";

export {
  admit,
  denied,
  engage,
  resources,
  root,
  rpc,
  scopes,
  seed,
  storageTarget,
} from "./access-ownership-support.mjs";
export const issuer = "https://identity.example";
export const fixed = (overrides = {}) => ({
  profile: "fixed",
  access: { mode: "fixed", issuer, subject: "alice", scopes: [...scopes(), ...resources], ...overrides },
});
export const entry = path.join(root, "packages/trust-runtime/dist/src/index.js");
export async function fixture(options = {}) {
  const f = await setupConfiguration({
    ...options,
    server: { operationsDirectory: path.join(root, "assets/operations"), ...options.server },
    authentication: options.authentication ?? fixed(),
  });
  let child,
    completion,
    output = "";
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      try {
        await completion;
      } finally {
        clearTimeout(timer);
      }
    }
    child = undefined;
  };
  return {
    ...f,
    endpoint: `http://127.0.0.1:${f.port}`,
    async start(authentication = f.configuration.authentication) {
      await stop();
      await writeFile(f.file, JSON.stringify({ ...f.configuration, authentication }));
      output = "";
      child = spawn(process.execPath, [entry], {
        cwd: root,
        env: cleanEnvironment({ TRUST_CONFIG_FILE: f.file }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      completion = once(child, "exit");
      child.stdout.on("data", (c) => (output += c));
      child.stderr.on("data", (c) => (output += c));
      for (let i = 0; i < 1200; i++) {
        if (output.includes("TRUST runtime listening on")) return;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
        await delay(25);
      }
      await stop();
      throw new Error(`Startup timed out: ${output}`);
    },
    stop,
    async close() {
      await stop();
      await f.close();
    },
  };
}
export async function mcp(endpoint, name, args = {}) {
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
export async function probeExtension(directory) {
  await writeFile(
    path.join(directory, "probe.mjs"),
    `export function createExtension(){return {async prepare(){},async start(){},async stop(){},async read(){return {}},async command(input,context){const body={principal:context.principal,extensionId:context.extensionId};return {status:200,body,text:JSON.stringify(body)}}}}`,
  );
  await writeFile(
    path.join(directory, "probe.json"),
    JSON.stringify({
      contract: "trust.extension@1",
      id: "dragon-heist",
      title: "Fixed identity probe",
      version: "1.0.0",
      server: "./probe.mjs",
      configuration: {},
      requestedCapabilities: [],
      mcp: {
        description: "Read invocation identity",
        commands: [
          { name: "identity.read", description: "Read identity", readOnly: true, inputSchema: { type: "object" } },
        ],
      },
    }),
  );
  const registry = path.join(directory, "extensions.json");
  await writeFile(
    registry,
    JSON.stringify({
      extensions: [
        {
          manifest: path.join(directory, "probe.json"),
          configuration: {},
          environment: "local",
          grants: [],
          autoStart: true,
        },
      ],
    }),
  );
  return registry;
}
