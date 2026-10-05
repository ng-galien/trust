#!/usr/bin/env node
// Test selection from a mapping file: which test files a set of changed paths calls for. Runs no test.
//
// Mapping (JSON, closed keys):
//   {
//     "tests":  ["acceptance/*.acceptance.test.mjs"],
//     "ignore": ["docs/**", "**/*.md"],
//     "rules":  [{ "sources": ["src/registry/**"], "tests": ["acceptance/registry.acceptance.test.mjs"] }]
//   }
// `tests` names every test file the mapping governs; the optional `ignore` names changed paths that call for no
// test; each rule maps source patterns to test patterns. Patterns are repository-relative with forward slashes:
// `*` and `?` stay inside one path segment, `**` crosses segments. A changed test file selects itself. A changed
// path that is neither ignored, a test file nor covered by a rule is unmapped. A rule test pattern that names no
// existing governed test file is missing.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SELF = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
const MAX_MAPPING_BYTES = 256 * 1024;
const MAX_PATTERNS = 500;
const MAX_WALKED = 50000;
const MAX_CHANGED = 20000;
const MAX_REPORTED = 1000;
const GITLINK = "160000";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => {
  throw new Error(message);
};
const relativePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes("\\") &&
  !path.isAbsolute(value) &&
  [...value].every((character) => character.charCodeAt(0) >= 32) &&
  value.split("/").every((part) => part !== ".." && part !== "." && part !== "");
const patterns = (value, name, minimum = 1) => {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > MAX_PATTERNS ||
    !value.every(relativePath) ||
    new Set(value).size !== value.length
  )
    fail(`Invalid ${name}`);
  return value;
};
const sorted = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function parseMapping(serialized) {
  const value = JSON.parse(serialized);
  if (
    !value ||
    Array.isArray(value) ||
    !["rules,tests", "ignore,rules,tests"].includes(Object.keys(value).sort().join(","))
  )
    fail("Closed selection mapping keys required: tests, rules and optional ignore");
  patterns(value.tests, "mapping tests");
  patterns(value.ignore ?? [], "mapping ignore", 0);
  if (!Array.isArray(value.rules) || value.rules.length > MAX_PATTERNS) fail("Invalid mapping rules");
  for (const rule of value.rules) {
    if (!rule || Array.isArray(rule) || Object.keys(rule).sort().join(",") !== "sources,tests")
      fail("Closed mapping rule keys required: sources and tests");
    patterns(rule.sources, "rule sources");
    patterns(rule.tests, "rule tests");
  }
  return { tests: value.tests, ignore: value.ignore ?? [], rules: value.rules };
}

