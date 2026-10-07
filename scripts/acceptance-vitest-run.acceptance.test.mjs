import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCOPE, startWorkspace } from "./acceptance-operations-support.mjs";

const trust = fileURLToPath(new URL("../", import.meta.url));
const PROCEDURE = "trust-extension/extensions/corpus/procedures/delegation/delegation-code-vitest.procedure.feature";
/* The Procedure lives in the Corpus submodule of a private repository; a checkout without it skips AC3 and AC4. */
const corpus = existsSync(path.join(trust, PROCEDURE)) ? false : "the Corpus submodule is not checked out";
const HELPERS = ["acceptance-vitest-verification.mjs", "workspace-script-gate.mjs", "review-checklist.mjs"];
const SUM = "export const sum = (left, right) => left + right;\n";
const files = ["test/sum.acceptance.test.mjs", "test/zero.acceptance.test.mjs"];
const contract = (assertions = {}) =>
  JSON.stringify({
    id: "fixture-sum",
    revision: 2,
    requirements: ["SUM-1", "SUM-2"],
    testFiles: files,
    sourcePaths: ["src"],
    artifactPaths: ["vitest.config.mjs"],
    assertions: [
      { file: files[0], name: assertions.sum ?? "sum > adds two numbers", requirement: "SUM-1" },
      { file: files[1], name: "keeps zero neutral", requirement: "SUM-2" },
    ],
    vitest: { project: "unit", config: "vitest.config.mjs" },
  });
const probe = `@trust-dsl:1 @procedure:vitest-probe @version:1.0.0
Feature: Observe the named Vitest tests of one project
  Background: Plan context
${SCOPE}
    And one string "project"
    And one string "acceptance verification"
    And one string "expected digest"
    And one string "gate scripts"

  @scenario:verification
  Scenario: Execute the Vitest acceptance tests
    Then Check "verify acceptance" runs Operation "acceptance.vitest-run@1.0.0"
      on "acceptance verification" as Input "contract"
      using "project" as Input "project"
      using "expected digest" as Input "expectedDigest"
      and must establish "the named Vitest tests passed on unchanged code"
      """js
      fact.complete === 1 || fail(fact.reason)
      """

  @scenario:gate
  Scenario: Run the quality gate of the project
    Then Check "quality gate" runs Operation "workspace.script-gate@1.0.0"
      on "gate scripts" as Input "gate"
      using "project" as Input "project"
      and must establish "the project gate passes"
      """js
      fact.passed === 1 || fail(fact.summary)
      """
`;

/** A projects directory: the TRUST checkout providing the helpers beside "fixture", a project of code and tests only. */
let workspace;
let fixture;
before(async () => {
  workspace = await startWorkspace("vitest-run-", {
    helpers: HELPERS,
    helperDirectory: "trust/scripts",
    operations: [
      "agent.response-read.feature",
      "drafts/acceptance.vitest-run.feature",
      "drafts/workspace.script-gate.feature",
      "drafts/review.checklist-check-1.1.0.feature",
    ],
  });
  await workspace.write(
    "fixture/package.json",
    JSON.stringify({
      name: "fixture",
      private: true,
      type: "module",
      scripts: { typecheck: 'node -e ""', lint: 'node -e ""' },
    }),
  );
  // The project's own Vitest is the one installed in this repository, linked without a network install.
  await symlink(path.join(trust, "node_modules"), path.join(workspace.workspace, "fixture/node_modules"), "dir");
  await workspace.write(
    "fixture/vitest.config.mjs",
    `export default {
  cacheDir: ".vitest-cache",
  test: { projects: [{ test: { name: "unit", include: ["test/**/*.test.mjs"] } }] },
};
`,
  );
  await workspace.write("fixture/src/sum.mjs", SUM);
  await workspace.write(
    `fixture/${files[0]}`,
    `import { describe, expect, test } from "vitest";
import { sum } from "../src/sum.mjs";
describe("sum", () => {
  test("adds two numbers", () => expect(sum(2, 3)).toBe(5));
});
`,
  );
  await workspace.write(
    `fixture/${files[1]}`,
    `import { expect, test } from "vitest";
import { sum } from "../src/sum.mjs";
test("keeps zero neutral", () => expect(sum(7, 0)).toBe(7));
`,
  );
  fixture = await realpath(path.join(workspace.workspace, "fixture"));
  await workspace.publish(probe);
  if (!corpus) await workspace.publish(await readFile(path.join(trust, PROCEDURE), "utf8"));
});
after(() => workspace?.close());

