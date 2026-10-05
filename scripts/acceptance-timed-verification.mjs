#!/usr/bin/env node
/**
 * Timed public-boundary Node test observation: one run with its durations, or the same group repeated on unchanged
 * code. Self-contained on purpose: acceptance-verification.mjs stays the frozen helper of acceptance.node-run@1.0.0.
 * No report-import or arbitrary command mode.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { run } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SELF = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
const MAX_FILES = 20000;
const MAX_BYTES = 128 * 1024 * 1024;
/** One run never exceeds the bound of acceptance.node-run@1.0.0. */
export const RUN_TIMEOUT_MS = 120000;
/** All repeated runs together stay below the Runner's default Shell timeout (600 s), snapshots included. */
export const REPEAT_BUDGET_MS = 540000;
export const REPEAT_RUNS = { min: 2, max: 10 };
export const FILE_CONCURRENCY = { min: 1, max: 8 };
const MAX_REPORTED = 100;
const CONTRACT_KEYS = [
  "artifactPaths,assertions,id,layer,requirements,sourcePaths,testFiles",
  "artifactPaths,assertions,id,layer,requirements,revision,sourcePaths,testFiles",
];
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
/** One protocol line: a name observed from a test file never breaks the line protocol. */
const line = (value) =>
  [...String(value)].map((character) => (character.charCodeAt(0) < 32 ? " " : character)).join("");

/** The first 500 characters of a failure's own message and its cause (node:test wraps hook failures). */
function failureMessage(error) {
  const parts = [error?.message, error?.cause?.message].filter((part) => typeof part === "string" && part.length > 0);
  return parts.join(" — ").slice(0, 500) || "failed without a message";
}

/**
 * The closed contract of acceptance.node-run@1.0.0, plus the optional `revision`: the approved thread revision
 * that founds the mission, a positive integer this helper records and never interprets.
 */
export function parseContract(serialized, layer) {
  if (typeof serialized !== "string" || serialized.length > 65536) fail("Invalid verification contract");
  const value = JSON.parse(serialized);
  if (!value || Array.isArray(value) || !CONTRACT_KEYS.includes(Object.keys(value).sort().join(",")))
    fail("Closed verification contract keys required");
  if ("revision" in value && (!Number.isSafeInteger(value.revision) || value.revision < 1))
    fail("Contract revision must be a positive integer");
  if (
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u.test(value.id) ||
    value.layer !== layer ||
    !["integration", "database"].includes(layer)
  )
    fail("Contract identity or layer mismatch");
  list(
    value.requirements,
    (entry) => typeof entry === "string" && /^[A-Z][A-Z0-9_.-]{0,95}$/u.test(entry),
    "requirement IDs",
  );
  list(value.testFiles, (entry) => relativePath(entry) && /\.(mjs|cjs|js|ts)$/u.test(entry), "testFiles");
  list(value.sourcePaths, relativePath, "sourcePaths");
  list(value.artifactPaths, relativePath, "artifactPaths");
  list(
    value.assertions,
    (entry) =>
      entry &&
      Object.keys(entry).sort().join(",") === "file,name,requirement" &&
      value.requirements.includes(entry.requirement) &&
      text(entry.name) &&
      relativePath(entry.file),
    "assertions",
  );
  const keys = value.assertions.map((entry) => `${entry.file}\0${entry.name}`);
  if (
    new Set(keys).size !== keys.length ||
    value.requirements.some((id) => !value.assertions.some((entry) => entry.requirement === id))
  )
    fail("Each requirement needs distinct named assertions");
  return value;
}

/** Static and dynamic imports with a relative specifier. */
const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/gu;

