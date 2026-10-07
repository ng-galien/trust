import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const LISTEN_TIMEOUT_MS = 30_000;
const GATE_TIMEOUT_MS = 20_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const runtimeEntry = path.join(packageRoot, "dist/src/index.js");
const gateScript = path.join(repositoryRoot, "scripts/workspace-gate.mjs");
const agentGuide = "docs/agents/author-interface.md";
const documentationPage = "guides/interface-authoring.mdx";
const contentRoot = path.join(repositoryRoot, "packages/trust-ui/src/docs/content");
const interfaceProcedure = path.join(
  repositoryRoot,
  "trust-extension/extensions/corpus/procedures/delegation/delegation-interface-3.0.0.procedure.feature",
);
const TOKEN_FILE = "packages/trust-ui/src/tokens.css";
const HOST_CATALOGUES = "packages/trust-ui/src/i18n";
const CORPUS_UI = "trust-extension/extensions/corpus/ui";
/* The Corpus extension is a Git submodule of a private repository; a checkout without it skips these tests. */
const skip = existsSync(path.join(repositoryRoot, CORPUS_UI)) ? false : "the Corpus submodule is not checked out";

interface GateResult {
  readonly gate: string;
  readonly passed: number;
  readonly findings: number;
  readonly summary: string;
  readonly details: readonly string[];
}

interface Fence {
  readonly language: string;
  readonly meta: string;
  readonly code: string;
}

interface Guide {
  readonly name: string;
  readonly text: string;
}

const temporaryDirectories: string[] = [];
after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true, maxRetries: 5 });
});