const mission = (plan, overrides = {}) =>
  workspace.engage("delegation-code-vitest", plan, {
    mission: plan,
    assignee: "worker",
    reviewer: "reviewer",
    project: "fixture",
    facet: "code",
    instructions: "Make sum add two numbers.",
    expected: "SUM-1 and SUM-2 pass.",
    authorized: "Edit the fixture.",
    forbidden: "Edit another project.",
    "acceptance verification": contract(),
    ...overrides,
  });
const declare = async (plan, declarations) =>
  workspace.rpc("plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan,
    expectedRevision: (await workspace.rpc("plan.read", { plan })).revision,
    declarations,
  });

test("TEST-010 AC1 the Operation runs the Vitest tests a mission contract names and gives their counts, the source digests and the duration", {
  timeout: 120000,
}, async () => {
  await workspace.engage("vitest-probe", "counts", {
    project: "fixture",
    "acceptance verification": contract(),
    "expected digest": "capture",
    "gate scripts": "typecheck lint",
  });
  const run = await workspace.run("counts", "verify acceptance");
  assert.equal(run.verdict, "VALIDATED", run.reason);
  assert.equal(run.lines.length, 15);
  assert.equal(run.lines[0], "fixture-sum");
  assert.match(run.lines[1], /^[a-f0-9]{64}$/u);
  assert.equal(run.lines[2], run.lines[1]);
  // tested, passed, failed, skipped, crashed, missing, stale, complete
  assert.deepEqual(run.lines.slice(3, 11).map(Number), [2, 2, 0, 0, 0, 0, 0, 1]);
  const report = run.report;
  assert.equal(run.lines[12], String(report.durationMs));
  assert.ok(Number.isInteger(report.durationMs) && report.durationMs > 0);
  assert.equal(report.revision, 2);
  assert.equal(
    report.vitestVersion,
    JSON.parse(await readFile(path.join(trust, "node_modules/vitest/package.json"))).version,
  );
  assert.deepEqual(report.command.selection, { project: "unit", config: "vitest.config.mjs" });
  assert.deepEqual(
    report.assertions.map(({ name, status }) => [name, status]),
    [
      ["sum > adds two numbers", "passed"],
      ["keeps zero neutral", "passed"],
    ],
  );
  // The digest covers the contract's closure in the project, never its installed dependencies.
  const closure = report.files.map(([file]) => file);
  for (const file of ["src/sum.mjs", "vitest.config.mjs", "package.json", ...files])
    assert.ok(closure.includes(file), file);
  assert.ok(!closure.some((file) => file.startsWith("node_modules")));
});

test("TEST-010 AC2 the Operation runs at the root of the repository of the Plan environment with the scripts TRUST provides", {
  timeout: 120000,
}, async () => {
  await workspace.engage("vitest-probe", "location", {
    project: "fixture",
    "acceptance verification": contract(),
    "expected digest": "capture",
    "gate scripts": "typecheck lint",
  });
  const run = await workspace.run("location", "verify acceptance");
  assert.equal(run.verdict, "VALIDATED", run.reason);
  assert.equal(run.report.project, "fixture");
  assert.equal(run.report.cwd, fixture);
  // The tested project holds only its code, its tests and its own configuration: no TRUST script.
  assert.deepEqual((await readdir(fixture)).filter((name) => name !== ".vitest-cache").sort(), [
    "node_modules",
    "package.json",
    "src",
    "test",
    "vitest.config.mjs",
  ]);
  for (const helper of HELPERS) await assert.rejects(readFile(path.join(fixture, "scripts", helper)));
  // The project declares its own gate in its package scripts; TRUST names only the scripts.
  const gate = await workspace.run("location", "quality gate");
  assert.equal(gate.verdict, "VALIDATED", gate.reason);
  assert.deepEqual(gate.lines, ["typecheck lint", "1", "0", "project fixture passed npm run typecheck, npm run lint"]);
  await workspace.engage("vitest-probe", "undeclared-gate", {
    project: "fixture",
    "acceptance verification": contract(),
    "expected digest": "capture",
    "gate scripts": "typecheck format",
  });
  const undeclared = await workspace.run("undeclared-gate", "quality gate");
  assert.equal(undeclared.verdict, "NOT_VALIDATED");
  assert.equal(undeclared.reason, "project fixture declares no package script format");
  // The project is one directory directly below the workspace: a path out of it is refused before any Fact.
  await workspace.engage("vitest-probe", "outside", {
    project: "..",
    "acceptance verification": contract(),
    "expected digest": "capture",
    "gate scripts": "typecheck lint",
  });
  const outside = await workspace.run("outside", "verify acceptance");
  assert.equal(outside.interrupted, true);
  assert.match(outside.message, /Project must name one directory directly below the workspace/u);
  assert.equal((await workspace.check("outside", "verify acceptance")).latestVerdict, null);
});

