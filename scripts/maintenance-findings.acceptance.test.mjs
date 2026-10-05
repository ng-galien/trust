import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/** Runs the check as a process from the repository root on a findings file. */
const check = async (file) => {
  const { stdout } = await exec(process.execPath, [SCRIPT, "check", file], { cwd: trust });
  return JSON.parse(stdout);
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