test("CXP-130 AC1 the guide names the theme token file, the style sheet convention, the English and French catalogues and the components to reuse", {
  skip,
}, async () => {
  const tokens = await readFile(path.join(repositoryRoot, TOKEN_FILE), "utf8");
  assert.match(tokens, /:root \{[\s\S]*--color-surface:/u, "the token file defines the light theme");
  assert.match(tokens, /html\.dark \{[\s\S]*--color-surface:/u, "the token file defines the dark theme");
  assert.ok(existsSync(path.join(repositoryRoot, HOST_CATALOGUES, "en/index.ts")), "the host English catalogue");
  assert.ok(existsSync(path.join(repositoryRoot, HOST_CATALOGUES, "fr/index.ts")), "the host French catalogue");
  assert.match(
    await readFile(path.join(repositoryRoot, CORPUS_UI, "i18n.tsx"), "utf8"),
    /^const fr: Record<string, string> = \{/mu,
    "the Corpus French catalogue",
  );

  for (const guide of await guides()) {
    for (const named of [
      TOKEN_FILE,
      `${HOST_CATALOGUES}/en/<area>.ts`,
      `${HOST_CATALOGUES}/fr/<area>.ts`,
      `${CORPUS_UI}/i18n.tsx`,
      "trail.module.css",
      "@theme inline",
    ])
      assert.ok(guide.text.includes(named), `${guide.name} names ${named}`);
    assert.match(guide.text, /\| [^|\n]*\| `packages\/trust-ui\/src\/tokens\.css`/u, `${guide.name} has the token row`);
    assert.ok(
      /One CSS module per component|Un module CSS par composant/u.test(guide.text),
      `${guide.name} states the style sheet convention`,
    );

    const components = componentReferences(guide.text);
    assert.ok(components.host.length >= 10, `${guide.name} lists host components`);
    assert.ok(components.corpus.length >= 6, `${guide.name} lists Corpus components`);
    for (const [directory, references] of [
      ["packages/trust-ui/src/ui", components.host],
      [CORPUS_UI, components.corpus],
    ] as const) {
      for (const { component, file } of references) {
        const source = await readFile(path.join(repositoryRoot, directory, file), "utf8");
        assert.match(
          source,
          new RegExp(`^export (?:function|const) ${component}\\b`, "mu"),
          `${guide.name}: ${directory}/${file} exports ${component}`,
        );
      }
    }
  }
});

test("CXP-130 AC2 the guide gives a conforming example and a refused example for each interface rule of the Procedure", {
  skip,
}, async () => {
  const procedure = await readFile(interfaceProcedure, "utf8");
  const rules = /one string "interface rules" fixed as "([^"]+)"/u.exec(procedure)?.[1]?.split(" ") ?? [];
  assert.equal(rules.length, 8, "the Procedure fixes eight interface rules");

  const all = await guides();
  for (const guide of all) {
    for (const rule of rules) {
      const section = ruleSection(guide.text, rule);
      assert.ok(section, `${guide.name} has a section for ${rule}`);
      const fences = pageFences(section);
      const conforming = fences.filter((fence) => fence.meta === `id="${rule}-conforming"`);
      const refused = fences.filter((fence) => fence.meta === `id="${rule}-refused"`);
      assert.equal(conforming.length, 1, `${guide.name}: one conforming example for ${rule}`);
      assert.equal(refused.length, 1, `${guide.name}: one refused example for ${rule}`);
      assert.ok(conforming[0]?.code.trim(), `${guide.name}: the conforming example of ${rule} is not empty`);
      assert.notEqual(conforming[0]?.code, refused[0]?.code, `${guide.name}: the ${rule} examples differ`);
    }
  }
  const [english, french] = await documentationPages();
  assert.deepEqual(pageFences(french), pageFences(english), "the French page has the same examples");
  const agent = all.find((guide) => guide.name === agentGuide);
  assert.deepEqual(pageFences(agent?.text ?? ""), pageFences(english), "the agent guide has the same examples");
  for (const rule of rules) {
    const sentence = new RegExp(`${rule}: ([^.]+\\.)`, "u").exec(procedure)?.[1];
    assert.ok(sentence, `the Procedure states ${rule}`);
    const statement = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    assert.ok(ruleSection(agent?.text ?? "", rule)?.includes(statement), `the guide states ${rule} as the Procedure`);
  }

  const example = (rule: string, kind: string): string =>
    pageFences(english).find((fence) => fence.meta === `id="${rule}-${kind}"`)?.code ?? "";
  const conforming = await gateOn({ "packages/trust-ui/src/example.css": example("theme-tokens", "conforming") });
  assert.equal(conforming.passed, 1, `the conforming theme example passes the gate: ${conforming.summary}`);
  const refusedSource = example("theme-tokens", "refused");
  const refused = await gateOn({ "packages/trust-ui/src/example.css": refusedSource });
  assert.equal(refused.passed, 0, "the refused theme example fails the gate");
  const refusedLines = refusedSource
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /#|rgb\(/u.test(line))
    .map(({ number }) => `packages/trust-ui/src/example.css:${number}`);
  assert.equal(refusedLines.length, 4);
  for (const location of refusedLines)
    assert.ok(
      refused.details.some((finding) => finding.startsWith(`${location} `)),
      `the gate names ${location}`,
    );
});

test("CXP-130 AC3 the agent guide links to the interface guide and the integrated documentation gives it through MCP", {
  skip,
}, async () => {
  const skill = await readFile(path.join(repositoryRoot, "docs/agents/SKILL.md"), "utf8");
  assert.match(skill, /\[Interface authoring\]\(author-interface\.md\)/u, "the agent guide links to the guide");
  const agent = await readFile(path.join(repositoryRoot, agentGuide), "utf8");
  assert.ok(
    agent.includes("(../../packages/trust-ui/src/docs/content/en/guides/interface-authoring.mdx)"),
    "the guide links to its page in the integrated documentation",
  );
  for (const language of ["en", "fr"]) {
    const page = await readFile(path.join(contentRoot, language, documentationPage), "utf8");
    assert.match(page, /^title: "[^"]+"$/mu, `the ${language} page has a title`);
  }

  await promisify(execFile)(process.execPath, ["scripts/package-documentation.mjs"], {
    cwd: packageRoot,
    timeout: GATE_TIMEOUT_MS,
  });
  const runtime = await startRuntime();
  try {
    const skillDocument = await readDocument(runtime.endpoint, "agents/SKILL");
    assert.ok(skillDocument.includes("(trust-doc:///agents/author-interface)"), "the packaged skill links the guide");
    const guide = await readDocument(runtime.endpoint, "agents/author-interface");
    const page = await readDocument(runtime.endpoint, "reference/guides/interface-authoring");
    for (const [name, text] of [
      ["agents/author-interface", guide],
      ["reference/guides/interface-authoring", page],
    ] as const) {
      assert.ok(text.includes(TOKEN_FILE), `${name} through MCP names the token file`);
      assert.ok(text.includes('id="theme-tokens-refused"'), `${name} through MCP gives the examples`);
    }
    assert.ok(guide.includes("(trust-doc:///reference/guides/interface-authoring)"), "the guide links its page");
    const listed = await callTool(runtime.endpoint, "trust_documentation_list", { query: "interface authoring" });
    assert.match(listed, /agents\/author-interface/u);
    assert.match(listed, /reference\/guides\/interface-authoring/u);
  } finally {
    await runtime.close();
  }
});

test("CXP-140 AC1 the gate fails and names the key when a translation key exists in one language catalogue only", {
  skip,
}, async () => {
  const englishCommon = await readFile(path.join(repositoryRoot, HOST_CATALOGUES, "en/common.ts"), "utf8");
  const frenchCommon = await readFile(path.join(repositoryRoot, HOST_CATALOGUES, "fr/common.ts"), "utf8");
  const files: Record<string, string> = {
    [`${HOST_CATALOGUES}/en/common.ts`]: insertAfter(
      englishCommon,
      "  actions: {\n",
      '    onlyInEnglish: "Only in English",\n',
    ),
    [`${HOST_CATALOGUES}/fr/common.ts`]: insertAfter(
      frenchCommon,
      "  states: {\n",
      '    onlyInFrench: "Seulement en français",\n',
    ),
    [`${CORPUS_UI}/i18n.tsx`]: [
      "const fr: Record<string, string> = {",
      '  "Shared text": "Texte partagé",',
      '  "Stale text": "Texte abandonné",',
      '  "kind|Thread": "Fil",',
      "};",
      "export const translate = (text: string) => fr[text] ?? text;",
      "",
    ].join("\n"),
    [`${CORPUS_UI}/page.tsx`]: [
      "export function Page({ t, kind }: { t(text: string): string; kind: string }) {",
      `  return [t("Shared text"), t(kind ? "Untranslated text" : "Shared text"), t(\`kind|\${kind}\`)];`,
      "}",
      "",
    ].join("\n"),
  };
  const result = await gateOn(files, { copyHostCatalogues: true });
  assert.equal(result.passed, 0, result.summary);
  assert.equal(result.findings, 4, result.details.join("\n"));
  assert.deepEqual(
    [...result.details].sort(),
    [
      `${CORPUS_UI}/i18n.tsx: key "Stale text" is in French only`,
      `${CORPUS_UI}/i18n.tsx: key "Untranslated text" is in English only (${CORPUS_UI}/page.tsx:2)`,
      `${HOST_CATALOGUES}/{en,fr}/common.ts: key "common.actions.onlyInEnglish" is in English only`,
      `${HOST_CATALOGUES}/{en,fr}/common.ts: key "common.states.onlyInFrench" is in French only`,
    ].sort(),
  );
  for (const named of [
    '"common.actions.onlyInEnglish" English only',
    '"common.states.onlyInFrench" French only',
    '"Stale text" French only',
    '"Untranslated text" English only',
  ])
    assert.ok(result.summary.includes(named), `the gate summary names ${named}: ${result.summary}`);
});

test("CXP-140 AC2 the gate fails and names file and line when a style sheet writes a colour outside the token files", {
  skip,
}, async () => {
  const sheet = [
    "/* A comment may mention #ffffff or white. */",
    ".panel {",
    "  color: #ff0000;",
    "  white-space: nowrap;",
    "  background: var(--color-surface, white);",
    "  border-color: transparent;",
    "  outline-color: rgb(0 0 0 / 10%);",
    "  fill: currentColor;",
    "  stroke: inherit;",
    "  box-shadow: var(--shadow-2);",
    "  background-image: color-mix(in srgb, var(--color-accent) 10%, transparent);",
    '  content: "#123";',
    "}",
    "",
  ].join("\n");
  const module = [
    ".root {",
    "  --corpus-text: var(--color-text, #1d2430);",
    "  color: var(--corpus-text);",
    "}",
    "",
  ].join("\n");
  const result = await gateOn({
    "packages/trust-ui/src/screen.css": sheet,
    [`${CORPUS_UI}/panel.module.css`]: module,
  });
  assert.equal(result.passed, 0, result.summary);
  assert.deepEqual(result.details, [
    "packages/trust-ui/src/screen.css:3 writes colour #ff0000",
    "packages/trust-ui/src/screen.css:5 writes colour white",
    "packages/trust-ui/src/screen.css:7 writes colour rgb(0 0 0 / 10%)",
    `${CORPUS_UI}/panel.module.css:2 writes colour #1d2430`,
  ]);
  assert.equal(result.findings, 4);
  for (const location of [
    "packages/trust-ui/src/screen.css:3",
    "packages/trust-ui/src/screen.css:5",
    "packages/trust-ui/src/screen.css:7",
    `${CORPUS_UI}/panel.module.css:2`,
  ])
    assert.ok(result.summary.includes(location), `the gate summary names ${location}`);
  assert.ok(!result.details.some((finding) => finding.startsWith(TOKEN_FILE)), "the token file may write colours");
});

test("CXP-140 AC3 the existing style sheets of Corpus and of the host pass the gate", { skip }, async () => {
  const started = Date.now();
  const result = await runGate(repositoryRoot, "interface-rules");
  assert.ok(Date.now() - started < GATE_TIMEOUT_MS, "the measured rules run quickly");
  assert.equal(result.gate, "interface-rules");
  assert.deepEqual(result.details, [], result.details.join("\n"));
  assert.equal(result.passed, 1, result.summary);
  assert.equal(result.findings, 0);
  const measured = Number(/and (\d+) style sheets use theme tokens/u.exec(result.summary)?.[1] ?? 0);
  const host = await styleSheets(path.join(repositoryRoot, "packages/trust-ui/src"));
  const corpus = await styleSheets(path.join(repositoryRoot, CORPUS_UI));
  assert.ok(host.length >= 5 && corpus.length >= 10, "the host and Corpus have style sheets");
  assert.ok(measured >= host.length + corpus.length, `the gate measured ${measured} style sheets`);
});

/** The agent guide and the English and French pages of the integrated documentation. */
async function guides(): Promise<readonly Guide[]> {
  const [english, french] = await documentationPages();
  return [
    { name: agentGuide, text: await readFile(path.join(repositoryRoot, agentGuide), "utf8") },
    { name: `en/${documentationPage}`, text: english },
    { name: `fr/${documentationPage}`, text: french },
  ];
}

async function documentationPages(): Promise<readonly [string, string]> {
  return [
    await readFile(path.join(contentRoot, "en", documentationPage), "utf8"),
    await readFile(path.join(contentRoot, "fr", documentationPage), "utf8"),
  ];
}

/** Components listed as `Name` followed by their (`file.tsx`), in the host bullet then the Corpus bullet. */
function componentReferences(text: string): {
  readonly host: readonly { component: string; file: string }[];
  readonly corpus: readonly { component: string; file: string }[];
} {
  const bullet = (prefix: string): string => {
    const start = text.indexOf(`- ${prefix}`);
    assert.ok(start >= 0, `the guide has the ${prefix} components`);
    const end = text.indexOf("\n- ", start + 2);
    const blank = text.indexOf("\n\n", start);
    return text.slice(
      start,
      [end, blank].filter((value) => value > 0).reduce((a, b) => Math.min(a, b)),
    );
  };
  const references = (list: string) => {
    const found: { component: string; file: string }[] = [];
    for (const group of list.matchAll(/((?:`[A-Z]\w+`(?:, )?)+) \(`([\w-]+\.tsx)`/gu)) {
      for (const component of (group[1] ?? "").matchAll(/`([A-Z]\w+)`/gu))
        found.push({ component: component[1] ?? "", file: group[2] ?? "" });
    }
    return found;
  };
  return {
    host: references(bullet(text.includes("- Host,") ? "Host," : "Hôte,")),
    corpus: references(bullet("Corpus,")),
  };
}

function ruleSection(text: string, rule: string): string | undefined {
  const start = text.indexOf(`### \`${rule}\``);
  if (start < 0) return undefined;
  const next = text.slice(start + 4).search(/^#{2,3} /mu);
  return next < 0 ? text.slice(start) : text.slice(start, start + 4 + next);
}

function pageFences(text: string): readonly Fence[] {
  return [...text.matchAll(/^```(\w+)([^\n]*)\n([\s\S]*?)^```/gmu)].map((match) => ({
    language: match[1] ?? "",
    meta: (match[2] ?? "").trim(),
    code: match[3] ?? "",
  }));
}

function insertAfter(source: string, anchor: string, addition: string): string {
  const index = source.indexOf(anchor);
  assert.ok(index >= 0, `the catalogue has ${anchor.trim()}`);
  return source.slice(0, index + anchor.length) + addition + source.slice(index + anchor.length);
}

/** Runs the measured interface rules on a fixture checkout holding the host token file and the given files. */
async function gateOn(
  files: Readonly<Record<string, string>>,
  options: { readonly copyHostCatalogues?: boolean } = {},
): Promise<GateResult> {
  const root = await mkdtemp(path.join(tmpdir(), "trust-interface-rules-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, path.dirname(TOKEN_FILE)), { recursive: true });
  await cp(path.join(repositoryRoot, TOKEN_FILE), path.join(root, TOKEN_FILE));
  if (options.copyHostCatalogues)
    await cp(path.join(repositoryRoot, HOST_CATALOGUES), path.join(root, HOST_CATALOGUES), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return runGate(root, "interface-rules");
}

async function runGate(cwd: string, gate: string): Promise<GateResult> {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [gateScript, gate], {
    cwd,
    timeout: GATE_TIMEOUT_MS,
  });
  const [name = "", passed = "", findings = "", summary = ""] = stdout.split("\n");
  return {
    gate: name,
    passed: Number(passed),
    findings: Number(findings),
    summary,
    details: stderr.split("\n").filter((line) => line.trim()),
  };
}

async function styleSheets(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name)) found.push(...(await styleSheets(full)));
    else if (entry.isFile() && entry.name.endsWith(".css")) found.push(full);
  }
  return found;
}

async function callTool(endpoint: string, name: string, args: Readonly<Record<string, unknown>>): Promise<string> {
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    readonly error?: unknown;
    readonly result?: { readonly isError?: boolean; readonly content: readonly { readonly text: string }[] };
  };
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.notEqual(result.result?.isError, true, JSON.stringify(result));
  return (result.result?.content ?? []).map((part) => part.text).join("\n");
}

/** Reads a whole document through the MCP documentation tool, following its page cursors. */
async function readDocument(endpoint: string, document: string): Promise<string> {
  let text = "";
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await callTool(endpoint, "trust_documentation_read", {
      document,
      limit: 12000,
      ...(cursor ? { cursor } : {}),
    });
    text += page.split("\nCONTENT\n")[1] ?? "";
    cursor = /^Next cursor: (.+)$/mu.exec(page)?.[1];
    assert.ok(++pages < 50, "pagination terminates");
  } while (cursor);
  return text;
}