async function snapshot(root, contract) {
  const entries = new Map();
  let bytes = 0;
  async function visit(relative) {
    // Installed dependencies are not the work under verification: they are never part of the closure.
    if (path.basename(relative) === "node_modules") return;
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if ((await realpath(absolute)) !== absolute) fail(`Symbolic link refused in verification closure: ${relative}`);
    if (stat.isSymbolicLink()) fail(`Symbolic link refused in verification closure: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      if (entries.has(relative)) return;
      bytes += stat.size;
      if (entries.size >= MAX_FILES || bytes > MAX_BYTES) fail("Verification closure exceeds bounds");
      entries.set(relative, hash(await readFile(absolute)));
    } else fail(`Unsupported verification file: ${relative}`);
  }
  const tests = new Set([...contract.testFiles, ...contract.assertions.map((entry) => entry.file)]);
  for (const relative of new Set([...contract.sourcePaths, ...contract.artifactPaths, ...tests])) await visit(relative);
  // The support modules a test imports belong to the verified closure even when the contract does not list them:
  // relative imports are followed from each test file, recursively inside that test file's directory.
  const followed = new Set();
  async function followImports(relative, scope) {
    if (followed.has(relative) || !/\.(mjs|cjs|js|ts)$/u.test(relative)) return;
    followed.add(relative);
    const source = await readFile(path.join(root, relative), "utf8");
    for (const [, specifier] of source.matchAll(LOCAL_IMPORT)) {
      const target = path.normalize(path.join(path.dirname(relative), specifier));
      if (target.startsWith("..") || path.isAbsolute(target)) continue;
      try {
        await visit(target);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (target.startsWith(scope)) await followImports(target, scope);
    }
  }
  for (const relative of tests) await followImports(relative, `${path.dirname(relative)}${path.sep}`);
  for (const name of ["package.json", "package-lock.json"]) {
    try {
      await visit(name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  entries.set("@verification-helper", hash(await readFile(SELF)));
  const files = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { digest: hash(JSON.stringify({ contract, node: process.version, files })), files };
}

async function snapshotDigest(root, contract) {
  try {
    return (await snapshot(root, contract)).digest;
  } catch {
    return "unavailable";
  }
}

function runConfiguration(root, contract, timeoutMs, concurrency) {
  return {
    files: contract.testFiles.map((file) => path.join(root, file)),
    cwd: root,
    isolation: "process",
    concurrency,
    execArgv: [],
    argv: [],
    timeout: timeoutMs,
  };
}

/** One node:test run of the contract's test files, judged against its named assertions, with its durations. */
async function observeRun(root, contract, configuration) {
  // No inherited preload, test-selection or child-runner context may silently select another run.
  for (const name of ["NODE_OPTIONS", "NODE_TEST_CONTEXT", "NODE_TEST_ONLY", "NODE_V8_COVERAGE"])
    delete process.env[name];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), configuration.timeout);
  const observations = [];
  const fileDurations = new Map();
  const result = { tested: 0, passed: 0, failed: 0, skipped: 0, crashed: 0 };
  let summary;
  let outputBytes = 0;
  const started = performance.now();
  try {
    const stream = run({ ...configuration, signal: abort.signal });
    for await (const event of stream) {
      const data = event.data;
      if (event.type === "test:stdout" || event.type === "test:stderr") {
        outputBytes += Buffer.byteLength(data.message ?? "");
        if (outputBytes > 1024 * 1024) abort.abort();
      }
      // The file-level completion carries the wall time of that file's process, start-up included.
      if (event.type === "test:complete" && data.file && data.name === data.file)
        fileDurations.set(path.relative(root, data.file), milliseconds(data.details?.duration_ms));
      if (event.type === "test:summary" && data.file && !fileDurations.has(path.relative(root, data.file)))
        fileDurations.set(path.relative(root, data.file), milliseconds(data.duration_ms));
      if (event.type === "test:pass" || event.type === "test:fail") {
        if (observations.length >= 10000) {
          abort.abort();
          continue;
        }
        if (data.details?.type !== "suite" && data.name !== data.file)
          observations.push({
            file: path.relative(root, data.file ?? ""),
            name: data.name,
            status: data.skip || data.todo ? "skipped" : event.type === "test:pass" ? "passed" : "failed",
            durationMs: milliseconds(data.details?.duration_ms),
            // A failure keeps its bounded cause, including a failed before() hook, so a report explains itself.
            ...(event.type === "test:fail" ? { failure: failureMessage(data.details?.error) } : {}),
          });
        if (
          event.type === "test:fail" &&
          (data.details?.error?.exitCode !== undefined ||
            data.details?.error?.signal ||
            data.details?.error?.failureType === "cancelledByParent")
        )
          result.crashed++;
      }
      if (event.type === "test:summary" && !data.file) summary = data;
    }
  } catch {
    result.crashed++;
  } finally {
    clearTimeout(timer);
  }
  const durationMs = milliseconds(performance.now() - started);
  if (abort.signal.aborted || !summary) result.crashed++;
  if (summary) {
    result.runnerCounts = summary.counts;
    result.tested = observations.length;
    result.passed = observations.filter((entry) => entry.status === "passed").length;
    result.failed = summary.counts.failed;
    result.skipped = summary.counts.skipped + summary.counts.todo;
    result.crashed += summary.counts.cancelled;
  }
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
  const slowest = (entries) => entries.reduce((worst, entry) => (entry[1] > worst[1] ? entry : worst), ["", 0]);
  const [slowestFile, slowestFileMs] = slowest([...fileDurations]);
  const [slowestTestKey, slowestTestMs] = slowest(
    observations.map((entry) => [`${entry.file}\0${entry.name}`, entry.durationMs]),
  );
  return {
    ...result,
    missing: assertions.filter((entry) => entry.status !== "passed").length,
    succeeded: summary?.success === true,
    assertions,
    observations,
    durationMs,
    slowestFileMs,
    slowestFile,
    slowestTestMs,
    slowestTest: slowestTestKey.split("\0")[1] ?? "",
    slowestTestFile: slowestTestKey.split("\0")[0],
    fileDurations: [...fileDurations].map(([file, durationMs]) => ({ file, durationMs })),
  };
}

const complete = (observed, stale) =>
  observed.succeeded &&
  observed.tested > 0 &&
  observed.passed > 0 &&
  observed.failed === 0 &&
  observed.skipped === 0 &&
  observed.crashed === 0 &&
  observed.missing === 0 &&
  stale === 0
    ? 1
    : 0;

async function opening(root, serialized, layer, expectedDigest) {
  const contract = parseContract(serialized, layer);
  if (expectedDigest !== "capture" && !/^[a-f0-9]{64}$/u.test(expectedDigest))
    fail("Expected digest must be capture or SHA256");
  const resolved = await realpath(root);
  const before = await snapshot(resolved, contract);
  let gitHead = "unversioned";
  try {
    gitHead = (await execute("git", ["rev-parse", "HEAD"], { cwd: resolved, timeout: 5000 })).stdout.trim();
  } catch {}
  return {
    contract,
    root: resolved,
    before,
    gitHead,
    stale: expectedDigest !== "capture" && expectedDigest !== before.digest ? 1 : 0,
  };
}

/** acceptance.node-run@1.1.0: the observation of 1.0.0 plus the durations of the run. */
export async function executeVerification({
  root,
  serialized,
  layer,
  expectedDigest = "capture",
  executionId = randomUUID(),
  timeoutMs = RUN_TIMEOUT_MS,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > RUN_TIMEOUT_MS)
    fail("Invalid verification timeout");
  const start = await opening(root, serialized, layer, expectedDigest);
  const { contract, before } = start;
  const configuration = runConfiguration(start.root, contract, timeoutMs, 1);
  const report = {
    contractId: contract.id,
    layer,
    requirementIds: contract.requirements,
    ...("revision" in contract ? { revision: contract.revision } : {}),
    executionId,
    expectedDigest,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    gitHead: start.gitHead,
    nodeVersion: process.version,
    command: { executable: process.execPath, api: "node:test.run", configuration },
    sourceDigest: before.digest,
    afterDigest: before.digest,
    tested: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    crashed: 0,
    missing: contract.assertions.length,
    stale: start.stale,
    complete: 0,
    durationMs: 0,
    slowestFileMs: 0,
    slowestFile: "",
    slowestTestMs: 0,
    slowestTest: "",
    slowestTestFile: "",
    fileDurations: [],
    assertions: [],
    files: before.files,
  };
  if (report.stale) {
    report.endedAt = new Date().toISOString();
    return report;
  }
  const observed = await observeRun(start.root, contract, configuration);
  const { observations: _observations, succeeded: _succeeded, ...reported } = observed;
  Object.assign(report, reported);
  report.afterDigest = await snapshotDigest(start.root, contract);
  if (before.digest !== report.afterDigest) report.stale = 1;
  report.complete = complete(observed, report.stale);
  report.endedAt = new Date().toISOString();
  return report;
}

function bounded(value, { min, max }, name) {
  const number = typeof value === "number" ? value : /^[0-9]{1,3}$/u.test(value ?? "") ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max)
    fail(`${name} must be a whole number from ${min} to ${max}`);
  return number;
}

/**
 * acceptance.node-repeat@1.0.0: the contract's test files run `runs` times in a row on unchanged code, `concurrency`
 * files at once. Each run is judged exactly like acceptance.node-run; the repetition stops when the code changed.
 */
export async function executeRepetition({
  root,
  serialized,
  layer,
  expectedDigest = "capture",
  runs,
  concurrency,
  executionId = randomUUID(),
  budgetMs = REPEAT_BUDGET_MS,
}) {
  const requestedRuns = bounded(runs, REPEAT_RUNS, "runs");
  const fileConcurrency = bounded(concurrency, FILE_CONCURRENCY, "concurrency");
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 10 * requestedRuns || budgetMs > REPEAT_BUDGET_MS)
    fail("Invalid repetition budget");
  const start = await opening(root, serialized, layer, expectedDigest);
  const { contract, before } = start;
  // Every requested run gets the same share of the budget, never more than one acceptance.node-run.
  const timeoutMs = Math.min(RUN_TIMEOUT_MS, Math.floor(budgetMs / requestedRuns));
  const configuration = runConfiguration(start.root, contract, timeoutMs, fileConcurrency);
  const report = {
    contractId: contract.id,
    layer,
    requirementIds: contract.requirements,
    ...("revision" in contract ? { revision: contract.revision } : {}),
    executionId,
    expectedDigest,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    gitHead: start.gitHead,
    nodeVersion: process.version,
    command: { executable: process.execPath, api: "node:test.run", configuration },
    sourceDigest: before.digest,
    afterDigest: before.digest,
    requestedRuns,
    concurrency: fileConcurrency,
    runTimeoutMs: timeoutMs,
    runs: 0,
    passedRuns: 0,
    failedRuns: 0,
    unstableTests: 0,
    minDurationMs: 0,
    maxDurationMs: 0,
    stale: start.stale,
    stable: 0,
    runReports: [],
    unstable: [],
    files: before.files,
  };
  if (report.stale) {
    report.endedAt = new Date().toISOString();
    return report;
  }
  const statuses = new Map();
  for (let index = 1; index <= requestedRuns; index++) {
    const startedAt = new Date().toISOString();
    const observed = await observeRun(start.root, contract, configuration);
    report.afterDigest = await snapshotDigest(start.root, contract);
    // A run that ended on changed code proves nothing about the captured code: it counts as failed.
    if (before.digest !== report.afterDigest) report.stale = 1;
    const passed = complete(observed, report.stale);
    for (const entry of observed.observations) {
      const key = `${entry.file}\0${entry.name}`;
      if (!statuses.has(key)) statuses.set(key, new Map());
      // A name observed twice in one run is ambiguous and can never look stable.
      statuses.get(key).set(index, statuses.get(key).has(index) ? "ambiguous" : entry.status);
    }
    report.runs++;
    report.passedRuns += passed;
    report.failedRuns += 1 - passed;
    report.runReports.push({
      index,
      startedAt,
      complete: passed,
      durationMs: observed.durationMs,
      tested: observed.tested,
      passed: observed.passed,
      failed: observed.failed,
      skipped: observed.skipped,
      crashed: observed.crashed,
      missing: observed.missing,
      slowestFileMs: observed.slowestFileMs,
      slowestFile: observed.slowestFile,
      slowestTestMs: observed.slowestTestMs,
      slowestTest: observed.slowestTest,
      slowestTestFile: observed.slowestTestFile,
      failures: observed.observations
        .filter((entry) => entry.status === "failed")
        .slice(0, MAX_REPORTED)
        .map(({ file, name, failure }) => ({ file, name, failure })),
      unmetAssertions: observed.assertions.filter((entry) => entry.status !== "passed").slice(0, MAX_REPORTED),
    });
    if (report.stale) break;
  }
  // A test is unstable when its status is not the same in every executed run, an absent observation included.
  const unstable = [...statuses]
    .map(([key, byRun]) => ({
      file: key.split("\0")[0],
      name: key.split("\0")[1],
      statuses: Array.from({ length: report.runs }, (_, offset) => byRun.get(offset + 1) ?? "missing"),
    }))
    .filter((entry) => new Set(entry.statuses).size > 1);
  const durations = report.runReports.map((entry) => entry.durationMs);
  report.unstableTests = unstable.length;
  report.unstable = unstable.slice(0, MAX_REPORTED);
  report.minDurationMs = Math.min(...durations);
  report.maxDurationMs = Math.max(...durations);
  report.stable =
    report.runs === requestedRuns && report.passedRuns === requestedRuns && report.unstableTests === 0 && !report.stale
      ? 1
      : 0;
  report.endedAt = new Date().toISOString();
  return report;
}

// A fixed line protocol permits canonical JSONata projection without arbitrary JSON evaluation.
export function renderObservation(report) {
  return [
    report.contractId,
    report.layer,
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
    report.slowestFileMs,
    report.slowestTestMs,
    line(report.slowestFile),
    line(report.slowestTest),
    JSON.stringify(report),
  ].join("\n");
}

export function renderRepetition(report) {
  return [
    report.contractId,
    report.layer,
    report.sourceDigest,
    report.afterDigest,
    report.requestedRuns,
    report.concurrency,
    report.runs,
    report.passedRuns,
    report.failedRuns,
    report.unstableTests,
    report.minDurationMs,
    report.maxDurationMs,
    report.stale,
    report.stable,
    report.runId,
    JSON.stringify(report),
  ].join("\n");
}

const USAGE = `Usage: acceptance-timed-verification.mjs run <contract-json> <layer> <expected-digest|capture> <execution-id>
       acceptance-timed-verification.mjs repeat <contract-json> <layer> <expected-digest|capture> <runs> <concurrency> <execution-id>`;

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [mode, serialized, layer, expectedDigest, ...rest] = process.argv.slice(2);
  // This process is a child of the packaged Runner; only its final observation reaches stdout.
  try {
    const root = process.cwd();
    if (mode === "run" && rest.length === 1 && rest[0])
      console.log(
        renderObservation(await executeVerification({ root, serialized, layer, expectedDigest, executionId: rest[0] })),
      );
    else if (mode === "repeat" && rest.length === 3 && rest[2])
      console.log(
        renderRepetition(
          await executeRepetition({
            root,
            serialized,
            layer,
            expectedDigest,
            runs: rest[0],
            concurrency: rest[1],
            executionId: rest[2],
          }),
        ),
      );
    else fail(USAGE);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
