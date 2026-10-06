import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const trust = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(trust, "scripts/maintenance-findings.mjs");
const EXAMPLE = "maintenance/examples/findings.json";
const REQUIRED = ["id", "location", "evidence", "action", "risk", "state"];
const LOCATION_FIELDS = ["file", "lines", "text"];

let scratch;
let example;
let variant = 0;

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "maintenance-findings-"));
  example = JSON.parse(await readFile(path.join(trust, EXAMPLE), "utf8"));
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Runs a copy of the command as a process and returns its exit code and output. */
const run = async (script, args, cwd) => {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
};

/** Runs the check as a process from the repository root on a findings file; the exit code follows the verdict. */
const check = async (file, script = SCRIPT, cwd = trust) => {
  const { code, stdout } = await run(script, ["check", file], cwd);
  const result = JSON.parse(stdout);
  assert.equal(code, result.accepted ? 0 : 1, stdout);
  return result;
};

/** Writes a variant of the example built by edit and checks it. */
const checkVariant = async (edit) => {
  const data = structuredClone(example);
  edit(data);
  variant += 1;
  const file = path.join(scratch, `variant-${variant}.json`);
  await writeFile(file, JSON.stringify(data, null, 2));
  return check(file);
};

const refusedFor = (result, finding, pattern) => {
  assert.equal(result.accepted, false);
  assert.ok(
    result.refusals.some((refusal) => refusal.finding === finding && pattern.test(refusal.reason)),
    `expected a refusal of ${finding} matching ${pattern}, got ${JSON.stringify(result.refusals)}`,
  );
};

test("MAINT-010 AC1 a findings file holds, for each finding, an id, a location with file and lines, the cited text, an evidence, a proposed action, a risk and a state", async () => {
  const accepted = await check(EXAMPLE);
  assert.equal(accepted.accepted, true, JSON.stringify(accepted.refusals));
  for (const field of REQUIRED) {
    const result = await checkVariant((data) => {
      delete data.findings[0][field];
    });
    const finding = field === "id" ? "findings[0]" : "duplicate-amount-formatter";
    refusedFor(result, finding, new RegExp(`^${field} is missing$`));
  }
  for (const field of LOCATION_FIELDS) {
    const result = await checkVariant((data) => {
      delete data.findings[0].location[field];
    });
    refusedFor(result, "duplicate-amount-formatter", new RegExp(`^location\\.${field} is missing$`));
  }
});

test("MAINT-010 AC2 the check accepts a well formed findings file whose cited texts are at their locations and refuses a faulty one by naming the finding and the reason", async () => {
  const accepted = await check(EXAMPLE);
  assert.deepEqual(accepted, {
    accepted: true,
    axis: "example",
    findings: 4,
    open: 1,
    fixed: 2,
    declined: 1,
    refusals: [],
  });

  const wrongText = await checkVariant((data) => {
    data.findings[0].location.text = data.findings[0].location.text.replace("EUR", "USD");
  });
  refusedFor(wrongText, "duplicate-amount-formatter", /^location\.text differs from lines 3-5 of /);

  const outOfRange = await checkVariant((data) => {
    data.findings[1].location.lines = [11, 40];
  });
  refusedFor(outOfRange, "legacy-pricing-flag", /^location\.lines \[11, 40\] out of range: .* has 12 lines$/);

  const missingFile = await checkVariant((data) => {
    data.findings[0].location.file = "maintenance/examples/absent.txt";
    data.findings[0].touches = ["maintenance/examples/absent.txt"];
  });
  refusedFor(
    missingFile,
    "duplicate-amount-formatter",
    /^location\.file 'maintenance\/examples\/absent\.txt' not found$/,
  );

  const duplicateId = await checkVariant((data) => {
    data.findings[1].id = "duplicate-amount-formatter";
  });
  refusedFor(duplicateId, "duplicate-amount-formatter", /^duplicate id 'duplicate-amount-formatter'$/);

  const unknownState = await checkVariant((data) => {
    data.findings[0].state = "pending";
  });
  refusedFor(unknownState, "duplicate-amount-formatter", /^state "pending" is not one of open, fixed, declined$/);

  const stillPresent = await checkVariant((data) => {
    data.findings[1].state = "fixed";
  });
  refusedFor(
    stillPresent,
    "legacy-pricing-flag",
    /^location\.text is still present in .* at line 11 although the state is fixed$/,
  );
});

