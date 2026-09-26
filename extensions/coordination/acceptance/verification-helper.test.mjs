import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../../../scripts/coordination-verification.mjs", import.meta.url));
const good =
  "import test from 'node:test';import assert from 'node:assert/strict';test('REQ exact assertion',t=>{t.plan(1);t.assert.equal(2+2,4);});";
async function fixture(body = good) {
  const root = await mkdtemp(path.join(tmpdir(), "trust-verification-"));
  await writeFile(path.join(root, "source.js"), "export const actual = 4;");
  await writeFile(path.join(root, "compiled.js"), "export const actual = 4;");
  await writeFile(path.join(root, "test.mjs"), body);
  const contract = {
    id: "REQ-unit",
    layer: "unit",
    requirements: ["REQ"],
    testFiles: ["test.mjs"],
    assertions: [{ requirement: "REQ", name: "REQ exact assertion", file: "test.mjs" }],
    sourcePaths: ["source.js"],
    artifactPaths: ["compiled.js"],
  };
  return { root, contract, close: () => rm(root, { recursive: true, force: true }) };
}
async function observe(f, expected = "capture") {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const { stdout } = await execute(
    process.execPath,
    [helper, JSON.stringify(f.contract), "unit", expected, "test-execution"],
    { cwd: f.root, env, timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}
async function using(body, check) {
  const f = await fixture(body);
  try {
    await check(f);
  } finally {
    await f.close();
  }
}

test("VERIFY-GREEN actual named assertion and fresh rerun pass", () =>
  using(good, async (f) => {
    const first = await observe(f);
    assert.equal(first.complete, 1);
    assert.equal(first.nodeVersion, process.version);
    assert.equal(first.command.api, "node:test.run");
    assert.equal(first.command.configuration.cwd, f.root.replace("/var/", "/private/var/"));
    assert.ok(Date.parse(first.endedAt) >= Date.parse(first.startedAt));
    assert.equal(typeof first.gitHead, "string");
    assert.equal(first.tested, 1);
    assert.equal(first.passed, 1);
    assert.equal(first.missing, 0);
    const second = await observe(f, first.sourceDigest);
    assert.equal(second.complete, 1);
    assert.equal(second.sourceDigest, first.sourceDigest);
    assert.notEqual(second.runId, first.runId);
  }));
test("VERIFY-FAILED failed assertion is not qualification", () =>
  using(good.replace("2+2,4", "2+2,5"), async (f) => {
    const r = await observe(f);
    assert.equal(r.complete, 0);
    assert.equal(r.failed, 1);
  }));
test("VERIFY-ZERO successful process with zero tests is rejected", () =>
  using('console.log("all good");', async (f) => {
    const r = await observe(f);
    assert.equal(r.complete, 0);
    assert.equal(r.missing, 1);
    assert.equal(r.tested, 0);
  }));
test("VERIFY-SKIPPED skipped required assertion is rejected", () =>
  using(good.replace("test('REQ", "test.skip('REQ"), async (f) => {
    const r = await observe(f);
    assert.equal(r.complete, 0);
    assert.equal(r.skipped, 1);
  }));
test("VERIFY-CRASH crashed test process is rejected", () =>
  using("process.exit(7)", async (f) => {
    const r = await observe(f);
    assert.equal(r.complete, 0);
    assert.ok(r.crashed > 0);
  }));
test("VERIFY-FAKE printed report cannot impersonate test events", () =>
  using(
    'console.log(JSON.stringify({complete:1,passed:99,assertions:[{name:"REQ exact assertion",status:"passed"}]}));',
    async (f) => {
      const r = await observe(f);
      assert.equal(r.complete, 0);
      assert.equal(r.missing, 1);
    },
  ));
test("VERIFY-STALE changed source or compiled artifact refuses rerun", () =>
  using(good, async (f) => {
    const r = await observe(f);
    for (const file of ["source.js", "compiled.js"]) {
      await writeFile(path.join(f.root, file), "changed");
      const changed = await observe(f, r.sourceDigest);
      assert.equal(changed.complete, 0);
      assert.equal(changed.stale, 1);
      assert.equal(changed.tested, 0);
    }
  }));
test("VERIFY-MUTATION code changing during execution is rejected", () =>
  using(
    "import test from 'node:test';import{writeFileSync}from'node:fs';test('REQ exact assertion',()=>writeFileSync('compiled.js','changed'));",
    async (f) => {
      const r = await observe(f);
      assert.equal(r.complete, 0);
      assert.equal(r.stale, 1);
    },
  ));
test("VERIFY-PATH escaping and symbolic paths are refused", () =>
  using(good, async (f) => {
    f.contract.sourcePaths = ["../outside"];
    await assert.rejects(observe(f), /Invalid sourcePaths/);
    await symlink("/private/tmp", path.join(f.root, "escape"));
    f.contract.sourcePaths = ["escape"];
    await assert.rejects(observe(f), /Symbolic link refused/);
  }));
test("VERIFY-MISSING wrong assertion name does not satisfy the requirement", () =>
  using(good.replace("REQ exact assertion", "some other test"), async (f) => {
    const r = await observe(f);
    assert.equal(r.complete, 0);
    assert.equal(r.passed, 1);
    assert.equal(r.missing, 1);
  }));
test("VERIFY-REQUIREMENT every required ID needs an expected assertion", () =>
  using(good, async (f) => {
    f.contract.requirements.push("UNTESTED");
    await assert.rejects(observe(f), /Each requirement needs distinct named assertions/);
    f.contract.requirements.pop();
    f.contract.id = null;
    await assert.rejects(observe(f), /Contract identity or layer mismatch/);
  }));
