import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  A,
  documentOf,
  editCorpusStore,
  ok,
  registerContinuationRuntime,
} from "../trust-extension/extensions/corpus/acceptance/continuation-harness.mjs";

const trust = fileURLToPath(new URL("../", import.meta.url));
const FINDINGS = "maintenance/findings/corpus-old-frameworks.json";
const CORPUS = path.join(trust, "trust-extension/extensions/corpus");
const CURRENT = "0.9.0";

/** The 16 findings of the axis: each is fixed or declined. */
const FINDING_IDS = [
  "orphan-framework-0-6-0-comment",
  "framework-from-comment-names-0-4-0",
  "evolves-revision-approvals",
  "evolving-coverage-0-6-0",
  "coverage-additions-input",
  "evolving-framework-tests-0-6-0",
  "framework-0-2-0-source-unread",
  "framework-0-3-0-and-exclusive-operations",
  "framework-0-1-0-as-test-vehicle",
  "link-time-carried-requirements-0-7-0",
  "evolving-option-two-meanings",
  "frozen-approved-requirements-0-4-0-0-5-0",
  "framing-and-addition-approvals",
  "commit-work-closure-prerequisite",
  "coverage-missions-input-and-reframed-missions",
  "ui-reframed-and-addition-episodes",
];
/** The Corpus acceptance files that remain, run one at a time. */
const CORPUS_FILES = [
  "governance.acceptance.test.mjs",
  "plan-history.acceptance.test.mjs",
  "thread-management.acceptance.test.mjs",
  "corpus.acceptance.test.mjs",
  "declared-delivery.acceptance.test.mjs",
];

// The isolated runtime in which a thread linked to a Plan TRUST does not hold is read.
registerContinuationRuntime();

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
/** Every file under a directory, recursively. */
async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

test("MAINT-040 AC2 the Corpus extension serves only the current framework version, the old-frameworks findings are fixed or declined and pass the check, a thread linked to an old Plan is read with the current rules, and the remaining Corpus acceptance tests pass unchanged", {
  timeout: 1_800_000,
}, async () => {
  // The findings of the axis pass the check, each fixed or declined.
  const check = await run(
    process.execPath,
    [path.join(trust, "scripts/maintenance-findings.mjs"), "check", FINDINGS],
    trust,
  );
  assert.equal(check.code, 0, check.output);
  const result = JSON.parse(check.output);
  assert.equal(result.accepted, true, JSON.stringify(result.refusals));
  assert.deepEqual(result.refusals, []);
  assert.equal(result.open, 0);
  const findings = JSON.parse(await readFile(path.join(trust, FINDINGS), "utf8")).findings;
  assert.deepEqual(findings.map((finding) => finding.id).sort(), [...FINDING_IDS].sort());
  for (const finding of findings) assert.match(finding.state, /^(fixed|declined)$/, finding.id);

  // No Procedure source declares another framework version, and the domain tests no framework version.
  const declared = [];
  for (const file of await filesUnder(path.join(CORPUS, "procedures"))) {
    const tags = (await readFile(file, "utf8")).match(/@procedure:corpus-thread-framework @version:(\S+)/);
    if (tags) declared.push([path.relative(CORPUS, file), tags[1]]);
  }
  assert.deepEqual(declared, [["procedures/thread-framework-0.9.0.procedure.feature", CURRENT]]);
  assert.doesNotMatch(await readFile(path.join(CORPUS, "domain.mjs"), "utf8"), /frameworkFrom\(/);

  // A thread whose framework Plan TRUST does not hold, as a retained link to a retired Plan, reads without error.
  for (const id of ["linked-retired-plan", "linked-retired-history"])
    await ok("threads.open", { id, title: "Thread of a retired framework Plan", body: documentOf(A) });
  await editCorpusStore(async (store) => {
    await store.query("UPDATE trust_corpus.threads SET framework_plan=$2 WHERE id=$1", [
      "linked-retired-plan",
      "retired-framework-0-5-0",
    ]);
    await store.query("UPDATE trust_corpus.threads SET framework_plan=$2 WHERE id=$1", [
      "linked-retired-history",
      "retired-history-0-5-0",
    ]);
    await store.query("INSERT INTO trust_corpus.thread_plans(thread,position,plan) VALUES($1,1,$2)", [
      "linked-retired-history",
      "retired-history-0-5-0",
    ]);
  });
  const stale = await ok("threads.read", { id: "linked-retired-plan" });
  assert.deepEqual(
    [stale.framework_plan, stale.framework, stale.requirements.map((r) => r.id)],
    ["retired-framework-0-5-0", null, ["CORPUS-TEST-010"]],
  );
  assert.equal((await ok("threads.read", { number: stale.number })).id, "linked-retired-plan");
  const recorded = await ok("threads.read", { id: "linked-retired-history" });
  assert.deepEqual(
    [recorded.framework.plan, recorded.framework.revision, recorded.framework.requirements],
    ["retired-history-0-5-0", null, null],
  );
  assert.deepEqual(
    (await ok("threads.plans", { id: "linked-retired-history" })).plans.map((entry) => [entry.plan, entry.current]),
    [["retired-history-0-5-0", true]],
  );

  // The Corpus acceptance files that remain pass, run one at a time from the repository root.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  for (const file of CORPUS_FILES) {
    const relative = path.join("trust-extension/extensions/corpus/acceptance", file);
    const suite = await run(process.execPath, ["--test", "--test-reporter=spec", relative], trust, environment);
    const count = (name) => Number(suite.output.match(new RegExp(`^ℹ ${name} (\\d+)$`, "m"))?.[1] ?? Number.NaN);
    assert.equal(suite.code, 0, `${file}\n${suite.output.slice(-4000)}`);
    assert.ok(count("pass") > 0, `${file} passes no test`);
    assert.deepEqual([count("fail"), count("cancelled")], [0, 0], file);
  }
});
