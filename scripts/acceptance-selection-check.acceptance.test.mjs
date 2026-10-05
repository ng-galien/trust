import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SCOPE, startWorkspace } from "./acceptance-operations-support.mjs";

const exec = promisify(execFile);

test("acceptance.selection-check@1.0.0 observes the tests a mapping selects for a change and a Procedure qualifies it", {
  timeout: 120000,
}, async () => {
  const workspace = await startWorkspace("selection-check-", {
    helpers: ["acceptance-selection.mjs"],
    operations: ["drafts/acceptance.selection-check.feature"],
  });
  const git = (cwd, ...parameters) =>
    exec(
      "git",
      [
        "-c",
        "user.name=Acceptance",
        "-c",
        "user.email=acceptance@example.test",
        "-c",
        "protocol.file.allow=always",
      ].concat(parameters),
      { cwd },
    );
  const cli = (...parameters) =>
    exec(process.execPath, ["scripts/acceptance-selection.mjs", ...parameters], { cwd: workspace.workspace }).catch(
      (error) => error,
    );
  try {
    // A dependency checked out as a submodule: its own changed files are named, not only its directory.
    const origin = path.join(workspace.directory, "dependency");
    await mkdir(path.join(origin, "lib"), { recursive: true });
    await writeFile(path.join(origin, "lib/codec.mjs"), "export const version = 1;\n");
    await git(origin, "init", "--quiet", "--initial-branch=main");
    await git(origin, "add", ".");
    await git(origin, "commit", "--quiet", "-m", "dependency");

    const rules = [
      { sources: ["src/registry/**"], tests: ["tests/registry.acceptance.test.mjs"] },
      { sources: ["src/plans/**"], tests: ["tests/plans.acceptance.test.mjs"] },
    ];
    const mapping = (extra) =>
      JSON.stringify({
        tests: ["tests/*.acceptance.test.mjs"],
        ignore: ["docs/**", "**/*.md"],
        rules: [...rules, extra],
      });
    for (const [file, content] of [
      ["src/registry/store.mjs", "export const store = 1;\n"],
      ["src/plans/read.mjs", "export const read = 1;\n"],
      ["docs/guide.md", "# Guide\n"],
      ["tests/registry.acceptance.test.mjs", "// registry\n"],
      ["tests/plans.acceptance.test.mjs", "// plans\n"],
      ["tests/health.acceptance.test.mjs", "// health\n"],
      ["tests/support.mjs", "// not a test file\n"],
      // One rule names a test file that does not exist and nothing covers the orphan or the dependency.
      [
        "selection-incomplete.json",
        mapping({ sources: ["src/legacy/**"], tests: ["tests/legacy.acceptance.test.mjs"] }),
      ],
      ["selection.json", mapping({ sources: ["src/orphan.mjs", "dependency/lib/**"], tests: ["tests/reg*.test.mjs"] })],
      ["selection.txt", "{}"],
    ])
      await workspace.write(file, content);
    await git(workspace.workspace, "init", "--quiet", "--initial-branch=main");
    await git(workspace.workspace, "submodule", "--quiet", "add", origin, "dependency");
    await git(workspace.workspace, "add", ".");
    await git(workspace.workspace, "commit", "--quiet", "-m", "base");
    await git(workspace.workspace, "checkout", "--quiet", "-b", "work");
    // The change: one committed source, then uncommitted, untracked, ignored and submodule edits.
    await workspace.write("src/registry/store.mjs", "export const store = 2;\n");
    await git(workspace.workspace, "commit", "--quiet", "-am", "registry change");
    await workspace.write("src/orphan.mjs", "export const orphan = 1;\n");
    await workspace.write("docs/guide.md", "# Guide, revised\n");
    await workspace.write("dependency/lib/codec.mjs", "export const version = 2;\n");

    await workspace.publish(`@trust-dsl:1 @procedure:selection-probe @version:1.0.0
Feature: Qualify that the tests selected for a change are mapped and selective
  Background: Plan context
${SCOPE}
    And one string "test selection mapping"
    And one string "change base"

  @scenario:selection
  Scenario: Observe the test selection of the change
    Then Check "check selection" runs Operation "acceptance.selection-check@1.0.0"
      on "test selection mapping" as Input "mapping"
      using "change base" as Input "base"
      and must establish "every changed file is mapped and the change selects a strict part of the tests"
      """js
      (fact.mapping === context["test selection mapping"] || fail("another mapping was read")) &&
      (fact.missingTestFiles === 0 || fail(\`\${fact.missingTestFiles} mapped test files do not exist\`)) &&
      (fact.unmappedChangedFiles === 0 || fail(\`\${fact.unmappedChangedFiles} changed files are covered by no mapping entry\`)) &&
      (fact.changedFiles > 0 && fact.selectedTestFiles > 0 && fact.selectedTestFiles < fact.totalTestFiles ||
        fail(\`\${fact.selectedTestFiles} of \${fact.totalTestFiles} test files are selected for \${fact.changedFiles} changed files\`))
      """
`);
    const check = async (plan, selection, base = "main") => {
      await workspace.engage("selection-probe", plan, { "test selection mapping": selection, "change base": base });
      return workspace.run(plan, "check selection");
    };
    const changed = ["dependency/lib/codec.mjs", "docs/guide.md", "src/orphan.mjs", "src/registry/store.mjs"];

    const incomplete = await check("incomplete", "selection-incomplete.json");
    assert.equal(incomplete.verdict, "NOT_VALIDATED");
    assert.equal(incomplete.reason, "1 mapped test files do not exist");
    assert.equal(incomplete.lines.length, 10);
    // changedFiles, selectedTestFiles, totalTestFiles, unmappedChangedFiles, missingTestFiles
    assert.deepEqual(incomplete.lines.slice(4, 9).map(Number), [4, 1, 3, 2, 1]);
    assert.deepEqual(incomplete.report.changed, changed);
    assert.deepEqual(incomplete.report.unmapped, ["dependency/lib/codec.mjs", "src/orphan.mjs"]);
    assert.deepEqual(incomplete.report.missing, ["tests/legacy.acceptance.test.mjs"]);

    const selective = await check("selective", "selection.json");
    assert.equal(selective.verdict, "VALIDATED", selective.reason);
    assert.deepEqual(selective.lines.slice(4, 9).map(Number), [4, 1, 3, 0, 0]);
    assert.deepEqual(selective.report.selected, ["tests/registry.acceptance.test.mjs"]);
    assert.equal(selective.lines[2], "main");
    assert.equal(selective.lines[3], (await git(workspace.workspace, "rev-parse", "main")).stdout.trim());
    assert.match(selective.lines[1], /^[a-f0-9]{64}$/u);

    // Against the work branch itself only the uncommitted files changed.
    const uncommitted = await check("uncommitted", "selection.json", "HEAD");
    assert.equal(uncommitted.verdict, "VALIDATED", uncommitted.reason);
    assert.deepEqual(uncommitted.report.changed, changed.slice(0, 3));

    // The agent's CLI prints the same selection, one test file per line.
    const printed = await cli("select", "selection.json", "--base", "main");
    assert.equal(printed.code, undefined, printed.stderr);
    assert.equal(printed.stdout, "tests/registry.acceptance.test.mjs\n");
    assert.match(printed.stderr, /1 of 3 test files selected for 4 changed files/u);
    const explicit = await cli("select", "selection.json", "src/plans/read.mjs", "src/registry/store.mjs", "README.md");
    assert.equal(explicit.stdout, "tests/plans.acceptance.test.mjs\ntests/registry.acceptance.test.mjs\n");
    const warned = await cli("select", "selection-incomplete.json", "--base", "main");
    assert.equal(warned.code, 1);
    assert.equal(warned.stdout, "tests/registry.acceptance.test.mjs\n");
    assert.match(warned.stderr, /unmapped changed file: src\/orphan\.mjs/u);
    assert.match(warned.stderr, /mapped test file missing: tests\/legacy\.acceptance\.test\.mjs/u);

    // A changed test file selects itself; a changed support module of the tests is an ordinary unmapped source.
    await workspace.write("tests/health.acceptance.test.mjs", "// health, revised\n");
    const withTest = await check("changed-test", "selection.json");
    assert.equal(withTest.verdict, "VALIDATED", withTest.reason);
    assert.deepEqual(withTest.report.selected, [
      "tests/health.acceptance.test.mjs",
      "tests/registry.acceptance.test.mjs",
    ]);
    await workspace.write("tests/support.mjs", "// revised\n");
    const withSupport = await check("changed-support", "selection.json");
    assert.equal(withSupport.reason, "1 changed files are covered by no mapping entry");
    assert.deepEqual(withSupport.report.unmapped, ["tests/support.mjs"]);

    // An unknown base, a mapping that is not a JSON file below the workspace or not closed: no Fact, no verdict.
    for (const [plan, selection, base, message] of [
      ["unknown-base", "selection.json", "release", /names no commit that shares history with HEAD/u],
      ["option-base", "selection.json", "--output=x", /Invalid Git base ref/u],
      ["outside", "../selection.json", "main", /Invalid mapping path/u],
      ["not-json", "selection.txt", "main", /Invalid mapping path/u],
      ["absent", "absent.json", "main", /ENOENT/u],
    ]) {
      const refused = await check(plan, selection, base);
      assert.equal(refused.interrupted, true, plan);
      assert.match(refused.message, message);
      assert.equal((await workspace.check(plan, "check selection")).latestVerdict, null);
    }
    await workspace.write("open.json", JSON.stringify({ tests: ["tests/**"], rules: [], command: "npm test" }));
    const open = await cli("select", "open.json", "src/plans/read.mjs");
    assert.equal(open.code, 2);
    assert.match(open.stderr, /Closed selection mapping keys required/u);
  } finally {
    await workspace.close();
  }
});
