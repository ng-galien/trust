#!/usr/bin/env node
// Browser twin of acceptance-verification.mjs: runs a closed group of named Playwright specs and reports
// the same observation protocol, so TRUST qualifies browser acceptance exactly like node:test groups.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderObservation } from "./acceptance-verification.mjs";

const SELF = fileURLToPath(import.meta.url);
const MAX_FILES = 20000;
const MAX_BYTES = 512 * 1024 * 1024;
const TIMEOUT_MS = 600000;
const fail = (message) => {
  throw new Error(message);
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const relativePath = (entry) =>
  typeof entry === "string" &&
  entry.length > 0 &&
  !path.isAbsolute(entry) &&
  !entry.includes("\\") &&
  !entry.split("/").some((part) => part === ".." || part === "");
const text = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 400;
function list(value, accept, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000 || !value.every(accept))
    fail(`Invalid ${label}`);
}

export function parseBrowserContract(serialized, layer) {
  if (typeof serialized !== "string" || serialized.length > 65536) fail("Invalid verification contract");
  const value = JSON.parse(serialized);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "artifactPaths,assertions,config,id,layer,requirements,sourcePaths,testFiles"
  )
    fail("Closed browser verification contract keys required");
  if (
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u.test(value.id) ||
    value.layer !== layer ||
    layer !== "browser"
  )
    fail("Contract identity or layer mismatch");
  if (!relativePath(value.config) || !/\.(ts|mjs|js)$/u.test(value.config)) fail("Invalid Playwright config path");
  list(
    value.requirements,
    (entry) => typeof entry === "string" && /^[A-Z][A-Z0-9_.-]{0,95}$/u.test(entry),
    "requirement IDs",
  );
  list(value.testFiles, (entry) => relativePath(entry) && /\.spec\.ts$/u.test(entry), "testFiles");
  list(value.sourcePaths, relativePath, "sourcePaths");
  list(value.artifactPaths, relativePath, "artifactPaths");
  list(
    value.assertions,
    (entry) =>
      entry &&
      Object.keys(entry).sort().join(",") === "file,name,requirement" &&
      value.requirements.includes(entry.requirement) &&
      text(entry.name) &&
      value.testFiles.includes(entry.file),
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

async function snapshot(root, contract) {
  const entries = new Map();
  let bytes = 0;
  async function visit(relative) {
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
  for (const relative of new Set([
    contract.config,
    ...contract.sourcePaths,
    ...contract.artifactPaths,
    ...contract.testFiles,
  ]))
    await visit(relative);
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

function runPlaywright(root, contract) {
  const configDirectory = path.join(root, path.dirname(contract.config));
  const files = contract.testFiles.map((file) => path.relative(configDirectory, path.join(root, file)));
  const environment = { ...process.env };
  for (const name of ["NODE_OPTIONS", "NODE_TEST_CONTEXT", "PW_TEST_REPORTER", "PLAYWRIGHT_JSON_OUTPUT_NAME", "CI"])
    delete environment[name];
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["playwright", "test", "--config", path.basename(contract.config), "--reporter=json", "--retries=0", ...files],
      { cwd: configDirectory, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 64 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout });
    });
  });
}

function observe(root, _contract, report) {
  const observations = [];
  const visit = (suite, titles) => {
    const scope = suite.title && !suite.file?.endsWith(suite.title) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1);
        const status =
          test.status === "skipped" || last?.status === "skipped"
            ? "skipped"
            : last?.status === "passed" && test.status === "expected"
              ? "passed"
              : "failed";
        if (last?.status === "timedOut" || last?.status === "interrupted") report.crashed++;
        observations.push({
          file: path.relative(root, path.resolve(report.configDirectory, report.testDir ?? ".", spec.file)),
          name: [...scope, spec.title].join(" › "),
          status,
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, scope);
  };
  return { observations, visit };
}

export async function executeBrowserVerification({
  root,
  serialized,
  layer,
  expectedDigest = "capture",
  executionId = randomUUID(),
}) {
  const contract = parseBrowserContract(serialized, layer);
  if (expectedDigest !== "capture" && !/^[a-f0-9]{64}$/u.test(expectedDigest))
    fail("Expected digest must be capture or SHA256");
  root = await realpath(root);
  const before = await snapshot(root, contract);
  const report = {
    contractId: contract.id,
    layer,
    requirementIds: contract.requirements,
    executionId,
    expectedDigest,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    nodeVersion: process.version,
    command: { executable: "npx playwright test", config: contract.config, files: contract.testFiles },
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
  const execution = await runPlaywright(root, contract);
  let parsed;
  try {
    parsed = JSON.parse(execution.stdout);
  } catch {
    report.crashed++;
  }
  if (execution.signal) report.crashed++;
  let observations = [];
  if (parsed) {
    report.configDirectory = path.join(root, path.dirname(contract.config));
    report.testDir = parsed.config?.projects?.[0]?.testDir
      ? path.relative(report.configDirectory, parsed.config.projects[0].testDir)
      : undefined;
    const collector = observe(root, contract, report);
    for (const suite of parsed.suites ?? []) collector.visit(suite, []);
    observations = collector.observations;
    if ((parsed.errors ?? []).length) report.crashed++;
    delete report.configDirectory;
    delete report.testDir;
  }
  report.tested = observations.length;
  report.passed = observations.filter((entry) => entry.status === "passed").length;
  report.failed = observations.filter((entry) => entry.status === "failed").length;
  report.skipped = observations.filter((entry) => entry.status === "skipped").length;
  report.assertions = contract.assertions.map((required) => {
    const matching = observations.filter(
      (observed) => observed.file === required.file && observed.name === required.name,
    );
    return {
      ...required,
      status: matching.length === 1 ? matching[0].status : matching.length === 0 ? "missing" : "ambiguous",
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
    execution.code === 0 &&
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

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [serialized, layer, expectedDigest, executionId, ...rest] = process.argv.slice(2);
  if (!serialized || !layer || !expectedDigest || !executionId || rest.length)
    fail("Usage: browser-acceptance-verification.mjs <contract-json> <layer> <expected-digest|capture> <execution-id>");
  process.stdout.write(
    renderObservation(
      await executeBrowserVerification({ root: process.cwd(), serialized, layer, expectedDigest, executionId }),
    ),
  );
}
