import assert from "node:assert/strict";
import test from "node:test";
import { SCOPE, startWorkspace } from "./acceptance-operations-support.mjs";

const steady = `import test from "node:test";
test("the steady criterion holds", () => {});
`;
// Fails on every second execution; its counter lives outside the verified closure.
const flaky = `import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
test("the flaky criterion holds", async () => {
  const state = new URL("../state/", import.meta.url);
  await mkdir(state, { recursive: true });
  const count = Number(await readFile(new URL("flaky-count", state), "utf8").catch(() => "0")) + 1;
  await writeFile(new URL("flaky-count", state), String(count));
  assert.notEqual(count % 2, 0, "every second execution fails");
});
`;
// Passes only while its peer file runs at the same time: a suite-level behaviour one file at a time never shows.
const paired = (own, peer) => `import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
test("the ${own} criterion holds", async () => {
  const state = new URL("../state/", import.meta.url);
  await mkdir(state, { recursive: true });
  await writeFile(new URL("pair-${own}", state), "");
  try {
    let met = false;
    for (let waited = 0; waited < 1500 && !met; waited += 20) {
      met = await access(new URL("pair-${peer}", state)).then(() => true, () => false);
      if (!met) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The peer polls every 20 ms: it sees this marker before it disappears.
    if (met) await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(met, true, "the peer file did not run at the same time");
  } finally {
    await rm(new URL("pair-${own}", state), { force: true });
  }
});
`;
// Changes a file of its own verified closure on every execution.
const mutating = `import { writeFile } from "node:fs/promises";
import test from "node:test";
test("the mutating criterion holds", async () => {
  await writeFile(new URL("./mutable.txt", import.meta.url), String(process.hrtime.bigint()));
});
`;

