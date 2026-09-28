import assert from "node:assert/strict";
import test from "node:test";

import { startPublicRuntime } from "../dist/acceptance/support/runtime-process.js";

async function post(endpoint, pathname, body, headers = {}) {
  const response = await fetch(`${endpoint}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function tool(endpoint, name, args) {
  const envelope = await post(
    endpoint,
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
  );
  assert.equal(envelope.error, undefined, JSON.stringify(envelope));
  return {
    isError: envelope.result.isError === true,
    text: envelope.result.content.map((part) => part.text).join("\n"),
  };
}

async function rpc(endpoint, method, params) {
  return post(endpoint, "/rpc", { jsonrpc: "2.0", id: method, method, params });
}

function nextCursor(text) {
  return text.match(/^Next cursor: (.+)$/m)?.[1];
}

async function discover(endpoint, query) {
  const ids = [];
  let cursor;
  do {
    const page = await tool(endpoint, "trust_documentation_list", { query, limit: 25, ...(cursor ? { cursor } : {}) });
    assert.equal(page.isError, false, page.text);
    ids.push(...Array.from(page.text.matchAll(/^- ([A-Za-z0-9_./-]+):/gm), (match) => match[1]));
    cursor = nextCursor(page.text);
  } while (cursor);
  return ids;
}

async function read(endpoint, document) {
  let cursor;
  let text = "";
  let pages = 0;
  do {
    const page = await tool(endpoint, "trust_documentation_read", {
      document,
      limit: 12000,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.isError, false, page.text);
    text += page.text.split("\nCONTENT\n")[1];
    cursor = nextCursor(page.text);
    assert.ok(++pages < 50, "pagination must terminate");
  } while (cursor);
  return text;
}

/** The text of one Markdown section, up to the next heading of the same or a higher level outside code fences. */
function section(text, heading) {
  const level = heading.match(/^#+/)[0].length;
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `missing section ${heading}`);
  let fenced = false;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].startsWith("```")) fenced = !fenced;
    else if (!fenced && new RegExp(`^#{1,${level}} `).test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

test("SEC-040 AC2 the documentation describes credential declaration in an Operation and credential management in an Environment", {
  timeout: 120000,
}, async () => {
  const runtime = await startPublicRuntime("trust-documentation-credentials-");
  try {
    const { endpoint } = runtime;

    // Discovery: an agent searching the packaged documentation reaches the credential pages.
    const declarationPages = await discover(endpoint, 'from Credential "');
    for (const id of [
      "reference/operations/interface",
      "reference/operations/steps/http",
      "reference/operations/steps/shell",
    ])
      assert.ok(declarationPages.includes(id), `search for credential references must find ${id}`);
    const managementPages = await discover(endpoint, "credential.save");
    assert.ok(managementPages.includes("reference/environments/index"), managementPages.join(", "));

    // Declaration in an Operation.
    const interfacePage = await read(endpoint, "reference/operations/interface");
    const credentials = section(interfacePage, "## Credentials");
    assert.match(credentials, /And Credentials\n\s+\| name\s+\|\n(?:\s+\| \w+\s+\|\n)+/);
    assert.match(credentials, /header is exactly `\| name \|`/);
    assert.match(credentials, /^\| HTTP \| `with header "<Header>" from Credential "<name>"` \|/m);
    assert.match(credentials, /^\| PostgreSQL \| `authenticated by Credential "<name>"` \|/m);
    assert.match(
      credentials,
      /^\| Shell \| `with variable "<VARIABLE>" from Credential "<name>"` \| [^|\n]*this step only/m,
    );

    const example = credentials.match(/```gherkin operation[^\n]*\n([\s\S]*?)\n```/)?.[1];
    assert.ok(example, "the Credentials section carries one complete Operation");
    const compiled = await tool(endpoint, "trust_operation_compile", {
      source: `${example}\n`,
      sourceName: "documented-credentials.feature",
    });
    assert.equal(compiled.isError, false, compiled.text);
    const declared = compiled.text.match(/^Credentials: (.+)$/m)?.[1].split(", ") ?? [];
    assert.ok(declared.length >= 3, compiled.text);
    const referenceForms = [
      /with header "[^"]+" from Credential "(\w+)"/g,
      /authenticated by Credential "(\w+)"/g,
      /with variable "[^"]+" from Credential "(\w+)"/g,
    ];
    const referenced = referenceForms.map((form) => Array.from(example.matchAll(form), (match) => match[1]));
    for (const [index, names] of referenced.entries())
      assert.ok(names.length > 0, `the documented Operation uses reference form ${referenceForms[index]}`);
    assert.deepEqual(new Set(referenced.flat()), new Set(declared), "each declared credential is referenced by a step");
    const withoutDeclaration = example.replace(/\n {4}And Credentials\n(?: {6}\|[^\n]*\n)+/, "\n");
    assert.doesNotMatch(withoutDeclaration, /And Credentials/);
    const undeclared = await tool(endpoint, "trust_operation_compile", {
      source: `${withoutDeclaration}\n`,
      sourceName: "documented-credentials-undeclared.feature",
    });
    assert.equal(undeclared.isError, true, "the documented rule 'every referenced name must be declared' holds");
    assert.match(undeclared.text, /unknown-credential/);

    assert.match(credentials, /resolves exactly the declared names/);
    assert.match(credentials, /A credential that is not declared is never delegated/);
    assert.match(credentials, /refuses the attempt, reason `credential-missing`, before any external action/);
    assert.match(credentials, /\*\*Dry-run\.\*\*[^\n]*receives no credential/);
    assert.match(credentials, /`credentials` root is refused/);
    assert.match(
      credentials,
      /`\[credential <name>\]` in step results, the action outcome, error messages and diagnostics/,
    );
    assert.match(credentials, /traces never carry a credential value/);
    assert.match(credentials, /`credentials` map keyed by name, separate from the `environment` map/);
    assert.match(credentials, /compiled Operation lists the declared names in `credentials`/);

    const http = section(await read(endpoint, "reference/operations/steps/http"), "## Authentication");
    assert.match(http, /with header "Authorization" from Credential "\w+"/);
    assert.match(http, /headers only, never for a path segment, a query parameter or a body/);
    assert.match(http, /trust-doc:\/\/\/reference\/operations\/interface#credentials/);
    const shell = section(await read(endpoint, "reference/operations/steps/shell"), "## Credential variables");
    assert.match(shell, /with variable "[A-Z_]+" from Credential "\w+"/);
    assert.match(shell, /exists for this step only/);
    assert.match(shell, /trust-doc:\/\/\/reference\/operations\/interface#credentials/);

    // Management in an Environment.
    const environmentPage = await read(endpoint, "reference/environments/index");
    const management = section(environmentPage, "### Credentials");
    assert.match(management, /\*\*Define\.\*\*[^\n]*name and a value/);
    assert.match(management, /\*\*Replace\.\*\*[^\n]*existing name replaces it/);
    assert.match(management, /\*\*Never read back\.\*\*[^\n]*No screen, RPC or MCP call returns a credential value/);
    assert.match(management, /\*\*Remove\.\*\*[^\n]*refused at admission/);
    assert.match(management, /trust-doc:\/\/\/reference\/operations\/interface#credentials/);
    const execution = section(environmentPage, "### What an execution receives");
    assert.match(execution, /\*\*only the ones the Operation declares\*\*/);
    assert.match(execution, /refused with reason `credential-missing` before any external action/);
    assert.match(execution, /A dry-run receives no credential/);
    assert.match(execution, /masks it as `\[credential <name>\]`/);
    assert.match(
      environmentPage,
      /`credential\.save \{ environment, name, value \}` creates or replaces one credential and returns `trust\.credential@1` `\{ credential: \{ environment, name \} \}`/,
    );
    assert.match(
      environmentPage,
      /`credential\.list \{ environment\? \}` returns `trust\.credential-catalog@1` `\{ credentials: \[\{ environment, name \}\] \}`/,
    );
    assert.match(
      environmentPage,
      /`credential\.remove \{ environment, name \}` returns `trust\.credential-removal@1` `\{ environment, name, removed \}`/,
    );
    assert.match(environmentPage, /A dry-run grant carries `credentials: \{\}`/);
    assert.doesNotMatch(environmentPage, /no execution receives them|product decision still open/);

    // The documented management contract is the one the public runtime serves.
    const secret = "documented-secret-value-4f1c";
    assert.equal((await rpc(endpoint, "environment.save", { environment: "docs", values: {} })).error, undefined);
    for (const value of [secret, `${secret}-replaced`]) {
      const saved = await rpc(endpoint, "credential.save", { environment: "docs", name: "registryToken", value });
      assert.deepEqual(saved.result, {
        contract: "trust.credential@1",
        credential: { environment: "docs", name: "registryToken" },
      });
    }
    const listed = await rpc(endpoint, "credential.list", { environment: "docs" });
    assert.deepEqual(listed.result, {
      contract: "trust.credential-catalog@1",
      credentials: [{ environment: "docs", name: "registryToken" }],
    });
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(secret));
    const environments = await tool(endpoint, "trust_environment_list", {});
    assert.doesNotMatch(environments.text, new RegExp(secret));
    assert.deepEqual(
      (await rpc(endpoint, "credential.remove", { environment: "docs", name: "registryToken" })).result,
      { contract: "trust.credential-removal@1", environment: "docs", name: "registryToken", removed: true },
    );

    // The agent guide no longer says credentials are withheld, and names the refusal.
    const agent = await read(endpoint, "reference/plans/agent");
    assert.doesNotMatch(agent, /credentials are not delegated/);
    assert.match(agent, /`ADMITTED` \([^)]*`environment`, `credentials`/);
    assert.match(agent, /`credential-missing`, plus `next: READ_PLAN`/);
    assert.match(agent, /^\| a credential the Operation declares is missing from the Plan's Environment \|/m);
    assert.match(agent, /never supplies one/);
  } finally {
    await runtime.close();
  }
});
