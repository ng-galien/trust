import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const trust = fileURLToPath(new URL("../", import.meta.url));
const FINDINGS = "maintenance/findings/corpus-interface.json";
const CORPUS = path.join(trust, "trust-extension/extensions/corpus");
// The Corpus submodule is a private repository; a checkout without it skips the test.
const skip = existsSync(CORPUS) ? false : "the Corpus submodule is not checked out";
const WEB = path.join(trust, "apps/trust-web");

/** The 19 findings of TRUST-FR-MAINT-040.AC1, and the duplication finding fixed with them by the coordinator's arbitration. */
const FIXED = [
  "explorer-css-old-library-classes",
  "plan-monitor-css-old-check-list",
  "plan-views-css-mark-rules",
  "plan-views-css-unused-keyframes",
  "plan-views-css-mission-list",
  "thread-document-css-unused-classes",
  "organisation-css-unused-classes",
  "plan-card-css-unused-classes",
  "plan-history-css-back",
  "thread-status-tone-unread",
  "organisation-form-page-unread-go-and-t",
  "i18n-unused-completed-thread-corpus",
  "global-class-corpus-thread-list",
  "global-class-corpus-intention",
  "global-classes-open-thread-dialog",
  "global-class-corpus-navigation",
  "global-class-corpus-post",
  "global-class-corpus-library-label",
  "global-class-corpus-references-facet",
  "thread-status-labels-duplicate-thread-state",
];

/** Runs one command to its end and returns its exit code and its combined output. */
function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("MAINT-040 AC1 the first-batch findings of the axis corpus-interface are fixed and pass the check, and the typecheck, the interface gate and the entry and thread browser specs pass unchanged", {
  skip,
  timeout: 1_800_000,
}, async () => {
  const check = await run(
    process.execPath,
    [path.join(trust, "scripts/maintenance-findings.mjs"), "check", FINDINGS],
    trust,
  );
  assert.equal(check.code, 0, check.output);
  const result = JSON.parse(check.output);
  assert.equal(result.accepted, true, JSON.stringify(result.refusals));
  assert.deepEqual(result.refusals, []);
  const findings = JSON.parse(await readFile(path.join(trust, FINDINGS), "utf8")).findings;
  const states = new Map(findings.map((finding) => [finding.id, finding.state]));
  for (const id of FIXED) assert.equal(states.get(id), "fixed", `${id} is ${states.get(id)}`);

  const typecheck = await run("npm", ["run", "typecheck"], CORPUS);
  assert.equal(typecheck.code, 0, typecheck.output);

  const gate = await run(process.execPath, [path.join(trust, "scripts/workspace-gate.mjs"), "interface"], trust);
  assert.equal(gate.code, 0, gate.output);

  const browser = { ...process.env };
  delete browser.CORPUS_HARNESS;
  for (const spec of ["acceptance/corpus-entry.acceptance.spec.ts", "acceptance/corpus-reading.acceptance.spec.ts"]) {
    const playwright = await run(
      "npx",
      ["playwright", "test", "-c", "playwright.corpus.config.ts", spec],
      WEB,
      browser,
    );
    assert.equal(playwright.code, 0, `${spec}\n${playwright.output}`);
    assert.match(playwright.output, /\d+ passed/, `${spec}\n${playwright.output}`);
    assert.doesNotMatch(playwright.output, /\d+ (failed|flaky|interrupted)/, `${spec}\n${playwright.output}`);
  }
});