test("acceptance.node-repeat@1.0.0 repeats a group on unchanged code and a Procedure qualifies its stability", {
  timeout: 180000,
}, async () => {
  const workspace = await startWorkspace("node-repeat-", {
    helpers: ["acceptance-timed-verification.mjs"],
    operations: ["drafts/acceptance.node-run-1.1.0.feature", "drafts/acceptance.node-repeat.feature"],
  });
  try {
    await workspace.write("steady.acceptance.test.mjs", steady);
    await workspace.write("flaky.acceptance.test.mjs", flaky);
    await workspace.write("left.acceptance.test.mjs", paired("left", "right"));
    await workspace.write("right.acceptance.test.mjs", paired("right", "left"));
    await workspace.write("mutating.acceptance.test.mjs", mutating);
    await workspace.write("mutable.txt", "initial");
    const contract = (id, names, sources = []) =>
      JSON.stringify({
        id,
        layer: "integration",
        requirements: names.map((name) => `REPEAT-${name.toUpperCase()}`),
        testFiles: names.map((name) => `${name}.acceptance.test.mjs`),
        sourcePaths: [...names.map((name) => `${name}.acceptance.test.mjs`), ...sources],
        artifactPaths: names.map((name) => `${name}.acceptance.test.mjs`),
        assertions: names.map((name) => ({
          file: `${name}.acceptance.test.mjs`,
          name: `the ${name} criterion holds`,
          requirement: `REPEAT-${name.toUpperCase()}`,
        })),
      });
    const qualification = `(fact.stale === 0 || fail(\`the code changed after \${fact.runs} of \${fact.requestedRuns} runs\`)) &&
      (fact.runs === fact.requestedRuns && fact.passedRuns === fact.runs && fact.failedRuns === 0 && fact.unstableTests === 0 && fact.stable === 1 ||
        fail(\`\${fact.failedRuns} of \${fact.runs} runs failed and \${fact.unstableTests} tests changed status at concurrency \${fact.concurrency}\`)) &&
      (fact.minDurationMs > 0 && fact.maxDurationMs >= fact.minDurationMs || fail("the durations are inconsistent"))`;
    await workspace.publish(`@trust-dsl:1 @procedure:repeat-probe @version:1.0.0
Feature: Qualify the stability of a group of acceptance tests
  Background: Plan context
${SCOPE}
    And one string "acceptance verification"
    And one string "acceptance layer" fixed as "integration"
    And one string "capture digest" fixed as "capture"
    And one string "stability runs"
    And one string "stability concurrency"

  @scenario:stability
  Scenario: Repeat the acceptance tests on unchanged code
    Then Check "repeat acceptance" runs Operation "acceptance.node-repeat@1.0.0"
      on "acceptance verification" as Input "contract"
      using "acceptance layer" as Input "layer"
      using "capture digest" as Input "expectedDigest"
      using "stability runs" as Input "runs"
      using "stability concurrency" as Input "concurrency"
      and must establish "every repeated run passed on the same code"
      """js
      ${qualification}
      """
`);
    // The digest captured by acceptance.node-run@1.1.0 is the digest acceptance.node-repeat expects.
    await workspace.publish(`@trust-dsl:1 @procedure:repeat-after-run-probe @version:1.0.0
Feature: Repeat the acceptance tests on the code a first run verified
  Background: Plan context
${SCOPE}
    And one string "acceptance verification"
    And one string "acceptance layer" fixed as "integration"
    And one string "capture digest" fixed as "capture"
    And one string "acceptance digest"
    And one string "stability runs" fixed as "2"
    And one string "stability concurrency" fixed as "2"

  @scenario:verification
  Scenario: Execute the acceptance tests
    Then Check "verify acceptance" runs Operation "acceptance.node-run@1.1.0"
      on "acceptance verification" as Input "contract"
      using "acceptance layer" as Input "layer"
      using "capture digest" as Input "expectedDigest"
      and materializes "acceptance digest" from field "sourceDigest"
      and must establish "the named assertions passed"
      """js
      fact.complete === 1 || fail("required assertions are absent, failed, skipped, crashed or stale")
      """

  @scenario:stability
  Scenario: Repeat the acceptance tests on the same code
    Given scenario "verification" is validated
    Then Check "repeat acceptance" runs Operation "acceptance.node-repeat@1.0.0"
      on "acceptance verification" as Input "contract"
      using "acceptance layer" as Input "layer"
      using "acceptance digest" as Input "expectedDigest"
      using "stability runs" as Input "runs"
      using "stability concurrency" as Input "concurrency"
      and must establish "every repeated run passed on the verified code"
      """js
      (fact.sourceDigest === context["acceptance digest"] || fail("another code was repeated")) &&
      ${qualification}
      """
`);
    const repeat = async (plan, verification, runs, concurrency) => {
      await workspace.engage("repeat-probe", plan, {
        "acceptance verification": verification,
        "stability runs": runs,
        "stability concurrency": concurrency,
      });
      return workspace.run(plan, "repeat acceptance");
    };
    const together = contract("together", ["steady", "left", "right"]);

    const stable = await repeat("stable", together, "3", "2");
    assert.equal(stable.verdict, "VALIDATED", stable.reason);
    assert.equal(stable.lines.length, 16);
    // requestedRuns, concurrency, runs, passedRuns, failedRuns, unstableTests
    assert.deepEqual(stable.lines.slice(4, 10).map(Number), [3, 2, 3, 3, 0, 0]);
    assert.deepEqual(stable.lines.slice(12, 14).map(Number), [0, 1]);
    assert.equal(stable.lines[2], stable.lines[3]);
    assert.equal(stable.report.command.configuration.concurrency, 2);
    assert.equal(stable.report.runTimeoutMs, 120000);
    assert.equal(stable.report.runReports.length, 3);
    const durations = stable.report.runReports.map((run) => run.durationMs);
    assert.deepEqual(stable.lines.slice(10, 12).map(Number), [Math.min(...durations), Math.max(...durations)]);
    assert.ok(durations.every((duration) => Number.isInteger(duration) && duration >= 300));

    // The same files, one at a time: the suite-level failure is a matter of file concurrency.
    const alone = await repeat("one-at-a-time", together, "2", "1");
    assert.equal(alone.verdict, "NOT_VALIDATED");
    assert.equal(alone.reason, "2 of 2 runs failed and 0 tests changed status at concurrency 1");
    assert.equal(alone.report.runReports[0].failures.length, 2);

    const unstable = await repeat("flaky", contract("flaky", ["steady", "flaky"]), "3", "1");
    assert.equal(unstable.verdict, "NOT_VALIDATED");
    assert.equal(unstable.reason, "1 of 3 runs failed and 1 tests changed status at concurrency 1");
    assert.deepEqual(unstable.report.unstable, [
      {
        file: "flaky.acceptance.test.mjs",
        name: "the flaky criterion holds",
        statuses: ["passed", "failed", "passed"],
      },
    ]);
    assert.deepEqual(
      unstable.report.runReports.map((run) => run.complete),
      [1, 0, 1],
    );

    // Ten runs share the 540 s budget: each one gets 54 s.
    const many = await repeat("ten", contract("steady", ["steady"]), "10", "8");
    assert.equal(many.verdict, "VALIDATED", many.reason);
    assert.equal(many.report.runTimeoutMs, 54000);
    assert.deepEqual(many.lines.slice(4, 9).map(Number), [10, 8, 10, 10, 0]);

    const changed = await repeat("changed", contract("mutating", ["mutating"], ["mutable.txt"]), "3", "1");
    assert.equal(changed.verdict, "NOT_VALIDATED");
    assert.equal(changed.reason, "the code changed after 1 of 3 runs");
    assert.notEqual(changed.lines[2], changed.lines[3]);
    // runs, passedRuns, failedRuns
    assert.deepEqual(changed.lines.slice(6, 9).map(Number), [1, 0, 1]);

    // Out-of-bounds Inputs interrupt the Operation: no Fact, no verdict.
    for (const [plan, runs, concurrency, message] of [
      ["one-run", "1", "1", /runs must be a whole number from 2 to 10/u],
      ["eleven-runs", "11", "1", /runs must be a whole number from 2 to 10/u],
      ["nine-files", "2", "9", /concurrency must be a whole number from 1 to 8/u],
      ["no-files", "2", "0", /concurrency must be a whole number from 1 to 8/u],
    ]) {
      const refused = await repeat(plan, together, runs, concurrency);
      assert.equal(refused.interrupted, true, plan);
      assert.match(refused.message, message);
      assert.equal((await workspace.check(plan, "repeat acceptance")).latestVerdict, null);
    }

    await workspace.engage("repeat-after-run-probe", "after-run", { "acceptance verification": together });
    // One file at a time, the paired files fail: the first Check runs the group like acceptance.node-run does.
    assert.equal((await workspace.run("after-run", "verify acceptance")).verdict, "NOT_VALIDATED");
    await workspace.engage("repeat-after-run-probe", "after-steady-run", {
      "acceptance verification": contract("steady", ["steady"]),
    });
    const first = await workspace.run("after-steady-run", "verify acceptance");
    assert.equal(first.verdict, "VALIDATED", first.reason);
    const repeated = await workspace.run("after-steady-run", "repeat acceptance");
    assert.equal(repeated.verdict, "VALIDATED", repeated.reason);
    assert.equal(repeated.lines[2], first.lines[2]);
  } finally {
    await workspace.close();
  }
});
