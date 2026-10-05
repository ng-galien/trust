#!/usr/bin/env node
/**
 * Public-boundary Vitest test observation of one project: the contract's named tests run once with that project's
 * own Vitest, at its root, with their counts, the source digests and the duration. The process runs in the directory
 * where the projects live and the TRUST checkout provides this helper; the tested project never holds it.
 * No report-import or arbitrary command mode.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const MAX_FILES = 20000;
const MAX_BYTES = 128 * 1024 * 1024;
/** One run stays below the Runner's default Shell timeout (600 s), snapshots included. */
export const RUN_TIMEOUT_MS = 300000;
const REQUIRED_KEYS = ["artifactPaths", "assertions", "id", "requirements", "sourcePaths", "testFiles"];
const OPTIONAL_KEYS = ["revision", "vitest"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => {
  throw new Error(message);
};
const text = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  [...value].every((character) => character.charCodeAt(0) >= 32);
const relativePath = (value) =>
  text(value) &&
  !path.isAbsolute(value) &&
  value.split(/[\\/]/u).every((part) => part !== ".." && part !== "." && part !== "");
const list = (value, predicate, name) => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 256 ||
    !value.every(predicate) ||
    new Set(value).size !== value.length
  )
    fail(`Invalid ${name}`);
  return value;
};
const milliseconds = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const TEST_FILE = /\.(mjs|cjs|js|jsx|mts|cts|ts|tsx)$/u;

/**
 * The closed contract: the acceptance.node-run contract without `layer`, plus the optional `revision` (the approved
 * thread revision that founds the mission) and the optional `vitest` selection `{ project?, config? }`. An assertion
 * names a test by its file and its full title: the titles of its enclosing suites and its own, joined by " > ".
 */
export function parseContract(serialized) {
  if (typeof serialized !== "string" || serialized.length > 65536) fail("Invalid verification contract");
  const value = JSON.parse(serialized);
  const keys = value && !Array.isArray(value) && typeof value === "object" ? Object.keys(value) : [];
  if (
    !REQUIRED_KEYS.every((key) => keys.includes(key)) ||
    !keys.every((key) => REQUIRED_KEYS.includes(key) || OPTIONAL_KEYS.includes(key))
  )
    fail("Closed verification contract keys required");
  if ("revision" in value && (!Number.isSafeInteger(value.revision) || value.revision < 1))
    fail("Contract revision must be a positive integer");
  if ("vitest" in value) {
    const selection = value.vitest;
    const selectionKeys = selection && !Array.isArray(selection) ? Object.keys(selection) : ["invalid"];
    if (
      !selectionKeys.every((key) => key === "project" || key === "config") ||
      ("project" in selection &&
        !(text(selection.project) && /^[A-Za-z0-9@][A-Za-z0-9@/_.:-]{0,95}$/u.test(selection.project))) ||
      ("config" in selection && !relativePath(selection.config))
    )
      fail("Contract vitest selection must be { project?, config? } with a project name and a relative config path");
  }
  if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u.test(value.id))
    fail("Contract identity mismatch");
  list(
    value.requirements,
    (entry) => typeof entry === "string" && /^[A-Z][A-Z0-9_.-]{0,95}$/u.test(entry),
    "requirement IDs",
  );
  list(value.testFiles, (entry) => relativePath(entry) && TEST_FILE.test(entry), "testFiles");
  list(value.sourcePaths, relativePath, "sourcePaths");
  list(value.artifactPaths, relativePath, "artifactPaths");
  list(
    value.assertions,
    (entry) =>
      entry &&
      Object.keys(entry).sort().join(",") === "file,name,requirement" &&
      value.requirements.includes(entry.requirement) &&
      text(entry.name) &&
      relativePath(entry.file) &&
      value.testFiles.includes(entry.file),
    "assertions",
  );
  const named = value.assertions.map((entry) => `${entry.file}\0${entry.name}`);
  if (
    new Set(named).size !== named.length ||
    value.requirements.some((id) => !value.assertions.some((entry) => entry.requirement === id))
  )
    fail("Each requirement needs distinct named assertions");
  return value;
}

/** Static and dynamic imports with a relative specifier. */
const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/gu;

