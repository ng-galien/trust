import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const trust = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(trust, "scripts/maintenance-findings.mjs");
const FINDINGS = "maintenance/findings/operation-drafts.json";

test("MAINT-020 AC4 the findings of the axis operation-drafts are recorded and pass the check", async () => {
  const { stdout } = await exec(process.execPath, [SCRIPT, "check", FINDINGS], { cwd: trust });
  const result = JSON.parse(stdout);
  assert.equal(result.accepted, true, JSON.stringify(result.refusals));
  assert.equal(result.axis, "operation-drafts");
  assert.deepEqual(result.refusals, []);
  assert.ok(result.findings >= 1, `expected at least one finding, got ${result.findings}`);
});
