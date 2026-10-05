import assert from "node:assert/strict";
import test from "node:test";
import { SCOPE, startWorkspace } from "./acceptance-operations-support.mjs";

test("acceptance.node-run@1.1.0 produces the durations of a run and a Procedure qualifies them", {
  timeout: 120000,
}, async () => {
  const workspace = await startWorkspace("node-run-timed-", {
    helpers: ["acceptance-verification.mjs", "acceptance-timed-verification.mjs"],
    operations: ["acceptance.node-run.feature", "drafts/acceptance.node-run-1.1.0.feature"],
  });
  try {
    await workspace.write(
      "slow.acceptance.test.mjs",
      `import test from "node:test";
test("the slow criterion holds", async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
});
`,
    );
    await workspace.write(
      "fast.acceptance.test.mjs",
      `import test from "node:test";
test("the fast criterion holds", () => {});
`,
    );
    const files = ["slow.acceptance.test.mjs", "fast.acceptance.test.mjs"];
    const contract = (extra = {}) =>
      JSON.stringify({
        id: "timed",
        layer: "integration",
        requirements: ["TIMED-1", "TIMED-2"],
        testFiles: files,
        sourcePaths: files,
        artifactPaths: files,
        assertions: [
          { file: files[0], name: "the slow criterion holds", requirement: "TIMED-1" },
          { file: files[1], name: "the fast criterion holds", requirement: "TIMED-2" },
        ],
        ...extra,
      });
    const probe = (name, version, timing = "") => `@trust-dsl:1 @procedure:${name} @version:1.0.0
Feature: Qualify how long a group of acceptance tests takes
  Background: Plan context
${SCOPE}
    And one string "acceptance verification"
    And one string "acceptance layer" fixed as "integration"
    And one string "expected digest"
    And one number "slowest test budget"

  @scenario:verification
  Scenario: Execute and time the acceptance tests
    Then Check "verify acceptance" runs Operation "acceptance.node-run@${version}"
      on "acceptance verification" as Input "contract"
      using "acceptance layer" as Input "layer"
      using "expected digest" as Input "expectedDigest"
      and must establish "the named assertions passed and no test exceeds its time budget"
      """js
      (fact.stale === 0 || fail("the run refers to stale code")) &&
      (fact.complete === 1 || fail("required assertions are absent, failed, skipped or crashed"))${timing}
      """
`;
    const timing = ` &&
      (fact.durationMs >= fact.slowestFileMs && fact.slowestFileMs >= fact.slowestTestMs && fact.slowestTestMs > 0 ||
        fail("the durations are inconsistent")) &&
      (fact.slowestTestMs <= context["slowest test budget"] ||
        fail(\`the slowest test "\${fact.slowestTest}" of \${fact.slowestFile} took \${fact.slowestTestMs} ms\`))`;
    await workspace.publish(probe("timed-probe", "1.1.0", timing));
    await workspace.publish(probe("untimed-probe", "1.0.0"));
    const engage = (plan, values = {}, procedure = "timed-probe") =>
      workspace.engage(procedure, plan, {
        "acceptance verification": contract({ revision: 3 }),
        "expected digest": "capture",
        "slowest test budget": 60000,
        ...values,
      });

    await engage("over-budget", { "slowest test budget": 50 });
    const slow = await workspace.run("over-budget", "verify acceptance");
    assert.equal(slow.verdict, "NOT_VALIDATED");
    const reason = /^the slowest test "the slow criterion holds" of slow\.acceptance\.test\.mjs took (\d+) ms$/u.exec(
      slow.reason,
    );
    assert.ok(reason, slow.reason);
    assert.ok(Number(reason[1]) >= 140, slow.reason);

    await engage("within-budget");
    const timed = await workspace.run("within-budget", "verify acceptance");
    assert.equal(timed.verdict, "VALIDATED", timed.reason);
    // The observation lines are the source of the Facts: the 1.0.0 lines in place, then the durations, then the report.
    assert.equal(timed.lines.length, 19);
    assert.deepEqual(timed.lines.slice(0, 2), ["timed", "integration"]);
    assert.deepEqual(timed.lines.slice(4, 12).map(Number), [2, 2, 0, 0, 0, 0, 0, 1]);
    const report = timed.report;
    assert.deepEqual(timed.lines.slice(13, 18), [
      String(report.durationMs),
      String(report.slowestFileMs),
      String(report.slowestTestMs),
      "slow.acceptance.test.mjs",
      "the slow criterion holds",
    ]);
    assert.ok(Number.isInteger(report.durationMs) && report.durationMs >= report.slowestFileMs);
    assert.ok(report.slowestFileMs >= report.slowestTestMs && report.slowestTestMs >= 140);
    assert.equal(report.slowestTestFile, "slow.acceptance.test.mjs");
    assert.deepEqual(report.fileDurations.map((entry) => entry.file).sort(), [...files].sort());
    assert.ok(report.fileDurations.every((entry) => Number.isInteger(entry.durationMs) && entry.durationMs > 0));
    assert.ok(report.startedAt < report.endedAt);
    // The contract names the approved revision that founds it; the report records it.
    assert.equal(report.revision, 3);

    await engage("stale", { "expected digest": "0".repeat(64) });
    const stale = await workspace.run("stale", "verify acceptance");
    assert.equal(stale.verdict, "NOT_VALIDATED");
    assert.equal(stale.reason, "the run refers to stale code");
    assert.deepEqual(stale.lines.slice(13, 18), ["0", "0", "0", "", ""]);

    // A revision that is not a positive integer interrupts the Operation: no Fact, no verdict.
    await engage("bad-revision", { "acceptance verification": contract({ revision: "3" }) });
    const refused = await workspace.run("bad-revision", "verify acceptance");
    assert.equal(refused.interrupted, true);
    assert.match(refused.message, /Contract revision must be a positive integer/u);
    assert.equal((await workspace.check("bad-revision", "verify acceptance")).latestVerdict, null);

    // 1.0.0 is unchanged: it keeps its closed keys and its fourteen observation lines.
    await engage("frozen-revision", {}, "untimed-probe");
    const frozen = await workspace.run("frozen-revision", "verify acceptance");
    assert.equal(frozen.interrupted, true);
    assert.match(frozen.message, /Closed verification contract keys required/u);
    await engage("frozen", { "acceptance verification": contract() }, "untimed-probe");
    const untimed = await workspace.run("frozen", "verify acceptance");
    assert.equal(untimed.verdict, "VALIDATED", untimed.reason);
    assert.equal(untimed.lines.length, 14);
    assert.equal(untimed.report.durationMs, undefined);
  } finally {
    await workspace.close();
  }
});
