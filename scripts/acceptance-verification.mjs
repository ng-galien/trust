#!/usr/bin/env node
import { execFile } from "node:child_process";
/** Public-boundary Node test observation. No report-import or arbitrary command mode. */
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

/** The first 500 characters of a failure's own message and its cause (node:test wraps hook failures). */
function failureMessage(error) {
  const parts = [error?.message, error?.cause?.message].filter((part) => typeof part === "string" && part.length > 0);
  return parts.join(" — ").slice(0, 500) || "failed without a message";
}

export function parseContract(serialized, layer) {
  if (typeof serialized !== "string" || serialized.length > 65536) fail("Invalid verification contract");
  const value = JSON.parse(serialized);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "artifactPaths,assertions,id,layer,requirements,sourcePaths,testFiles"
  )
    fail("Closed verification contract keys required");
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

export async function executeVerification({
  root,
  serialized,
  layer,
  expectedDigest = "capture",
  executionId = randomUUID(),
  timeoutMs = 120000,
}) {
  const contract = parseContract(serialized, layer);
  if (expectedDigest !== "capture" && !/^[a-f0-9]{64}$/u.test(expectedDigest))
    fail("Expected digest must be capture or SHA256");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120000) fail("Invalid verification timeout");
  root = await realpath(root);
  const before = await snapshot(root, contract);
  let gitHead = "unversioned";
  try {
    gitHead = (await execute("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5000 })).stdout.trim();
  } catch {}
  const configuration = {
    files: contract.testFiles.map((file) => path.join(root, file)),
    cwd: root,
    isolation: "process",
    concurrency: 1,
    execArgv: [],
    argv: [],
    timeout: timeoutMs,
  };
  const report = {
    contractId: contract.id,
    layer,
    requirementIds: contract.requirements,
    executionId,
    expectedDigest,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    gitHead,
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
    stale: expectedDigest !== "capture" && expectedDigest !== before.digest ? 1 : 0,
    complete: 0,
    assertions: [],
    files: before.files,
  };
  if (report.stale) {
    report.endedAt = new Date().toISOString();
    return report;
  }
  // No inherited preload, test-selection or child-runner context may silently select another run.
  for (const name of ["NODE_OPTIONS", "NODE_TEST_CONTEXT", "NODE_TEST_ONLY", "NODE_V8_COVERAGE"])
    delete process.env[name];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const observations = [];
  let summary;
  let outputBytes = 0;
  try {
    const stream = run({
      ...configuration,
      signal: abort.signal,
    });
    for await (const event of stream) {
      if (event.type === "test:stdout" || event.type === "test:stderr") {
        outputBytes += Buffer.byteLength(event.data.message ?? "");
        if (outputBytes > 1024 * 1024) abort.abort();
      }
      if (event.type === "test:pass" || event.type === "test:fail") {
        if (observations.length >= 10000) {
          abort.abort();
          continue;
        }
        const data = event.data;
        if (data.details?.type !== "suite" && data.name !== data.file)
          observations.push({
            file: path.relative(root, data.file ?? ""),
            name: data.name,
            status: data.skip || data.todo ? "skipped" : event.type === "test:pass" ? "passed" : "failed",
            // A failure keeps its bounded cause, including a failed before() hook, so a report explains itself.
            ...(event.type === "test:fail" ? { failure: failureMessage(data.details?.error) } : {}),
          });
        if (
          event.type === "test:fail" &&
          (data.details?.error?.exitCode !== undefined ||
            data.details?.error?.signal ||
            data.details?.error?.failureType === "cancelledByParent")
        )
          report.crashed++;
      }
      if (event.type === "test:summary" && !event.data.file) summary = event.data;
    }
  } catch {
    report.crashed++;
  } finally {
    clearTimeout(timer);
  }
  if (abort.signal.aborted || !summary) report.crashed++;
  if (summary) {
    report.runnerCounts = summary.counts;
    report.tested = observations.length;
    report.passed = observations.filter((entry) => entry.status === "passed").length;
    report.failed = summary.counts.failed;
    report.skipped = summary.counts.skipped + summary.counts.todo;
    report.crashed += summary.counts.cancelled;
  }
  report.assertions = contract.assertions.map((required) => {
    const matching = observations.filter(
      (observed) => observed.file === required.file && observed.name === required.name,
    );
    return {
      ...required,
      status: matching.length === 1 ? matching[0].status : matching.length === 0 ? "missing" : "ambiguous",
      ...(matching.length === 1 && matching[0].failure ? { failure: matching[0].failure } : {}),
    };
  });
  report.missing = report.assertions.filter((entry) => entry.status !== "passed").length;
  try {
    report.afterDigest = (await snapshot(root, contract)).digest;
  } catch {
    report.afterDigest = "unavailable";
  }
  if (before.digest !== report.afterDigest) report.stale = 1;
  report.complete =
    summary?.success &&
    report.tested > 0 &&
    report.passed > 0 &&
    report.failed === 0 &&
    report.skipped === 0 &&
    report.crashed === 0 &&
    report.missing === 0 &&
    report.stale === 0
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
    JSON.stringify(report),
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [serialized, layer, expectedDigest, executionId, ...rest] = process.argv.slice(2);
  if (rest.length || !executionId)
    fail("Usage: acceptance-verification.mjs <contract-json> <layer> <expected-digest|capture> <execution-id>");
  // This process is a child of the packaged Runner; only its final observation reaches stdout.
  try {
    console.log(
      renderObservation(
        await executeVerification({ root: process.cwd(), serialized, layer, expectedDigest, executionId }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
