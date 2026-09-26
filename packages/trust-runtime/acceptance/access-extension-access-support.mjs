import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import {
  createAccessTestProvider,
  DEVELOPMENT_RESOURCE,
  DEVELOPMENT_SCOPES,
} from "../../../environments/trust-test/auth/provider.mjs";
import { startRuntime } from "../dist/src/server.js";
import { engage, root, rpc, scopes, seed, storageTarget } from "./access-ownership-support.mjs";

export const aliceScopes = [
  ...scopes(),
  "trust.extension.list",
  "trust.extension.coordination.use",
  "trust.extension.mobile-companion.use",
];
export const form = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { decision: { type: "string", title: "Decision", enum: ["Approve", "Revise"] } },
    required: ["decision"],
  },
  uiSchema: { type: "VerticalLayout", elements: [{ type: "Control", scope: "#/properties/decision" }] },
};
export async function createExtensionAccessFixture(
  kind = "pglite",
  { browserOrigin, local = false, start = startRuntime } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-access-"));
  const target = await storageTarget(kind);
  const extensionTarget = await storageTarget("postgresql");
  const provider = await createAccessTestProvider(
    browserOrigin
      ? { browserRedirectUri: `${browserOrigin}/auth/callback`, browserPostLogoutUri: `${browserOrigin}/` }
      : {},
  );
  const extensionDatabase = new Client({ connectionString: extensionTarget.storage.connectionString });
  await extensionDatabase.connect();
  const extensionUrl = new URL(extensionTarget.storage.connectionString);
  assert.equal(extensionUrl.password, "", "Fixture PostgreSQL credentials must use PGPASSWORD, never registry URLs");
  const registry = path.join(directory, "extensions.json");
  const probe = path.join(directory, "probe.mjs");
  await writeFile(
    probe,
    `export function createExtension(){return {async prepare(){},async start(){},async stop(){},async read(input,context){return {status:200,body:context}},async command(input,context){await new Promise(r=>setTimeout(r,input.arguments.delay??0));const body={principal:context.principal??null,extensionId:context.extensionId??null};return {status:200,body,text:JSON.stringify(body)}}}}`,
  );
  const probeManifest = path.join(directory, "probe.json");
  await writeFile(
    probeManifest,
    JSON.stringify({
      contract: "trust.extension@1",
      id: "dragon-heist",
      title: "Disposable context probe",
      version: "1.0.0",
      server: "./probe.mjs",
      configuration: {},
      requestedCapabilities: [],
      mcp: {
        description: "Test private invocation identity",
        commands: [
          {
            name: "identity.read",
            description: "Return verified invocation identity",
            readOnly: true,
            inputSchema: { type: "object" },
          },
        ],
      },
    }),
  );
  await writeFile(
    registry,
    JSON.stringify({
      extensions: [
        ...["coordination", "mobile-companion"].map((id) => ({
          manifest: path.join(root, `extensions/${id}/extension.json`),
          configuration: { databaseUrl: extensionUrl.href },
          environment: "local",
          grants: ["plans.read", "plans.subscribe"],
          credentialEnvironment: ["PGPASSWORD"],
        })),
        { manifest: probeManifest, configuration: {}, environment: "local", grants: [] },
      ],
    }),
  );
  let runtime;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime?.close();
    await extensionDatabase.end();
    await provider.close();
    await extensionTarget.cleanup();
    await target.cleanup();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    runtime = await start({
      host: "127.0.0.1",
      port: 0,
      storage: target.storage,
      extensionsFile: registry,
      operationsDirectory: path.join(root, "assets/operations"),
      accessConfiguration: local ? { mode: "local" } : provider.configuration,
      accessResourceUrl: browserOrigin ? `${browserOrigin}/mcp` : "http://127.0.0.1/mcp",
      ...(browserOrigin
        ? {
            browserAuthentication: {
              issuer: provider.issuer,
              clientId: "trust-browser",
              redirectUri: `${browserOrigin}/auth/callback`,
              postLogoutRedirectUri: `${browserOrigin}/`,
              scope: `openid offline_access ${aliceScopes.join(" ")}`,
              resource: DEVELOPMENT_RESOURCE,
            },
          }
        : {}),
    });
    const endpoint = `http://127.0.0.1:${runtime.port}`;
    const [alice, bob, admin] = await Promise.all([
      provider.issue({ subject: "alice", scope: aliceScopes.join(" ") }),
      provider.issue({ subject: "bob", scope: aliceScopes.join(" ") }),
      provider.issue({ subject: "admin", scope: DEVELOPMENT_SCOPES.join(" ") }),
    ]);
    const request = async (route, token, { method = "GET", body } = {}) => {
      const response = await fetch(`${endpoint}${route}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const command = (id, token, name, args) =>
      request(`/extensions/${id}/commands`, token, { method: "POST", body: { command: name, arguments: args } });
    const read = (id, token, route) => request(`/extensions/${id}/api${route}`, token);
    const okay = (result) => {
      assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
      return result.body;
    };
    await seed(endpoint, admin.token);
    await rpc(endpoint, alice.token, "plan.engage", engage("alice-plan"));
    await rpc(endpoint, bob.token, "plan.engage", engage("bob-plan"));
    for (const id of ["coordination", "mobile-companion", "dragon-heist"]) {
      okay(await request(`/extensions/${id}/prepare`, admin.token, { method: "POST", body: {} }));
      okay(await request(`/extensions/${id}/start`, admin.token, { method: "POST", body: {} }));
    }
    for (const [mission, plan, assignee] of [
      ["alice-mission", "alice-plan", "agent-a"],
      ["bob-mission", "bob-plan", "agent-b"],
      ["historical-mission", "unresolved-historical-plan", "alice"],
    ]) {
      await extensionDatabase.query("SELECT trust_coordination.mission_create($1::jsonb)", [
        JSON.stringify({
          mission,
          plan,
          assignee,
          project: "extension-project",
          instructions: `Fixture ${mission}`,
          expected: "Verify access",
          authorized: "Disposable fixture",
          forbidden: "Retained changes",
        }),
      ]);
    }
    okay(
      await command("mobile-companion", admin.token, "projects.put", {
        id: "extension-project",
        title: "Extension project",
        description: "Disposable shared project",
        status: "active",
      }),
    );
    for (const [id, plan] of [
      ["alice-item", "alice-plan"],
      ["bob-item", "bob-plan"],
      ["unlinked-item", undefined],
    ]) {
      okay(
        await command("mobile-companion", admin.token, "feed.publish", {
          id,
          project: "extension-project",
          kind: "question",
          title: id,
          summary: `Question ${id}`,
          body: "Choose one response.",
          form,
          ...(plan ? { plan } : {}),
        }),
      );
    }
    return {
      endpoint,
      provider,
      alice,
      bob,
      admin,
      command,
      read,
      request,
      okay,
      extensionDatabase,
      runtime,
      close,
      ids: {
        alicePlan: "alice-plan",
        bobPlan: "bob-plan",
        aliceMission: "alice-mission",
        bobMission: "bob-mission",
        aliceItem: "alice-item",
        bobItem: "bob-item",
        project: "extension-project",
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