async function startRuntime(): Promise<{ readonly endpoint: string; close(): Promise<void> }> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "trust-interface-guide-"));
  const environment: Record<string, string | undefined> = { ...process.env };
  delete environment.TRUST_DATABASE_PATH;
  delete environment.TRUST_DATABASE_URL;
  delete environment.TRUST_PGLITE_DIRECTORY;
  const child = spawn(process.execPath, [runtimeEntry], {
    env: {
      ...environment,
      TRUST_HOST: "127.0.0.1",
      TRUST_PORT: "0",
      TRUST_STORAGE: "pglite",
      TRUST_PGLITE_DIRECTORY: path.join(dataDirectory, "pglite"),
      TRUST_CREDENTIAL_KEY_FILE: path.join(dataDirectory, "credential.key"),
    },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const close = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    return { endpoint: await listeningEndpoint(child, () => stderr), close };
  } catch (error) {
    await close();
    throw error;
  }
}

function listeningEndpoint(child: ChildProcessWithoutNullStreams, stderr: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`TRUST runtime did not listen within ${LISTEN_TIMEOUT_MS} ms. stderr=${stderr()}`));
    }, LISTEN_TIMEOUT_MS);
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      const match = /TRUST runtime listening on (127\.0\.0\.1):(\d+)/u.exec(stdout);
      if (!match) return;
      cleanup();
      resolve(`http://${match[1]}:${match[2]}`);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`TRUST runtime stopped before listening (code=${String(code)}). stderr=${stderr()}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.once("exit", onExit);
  });
}
