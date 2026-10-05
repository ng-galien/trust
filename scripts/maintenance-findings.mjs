#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const USAGE = "usage: node scripts/maintenance-findings.mjs check <findings-file>";
const KINDS = ["dead-code", "duplication", "leftover", "inconsistency"];
const RISKS = ["low", "medium", "high"];
const STATES = ["open", "fixed", "declined"];
const FILE_KEYS = ["axis", "findings"];
const FINDING_REQUIRED = [
  "id",
  "title",
  "kind",
  "location",
  "evidence",
  "action",
  "touches",
  "risk",
  "riskReason",
  "state",
];
const FINDING_KEYS = [...FINDING_REQUIRED, "related", "stateReason"];
const LOCATION_KEYS = ["file", "lines", "text"];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const lines = (content) =>
  content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());

/** Returns the reason a repository-relative path is malformed, or null. */
const pathFault = (value) => {
  if (typeof value !== "string" || value === "") return "is not a non-empty string";
  if (value.includes("\\")) return "uses a backslash";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return "is absolute";
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
    return "has an empty, '.' or '..' segment";
  return null;
};

/** Checks the form of one location; returns the reasons of its faults. */
const locationForm = (location, label) => {
  if (!isObject(location)) return [`${label} is not an object`];
  const faults = [];
  for (const key of Object.keys(location).sort())
    if (!LOCATION_KEYS.includes(key)) faults.push(`${label} has unknown key '${key}'`);
  for (const key of LOCATION_KEYS) if (!(key in location)) faults.push(`${label}.${key} is missing`);
  if ("file" in location) {
    const fault = pathFault(location.file);
    if (fault) faults.push(`${label}.file ${fault}`);
  }
  if ("lines" in location) {
    const range = location.lines;
    const valid =
      Array.isArray(range) &&
      range.length === 2 &&
      range.every((line) => Number.isInteger(line) && line >= 1) &&
      range[0] <= range[1];
    if (!valid) faults.push(`${label}.lines is not [first, last] with 1 <= first <= last`);
  }
  if ("text" in location && !isText(location.text)) faults.push(`${label}.text is not a non-empty string`);
  return faults;
};

