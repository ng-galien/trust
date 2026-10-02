import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  assertBuiltCheckout,
  createIsolatedWorkspace,
  freePorts,
  PACKAGE_NAME,
  packTrustPackage,
  repositoryRoot,
  run,
} from "./package-support.mjs";

/**
 * QUICKSTART.md is executed as written. Its `sh` blocks run in order in one bash session, from an empty
 * directory, with a temporary HOME. Only these documented values are replaced, everywhere they occur in
 * the shell blocks and in the expected outputs:
 *
 * | Documented value   | Replaced by                         | Why                                   |
 * | ------------------ | ----------------------------------- | ------------------------------------- |
 * | `@ng-galien/trust` | the archive produced by `npm pack`  | the package is not published yet      |
 * | `4173`             | a free port                         | the default public port may be in use |
 * | `4318`             | another free port                   | the default runtime port may be in use |
 * | `/home/you`        | the temporary HOME (expected output) | documented example home directory     |
 *
 * The harness adds `set -euo pipefail` and prints a marker before each block so every block's output is
 * compared with the expected output that follows it in the guide. `...` in an expected line matches any
 * text; expected lines must appear in order.
 */

let workspace;
let home;
let environment;
let archive;
let packedVersion;
let staged;
let webPort;
let runtimePort;

before(async () => {
  assertBuiltCheckout();
  ({ workspace, home, environment } = await createIsolatedWorkspace("trust-quickstart-"));
  let packed;
  ({ staged, packed, archive } = await packTrustPackage(workspace, environment));
  packedVersion = packed.version;
  [webPort, runtimePort] = await freePorts(2);
});

after(async () => {
  const pidFile = home && path.join(home, ".trust/server.pid");
  if (pidFile && existsSync(pidFile)) {
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

function readmeLinks(source) {
  return [...source.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

test("DIST-030 AC1 README presents TRUST, prerequisites, installation, start, project setup and links to the detailed documentation", async () => {
  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(staged, "package.json"), "utf8"));

  for (const term of ["Plan", "Check", "Procedure", "Operation", "Runner", "Facts", "VALIDATED", "NOT_VALIDATED"])
    assert.ok(readme.includes(term), `README explains ${term}`);
  assert.match(readme, /never writes its own evidence/);
  const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines.node)?.[1];
  assert.ok(minimum, manifest.engines.node);
  assert.ok(readme.includes(`Node.js ${minimum} or later`), `README requires Node.js ${minimum}`);

  const commands = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]).join("\n");
  assert.ok(commands.includes(`npm install --global ${PACKAGE_NAME}`));
  const help = (await run(environment, process.execPath, [path.join(staged, "bin/trust.js"), "--help"])).stdout;
  for (const invocation of commands.split("\n").filter((line) => line.startsWith("trust "))) {
    const [command, ...rest] = invocation.split(/\s+/).slice(1);
    assert.ok(help.includes(`trust ${command}`), `README command trust ${command} exists`);
    for (const option of rest.filter((part) => part.startsWith("--")))
      assert.ok(help.includes(option), `README option ${option} of trust ${command} exists`);
  }
  for (const subject of ["trust start", "trust setup", "Claude Code", "Codex", ".mcp.json", ".codex/config.toml"])
    assert.ok(readme.includes(subject), `README presents ${subject}`);

  const links = readmeLinks(readme);
  for (const required of [
    "QUICKSTART.md",
    "docs/agents/SKILL.md",
    "docs/agents/install-in-project.md",
    "packages/trust-ui/src/docs/content/en/index.mdx",
    "LICENSE",
  ])
    assert.ok(links.includes(required), `README links ${required}`);
  for (const link of links.filter((target) => !/^https?:\/\//.test(target)))
    assert.ok(existsSync(path.join(repositoryRoot, link.split("#")[0])), `README link ${link} resolves`);

  const guide = await readFile(path.join(repositoryRoot, "docs/agents/install-in-project.md"), "utf8");
  assert.match(guide, /trust setup \/absolute\/project --url http:\/\/127\.0\.0\.1:4173/);
  assert.doesNotMatch(guide, /Copy `assets\/skills\/trust-operations`/, "the guide no longer asks for manual copies");
});

test("DIST-030 AC2 the QUICKSTART commands run literally from the packed package until a connected project executes a first Check", async () => {
  const guide = await readFile(path.join(repositoryRoot, "QUICKSTART.md"), "utf8");
  const substitute = (text) =>
    text.replaceAll(PACKAGE_NAME, archive).replaceAll("4173", String(webPort)).replaceAll("4318", String(runtimePort));
  const fences = [...guide.matchAll(/```(sh|text)\n([\s\S]*?)```/g)].map((match) => ({
    language: match[1],
    body: match[2],
  }));
  const steps = [];
  for (const fence of fences) {
    if (fence.language === "sh") steps.push({ commands: substitute(fence.body), expected: undefined });
    else if (steps.length > 0 && steps.at(-1).expected === undefined)
      steps.at(-1).expected = substitute(fence.body).replaceAll("/home/you", home);
  }
  assert.ok(steps.length >= 8, "the guide has its shell steps");
  for (const value of [PACKAGE_NAME, "4173", "4318"])
    assert.ok(
      fences.some((fence) => fence.language === "sh" && fence.body.includes(value)),
      `${value} is a documented value`,
    );

  const script = [
    "set -euo pipefail",
    ...steps.map((step, index) => `printf '\\n@@quickstart-step ${index}@@\\n'\n${step.commands}`),
  ].join("\n");
  const start = path.join(workspace, "start");
  await mkdir(start);
  let stdout;
  try {
    ({ stdout } = await run(environment, "bash", ["-c", script], { cwd: start, timeout: 100_000 }));
  } catch (error) {
    assert.fail(`QUICKSTART failed: ${error.message}\nstdout:\n${error.stdout}\nstderr:\n${error.stderr}`);
  }
  const outputs = stdout.split(/\n@@quickstart-step \d+@@\n/).slice(1);
  assert.equal(outputs.length, steps.length);

  steps.forEach((step, index) => {
    if (step.expected === undefined) return;
    const lines = outputs[index].split("\n").map((line) => line.trim());
    let cursor = 0;
    for (const expected of step.expected
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      const pattern = new RegExp(
        `^${expected
          .split("...")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      while (cursor < lines.length && !pattern.test(lines[cursor])) cursor++;
      assert.ok(cursor < lines.length, `step ${index}: expected "${expected}" in order in:\n${outputs[index]}`);
      cursor++;
    }
  });

  assert.ok(outputs[1].split("\n").includes(packedVersion), "trust --version prints the installed version");
  const runs = outputs.flatMap((output) => output.match(/"verdict": "[A-Z_]+"/g) ?? []);
  assert.deepEqual(runs, ['"verdict": "NOT_VALIDATED"', '"verdict": "VALIDATED"']);
  assert.equal(outputs.at(-2).trim().split("\n").at(-1), "COMPLETE", "the Plan is complete");
  assert.ok(existsSync(path.join(home, "projects/demo/.claude/skills/trust/scripts/run.js")));
  const deadline = Date.now() + 10_000;
  let stopped = false;
  while (!stopped && Date.now() < deadline) {
    stopped = await fetch(`http://127.0.0.1:${webPort}/health`).then(
      () => false,
      () => true,
    );
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(stopped, "the last step stops the server");
});
