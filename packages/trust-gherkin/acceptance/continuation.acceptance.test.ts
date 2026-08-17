import { formatGherkinSource, parseGherkin, sourceLineRange, sourceValueRange } from "@trust/gherkin";
import { describe, expect, test } from "vitest";

const source = `Feature: Continuation
  Scenario: Run
    When Shell "status" runs "git" with cwd
        from Environment "workspaceRoot" and Input "project"
      | argument | source  |
      | status   | literal |
    Then done
`;

describe("Gherkin step continuation lines", () => {
  test("folds indented continuation lines into their step and keeps the data table", () => {
    const document = parseGherkin(source);
    const step = document.feature!.children[0]!.scenario!.steps[0]!;
    expect(step.text).toBe('Shell "status" runs "git" with cwd from Environment "workspaceRoot" and Input "project"');
    expect(step.location).toEqual({ line: 3, column: 5 });
    expect(step.dataTable!.rows).toHaveLength(2);
    expect(document.feature!.children[0]!.scenario!.steps[1]!.location.line).toBe(7);
  });

  test("resolves ranges of continued values back to their physical line", () => {
    const step = { location: { line: 3, column: 5 } };
    expect(sourceValueRange(source, step, '"workspaceRoot"')).toEqual({ start: { line: 4, column: 26 }, end: { line: 4, column: 41 } });
    expect(sourceLineRange(source, step.location)).toEqual({ start: { line: 3, column: 5 }, end: { line: 4, column: 61 } });
  });

  test("does not fold lines inside doc strings", () => {
    const withDocString = `Feature: Doc\n  Scenario: S\n    Given text\n      """\n      Given inner\n        indented\n      """\n`;
    const document = parseGherkin(withDocString);
    expect(document.feature!.children[0]!.scenario!.steps[0]!.docString!.content).toBe("Given inner\n  indented");
  });

  test("formats long steps onto continuation lines at connectives, idempotently, without touching tables", () => {
    const long = `Feature: F\n  Scenario: S\n    When Shell "status" runs "git" with cwd from Environment "workspaceRoot" and Input "project" where "a b" is quoted\n      | argument | source |\n`;
    const formatted = formatGherkinSource(long, { width: 60 });
    expect(formatted).toBe(`Feature: F\n  Scenario: S\n    When Shell "status" runs "git" with cwd\n        from Environment "workspaceRoot" and Input "project"\n        where "a b" is quoted\n      | argument | source |\n`);
    expect(formatGherkinSource(formatted, { width: 60 })).toBe(formatted);
    expect(parseGherkin(formatted).feature!.children[0]!.scenario!.steps[0]!.text).toBe(parseGherkin(long).feature!.children[0]!.scenario!.steps[0]!.text);
  });
});