const SUB_BASE = "3af09688467f2b28e237fa4fbdd266652c79fd08";
let repository;
let repositoryScript;
let base;
let findingsFile = 0;

/** Runs git in the temporary repository. */
const git = async (...args) => {
  const options = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];
  const { stdout } = await exec("git", [...options, ...args], { cwd: repository });
  return stdout.trim();
};

/** Creates a Git repository holding a copy of the command, commits a base, then edits the working tree. */
const createRepository = async () => {
  repository = await mkdtemp(path.join(tmpdir(), "maintenance-repository-"));
  await mkdir(path.join(repository, "scripts"));
  await mkdir(path.join(repository, "src"));
  await mkdir(path.join(repository, "maintenance"));
  repositoryScript = path.join(repository, "scripts/maintenance-findings.mjs");
  await copyFile(SCRIPT, repositoryScript);
  const rules = [
    ".alpha { color: red; }",
    ".beta { color: blue; }",
    ".gamma { color: green; }",
    ".delta { color: black; }",
  ];
  await writeFile(path.join(repository, "src/rules.css"), `${rules.join("\n")}\n`);
  await writeFile(path.join(repository, "src/old.txt"), "old helper\n");
  await git("init", "--quiet");
  await git("add", ".");
  await git("commit", "--quiet", "--no-verify", "-m", "base");
  base = await git("rev-parse", "HEAD");
  await writeFile(path.join(repository, "src/rules.css"), `${rules[1]}\n${rules[3]}\n`);
  await unlink(path.join(repository, "src/old.txt"));
};

before(createRepository);
after(async () => {
  await rm(repository, { recursive: true, force: true });
});

const location = (file, first, last, text) => ({ file, lines: [first, last], text });

/** Builds one finding of the temporary repository. */
const finding = (id, state, primary, extra = {}) => ({
  id,
  title: `finding ${id}`,
  kind: "dead-code",
  location: primary,
  evidence: "searched the temporary repository",
  action: "delete it",
  touches: [primary.file],
  risk: "low",
  riskReason: "no caller",
  state,
  ...(state === "open" ? {} : { stateReason: `${state} in the test` }),
  ...extra,
});

/** Writes a findings file into the temporary repository and returns its absolute path. */
const writeFindings = async (findings, top = { base }) => {
  findingsFile += 1;
  const file = path.join(repository, "maintenance", `findings-${findingsFile}.json`);
  await writeFile(file, JSON.stringify({ axis: "test", ...top, findings }, null, 2));
  return file;
};

/** Checks findings of the temporary repository with its own copy of the command. */
const checkRepository = async (findings, top) =>
  check(await writeFindings(findings, top), repositoryScript, repository);

const ALPHA = location("src/rules.css", 1, 1, ".alpha { color: red; }");
const GAMMA = location("src/rules.css", 3, 3, ".gamma { color: green; }");
const BETA_NOW = location("src/rules.css", 1, 1, ".beta { color: blue; }");
const DELTA_NOW = location("src/rules.css", 2, 2, ".delta { color: black; }");
const DELTA_AT_BASE = location("src/rules.css", 4, 4, ".delta { color: black; }");