test("TEST-010 AC3 a delegation Procedure proves a mission with the Vitest Operation, the repository quality gate, the repetition, the review checklist and the response", {
  timeout: 120000,
  skip: corpus,
}, async () => {
  await mission("proved");
  const verified = await workspace.run("proved", "verify acceptance");
  assert.equal(verified.verdict, "VALIDATED", verified.reason);
  const gate = await workspace.run("proved", "quality gate");
  assert.equal(gate.verdict, "VALIDATED", gate.reason);
  const repeated = await workspace.run("proved", "repeat acceptance");
  assert.equal(repeated.verdict, "VALIDATED", repeated.reason);
  assert.equal(repeated.report.sourceDigest, verified.report.sourceDigest);
  assert.equal(repeated.report.expectedDigest, verified.report.sourceDigest);
  assert.notEqual(repeated.report.runId, verified.report.runId);
  const items = [
    ...["public-boundary-tests", "canonical-contracts", "retained-data", "english-artifacts"].map(
      (rule) => `rule:${rule}`,
    ),
    "criterion:SUM-1",
    "criterion:SUM-2",
  ].map((subject) => ({ subject, verdict: "pass", evidence: `${subject} read in the diff and the tests` }));
  await declare("proved", { "review checklist": JSON.stringify({ items }) });
  const review = await workspace.run("proved", "review checklist");
  assert.equal(review.verdict, "VALIDATED", review.reason);
  await declare("proved", {
    "review checklist": JSON.stringify({ items }),
    response: "sum adds two numbers; SUM-1 and SUM-2 pass.",
    outcome: "completed",
  });
  const completion = await workspace.run("proved", "observe completion");
  assert.equal(completion.verdict, "VALIDATED", completion.reason);
  const plan = await workspace.rpc("plan.read", { plan: "proved" });
  assert.equal(plan.workState, "COMPLETE");
  assert.ok(plan.checks.every((check) => check.state === "SATISFIED"));
});

test("TEST-010 AC4 a missing named test or a code change between the two runs gives a negative verdict with its reason", {
  timeout: 120000,
  skip: corpus,
}, async () => {
  await mission("absent", { "acceptance verification": contract({ sum: "sum > subtracts two numbers" }) });
  const absent = await workspace.run("absent", "verify acceptance");
  assert.equal(absent.verdict, "NOT_VALIDATED");
  assert.equal(
    absent.reason,
    "required tests are absent, failed, skipped, crashed or refer to stale code: named tests not passed: sum > subtracts two numbers (missing)",
  );
  assert.deepEqual(absent.lines.slice(3, 11).map(Number), [2, 2, 0, 0, 0, 1, 0, 0]);

  await mission("changed");
  assert.equal((await workspace.run("changed", "verify acceptance")).verdict, "VALIDATED");
  assert.equal((await workspace.run("changed", "quality gate")).verdict, "VALIDATED");
  await workspace.write("fixture/src/sum.mjs", `${SUM}// changed after the verified run\n`);
  try {
    const repeated = await workspace.run("changed", "repeat acceptance");
    assert.equal(repeated.verdict, "NOT_VALIDATED");
    assert.equal(
      repeated.reason,
      "the code changed since the verified run: the project code changed since the captured digest",
    );
    assert.deepEqual(repeated.lines.slice(9, 11).map(Number), [1, 0]);
    assert.equal(repeated.report.tested, 0);
  } finally {
    await workspace.write("fixture/src/sum.mjs", SUM);
  }
});
