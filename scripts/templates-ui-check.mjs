import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Public acceptance commands only. Reports contain observations, never a TRUST verdict.
const [mode, reportRoot] = process.argv.slice(2);
if (!["ui", "review"].includes(mode) || !reportRoot || !path.isAbsolute(reportRoot)) {
  throw new Error("Usage: node scripts/templates-ui-check.mjs ui|review <absolute-report-directory>");
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
const captureNames = [
  "catalog",
  "detail",
  "creation",
  "procedure",
  "reference-catalog",
  "reference-detail",
  "template-language",
];
const captureRoot = path.join(reportRoot, "templates-ui-captures");
mkdirSync(captureRoot, { recursive: true });
const hashFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const report = {
  mode,
  reviewDecision: "not-reviewed",
  beforeHead: before.head,
  beforeDigest: before.digest,
  afterHead: "",
  afterDigest: "",
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  reportParsed: "no",
  commandsSucceeded: "no",
  captures: {},
  results: [],
};
if (mode === "ui") {
  for (const name of captureNames) rmSync(path.join(captureRoot, `${name}.png`), { force: true });
  const output = path.join(reportRoot, "templates-ui-playwright.json");
  rmSync(output, { force: true });
  const command = (name, executable, args, options = {}) => {
    const result = run(executable, args, options);
    const log = path.join(reportRoot, `templates-ui-${name}.log`);
    writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`);
    report.results.push({ name, exitCode: result.status ?? -1, log });
    return result;
  };
  const build = command("build", "npm", ["run", "build", "--workspace=@trust/runtime"]);
  if (build.status === 0) {
    command("lsp", "npm", ["run", "test:acceptance", "--workspace=@trust/language-server"]);
    command("template-runtime", "node", [
      "--test",
      "packages/trust-runtime/dist/acceptance/templates.acceptance.test.js",
    ]);
    command(
      "playwright",
      "npx",
      [
        "playwright",
        "test",
        "templates.acceptance.spec.ts",
        "authoring.acceptance.spec.ts",
        "--project=acceptance",
        "--reporter=json",
      ],
      {
        cwd: path.join(root, "apps/trust-web"),
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: output, TRUST_UI_CAPTURE_ROOT: captureRoot },
      },
    );
    command("architecture-acceptance", "node", ["--test", "scripts/canonical-dispatch.acceptance.test.mjs"]);
    command("architecture", "code-moniker", ["check", ".", "--report"]);
    try {
      const result = JSON.parse(readFileSync(output, "utf8"));
      report.passed = result.stats.expected;
      report.failed = result.stats.unexpected + result.stats.flaky;
      report.skipped = result.stats.skipped;
      report.total = report.passed + report.failed + report.skipped;
      for (const name of captureNames) report.captures[name] = hashFile(path.join(captureRoot, `${name}.png`));
      report.reportParsed =
        [report.total, report.passed, report.failed, report.skipped].every(Number.isSafeInteger) &&
        result.errors.length === 0
          ? "yes"
          : "no";
    } catch (error) {
      report.error = String(error);
    }
  }
  report.commandsSucceeded =
    report.results.length === 6 && report.results.every((result) => result.exitCode === 0) ? "yes" : "no";
} else {
  try {
    const verifiedPath = path.join(reportRoot, "templates-ui-ui.json");
    const verified = JSON.parse(readFileSync(verifiedPath, "utf8"));
    const review = JSON.parse(readFileSync(path.join(reportRoot, "templates-ui-review-response.json"), "utf8"));
    const criteria = ["catalog", "detail", "editor", "navigation", "workflow", "authority", "domain"];
    report.reviewDecision = typeof review.decision === "string" ? review.decision : "missing";
    report.total = criteria.length;
    report.passed = criteria.filter((name) => review.criteria?.[name] === true).length;
    report.failed = report.total - report.passed;
    const capturesMatch = captureNames.every(
      (name) =>
        review.captures?.[name] === verified.captures?.[name] &&
        hashFile(path.join(captureRoot, `${name}.png`)) === verified.captures[name],
    );
    const matches =
      review.acceptanceDigest === hashFile(verifiedPath) &&
      review.checkoutDigest === before.digest &&
      verified.beforeDigest === before.digest &&
      verified.afterDigest === before.digest &&
      verified.beforeHead === before.head &&
      verified.afterHead === before.head &&
      verified.commandsSucceeded === "yes" &&
      verified.failed === 0 &&
      verified.skipped === 0 &&
      verified.passed === verified.total &&
      verified.reportParsed === "yes" &&
      capturesMatch;
    report.reportParsed =
      typeof review.reviewer === "string" && review.reviewer.trim().length > 0 && Array.isArray(review.findings)
        ? "yes"
        : "no";
    report.commandsSucceeded = matches ? "yes" : "no";
    report.reviewer = review.reviewer;
    report.findings = review.findings;
    report.captures = verified.captures;
  } catch (error) {
    report.error = String(error);
  }
}
const after = identity();
report.afterHead = after.head;
report.afterDigest = after.digest;
writeFileSync(path.join(reportRoot, `templates-ui-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