/** Reads a cited file from the repository root, or null when it does not exist. */
const readCited = (root, file) => {
  const absolute = path.join(root, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  return lines(readFileSync(absolute, "utf8"));
};

/** Checks that the cited text is exactly the content of the cited line range. */
const presence = (root, location, label) => {
  const content = readCited(root, location.file);
  if (content === null) return [`${label}.file '${location.file}' not found`];
  const [first, last] = location.lines;
  const count = content.at(-1) === "" ? content.length - 1 : content.length;
  if (last > count) return [`${label}.lines [${first}, ${last}] out of range: '${location.file}' has ${count} lines`];
  const cited = lines(location.text);
  const actual = content.slice(first - 1, last);
  if (cited.length !== actual.length || cited.some((line, index) => line !== actual[index]))
    return [`${label}.text differs from lines ${first}-${last} of '${location.file}'`];
  return [];
};

/** Checks that the cited text no longer appears as consecutive lines of its file. */
const absence = (root, location, label) => {
  const content = readCited(root, location.file);
  if (content === null) return [];
  const cited = lines(location.text);
  for (let start = 0; start + cited.length <= content.length; start++)
    if (cited.every((line, index) => line === content[start + index]))
      return [`${label}.text is still present in '${location.file}' at line ${start + 1} although the state is fixed`];
  return [];
};

/** Checks one finding; returns the reasons of its faults. */
const checkFinding = (root, finding) => {
  if (!isObject(finding)) return ["the finding is not an object"];
  const faults = [];
  for (const key of Object.keys(finding).sort()) if (!FINDING_KEYS.includes(key)) faults.push(`unknown key '${key}'`);
  for (const key of FINDING_REQUIRED) if (!(key in finding)) faults.push(`${key} is missing`);
  if ("id" in finding && !(typeof finding.id === "string" && KEBAB.test(finding.id)))
    faults.push("id is not kebab-case");
  for (const key of ["title", "evidence", "action", "riskReason"])
    if (key in finding && !isText(finding[key])) faults.push(`${key} is not a non-empty string`);
  if ("kind" in finding && !KINDS.includes(finding.kind))
    faults.push(`kind ${JSON.stringify(finding.kind)} is not one of ${KINDS.join(", ")}`);
  if ("risk" in finding && !RISKS.includes(finding.risk))
    faults.push(`risk ${JSON.stringify(finding.risk)} is not one of ${RISKS.join(", ")}`);
  if ("state" in finding && !STATES.includes(finding.state))
    faults.push(`state ${JSON.stringify(finding.state)} is not one of ${STATES.join(", ")}`);
  if (finding.state === "open" && "stateReason" in finding) faults.push("stateReason is not allowed when open");
  if ((finding.state === "fixed" || finding.state === "declined") && !isText(finding.stateReason))
    faults.push(`stateReason is required when ${finding.state}`);
  const locationFaults = "location" in finding ? locationForm(finding.location, "location") : [];
  faults.push(...locationFaults);
  const related = finding.related;
  const relatedFaults = [];
  if ("related" in finding) {
    if (!Array.isArray(related) || related.length === 0) relatedFaults.push("related is not a non-empty array");
    else
      for (const [index, entry] of related.entries()) relatedFaults.push(...locationForm(entry, `related[${index}]`));
  }
  faults.push(...relatedFaults);
  if ("touches" in finding) {
    const touches = finding.touches;
    if (!Array.isArray(touches) || touches.length === 0) faults.push("touches is not a non-empty array");
    else {
      touches.forEach((file, index) => {
        const fault = pathFault(file);
        if (fault) faults.push(`touches[${index}] ${fault}`);
      });
      if (new Set(touches).size !== touches.length) faults.push("touches has a duplicate path");
      if (isObject(finding.location) && !touches.includes(finding.location.file))
        faults.push("touches does not contain location.file");
    }
  }
  if (faults.length > 0) return faults;
  if (finding.state === "fixed") return absence(root, finding.location, "location");
  const cited = [presence(root, finding.location, "location")];
  for (const [index, entry] of (related ?? []).entries()) cited.push(presence(root, entry, `related[${index}]`));
  return cited.flat();
};

/** Checks a parsed findings file against the repository at root. */
const checkFindings = (root, data) => {
  const result = { accepted: false, axis: null, findings: 0, open: 0, fixed: 0, declined: 0, refusals: [] };
  const refuse = (finding, reason) => result.refusals.push({ finding, reason });
  if (!isObject(data)) {
    refuse(null, "the findings file is not a JSON object");
    return result;
  }
  for (const key of Object.keys(data).sort()) if (!FILE_KEYS.includes(key)) refuse(null, `unknown key '${key}'`);
  if (typeof data.axis === "string" && KEBAB.test(data.axis)) result.axis = data.axis;
  else refuse(null, "axis is missing or not kebab-case");
  if (!Array.isArray(data.findings)) {
    refuse(null, "findings is missing or not an array");
    return result;
  }
  result.findings = data.findings.length;
  const seen = new Set();
  data.findings.forEach((finding, index) => {
    const named = isObject(finding) && typeof finding.id === "string" && KEBAB.test(finding.id);
    const name = named ? finding.id : `findings[${index}]`;
    if (named && seen.has(finding.id)) refuse(name, `duplicate id '${finding.id}'`);
    if (named) seen.add(finding.id);
    if (isObject(finding) && STATES.includes(finding.state)) result[finding.state] += 1;
    for (const reason of checkFinding(root, finding)) refuse(name, reason);
  });
  result.accepted = result.refusals.length === 0;
  return result;
};

const main = (argv) => {
  if (argv.length !== 2 || argv[0] !== "check") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const root = process.cwd();
  const file = path.resolve(root, argv[1]);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    process.stderr.write(`cannot read ${argv[1]}: ${error.code ?? error.message}\n${USAGE}\n`);
    return 2;
  }
  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    const result = { accepted: false, axis: null, findings: 0, open: 0, fixed: 0, declined: 0, refusals: [] };
    result.refusals.push({ finding: null, reason: `the findings file is not valid JSON: ${error.message}` });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify(checkFindings(root, data))}\n`);
  return 0;
};

process.exitCode = main(process.argv.slice(2));
