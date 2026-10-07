import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const trust = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(trust, "scripts/maintenance-findings.mjs");
// The findings cite files of the Corpus submodule, a private repository; a checkout without it skips the check.
const skip = existsSync(path.join(trust, "trust-extension/package.json"))
  ? false
  : "the Corpus submodule is not checked out";
const FINDINGS = "maintenance/findings/corpus-interface.json";

test("MAINT-020 AC3 the findings of the axis corpus-interface are recorded and pass the check", { skip }, async () => {
  const { stdout } = await exec(process.execPath, [SCRIPT, "check", FINDINGS], { cwd: trust });
  const result = JSON.parse(stdout);
  assert.equal(result.accepted, true, JSON.stringify(result.refusals));
  assert.equal(result.axis, "corpus-interface");
  assert.deepEqual(result.refusals, []);
  assert.ok(result.findings >= 1, `expected at least one finding, got ${result.findings}`);
});