test("MAINT-030 AC1 a fixed finding is proved by its cited text being at the cited lines at the base commit of the file and no longer in the file, and a text absent at the base commit is refused with the finding and the reason", async () => {
  const proved = await checkRepository([
    finding("removed-alpha", "fixed", ALPHA),
    finding("deleted-file", "fixed", location("src/old.txt", 1, 1, "old helper")),
  ]);
  assert.deepEqual(proved, { accepted: true, axis: "test", findings: 2, open: 0, fixed: 2, declined: 0, refusals: [] });

  const absentAtBase = await checkRepository([
    finding("not-at-base", "fixed", location("src/rules.css", 1, 1, ".alpha { color: pink; }")),
  ]);
  refusedFor(
    absentAtBase,
    "not-at-base",
    /^location\.text differs from lines 1-1 of 'src\/rules\.css' at base [0-9a-f]{7}$/,
  );

  const otherLines = await checkRepository([
    finding("other-lines", "fixed", location("src/rules.css", 2, 2, ".alpha { color: red; }")),
  ]);
  refusedFor(otherLines, "other-lines", /^location\.text differs from lines 2-2 of 'src\/rules\.css' at base /);

  const fileAbsentAtBase = await checkRepository([
    finding("never-recorded", "fixed", location("src/never.txt", 1, 1, "never")),
  ]);
  refusedFor(fileAbsentAtBase, "never-recorded", /^location\.file 'src\/never\.txt' not found at base /);

  const stillPresent = await checkRepository([finding("kept-delta", "fixed", DELTA_AT_BASE)]);
  refusedFor(
    stillPresent,
    "kept-delta",
    /^location\.text is still present in 'src\/rules\.css' at line 2 although the state is fixed$/,
  );

  const noBase = await checkRepository([finding("removed-alpha", "fixed", ALPHA)], {});
  refusedFor(noBase, null, /^base is missing or not a full commit sha$/);
  const unknownBase = await checkRepository([finding("removed-alpha", "fixed", ALPHA)], { base: "0".repeat(40) });
  refusedFor(unknownBase, null, /^base 0{40} is not a commit of the repository$/);

  const submoduleHead = location("trust-extension/package.json", 1, 2, '{\n  "name": "trust-extension",');
  const submodule = path.join(scratch, "submodule.json");
  const submoduleFinding = { ...finding("submodule-head", "fixed", submoduleHead) };
  await writeFile(submodule, JSON.stringify({ axis: "submodule", base: SUB_BASE, findings: [submoduleFinding] }));
  const readAtBase = await check(submodule);
  assert.deepEqual(readAtBase.refusals, [
    {
      finding: "submodule-head",
      reason: "location.text is still present in 'trust-extension/package.json' at line 1 although the state is fixed",
    },
  ]);
  const wrongAtBase = { ...submoduleHead, text: '{\n  "name": "another-extension",' };
  await writeFile(
    submodule,
    JSON.stringify({ axis: "submodule", base: SUB_BASE, findings: [{ ...submoduleFinding, location: wrongAtBase }] }),
  );
  refusedFor(
    await check(submodule),
    "submodule-head",
    /^location\.text differs from lines 1-2 of 'trust-extension\/package\.json' at base 3af0968$/,
  );
});