const compiled = new Map();
// `**` crosses path segments, and followed by a slash it also matches no segment; `*` and `?` do not cross.
export function matches(pattern, candidate) {
  if (!compiled.has(pattern)) {
    let source = "";
    for (let index = 0; index < pattern.length; index++) {
      const character = pattern[index];
      if (pattern.startsWith("**/", index) && (index === 0 || pattern[index - 1] === "/")) {
        source += "(?:[^/]+/)*";
        index += 2;
      } else if (pattern.startsWith("**", index)) {
        source += ".*";
        index += 1;
      } else if (character === "*") source += "[^/]*";
      else if (character === "?") source += "[^/]";
      else source += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
    compiled.set(pattern, new RegExp(`^${source}$`, "u"));
  }
  return compiled.get(pattern).test(candidate);
}
const matchesAny = (list, candidate) => list.some((pattern) => matches(pattern, candidate));

/** Every existing regular file the `tests` patterns name, walked from each pattern's fixed directory prefix. */
async function governedTestFiles(root, mapping) {
  const found = new Set();
  let walked = 0;
  async function walk(relative) {
    if (++walked > MAX_WALKED) fail("Test file discovery exceeds bounds");
    let stat;
    try {
      stat = await lstat(path.join(root, relative));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
      throw error;
    }
    if (stat.isDirectory()) {
      const name = path.basename(relative);
      // Installed dependencies and Git metadata never hold governed tests.
      if (name === "node_modules" || name === ".git") return;
      for (const entry of (await readdir(path.join(root, relative))).sort())
        await walk(relative === "" ? entry : `${relative}/${entry}`);
    } else if (stat.isFile() && matchesAny(mapping.tests, relative)) found.add(relative);
  }
  const prefixes = new Set(
    mapping.tests.map((pattern) => {
      const fixed = pattern.split("/");
      const wildcard = fixed.findIndex((part) => /[*?]/u.test(part));
      return (wildcard === -1 ? fixed : fixed.slice(0, wildcard)).join("/");
    }),
  );
  for (const prefix of prefixes) await walk(prefix);
  return found;
}

export function select(mapping, changed, governed) {
  const tests = sorted(governed);
  const selected = new Set();
  const unmapped = [];
  const ignored = [];
  for (const file of sorted(new Set(changed))) {
    if (governed.has(file)) {
      selected.add(file);
      continue;
    }
    if (matchesAny(mapping.ignore, file)) {
      ignored.push(file);
      continue;
    }
    const rules = mapping.rules.filter((rule) => matchesAny(rule.sources, file));
    // A removed or renamed test file matches the tests patterns without existing: it calls for no other test.
    if (rules.length === 0 && !matchesAny(mapping.tests, file)) unmapped.push(file);
    for (const rule of rules) for (const test of tests) if (matchesAny(rule.tests, test)) selected.add(test);
  }
  const missing = new Set();
  for (const rule of mapping.rules)
    for (const pattern of rule.tests) if (!tests.some((test) => matches(pattern, test))) missing.add(pattern);
  return {
    changed: sorted(new Set(changed)),
    selected: sorted(selected),
    unmapped,
    ignored,
    missing: sorted(missing),
    total: tests.length,
  };
}

const git = async (cwd, ...parameters) =>
  (await execute("git", parameters, { cwd, timeout: 30000, maxBuffer: 64 * 1024 * 1024 })).stdout;

/**
 * Paths that differ between one commit and the working tree, untracked files included. A changed submodule is
 * entered and compared with the commit the base recorded for it, so its own files are named.
 */
async function changedSince(directory, commit, prefix = "") {
  const changed = [];
  const raw = (await git(directory, "diff", "--raw", "--no-renames", "--abbrev=40", "-z", commit, "--")).split("\0");
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const [oldMode, newMode, oldCommit] = raw[index].slice(1).split(" ");
    const file = raw[index + 1];
    const nested = path.join(directory, file);
    let checkedOut = false;
    if (oldMode === GITLINK && newMode === GITLINK)
      try {
        await lstat(path.join(nested, ".git"));
        checkedOut = true;
      } catch {}
    if (checkedOut) changed.push(...(await changedSince(nested, oldCommit, `${prefix}${file}/`)));
    else changed.push(`${prefix}${file}`);
  }
  const untracked = (await git(directory, "ls-files", "--others", "--exclude-standard", "-z")).split("\0");
  for (const file of untracked) if (file) changed.push(`${prefix}${file}`);
  if (changed.length > MAX_CHANGED) fail("Changed paths exceed bounds");
  return changed;
}

