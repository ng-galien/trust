import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { startPublicRuntime } from "../dist/acceptance/support/runtime-process.js";

const execFileAsync = promisify(execFile);
const GUIDE = "reference/guides/registries";
const REGISTRY_ERROR_CODE = -32050;

let workspace;
let packagesDirectory;
let runtime;
let endpoint;
let server;
let serverOrigin;
/** Files served by the loopback HTTP registry, keyed by URL path; every request is logged. */
const served = new Map();
const requests = [];

before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "trust-documentation-registry-"));
  packagesDirectory = path.join(workspace, "packages");
  await mkdir(path.join(workspace, "operations"), { recursive: true });
  runtime = await startPublicRuntime("trust-documentation-registry-runtime-", {
    operationsDirectory: path.join(workspace, "operations"),
    processEnvironment: { TRUST_PACKAGES_DIRECTORY: packagesDirectory },
  });
  endpoint = runtime.endpoint;
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const body = served.get(request.url);
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  serverOrigin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await runtime?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

// --- Public surfaces -------------------------------------------------------------------------------------

async function post(pathname, body, headers = {}) {
  const response = await fetch(`${endpoint}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function mcp(method, params) {
  const envelope = await post(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method, params },
    {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
  );
  assert.equal(envelope.error, undefined, JSON.stringify(envelope));
  return envelope.result;
}

async function tool(name, args) {
  const result = await mcp("tools/call", { name, arguments: args });
  return {
    isError: result.isError === true,
    text: result.content.map((part) => part.text).join("\n"),
  };
}

async function rpc(method, params) {
  const envelope = await post("/rpc", {
    jsonrpc: "2.0",
    id: method,
    method,
    params,
  });
  assert.equal(envelope.error, undefined, `${method}: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}

/** A registry refusal: the documented JSON-RPC error code and its `trust.registry-error@1` body. */
async function refusal(method, params) {
  const envelope = await post("/rpc", {
    jsonrpc: "2.0",
    id: method,
    method,
    params,
  });
  assert.ok(envelope.error, `${method} unexpectedly succeeded: ${JSON.stringify(envelope.result)}`);
  assert.equal(envelope.error.code, REGISTRY_ERROR_CODE, JSON.stringify(envelope.error));
  assert.equal(envelope.error.data.contract, "trust.registry-error@1");
  return envelope.error.data;
}

// --- Packaged documentation ------------------------------------------------------------------------------

function nextCursor(text) {
  return text.match(/^Next cursor: (.+)$/m)?.[1];
}

async function discover(query) {
  const ids = [];
  let cursor;
  do {
    const page = await tool("trust_documentation_list", {
      query,
      limit: 25,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.isError, false, page.text);
    ids.push(...Array.from(page.text.matchAll(/^- ([A-Za-z0-9_./-]+):/gm), (match) => match[1]));
    cursor = nextCursor(page.text);
  } while (cursor);
  return ids;
}

async function read(document) {
  let cursor;
  let text = "";
  let pages = 0;
  do {
    const page = await tool("trust_documentation_read", {
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

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** The documented worked example: its index and the exact bytes of every Operation file it declares. */
function documentedExample(guide) {
  const index = guide.match(/```json id="registry-example-index"\n([\s\S]*?)\n```/)?.[1];
  assert.ok(index, "the guide carries the worked example index");
  const sources = new Map(
    Array.from(guide.matchAll(/```gherkin operation id="registry-example-([a-z-]+)"\n([\s\S]*?\n)```/g), (match) => [
      `operations/${match[1]}.feature`,
      match[2],
    ]),
  );
  return { index: JSON.parse(index), indexText: `${index}\n`, sources };
}

/** Write the documented example below a directory and return the index file path. */
async function writeExample(directory, example) {
  await mkdir(path.join(directory, "operations"), { recursive: true });
  for (const [relative, source] of example.sources) await writeFile(path.join(directory, relative), source);
  const indexFile = path.join(directory, "trust-registry.json");
  await writeFile(indexFile, example.indexText);
  return indexFile;
}

function packageNames(view) {
  return view.packages.map((value) => `${value.name}@${value.version}`).sort();
}

// --- Assertions ------------------------------------------------------------------------------------------

test("REG-010 AC1 the documentation presents extension management as the entry point for sources, packages, settings, updates and uninstallation", {
  timeout: 120000,
}, async () => {
  const found = await discover("extension management");
  for (const id of [GUIDE, "reference/screens/index"])
    assert.ok(found.includes(id), `search for extension management must find ${id}: ${found.join(", ")}`);

  const guide = await read(GUIDE);
  const management = section(guide, "## Extension management");
  assert.match(management, /Extension management is the entry point for every registry action/);
  assert.match(management, /Open it from the sidebar with \*\*Extensions\*\*/);
  for (const action of [
    "Add a source",
    "Refresh a source",
    "Browse packages",
    "Install a package",
    "Configure settings",
    "Update a package",
    "Uninstall a package",
    "Remove a source",
  ])
    assert.match(management, new RegExp(`^\\| ${action} \\| [^|\\n]+ \\|$`, "m"), `the entry point lists ${action}`);
  assert.match(management, /Every action names its source and its package, and its result lists what changed/);
  assert.match(
    management,
    /Preparing the storage of an extension, starting it and stopping it remain separate actions/,
  );
  // Each action of the entry point is described in its own section.
  for (const heading of [
    "## Sources",
    "## Packages",
    "## Refresh policy",
    "## Install a package",
    "## Extension settings",
    "## Update a package",
    "## Uninstall a package or remove a source",
  ])
    assert.ok(section(guide, heading).trim().length > 0, `${heading} is described`);

  const settings = section(guide, "## Extension settings");
  assert.match(
    settings,
    /TRUST validates them against the declaration and stores them; they are never written into the package/,
  );
  assert.match(settings, /A credential setting holds the name of an environment variable[^\n]*never returns its value/);
  const uninstall = section(guide, "## Uninstall a package or remove a source");
  assert.match(uninstall, /Uninstalling removes the package files, the extension installation and its settings/);
  assert.match(uninstall, /The packages installed from it stay installed, and the result lists them/);

  const screens = section(await read("reference/screens/index"), "## Extensions");
  assert.match(screens, /`\/extensions` — extension management, reached from \*\*Extensions\*\* in the sidebar/);
  assert.match(
    screens,
    /entry point of the registry: sources, the packages they offer, installation, extension settings, updates and uninstallation/,
  );
  assert.match(screens, /trust-doc:\/\/\/reference\/guides\/registries/);

  // Every documented method is served under its documented MCP tool name and result contract.
  const rows = Array.from(
    guide.matchAll(/^\| `(registry\.[a-z.]+) \{[^`]*\}` \| `(trust_[a-z_]+)` \| `(trust\.[a-z-]+@\d+)`/gm),
    (match) => ({ method: match[1], tool: match[2], contract: match[3] }),
  );
  assert.equal(rows.length, 9, "the RPC and MCP table documents the nine registry methods");
  const tools = new Set((await mcp("tools/list", {})).tools.map((entry) => entry.name));
  for (const { method, tool: name } of rows) {
    assert.equal(name, `trust_${method.replaceAll(".", "_")}`, "the documented naming rule holds");
    assert.ok(tools.has(name), `the public MCP surface serves ${name}`);
  }
  for (const name of tools)
    if (name.startsWith("trust_registry_")) assert.ok(guide.includes(`\`${name}\``), `the guide documents ${name}`);
  for (const name of ["trust_extension_settings_read", "trust_extension_settings_update"]) {
    assert.ok(tools.has(name), `the public MCP surface serves ${name}`);
    assert.ok(guide.includes(`\`${name}`), `the guide documents ${name}`);
  }
  const contract = (method) => rows.find((row) => row.method === method).contract;
  assert.equal((await rpc("registry.source.list", {})).contract, contract("registry.source.list"));
  assert.equal((await rpc("registry.package.list", {})).contract, contract("registry.package.list"));
});

test("REG-030 AC1 the documentation describes Git, HTTP and local file registry sources", {
  timeout: 120000,
}, async () => {
  const guide = await read(GUIDE);
  const sources = section(guide, "## Sources");
  assert.match(
    sources,
    /^- \*\*Git\*\*: the URL of a repository, with an optional branch or tag\. The index is always `trust-registry\.json` at the repository root\.$/m,
  );
  assert.match(
    sources,
    /^- \*\*HTTP\*\*: the URL of the index itself\. HTTPS is required, except on the loopback address during development\.$/m,
  );
  assert.match(sources, /^- \*\*Local file\*\*: the absolute path of an index file on the server\.$/m);
  assert.match(sources, /Adding a source only stores its configuration/);
  assert.match(
    guide,
    /`npm exec -- trust registry add NAME git URL \[--ref REF\]`, `add NAME http INDEX_URL`, `add NAME file \/absolute\/path\/trust-registry\.json`/,
  );

  // The three documented kinds serve the documented worked example through the public runtime.
  const example = documentedExample(guide);
  const expected = packageNames(example.index);

  const gitRepository = path.join(workspace, "git-source");
  await writeExample(gitRepository, example);
  const git = (...args) => execFileAsync("git", args, { cwd: gitRepository });
  await git("init", "--quiet", "--initial-branch=main");
  await git("add", ".");
  await git("-c", "user.name=Docs", "-c", "user.email=docs@example.invalid", "commit", "--quiet", "-m", "registry");
  const commit = (await git("rev-parse", "HEAD")).stdout.trim();

  const fileIndex = await writeExample(path.join(workspace, "file-source"), example);

  served.set("/sources/trust-registry.json", example.indexText);
  for (const [relative, source] of example.sources) served.set(`/sources/${relative}`, source);

  const saved = [
    { name: "docs-git", kind: "git", url: gitRepository, reference: "main" },
    {
      name: "docs-http",
      kind: "http",
      url: `${serverOrigin}/sources/trust-registry.json`,
    },
    { name: "docs-file", kind: "file", url: fileIndex },
  ];
  for (const input of saved) {
    const result = await rpc("registry.source.save", input);
    assert.equal(result.contract, "trust.registry-source@1");
    assert.deepEqual(
      {
        name: result.source.name,
        kind: result.source.kind,
        url: result.source.url,
        reference: result.source.reference,
      },
      { reference: undefined, ...input },
    );
    // Adding a source only stores its configuration: nothing has been read yet.
    assert.equal((await refusal("registry.source.read", { name: input.name })).reason, "index-not-refreshed");
  }
  assert.deepEqual((await rpc("registry.source.list", {})).sources.map((source) => source.kind).sort(), [
    "file",
    "git",
    "http",
  ]);
  assert.equal(requests.length, 0, `saving sources contacted the HTTP source: ${requests.join(", ")}`);

  const revisions = {
    "docs-git": commit,
    "docs-http": sha256(example.indexText),
    "docs-file": sha256(example.indexText),
  };
  for (const { name } of saved) {
    const view = await rpc("registry.source.refresh", { name });
    assert.equal(view.contract, "trust.registry-source-index@1");
    assert.equal(view.revision, revisions[name], `${name} records the documented revision`);
    assert.deepEqual(packageNames(view), expected, `${name} offers the documented packages`);
  }
  assert.ok(requests.includes("GET /sources/trust-registry.json"), requests.join(", "));

  // A Git index lives only at the repository root.
  const misplaced = path.join(workspace, "git-misplaced");
  await mkdir(path.join(misplaced, "registry"), { recursive: true });
  await writeFile(path.join(misplaced, "registry", "trust-registry.json"), example.indexText);
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: misplaced,
  });
  await execFileAsync("git", ["add", "."], { cwd: misplaced });
  await execFileAsync(
    "git",
    ["-c", "user.name=Docs", "-c", "user.email=docs@example.invalid", "commit", "--quiet", "-m", "misplaced"],
    { cwd: misplaced },
  );
  await rpc("registry.source.save", {
    name: "docs-git-misplaced",
    kind: "git",
    url: misplaced,
  });
  const notAtRoot = await refusal("registry.source.refresh", {
    name: "docs-git-misplaced",
  });
  assert.equal(notAtRoot.reason, "source-unavailable", JSON.stringify(notAtRoot));
  assert.match(notAtRoot.message, /Registry index could not be read/);

  // The documented source rules are the ones the runtime enforces.
  assert.equal(
    (
      await refusal("registry.source.save", {
        name: "plain-http",
        kind: "http",
        url: "http://registry.example.com/trust-registry.json",
      })
    ).reason,
    "invalid-source",
  );
  assert.equal(
    (
      await refusal("registry.source.save", {
        name: "relative-file",
        kind: "file",
        url: "trust-registry.json",
      })
    ).reason,
    "invalid-source",
  );
  assert.equal(
    (
      await refusal("registry.source.save", {
        name: "credential-url",
        kind: "http",
        url: "https://user:secret@registry.example.com/trust-registry.json",
      })
    ).reason,
    "invalid-source",
  );
});

test("REG-030 AC2 the documentation describes an index offering several packages selected individually", {
  timeout: 120000,
}, async () => {
  const guide = await read(GUIDE);
  const packages = section(guide, "## Packages");
  assert.match(packages, /One index offers several packages, and may offer several versions of each/);
  assert.match(packages, /^- \*\*extension code\*\*: an extension directory with its `extension\.json`;$/m);
  assert.match(packages, /^- \*\*Operations\*\*;$/m);
  assert.match(packages, /^- \*\*Procedures\*\*\.$/m);
  assert.match(packages, /Each category is optional; a package declares at least one\. No category requires another/);
  assert.match(
    packages,
    /Packages are selected individually\. An installation concerns one package at one exact version/,
  );
  assert.match(packages, /installing a package never installs another package of the same index/);
  assert.match(section(guide, "## Install a package"), /A failure at any step installs nothing/);

  // The worked example is self-consistent: several packages whose digests are those of the documented files.
  const example = documentedExample(guide);
  assert.equal(example.index.contract, "trust.registry-index@2");
  assert.ok(example.index.packages.length >= 2, "the documented index offers several packages");
  for (const declaration of example.index.packages)
    for (const content of declaration.operations) {
      assert.ok(example.sources.has(content.path), `the guide documents ${content.path}`);
      assert.equal(sha256(example.sources.get(content.path)), content.sha256, `${content.path} digest`);
      assert.match(
        example.sources.get(content.path),
        new RegExp(`@operation:${content.name} @version:${content.version}`),
      );
    }

  const indexFile = await writeExample(path.join(workspace, "selection-source"), example);
  await rpc("registry.source.save", {
    name: "docs-selection",
    kind: "file",
    url: indexFile,
  });
  const offered = await rpc("registry.source.refresh", {
    name: "docs-selection",
  });
  assert.deepEqual(packageNames(offered), packageNames(example.index));
  for (const value of offered.packages) {
    assert.equal(value.installedVersion, null, `${value.name} is offered, not installed`);
    assert.deepEqual(value.categories, ["operations"]);
  }

  // Install exactly one documented package; the other stays available and uninstalled.
  const [chosen, ...others] = example.index.packages;
  const installation = await rpc("registry.package.install", {
    source: "docs-selection",
    package: chosen.name,
    version: chosen.version,
  });
  assert.equal(installation.contract, "trust.registry-package-installation@1");
  assert.equal(installation.package.name, chosen.name);
  assert.equal(installation.package.directory, path.join(packagesDirectory, chosen.name, chosen.version));
  assert.equal(installation.steps.build, "skipped", "a package without extension code is never built");
  assert.equal(installation.extension, null);
  assert.deepEqual(
    installation.catalog.map(({ kind, name, version, status }) => ({
      kind,
      name,
      version,
      status,
    })),
    chosen.operations.map(({ name, version }) => ({
      kind: "operation",
      name,
      version,
      status: "imported",
    })),
  );
  assert.deepEqual(
    (await rpc("registry.package.list", {})).packages.map((value) => value.name),
    [chosen.name],
  );
  const listed = await rpc("registry.source.read", {
    name: "docs-selection",
  });
  assert.equal(listed.packages.find((value) => value.name === chosen.name).installedVersion, chosen.version);
  for (const other of others)
    assert.equal(listed.packages.find((value) => value.name === other.name).installedVersion, null);
});

test("REG-060 AC1 the documentation states when TRUST reads a remote index and that a refresh never updates an installed package", {
  timeout: 120000,
}, async () => {
  const guide = await read(GUIDE);
  const policy = section(guide, "## Refresh policy");
  assert.match(policy, /\*\*A refresh never updates an installed package\*\*/);
  assert.match(
    policy,
    /TRUST reads a remote index only on an explicit refresh of its source\. There is no automatic, scheduled or startup refresh\./,
  );
  assert.match(
    policy,
    /A refresh records which packages and versions the source offers; it never installs, updates or uninstalls a package\./,
  );
  assert.match(
    policy,
    /Adding a source, browsing its packages and listing the installed packages never contact the source\./,
  );
  assert.match(
    policy,
    /Installing and updating contact the source to acquire the files of the selected version\. The version must be offered by the last refreshed index/,
  );
  assert.match(policy, /the installed package keeps its version until you update it/);
  assert.match(section(guide, "## Update a package"), /An update is always explicit/);
  assert.match(
    guide,
    /`registry\.source\.read \{ name \}` \| `trust_registry_source_read` \| `trust\.registry-source-index@1`, never contacting the source/,
  );

  // A loopback HTTP registry records every request TRUST makes to it.
  const example = documentedExample(guide);
  const declaration = example.index.packages.at(-1);
  const content = declaration.operations[0];
  const indexPath = "/policy/trust-registry.json";
  const filePath = (relative) => `/policy/${relative}`;
  const publish = (versions) => {
    const packages = versions.map((version) => {
      const relative =
        version === content.version ? content.path : content.path.replace(".feature", `-${version}.feature`);
      const source = example.sources.get(content.path).replace(`@version:${content.version}`, `@version:${version}`);
      served.set(filePath(relative), source);
      return {
        ...declaration,
        version,
        operations: [{ ...content, path: relative, version, sha256: sha256(source) }],
      };
    });
    const text = `${JSON.stringify({ ...example.index, packages }, null, 2)}\n`;
    served.set(indexPath, text);
    return text;
  };
  const policyRequests = () => requests.filter((line) => line.includes(" /policy/"));
  const since = (mark) => policyRequests().slice(mark);

  const firstIndex = publish([declaration.version]);
  await rpc("registry.source.save", {
    name: "docs-policy",
    kind: "http",
    url: `${serverOrigin}${indexPath}`,
  });
  assert.equal((await refusal("registry.source.read", { name: "docs-policy" })).reason, "index-not-refreshed");
  await rpc("registry.package.list", {});
  assert.deepEqual(policyRequests(), [], "adding, browsing and listing never contact the source");

  let mark = policyRequests().length;
  const refreshed = await rpc("registry.source.refresh", {
    name: "docs-policy",
  });
  assert.deepEqual(since(mark), [`GET ${indexPath}`], "a refresh reads the index and nothing else");
  assert.equal(refreshed.revision, sha256(firstIndex));

  mark = policyRequests().length;
  await rpc("registry.package.install", {
    source: "docs-policy",
    package: declaration.name,
    version: declaration.version,
  });
  assert.ok(since(mark).includes(`GET ${filePath(content.path)}`), "installing acquires the package files");

  // A newer version is published; until an explicit refresh TRUST neither sees nor contacts it.
  const newer = "1.1.0";
  const secondIndex = publish([declaration.version, newer]);
  mark = policyRequests().length;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const stale = await rpc("registry.source.read", { name: "docs-policy" });
  assert.equal(stale.revision, refreshed.revision);
  assert.deepEqual(
    stale.packages.map((value) => value.version),
    [declaration.version],
  );
  const beforeRefresh = (await rpc("registry.package.list", {})).packages.find(
    (value) => value.name === declaration.name,
  );
  assert.equal(beforeRefresh.version, declaration.version);
  assert.equal(beforeRefresh.latestVersion, declaration.version);
  assert.equal(
    (
      await refusal("registry.package.update", {
        package: declaration.name,
        version: newer,
      })
    ).reason,
    "unknown-package",
    "an update needs a version offered by the last refreshed index",
  );
  assert.deepEqual(since(mark), [], "nothing contacts the source without an explicit action");

  // The explicit refresh records the new version and leaves the installed package unchanged.
  mark = policyRequests().length;
  const current = await rpc("registry.source.refresh", {
    name: "docs-policy",
  });
  assert.deepEqual(since(mark), [`GET ${indexPath}`], "a refresh acquires no package file");
  assert.equal(current.revision, sha256(secondIndex));
  assert.deepEqual(current.packages.map((value) => value.version).sort(), [declaration.version, newer]);
  for (const value of current.packages) assert.equal(value.installedVersion, declaration.version);
  const afterRefresh = (await rpc("registry.package.list", {})).packages.find(
    (value) => value.name === declaration.name,
  );
  assert.equal(afterRefresh.version, declaration.version, "a refresh never updates an installed package");
  assert.equal(afterRefresh.latestVersion, newer);
  assert.equal(afterRefresh.directory, path.join(packagesDirectory, declaration.name, declaration.version));
  assert.equal(afterRefresh.updatedAt, beforeRefresh.updatedAt);

  // Only the explicit update moves the package.
  const update = await rpc("registry.package.update", {
    package: declaration.name,
    version: newer,
  });
  assert.equal(update.contract, "trust.registry-package-update@1");
  assert.equal(update.previousVersion, declaration.version);
  assert.equal(update.package.version, newer);
  assert.deepEqual(
    update.catalog.map(({ name, version, status }) => ({
      name,
      version,
      status,
    })),
    [{ name: content.name, version: newer, status: "imported" }],
  );
});
