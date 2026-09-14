import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startPublicRuntime } from "../dist/acceptance/support/runtime-process.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
async function request(endpoint, method, params) {
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function tool(endpoint, name, args) {
  return request(endpoint, "tools/call", { name, arguments: args });
}
function output(result) {
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.notEqual(result.result.isError, true, JSON.stringify(result));
  return result.result.content.map((part) => part.text).join("\n");
}
function next(text) {
  return text.match(/^Next cursor: (.+)$/m)?.[1];
}
async function read(endpoint, document, limit = 12000) {
  let cursor;
  let text = "";
  let pages = 0;
  do {
    const result = output(
      await tool(endpoint, "trust_documentation_read", { document, limit, ...(cursor ? { cursor } : {}) }),
    );
    text += result.split("\nCONTENT\n")[1];
    cursor = next(result);
    assert.ok(++pages < 200, "pagination must terminate");
  } while (cursor);
  return text;
}
async function verify(endpoint) {
  const tools = (await request(endpoint, "tools/list", {})).result.tools;
  for (const name of ["trust_documentation_list", "trust_documentation_read"]) {
    assert.equal(tools.find((entry) => entry.name === name)?.annotations.readOnlyHint, true);
  }
  assert.match(
    tools.find((entry) => entry.name === "trust_documentation_list")?.description ?? "",
    /Start at agents\/SKILL\./,
  );
  const first = output(await tool(endpoint, "trust_documentation_list", { limit: 2 }));
  const entrypoint = first.match(/^Start: (.+)$/m)?.[1];
  assert.equal(entrypoint, "agents/SKILL");
  const listCursor = next(first);
  assert.ok(listCursor);
  assert.equal(
    (await tool(endpoint, "trust_documentation_list", { query: "unblock", cursor: listCursor })).error.code,
    -32602,
  );
  const searched = output(await tool(endpoint, "trust_documentation_list", { query: "reimplement" }));
  assert.match(searched, /execute-and-coordinate/);

  const index = await read(endpoint, "agents/README", 511);
  assert.match(index, /trust-doc:\/\/\/agents\/SKILL/);
  const skill = await read(endpoint, entrypoint, 511);
  assert.match(skill, /trust-doc:\/\/\/references\/runner/);
  for (const reference of [
    "author-operation",
    "author-procedure",
    "verify-and-test",
    "execute-and-coordinate",
    "author-extension",
  ]) {
    assert.ok(skill.includes(`trust-doc:///agents/${reference}`));
  }
  const skillReferences = new Set(
    Array.from(skill.matchAll(/\]\(trust-doc:\/\/\/([^\s)#]+)(?:#[^)]*)?\)/g), (match) => decodeURIComponent(match[1])),
  );
  assert.ok(skillReferences.size > 0, "the operational entrypoint must route to packaged references");
  for (const reference of skillReferences) {
    assert.ok((await read(endpoint, reference, 511)).trim(), `Unreadable skill reference ${reference}`);
  }
  const runner = await read(endpoint, "references/runner");
  assert.match(runner, /Do not modify, patch, reimplement or bypass/);
  const sdk = await read(endpoint, "references/extension-sdk");
  assert.match(sdk, /ExtensionFactory/);
  assert.match(sdk, /"requestedCapabilities": \[\]/);
  const language = await read(endpoint, "reference/operations/produce");
  assert.match(language, /\$string/);
  assert.doesNotMatch(language, /<OperationLanguageReference/);
  const anatomy = await read(endpoint, "reference/operations/anatomy");
  assert.match(anatomy, /Every Input is required/);
  assert.match(anatomy, /trust-doc:\/\/\/reference\/operations\/interface/);
  assert.doesNotMatch(anatomy, /\]\(\/docs/);
  const architecture = await read(endpoint, "reference/principles/architecture");
  assert.match(architecture, /The application hosting the agent/);
  assert.doesNotMatch(architecture, /<Compare|<ArchitectureFigure/);
  const example = await read(endpoint, "examples/operations/dragon-heist.turn-runes");
  assert.ok(
    example.includes(await readFile(path.join(root, "assets/operations/dragon-heist.turn-runes.feature"), "utf8")),
  );

  const firstPage = output(await tool(endpoint, "trust_documentation_read", { document: "agents/README", limit: 100 }));
  assert.ok(next(firstPage));
  for (const args of [
    { document: "../../AGENTS.md" },
    { document: "%2e%2e/secret" },
    { document: "/etc/passwd" },
    { document: "agents/README", limit: 12001 },
    { document: "agents/README", limit: 0 },
    { document: "agents/README", limit: null },
    { document: "agents/README", extra: true },
    { document: "agents/README", cursor: "junk" },
    { document: "references/runner", cursor: next(firstPage) },
  ])
    assert.equal((await tool(endpoint, "trust_documentation_read", args)).error.code, -32602, JSON.stringify(args));
  assert.equal(
    (await tool(endpoint, "trust_documentation_read", { document: "unknown/document" })).result.isError,
    true,
  );

  const ids = [];
  let cursor;
  do {
    const page = output(await tool(endpoint, "trust_documentation_list", { limit: 25, ...(cursor ? { cursor } : {}) }));
    ids.push(...Array.from(page.matchAll(/^- ([A-Za-z0-9_./-]+):/gm), (match) => match[1]));
    cursor = next(page);
  } while (cursor);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.filter((id) => id.startsWith("reference/")).length >= 48);
  for (const id of ids) {
    const contents = await read(endpoint, id);
    for (const match of contents.matchAll(/\]\(trust-doc:\/\/\/([^\s)#]+)(?:#[^)]*)?\)/g)) {
      assert.ok(ids.includes(match[1]), `Unreachable packaged link ${match[1]} from ${id}`);
    }
  }
}

test("documentation MCP serves complete bounded guides, reference tables and navigable examples", async () => {
  const runtime = await startPublicRuntime("trust-documentation-");
  try {
    await verify(runtime.endpoint);
  } finally {
    await runtime.close();
  }
});

test("packed runtime documentation works outside the checkout without UI or source document directories", {
  timeout: 120000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-packaged-documentation-"));
  const installed = new Set();
  let child;
  try {
    // Copy actual runtime dependencies; archive workspace packages, excluding source docs.
    async function install(source) {
      const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
      if (installed.has(manifest.name)) return;
      installed.add(manifest.name);
      const destination = path.join(directory, "node_modules", manifest.name);
      await mkdir(destination, { recursive: true });
      if (manifest.name.startsWith("@trust/")) {
        const packed = JSON.parse(
          execFileSync(
            "npm",
            [
              "pack",
              source,
              "--ignore-scripts",
              "--workspaces=false",
              "--json",
              "--cache",
              path.join(directory, "cache"),
              "--pack-destination",
              directory,
            ],
            { cwd: directory, encoding: "utf8" },
          ),
        );
        const archive = Array.isArray(packed) ? packed[0] : packed[manifest.name];
        assert.ok(archive.filename);
        if (manifest.name === "@trust/runtime")
          assert.ok(archive.files.some((file) => file.path === "dist/documentation/catalog.json"));
        execFileSync("tar", [
          "-xzf",
          path.join(directory, archive.filename),
          "--strip-components=1",
          "-C",
          destination,
        ]);
      } else
        await cp(source, destination, {
          recursive: true,
          filter: (file) => file === source || !path.relative(source, file).split(path.sep).includes("node_modules"),
        });
      const require = createRequire(path.join(source, "package.json"));
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (dependency.startsWith("@trust/")) {
          await install(path.join(root, "packages", `trust-${dependency.slice(7)}`));
          continue;
        }
        let dependencyRoot;
        try {
          dependencyRoot = path.dirname(require.resolve(`${dependency}/package.json`));
        } catch {
          dependencyRoot = path.dirname(require.resolve(dependency));
          while (true) {
            try {
              const candidate = JSON.parse(await readFile(path.join(dependencyRoot, "package.json"), "utf8"));
              if (candidate.name === dependency && typeof candidate.version === "string") break;
            } catch {}
            const parent = path.dirname(dependencyRoot);
            if (parent === dependencyRoot) throw new Error(`Could not find package ${dependency}`);
            dependencyRoot = parent;
          }
        }
        await install(dependencyRoot);
      }
    }
    await install(path.join(root, "packages/trust-runtime"));
    assert.equal(installed.has("@trust/ui"), false);
    const emptyOperations = path.join(directory, "operations");
    await mkdir(emptyOperations);
    child = spawn(process.execPath, [path.join(directory, "node_modules/@trust/runtime/dist/src/index.js")], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        TRUST_HOST: "127.0.0.1",
        TRUST_PORT: "0",
        TRUST_DATABASE_PATH: path.join(directory, "runtime.sqlite"),
        TRUST_OPERATIONS_DIRECTORY: emptyOperations,
      },
      stdio: "pipe",
    });
    const endpoint = await new Promise((resolve, reject) => {
      let output = "";
      let error = "";
      child.stderr.on("data", (chunk) => {
        error += String(chunk);
      });
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        const matched = output.match(/TRUST runtime listening on ([^:]+):(\d+)/);
        if (matched) resolve(`http://${matched[1]}:${matched[2]}`);
      });
      child.once("exit", () => reject(new Error(`Packaged runtime failed: ${error}`)));
      child.once("error", reject);
    });
    await verify(endpoint);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(directory, { recursive: true, force: true });
  }
});