/** The working tree compared with the merge base of `base` and HEAD: what this work changed since it left `base`. */
export async function changedFromBase(root, base) {
  if (typeof base !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,199}$/u.test(base)) fail("Invalid Git base ref");
  let baseCommit;
  try {
    const named = (await git(root, "rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`)).trim();
    baseCommit = (await git(root, "merge-base", named, "HEAD")).trim();
  } catch {
    fail(`Git base ref "${base}" names no commit that shares history with HEAD`);
  }
  return { baseCommit, changed: await changedSince(root, baseCommit) };
}

async function readMapping(root, mappingPath) {
  if (!relativePath(mappingPath) || !mappingPath.endsWith(".json")) fail("Invalid mapping path");
  const absolute = path.join(root, mappingPath);
  if ((await realpath(absolute)) !== absolute || !(await lstat(absolute)).isFile())
    fail("The mapping must be a regular file inside the repository");
  const bytes = await readFile(absolute);
  if (bytes.byteLength > MAX_MAPPING_BYTES) fail("The mapping exceeds bounds");
  return { mapping: parseMapping(bytes.toString("utf8")), mappingDigest: hash(bytes) };
}

/** The selection for explicit changed paths, or for the changes since a Git base ref when `base` is given. */
export async function executeSelection({ root, mappingPath, base, changedPaths }) {
  const resolved = await realpath(root);
  const { mapping, mappingDigest } = await readMapping(resolved, mappingPath);
  let baseCommit = "";
  let changed = changedPaths;
  if (base !== undefined) ({ baseCommit, changed } = await changedFromBase(resolved, base));
  else if (!Array.isArray(changed) || changed.length > MAX_CHANGED || !changed.every(relativePath))
    fail("Changed paths must be repository-relative paths");
  const selection = select(mapping, changed, await governedTestFiles(resolved, mapping));
  return {
    mapping: mappingPath,
    mappingDigest,
    base: base ?? "",
    baseCommit,
    changedFiles: selection.changed.length,
    selectedTestFiles: selection.selected.length,
    totalTestFiles: selection.total,
    unmappedChangedFiles: selection.unmapped.length,
    missingTestFiles: selection.missing.length,
    ignoredChangedFiles: selection.ignored.length,
    selected: selection.selected,
    unmapped: selection.unmapped.slice(0, MAX_REPORTED),
    missing: selection.missing,
    changed: selection.changed.slice(0, MAX_REPORTED),
  };
}

// A fixed line protocol permits canonical JSONata projection without arbitrary JSON evaluation.
export function renderSelection(report) {
  return [
    report.mapping,
    report.mappingDigest,
    report.base,
    report.baseCommit,
    report.changedFiles,
    report.selectedTestFiles,
    report.totalTestFiles,
    report.unmappedChangedFiles,
    report.missingTestFiles,
    JSON.stringify(report),
  ].join("\n");
}

const USAGE = `Usage: acceptance-selection.mjs observe <mapping.json> <git-base-ref>     Operation observation (line protocol)
       acceptance-selection.mjs select <mapping.json> --base <git-base-ref>  print the test files to run
       acceptance-selection.mjs select <mapping.json> <changed-path>...      same, for explicit changed paths
       select exits 1 when a changed file is unmapped or a mapped test file is missing.`;

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [mode, mappingPath, ...rest] = process.argv.slice(2);
  const root = process.cwd();
  try {
    if (mode === "observe" && rest.length === 1)
      console.log(renderSelection(await executeSelection({ root, mappingPath, base: rest[0] })));
    else if (mode === "select" && mappingPath && rest.length > 0) {
      const byBase = rest[0] === "--base";
      if (byBase && rest.length !== 2) fail(USAGE);
      const report = await executeSelection({
        root,
        mappingPath,
        ...(byBase ? { base: rest[1] } : { changedPaths: rest }),
      });
      // The test files go to stdout, one per line, ready for `node --test`; everything else goes to stderr.
      for (const file of report.selected) console.log(file);
      for (const file of report.unmapped) console.error(`unmapped changed file: ${file}`);
      for (const pattern of report.missing) console.error(`mapped test file missing: ${pattern}`);
      console.error(
        `${report.selectedTestFiles} of ${report.totalTestFiles} test files selected for ${report.changedFiles} changed files`,
      );
      if (report.unmappedChangedFiles > 0 || report.missingTestFiles > 0) process.exitCode = 1;
    } else fail(USAGE);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
