import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeEntry = path.join(repositoryRoot, "apps/trust-runtime/dist/src/index.js");
const procedurePath = path.join(
  repositoryRoot,
  "assets/procedures/01-defect-correction-multi-project.feature",
);
const publisherIdentity = "spiffe://trust-test/skill-publishers/runtime-mcp-loop";
const operatorIdentity = "spiffe://trust-test/operators/runtime-mcp-loop";
const observerIdentity = "spiffe://trust-test/observers/runtime-mcp-loop";
const credentials = Object.freeze({
  publisher: "runtime_mcp_loop_publisher_secret",
  operator: "runtime_mcp_loop_operator_secret",
  observer: "runtime_mcp_loop_observer_secret",
});

test("runtime MCP gives an agent one dynamically published procedure and its initial actionable Checks", {
  timeout: 60_000,
}, async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "trust-runtime-mcp-loop-"));
  const procedureSource = await readFile(procedurePath, "utf8");
  const runtimeOptions = {
    databasePath: path.join(temporaryDirectory, "trust.sqlite"),
    principals: [
      principal(publisherIdentity, ["publisher"], credentials.publisher),
      principal(operatorIdentity, ["operator"], credentials.operator),
      principal(observerIdentity, ["observer"], credentials.observer),
    ],
  };
  let runtime = await startPublicRuntime(runtimeOptions);
  try {
    const publication = await rpc(runtime.endpoint, "procedure.definition.publish", {
      source: procedureSource,
      sourceName: path.basename(procedurePath),
    }, credentials.publisher);
    assert.equal(publication.definition.procedure, "defect-correction");
    assert.equal(publication.definition.version, "3.0.0");
    assert.equal(publication.definition.requiredCapabilities.length, 10);

    const observerMcp = await initializeMcp(runtime.endpoint, credentials.observer, "2099-12-31");
    const operatorMcp = await initializeMcp(runtime.endpoint, credentials.operator, "2025-06-18");
    const observerTools = await callMcp(observerMcp, "tools/list", {});
    assert.deepEqual(
      observerTools.tools.map(({ name }) => name).sort(),
      ["trust_check_read", "trust_plan_read", "trust_procedure_read", "trust_session_read"],
    );
    const operatorTools = await callMcp(operatorMcp, "tools/list", {});
    assert.ok(operatorTools.tools.some(({ name }) => name === "trust_plan_engage"));
    assert.ok(operatorTools.tools.some(({ name }) => name === "trust_plan_declarations_replace"));

    const engagementArguments = {
      procedure: "defect-correction",
      procedureVersion: "3.0.0",
      plan: "tk-9001",
      environment: "trust-test",
      rootInputs: { "jira issue": "TK-9001" },
    };
    const denied = await callMcp(observerMcp, "tools/call", {
      name: "trust_plan_engage",
      arguments: engagementArguments,
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /operator authority/i);

    const engagementText = await callTextTool(operatorMcp, "trust_plan_engage", engagementArguments);
    assert.match(engagementText, /Status: ENGAGED/);
    assert.match(engagementText, /Procedure: defect-correction@3\.0\.0/);
    assert.match(engagementText, /Initial Checks: 2/);
    const checkUris = [...new Set(
      [...engagementText.matchAll(/trust:\/\/[^\s]+/g)].map(([uri]) => uri),
    )];
    assert.equal(checkUris.length, 2);
    const jiraCheckUri = checkUris.find((uri) => uri.includes("jira-issue-read"));
    const gitCheckUri = checkUris.find((uri) => uri.includes("git-head-read"));
    assert.ok(jiraCheckUri);
    assert.ok(gitCheckUri);

    const firstProcedurePage = await readProcedurePage(observerMcp, jiraCheckUri, 1_024);
    assert.equal(firstProcedurePage.morePages, true);
    assert.equal(typeof firstProcedurePage.nextCursor, "string");
    const firstProcedureCursor = firstProcedurePage.nextCursor;
    assert.ok(firstProcedureCursor);

    const tamperedCursor = `${firstProcedureCursor.startsWith("a") ? "b" : "a"}${
      firstProcedureCursor.slice(1)
    }`;
    await assertInvalidProcedureCursor(observerMcp, jiraCheckUri, tamperedCursor);
    await assertInvalidProcedureCursor(observerMcp, gitCheckUri, firstProcedureCursor);

    const reconstructed = await readCompleteProcedure(observerMcp, jiraCheckUri);
    assert.ok(reconstructed.pages >= 1);
    assert.equal(reconstructed.source, procedureSource);

    const plan = await callTextTool(observerMcp, "trust_plan_read", { checkUri: jiraCheckUri });
    assert.match(plan, /Revision: 1/);
    assert.match(plan, /Declaration roles: .*acceptance criterion.*affected project.*planned modification/);
    assert.match(plan, /"parents":\[\{"role":"affected project","each":true\}\]/);
    assert.match(plan, /Declarations: \{\}/);
    assert.match(plan, /Missing declarations: \["acceptance criterion","affected project","planned modification"\]/);
    assert.match(plan, /Checklist complete: no/);
    assert.match(plan, /Session: OPEN/);
    assert.match(plan, /Session meaning: delegation window for the current Plan/);
    assert.match(plan, /Work state: IN_PROGRESS/);
    assert.match(plan, /Open Checks: 2/);
    assert.match(plan, /Actionable Checks: 2/);
    assert.match(plan, /Blocked Checks: 0/);
    assert.match(plan, /Current checklist:/);
    assert.match(plan, /Latest revision change: none -> 1/);
    assert.match(plan, /Added Checks: 2/);
    assert.match(plan, /Latest current-Check attempt verdict: none/);
    assert.match(plan, /Latest current-Check attempt reason code: none/);
    assert.match(plan, /Latest attempt newly satisfied Checks: 0/);
    assert.match(plan, /Latest attempt newly opened Checks: 0/);
    assert.match(plan, new RegExp(escapeRegExp(jiraCheckUri)));
    assert.match(plan, new RegExp(escapeRegExp(gitCheckUri)));

    const session = await callTextTool(observerMcp, "trust_session_read", {
      checkUri: jiraCheckUri,
    });
    assert.match(session, /^Plan: tk-9001$/m);
    assert.match(session, /^Session: OPEN$/m);
    assert.match(session, /^Work state: IN_PROGRESS$/m);
    assert.match(session, /^Checklist complete: no$/m);
    assert.match(session, /^Satisfied Checks: 0$/m);
    assert.match(session, /^Open Checks: 2$/m);

    const jiraCheck = await callTextTool(observerMcp, "trust_check_read", { checkUri: jiraCheckUri });
    assert.match(jiraCheck, /Status: OPEN/);
    assert.match(jiraCheck, /Actionable: yes/);
    assert.match(jiraCheck, /Inputs: \{"issue":"TK-9001"\}/);
    assert.match(jiraCheck, /Blocked by: none/);
    assert.match(jiraCheck, /Capability: jira\.issue-read/);
    assert.match(jiraCheck, /Accepted attempt history: 0/);
    const gitCheck = await callTextTool(observerMcp, "trust_check_read", { checkUri: gitCheckUri });
    assert.match(gitCheck, /Status: OPEN/);
    assert.match(gitCheck, /Actionable: yes/);
    assert.match(gitCheck, /Blocked by: none/);
    assert.match(gitCheck, /Capability: git\.head-read/);

    const declarations = {
      "affected project": ["payment-api"],
      "planned modification": [{
        value: "validate-currency-code",
        parents: [{ role: "affected project", value: "payment-api" }],
      }],
      "acceptance criterion": [
        "Rejects a mixed-case currency code before any worker or persistence effect",
      ],
    };
    const declarationDenied = await callMcp(observerMcp, "tools/call", {
      name: "trust_plan_declarations_replace",
      arguments: { plan: "tk-9001", expectedRevision: 1, declarations },
    });
    assert.equal(declarationDenied.isError, true);
    assert.match(declarationDenied.content[0].text, /operator authority/i);

    const unknownDeclaration = await callMcp(operatorMcp, "tools/call", {
      name: "trust_plan_declarations_replace",
      arguments: {
        plan: "tk-9001",
        expectedRevision: 1,
        declarations: { ...declarations, "ticket projects": ["payment-api"] },
      },
    });
    assert.equal(unknownDeclaration.isError, true);
    assert.match(unknownDeclaration.content[0].text, /not declared by the Feature as agent-owned/);

    const duplicateDeclaration = await callMcp(operatorMcp, "tools/call", {
      name: "trust_plan_declarations_replace",
      arguments: {
        plan: "tk-9001",
        expectedRevision: 1,
        declarations: { ...declarations, "affected project": ["payment-api", "payment-api"] },
      },
    });
    assert.equal(duplicateDeclaration.isError, true);
    assert.match(duplicateDeclaration.content[0].text, /duplicate value/);

    const emptyDeclaration = await callMcp(operatorMcp, "tools/call", {
      name: "trust_plan_declarations_replace",
      arguments: {
        plan: "tk-9001",
        expectedRevision: 1,
        declarations: { ...declarations, "acceptance criterion": [] },
      },
    });
    assert.equal(emptyDeclaration.isError, true);
    assert.match(emptyDeclaration.content[0].text, /acceptance criterion must be a non-empty array/);

    const wrongDeclarationType = await callMcp(operatorMcp, "tools/call", {
      name: "trust_plan_declarations_replace",
      arguments: {
        plan: "tk-9001",
        expectedRevision: 1,
        declarations: { ...declarations, "affected project": "payment-api" },
      },
    });
    assert.equal(wrongDeclarationType.isError, true);
    assert.match(wrongDeclarationType.content[0].text, /affected project must be a non-empty array/);

    const missingParentCoordinate = await callMcp(operatorMcp, "tools/call", {
      name: "trust_plan_declarations_replace",
      arguments: {
        plan: "tk-9001",
        expectedRevision: 1,
        declarations: { ...declarations, "planned modification": [] },
      },
    });
    assert.equal(missingParentCoordinate.isError, true);
    assert.match(missingParentCoordinate.content[0].text, /must contain one value per affected project/);

    const crossedParentCoordinate = await callMcp(operatorMcp, "tools/call", {
      name: "trust_plan_declarations_replace",
      arguments: {
        plan: "tk-9001",
        expectedRevision: 1,
        declarations: {
          ...declarations,
          "planned modification": [{
            value: "validate-currency-code",
            parents: [{ role: "another project", value: "payment-api" }],
          }],
        },
      },
    });
    assert.equal(crossedParentCoordinate.isError, true);
    assert.match(crossedParentCoordinate.content[0].text, /has another parent role/);

    const extraParentCoordinate = await callMcp(operatorMcp, "tools/call", {
      name: "trust_plan_declarations_replace",
      arguments: {
        plan: "tk-9001",
        expectedRevision: 1,
        declarations: {
          ...declarations,
          "planned modification": [{
            value: "validate-currency-code",
            parents: [
              { role: "affected project", value: "payment-api" },
              { role: "affected project", value: "payment-api" },
            ],
          }],
        },
      },
    });
    assert.equal(extraParentCoordinate.isError, true);
    assert.match(extraParentCoordinate.content[0].text, /must contain one parent coordinate/);

    const replacement = await callTextTool(
      operatorMcp,
      "trust_plan_declarations_replace",
      { plan: "tk-9001", expectedRevision: 1, declarations },
    );
    assert.match(replacement, /Status: REPLACED/);
    assert.match(replacement, /Revision: 2/);
    assert.match(replacement, /payment-api/);
    assert.match(
      replacement,
      /Rejects a mixed-case currency code before any worker or persistence effect/,
    );
    assert.match(replacement, /--- Current Plan ---/);
    assert.match(replacement, /Latest revision change: 1 -> 2/);
    assert.match(replacement, /Unchanged Checks:/);
    const projectCheckUri = [...replacement.matchAll(/trust:\/\/[^\s]+/g)]
      .map(([uri]) => uri)
      .find((uri) => uri.includes("payment-api"));
    assert.ok(projectCheckUri);
    assert.deepEqual(revisionChange(replacement), {
      from: 1,
      to: 2,
      added: [projectCheckUri],
      removed: [],
      newlySatisfied: [],
      newlyOpened: [],
      changed: [],
      unchanged: [gitCheckUri, jiraCheckUri].sort(),
    });

    const idempotent = await callTextTool(
      operatorMcp,
      "trust_plan_declarations_replace",
      { plan: "tk-9001", expectedRevision: 2, declarations },
    );
    assert.match(idempotent, /Revision: 2/);

    const enrichedPlan = await callTextTool(observerMcp, "trust_plan_read", { checkUri: jiraCheckUri });
    assert.match(enrichedPlan, /Revision: 2/);
    assert.match(enrichedPlan, /validate-currency-code/);
    assert.match(enrichedPlan, /Missing declarations: \[\]/);
    assert.match(enrichedPlan, /Checklist complete: no/);

    const replacedDeclarations = {
      "affected project": ["payment-common"],
      "planned modification": [{
        value: "share-currency-validation",
        parents: [{ role: "affected project", value: "payment-common" }],
      }],
      "acceptance criterion": ["Accepts uppercase currency code (EUR)"],
    };
    const replaced = await callTextTool(
      operatorMcp,
      "trust_plan_declarations_replace",
      { plan: "tk-9001", expectedRevision: 2, declarations: replacedDeclarations },
    );
    assert.match(replaced, /Revision: 3/);
    assert.match(replaced, /Removed Checks: 1/);
    assert.match(replaced, /payment-api/);
    assert.match(replaced, /payment-common/);
    assert.match(replaced, /Accepts uppercase currency code \(EUR\)/);
    const replacementChange = revisionChange(replaced);
    assert.equal(replacementChange.from, 2);
    assert.equal(replacementChange.to, 3);
    assert.deepEqual(replacementChange.removed, [projectCheckUri]);
    assert.deepEqual(replacementChange.newlySatisfied, []);
    assert.deepEqual(replacementChange.newlyOpened, []);
    assert.deepEqual(replacementChange.changed, []);
    assert.deepEqual(replacementChange.unchanged, [gitCheckUri, jiraCheckUri].sort());
    assert.equal(replacementChange.added.length, 1);
    assert.match(replacementChange.added[0], /payment-common/);
    const removedProjectCheck = await callMcp(observerMcp, "tools/call", {
      name: "trust_check_read",
      arguments: { checkUri: projectCheckUri },
    });
    assert.equal(removedProjectCheck.isError, true);
    assert.match(removedProjectCheck.content[0].text, /semantic Check URI is unknown/);

    const staleRevision = await callMcp(operatorMcp, "tools/call", {
      name: "trust_plan_declarations_replace",
      arguments: { plan: "tk-9001", expectedRevision: 2, declarations },
    });
    assert.equal(staleRevision.isError, true);
    assert.match(staleRevision.content[0].text, /at revision 3, not 2/);

    await runtime.close();
    runtime = await startPublicRuntime(runtimeOptions);
    const observerAfterRestart = await initializeMcp(
      runtime.endpoint,
      credentials.observer,
      "2025-06-18",
    );
    await assertInvalidProcedureCursor(observerAfterRestart, jiraCheckUri, firstProcedureCursor);
    const freshProcedurePage = await readProcedurePage(observerAfterRestart, jiraCheckUri, 1_024);
    assert.equal(freshProcedurePage.source, firstProcedurePage.source);
    assert.equal(freshProcedurePage.morePages, true);
    const persistedPlan = await callTextTool(observerAfterRestart, "trust_plan_read", {
      checkUri: jiraCheckUri,
    });
    assert.match(persistedPlan, /Revision: 3/);
    assert.match(persistedPlan, /payment-common/);
    assert.match(persistedPlan, /share-currency-validation/);
    assert.match(persistedPlan, /Accepts uppercase currency code \(EUR\)/);
    assert.match(persistedPlan, /Checklist complete: no/);
    assert.match(persistedPlan, /Session: OPEN/);
    assert.match(persistedPlan, /Work state: IN_PROGRESS/);
    assert.match(persistedPlan, /Latest revision change: 2 -> 3/);
  } finally {
    await runtime.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function readCompleteProcedure(mcp, checkUri, limit) {
  let cursor;
  let source = "";
  let pages = 0;
  const seen = new Set();
  do {
    const page = await readProcedurePage(mcp, checkUri, limit, cursor);
    source += page.source;
    pages += 1;
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      assert.equal(seen.has(cursor), false);
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return { source, pages };
}

async function readProcedurePage(mcp, checkUri, limit, cursor) {
  const result = await callMcp(mcp, "tools/call", {
    name: "trust_procedure_read",
    arguments: {
      checkUri,
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  const [source, navigation, ...unexpected] = result.content[0].text.split(
    "\n\n--- TRUST procedure pagination ---\n",
  );
  assert.deepEqual(unexpected, []);
  assert.equal(typeof navigation, "string");
  const nextCursor = navigation.match(/^Next cursor: (.+)$/mu)?.[1];
  const morePages = /^More pages: yes$/mu.test(navigation);
  assert.equal(/^Procedure read complete: yes$/mu.test(navigation), !morePages);
  assert.equal(result._meta?.nextCursor, nextCursor);
  return { source, navigation, nextCursor, morePages };
}

async function assertInvalidProcedureCursor(mcp, checkUri, cursor) {
  const result = await callMcp(mcp, "tools/call", {
    name: "trust_procedure_read",
    arguments: { checkUri, cursor, limit: 1_024 },
  });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /Procedure cursor is invalid or no longer belongs to this Check/,
  );
  assert.match(
    result.content[0].text,
    /Start procedure reading again without a cursor/,
  );
}

function revisionChange(plan) {
  const block = plan.split("Latest revision change: ").at(-1);
  assert.equal(typeof block, "string");
  const revision = /^(none|\d+) -> (\d+)$/m.exec(block);
  assert.ok(revision);
  const sections = [
    ["added", "Added Checks"],
    ["removed", "Removed Checks"],
    ["newlySatisfied", "Newly satisfied Checks"],
    ["newlyOpened", "Newly opened Checks"],
    ["changed", "Changed Checks"],
    ["unchanged", "Unchanged Checks"],
  ];
  const result = {
    from: revision[1] === "none" ? null : Number(revision[1]),
    to: Number(revision[2]),
  };
  for (const [key, label] of sections) {
    const start = block.indexOf(`${label}: `);
    assert.notEqual(start, -1);
    const remaining = block.slice(start);
    const header = new RegExp(`^${escapeRegExp(label)}: (\\d+)$`, "m").exec(remaining);
    assert.ok(header);
    const nextStarts = sections
      .map(([, candidate]) => block.indexOf(`${candidate}: `, start + label.length + 2))
      .filter((candidate) => candidate > start);
    const end = nextStarts.length === 0 ? block.length : Math.min(...nextStarts);
    const values = block.slice(start, end)
      .split("\n")
      .filter((line) => line.startsWith("  - "))
      .map((line) => line.slice(4));
    assert.equal(values.length, Number(header[1]));
    result[key] = values.sort();
  }
  return result;
}

async function initializeMcp(endpoint, credential, protocolVersion) {
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: mcpHeaders(undefined, credential, undefined),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "1.0.0" },
      },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.result.protocolVersion, protocolVersion);
  const sessionId = response.headers.get("mcp-session-id") ?? undefined;
  await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: mcpHeaders(sessionId, credential, protocolVersion),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return { endpoint, credential, protocolVersion, sessionId, nextId: 0 };
}

async function callTextTool(mcp, name, argumentsValue) {
  const result = await callMcp(mcp, "tools/call", { name, arguments: argumentsValue });
  assert.equal(result.isError, undefined, `${name} must succeed`);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return result.content[0].text;
}

async function callMcp(mcp, method, params) {
  const id = `mcp-${++mcp.nextId}`;
  const response = await fetch(`${mcp.endpoint}/mcp`, {
    method: "POST",
    headers: mcpHeaders(mcp.sessionId, mcp.credential, mcp.protocolVersion),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const responseBody = await response.text();
  assert.equal(response.status, 200, responseBody);
  const envelope = JSON.parse(responseBody);
  assert.equal(envelope.id, id);
  if (envelope.error !== undefined) assert.fail(JSON.stringify(envelope.error));
  return envelope.result;
}

function mcpHeaders(sessionId, credential, protocolVersion) {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${credential}`,
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === undefined ? {} : { "mcp-protocol-version": protocolVersion }),
  };
}

async function rpc(endpoint, method, params, credential) {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  if (envelope.error !== undefined) assert.fail(JSON.stringify(envelope.error));
  return envelope.result;
}

async function startPublicRuntime({ databasePath, principals }) {
  const child = spawn(process.execPath, [runtimeEntry], {
    env: {
      ...process.env,
      TRUST_HOST: "127.0.0.1",
      TRUST_PORT: "0",
      TRUST_DATABASE_PATH: databasePath,
      TRUST_SEMANTIC_AUTHORITY: "trust-test:4318",
      TRUST_SKILL_POLICY: "verified",
      TRUST_REGISTRY_PRINCIPALS_JSON: JSON.stringify(principals),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const endpoint = await listeningEndpoint(child);
    return {
      endpoint,
      async close() {
        if (child.exitCode === null) child.kill("SIGTERM");
        await once(child, "exit");
      },
    };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
}

async function listeningEndpoint(child) {
  let stdout = "";
  let stderr = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`runtime did not listen: ${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const port = /TRUST runtime listening on 127\.0\.0\.1:(\d+)/.exec(stdout)?.[1];
      if (port !== undefined) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${port}`);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`runtime exited before listening: ${code} ${stderr}`));
    });
  });
}

function principal(identity, roles, credential) {
  return {
    identity,
    roles,
    credentialSha256: `sha256:${createHash("sha256").update(credential).digest("hex")}`,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
