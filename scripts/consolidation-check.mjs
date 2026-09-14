import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Public acceptance commands only. Reports contain observations, never a TRUST verdict.
const [mode, reportRoot] = process.argv.slice(2);
if (!["docs", "mcp", "integration"].includes(mode) || !reportRoot || !path.isAbsolute(reportRoot)) {
  throw new Error("Usage: node scripts/consolidation-check.mjs docs|mcp|integration <absolute-report-directory>");
}
const root = process.cwd();
mkdirSync(reportRoot, { recursive: true });
const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300_000,
    ...options,
  });
function identity() {
  const head = run("git", ["rev-parse", "HEAD"]);
  const files = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (head.status !== 0 || files.status !== 0) throw new Error("Cannot identify the tested checkout");
  const hash = createHash("sha256");
  for (const file of [...new Set(files.stdout.split("\0").filter(Boolean))].sort()) {
    hash.update(file).update("\0");
    try {
      hash.update(readFileSync(path.join(root, file)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("<deleted>");
    }
    hash.update("\0");
  }
  return { head: head.stdout.trim(), digest: hash.digest("hex") };
}
const before = identity();
const results = [];
function command(name, executable, args, options) {
  const result = run(executable, args, options);
  const log = path.join(reportRoot, `${mode}-${name}.log`);
  writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`);
  results.push({ name, exitCode: result.status ?? -1, log });
  return result;
}
const build = command("build", "npm", ["run", "build", "--workspace=@trust/runtime"]);
let total = 0,
  passed = 0,
  failed = 0,
  skipped = 0,
  parsed = false;
if (build.status === 0) {
  if (mode === "docs") {
    const output = path.join(reportRoot, "playwright.json");
    const result = command(
      "tests",
      "npx",
      ["playwright", "test", "docs.acceptance.spec.ts", "--project=acceptance", "--reporter=json"],
      {
        cwd: path.join(root, "apps/trust-web"),
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: output },
      },
    );
    try {
      const report = JSON.parse(readFileSync(output, "utf8"));
      passed = report.stats.expected;
      failed = report.stats.unexpected + report.stats.flaky;
      skipped = report.stats.skipped;
      total = passed + failed + skipped;
      parsed = [total, passed, failed, skipped].every(Number.isSafeInteger) && report.errors.length === 0;
    } catch {
      parsed = false;
    }
    if (result.status === 0) command("site", "npm", ["run", "build:docs", "--workspace=@trust/web"]);
  } else {
    const files =
      mode === "mcp"
        ? ["packages/trust-runtime/acceptance/documentation.acceptance.test.mjs"]
        : [
            "packages/trust-runtime/dist/acceptance/dynamic-mission-declarations.acceptance.test.js",
            "packages/trust-runtime/dist/acceptance/child-plan-cascade.acceptance.test.js",
            "packages/trust-runtime/dist/acceptance/child-plan-depth.acceptance.test.js",
            "packages/trust-runtime/dist/acceptance/child-plan-escalation.acceptance.test.js",
            "packages/trust-runtime/dist/acceptance/child-plan-final-recovery.acceptance.test.js",
          ];
    const result = command("tests", process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      ...files,
    ]);
    const count = (key) => Number(result.stdout.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] ?? NaN);
    total = count("tests");
    passed = count("pass");
    failed = count("fail");
    skipped = count("skipped");
    parsed =
      [total, passed, failed, skipped].every(Number.isSafeInteger) && count("cancelled") === 0 && count("todo") === 0;
    if (mode === "integration") command("architecture", "code-moniker", ["check", ".", "--report"]);
  }
}
const after = identity();
const report = {
  mode,
  beforeHead: before.head,
  afterHead: after.head,
  beforeDigest: before.digest,
  afterDigest: after.digest,
  total: Number.isFinite(total) ? total : 0,
  passed: Number.isFinite(passed) ? passed : 0,
  failed: Number.isFinite(failed) ? failed : 0,
  skipped: Number.isFinite(skipped) ? skipped : 0,
  reportParsed: parsed ? "yes" : "no",
  commandsSucceeded: results.every((result) => result.exitCode === 0) ? "yes" : "no",
  results,
};
writeFileSync(path.join(reportRoot, `${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
