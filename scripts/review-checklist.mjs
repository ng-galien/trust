#!/usr/bin/env node
// Observe a declared checklist without storing a second mission or review record.
const [assignee, reviewer, ruleText, contractText, checklistText, ...extra] = process.argv.slice(2);
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
requireValue(
  extra.length === 0 &&
    [assignee, reviewer, ruleText, contractText, checklistText].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    ),
  "Five non-empty review inputs are required",
);
const contract = JSON.parse(contractText);
const checklist = JSON.parse(checklistText);
const rules = [...new Set(ruleText.trim().split(/\s+/u))];
const criteria = contract?.requirements;
requireValue(
  Array.isArray(criteria) &&
    criteria.length > 0 &&
    criteria.every((value) => typeof value === "string" && value.length > 0),
  "A contract with acceptance criteria is required",
);
const items = checklist?.items;
requireValue(Array.isArray(items) && items.length > 0, "A non-empty checklist is required");
const allowed = new Set([...rules.map((rule) => `rule:${rule}`), ...criteria.map((id) => `criterion:${id}`)]);
const seen = new Set();
for (const item of items) {
  requireValue(
    item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      Object.keys(item).sort().join(",") === "evidence,subject,verdict" &&
      typeof item.evidence === "string" &&
      ["pass", "fail"].includes(item.verdict) &&
      allowed.has(item.subject) &&
      !seen.has(item.subject),
    "Invalid, unknown or duplicate checklist item",
  );
  seen.add(item.subject);
}
const result = {
  reviewer,
  assignee,
  items: items.length,
  passed: items.filter((item) => item.verdict === "pass").length,
  failed: items.filter((item) => item.verdict === "fail").length,
  missingRules: rules.filter((rule) => !seen.has(`rule:${rule}`)).length,
  missingCriteria: criteria.filter((id) => !seen.has(`criterion:${id}`)).length,
  withoutEvidence: items.filter((item) => !item.evidence.trim()).length,
  summary: items
    .filter((item) => item.verdict === "fail")
    .map((item) => item.subject)
    .join(", "),
};
process.stdout.write(
  `${[
    result.reviewer,
    result.assignee,
    result.items,
    result.passed,
    result.failed,
    result.missingRules,
    result.missingCriteria,
    result.withoutEvidence,
    result.summary,
  ]
    .map((value) => String(value).replace(/\s+/gu, " "))
    .join("\n")}\n`,
);