test("MAINT-030 AC2 the other locations a fix removes are listed on the finding and checked like the primary location in the open and fixed states", async () => {
  const open = await checkRepository([finding("grouped-open", "open", BETA_NOW, { also: [DELTA_NOW] })]);
  assert.deepEqual(open, { accepted: true, axis: "test", findings: 1, open: 1, fixed: 0, declined: 0, refusals: [] });

  const openWrong = await checkRepository([
    finding("grouped-open", "open", BETA_NOW, { also: [{ ...DELTA_NOW, text: ".delta { color: white; }" }] }),
  ]);
  refusedFor(openWrong, "grouped-open", /^also\[0\]\.text differs from lines 2-2 of 'src\/rules\.css'$/);

  const openOutOfRange = await checkRepository([
    finding("grouped-open", "open", BETA_NOW, { also: [{ ...DELTA_NOW, lines: [4, 4] }] }),
  ]);
  refusedFor(openOutOfRange, "grouped-open", /^also\[0\]\.lines \[4, 4\] out of range: 'src\/rules\.css' has 2 lines$/);

  const fixed = await checkRepository([finding("grouped-fixed", "fixed", ALPHA, { also: [GAMMA] })]);
  assert.deepEqual(fixed, { accepted: true, axis: "test", findings: 1, open: 0, fixed: 1, declined: 0, refusals: [] });

  const fixedKept = await checkRepository([finding("grouped-fixed", "fixed", ALPHA, { also: [GAMMA, DELTA_AT_BASE] })]);
  refusedFor(
    fixedKept,
    "grouped-fixed",
    /^also\[1\]\.text is still present in 'src\/rules\.css' at line 2 although the state is fixed$/,
  );

  const fixedNotAtBase = await checkRepository([
    finding("grouped-fixed", "fixed", ALPHA, { also: [{ ...GAMMA, lines: [2, 2] }] }),
  ]);
  refusedFor(fixedNotAtBase, "grouped-fixed", /^also\[0\]\.text differs from lines 2-2 of 'src\/rules\.css' at base /);

  const untouched = await checkRepository([
    finding("grouped-fixed", "fixed", ALPHA, { also: [location("src/old.txt", 1, 1, "old helper")] }),
  ]);
  refusedFor(untouched, "grouped-fixed", /^touches does not contain also\[0\]\.file$/);

  const empty = await checkRepository([finding("grouped-fixed", "fixed", ALPHA, { also: [] })]);
  refusedFor(empty, "grouped-fixed", /^also is not a non-empty array$/);
});

test("MAINT-030 AC3 the command finds the repository root by itself from any directory and exits 1 on a refusal, 0 on acceptance and 2 on a usage error", async () => {
  const accepted = await writeFindings([finding("removed-alpha", "fixed", ALPHA)]);
  const outside = await mkdtemp(path.join(scratch, "outside-"));

  const fromOutside = await run(repositoryScript, ["check", accepted], outside);
  assert.equal(fromOutside.code, 0, fromOutside.stdout);
  assert.equal(JSON.parse(fromOutside.stdout).accepted, true);

  const fromSubdirectory = await run(
    repositoryScript,
    ["check", path.relative(path.join(repository, "src"), accepted)],
    path.join(repository, "src"),
  );
  assert.equal(fromSubdirectory.code, 0, fromSubdirectory.stdout);
  assert.equal(JSON.parse(fromSubdirectory.stdout).accepted, true);

  const realFromOutside = await run(SCRIPT, ["check", path.join(trust, EXAMPLE)], outside);
  assert.equal(realFromOutside.code, 0, realFromOutside.stdout);
  assert.equal(JSON.parse(realFromOutside.stdout).accepted, true);

  const refused = await writeFindings([finding("kept-delta", "fixed", DELTA_AT_BASE)]);
  const refusal = await run(repositoryScript, ["check", refused], outside);
  assert.equal(refusal.code, 1, refusal.stdout);
  assert.equal(JSON.parse(refusal.stdout).accepted, false);

  const invalid = path.join(outside, "invalid.json");
  await writeFile(invalid, "{ not json");
  const invalidRun = await run(repositoryScript, ["check", invalid], outside);
  assert.equal(invalidRun.code, 1, invalidRun.stdout);
  assert.equal(JSON.parse(invalidRun.stdout).refusals[0].finding, null);

  for (const args of [
    [],
    ["check"],
    ["verify", accepted],
    ["check", accepted, "extra"],
    ["check", path.join(outside, "absent.json")],
  ]) {
    const usage = await run(repositoryScript, args, outside);
    assert.equal(usage.code, 2, `${JSON.stringify(args)}: ${usage.stdout}`);
    assert.equal(usage.stdout, "");
    assert.match(usage.stderr, /usage: node scripts\/maintenance-findings\.mjs check <findings-file>/);
  }
});