/** The closure rule of acceptance.node-run: contract, sourcePaths, artifactPaths, test files and their local imports. */
async function snapshot(root, contract, vitestVersion) {
  const entries = new Map();
  let bytes = 0;
  async function visit(relative) {
    // Installed dependencies are not the work under verification: they are never part of the closure.
    if (path.basename(relative) === "node_modules") return;
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || (await realpath(absolute)) !== absolute)
      fail(`Symbolic link refused in verification closure: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      if (entries.has(relative)) return;
      bytes += stat.size;
      if (entries.size >= MAX_FILES || bytes > MAX_BYTES) fail("Verification closure exceeds bounds");
      entries.set(relative, hash(await readFile(absolute)));
    } else fail(`Unsupported verification file: ${relative}`);
  }
  const optional = async (relative) => {
    try {
      await visit(relative);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  for (const relative of new Set([...contract.sourcePaths, ...contract.artifactPaths, ...contract.testFiles]))
    await visit(relative);
  const followed = new Set();
  async function followImports(relative, scope) {
    if (followed.has(relative) || !TEST_FILE.test(relative)) return;
    followed.add(relative);
    const source = await readFile(path.join(root, relative), "utf8");
    for (const [, specifier] of source.matchAll(LOCAL_IMPORT)) {
      const target = path.normalize(path.join(path.dirname(relative), specifier));
      if (target.startsWith("..") || path.isAbsolute(target)) continue;
      await optional(target);
      if (target.startsWith(scope)) await followImports(target, scope);
    }
  }
  for (const relative of contract.testFiles) await followImports(relative, `${path.dirname(relative)}${path.sep}`);
  for (const name of ["package.json", "package-lock.json", contract.vitest?.config].filter(Boolean))
    await optional(name);
  entries.set("@verification-helper", hash(await readFile(SELF)));
  const files = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { digest: hash(JSON.stringify({ contract, node: process.version, vitest: vitestVersion, files })), files };
}

async function snapshotDigest(root, contract, vitestVersion) {
  try {
    return (await snapshot(root, contract, vitestVersion)).digest;
  } catch {
    return "unavailable";
  }
}

/** The project's own Vitest: TRUST never brings its own test runner into the tested project. */
function repositoryVitest(root) {
  try {
    const manifest = createRequire(path.join(root, "package.json")).resolve("vitest/package.json");
    return { entry: path.join(path.dirname(manifest), "vitest.mjs"), manifest };
  } catch {
    return undefined;
  }
}

const SKIPPED = new Set(["skipped", "pending", "todo", "disabled"]);

/** One Vitest run of the contract's test files with the JSON reporter, judged against its named assertions. */
async function observeRun(root, contract, vitest, timeoutMs) {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-vitest-"));
  const outputFile = path.join(directory, "report.json");
  const args = [
    vitest.entry,
    "run",
    "--reporter=json",
    `--outputFile=${outputFile}`,
    ...(contract.vitest?.config ? ["--config", contract.vitest.config] : []),
    ...(contract.vitest?.project ? ["--project", contract.vitest.project] : []),
    ...contract.testFiles,
  ];
  // No inherited preload, coverage or nested test context may silently select another run.
  const env = { ...process.env, NO_COLOR: "1", CI: "1" };
  for (const name of Object.keys(env))
    if (name === "NODE_OPTIONS" || name === "NODE_V8_COVERAGE" || name.startsWith("VITEST")) delete env[name];
  const started = performance.now();
  const exit = await new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: root, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" },
      (error, _stdout, stderr) =>
        resolve({ code: error ? (error.code ?? -1) : 0, killed: Boolean(error?.killed), stderr: String(stderr) }),
    );
  });
  const durationMs = milliseconds(performance.now() - started);
  let json;
  try {
    json = JSON.parse(await readFile(outputFile, "utf8"));
  } catch {
    json = undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const result = { tested: 0, passed: 0, failed: 0, skipped: 0, crashed: 0, failures: [], fileErrors: [] };
  const observations = [];
  if (!json || exit.killed) result.crashed++;
  for (const file of json?.testResults ?? []) {
    const relative = path.relative(root, file.name ?? "");
    // A file that failed outside any test (import, collection or hook error) is a crash of that file.
    if (file.status === "failed" && (file.message || !(file.assertionResults ?? []).length)) {
      result.crashed++;
      result.fileErrors.push({ file: relative, failure: String(file.message ?? "failed").slice(0, 500) });
    }
    for (const entry of file.assertionResults ?? []) {
      const status = entry.status === "passed" ? "passed" : SKIPPED.has(entry.status) ? "skipped" : "failed";
      observations.push({
        file: relative,
        name: [...(entry.ancestorTitles ?? []), entry.title].join(" > "),
        status,
        durationMs: milliseconds(entry.duration),
        ...(status === "failed" ? { failure: String(entry.failureMessages?.[0] ?? "").slice(0, 500) } : {}),
      });
    }
  }
  result.tested = observations.length;
  result.passed = observations.filter((entry) => entry.status === "passed").length;
  result.failed = observations.filter((entry) => entry.status === "failed").length;
  result.skipped = observations.filter((entry) => entry.status === "skipped").length;
  result.failures = observations.filter((entry) => entry.status === "failed").slice(0, 100);
  const assertions = contract.assertions.map((required) => {
    const matching = observations.filter(
      (observed) => observed.file === required.file && observed.name === required.name,
    );
    return {
      ...required,
      status: matching.length === 1 ? matching[0].status : matching.length === 0 ? "missing" : "ambiguous",
      ...(matching.length === 1 && matching[0].failure ? { failure: matching[0].failure } : {}),
    };
  });
  return {
    ...result,
    missing: assertions.filter((entry) => entry.status !== "passed").length,
    succeeded: json?.success === true && exit.code === 0,
    exitCode: exit.code,
    stderr: json ? "" : exit.stderr.slice(-2000),
    assertions,
    durationMs,
  };
}

/** The project directory directly below the workspace: one name, no traversal, no symbolic link out of it. */
export async function projectRoot(workspace, project) {
  if (!text(project) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(project) || project === "..")
    fail("Project must name one directory directly below the workspace");
  const base = await realpath(workspace);
  const root = path.join(base, project);
  const stat = await lstat(root).catch(() => undefined);
  if (!stat?.isDirectory() || (await realpath(root)) !== root)
    fail(`Project "${project}" is not a directory directly below the workspace`);
  return root;
}

/** acceptance.vitest-run@1.0.0: one observation of the named Vitest tests of the project at `root`. */
export async function executeVerification({
  root,
  project = path.basename(root ?? ""),
  serialized,
  expectedDigest = "capture",
  executionId = randomUUID(),
  timeoutMs = RUN_TIMEOUT_MS,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > RUN_TIMEOUT_MS)
    fail("Invalid verification timeout");
  const contract = parseContract(serialized);
  if (expectedDigest !== "capture" && !/^[a-f0-9]{64}$/u.test(expectedDigest))
    fail("Expected digest must be capture or SHA256");
  if (typeof root !== "string" || !path.isAbsolute(root)) fail("Project root must be an absolute directory");
  const resolved = await realpath(root);
  const vitest = repositoryVitest(resolved);
  if (!vitest) fail(`Vitest is not installed in the project ${project}`);
  const vitestVersion = JSON.parse(await readFile(vitest.manifest, "utf8")).version;
  const before = await snapshot(resolved, contract, vitestVersion);
  const stale = expectedDigest !== "capture" && expectedDigest !== before.digest ? 1 : 0;
  const report = {
    contractId: contract.id,
    requirementIds: contract.requirements,
    ...("revision" in contract ? { revision: contract.revision } : {}),
    executionId,
    expectedDigest,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    project,
    cwd: resolved,
    nodeVersion: process.version,
    vitestVersion,
    command: { executable: process.execPath, vitest: vitest.entry, selection: contract.vitest ?? {} },
    sourceDigest: before.digest,
    afterDigest: before.digest,
    tested: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    crashed: 0,
    missing: contract.assertions.length,
    stale,
    complete: 0,
    durationMs: 0,
    reason: stale ? "the project code changed since the captured digest" : "",
    assertions: [],
    failures: [],
    fileErrors: [],
    files: before.files,
  };
  if (stale) {
    report.endedAt = new Date().toISOString();
    return report;
  }
  const { succeeded, exitCode, ...observed } = await observeRun(resolved, contract, vitest, timeoutMs);
  Object.assign(report, observed, { vitestExitCode: exitCode });
  report.afterDigest = await snapshotDigest(resolved, contract, vitestVersion);
  if (before.digest !== report.afterDigest) report.stale = 1;
  report.complete =
    succeeded &&
    report.tested > 0 &&
    report.passed > 0 &&
    report.failed === 0 &&
    report.skipped === 0 &&
    report.crashed === 0 &&
    report.missing === 0 &&
    report.stale === 0
      ? 1
      : 0;
  const unmet = report.assertions.filter((entry) => entry.status !== "passed");
  report.reason = report.complete
    ? "every named test passed on unchanged code"
    : [
        report.stale ? "the project code changed during the run" : "",
        unmet.length
          ? `named tests not passed: ${unmet.map((entry) => `${entry.name} (${entry.status})`).join("; ")}`
          : "",
        report.failed ? `${report.failed} failed` : "",
        report.skipped ? `${report.skipped} skipped` : "",
        report.crashed ? `${report.crashed} crashed` : "",
      ]
        .filter(Boolean)
        .join("; ") || "the Vitest run did not succeed";
  report.endedAt = new Date().toISOString();
  return report;
}

// A fixed line protocol permits canonical JSONata projection without arbitrary JSON evaluation.
export function renderObservation(report) {
  return [
    report.contractId,
    report.sourceDigest,
    report.afterDigest,
    report.tested,
    report.passed,
    report.failed,
    report.skipped,
    report.crashed,
    report.missing,
    report.stale,
    report.complete,
    report.runId,
    report.durationMs,
    [...report.reason].map((character) => (character.charCodeAt(0) < 32 ? " " : character)).join(""),
    JSON.stringify(report),
  ].join("\n");
}

const USAGE =
  "Usage: acceptance-vitest-verification.mjs run <project> <contract-json> <expected-digest|capture> <execution-id>";

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [mode, project, serialized, expectedDigest, executionId, ...rest] = process.argv.slice(2);
  // This process is a child of the packaged Runner, in the directory where the projects live; only its final
  // observation reaches stdout.
  try {
    if (mode !== "run" || rest.length || !executionId) fail(USAGE);
    const root = await projectRoot(process.cwd(), project);
    console.log(
      renderObservation(await executeVerification({ root, project, serialized, expectedDigest, executionId })),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
