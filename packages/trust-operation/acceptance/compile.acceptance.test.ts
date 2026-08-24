import { readFileSync, readdirSync } from "node:fs";

import {
  analyzeOperation,
  compileOperation,
  CompiledOperationValidationError,
  HTTP_METHODS,
  OperationCompilationError,
  validateCompiledOperation,
  type OperationCompilationErrorCode,
} from "@trust/operation";
import { describe, expect, test } from "vitest";

const fixture = (path: string): string =>
  readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

const invalidDirectory = new URL("./fixtures/invalid/", import.meta.url);
const invalidCases = Object.entries(
  JSON.parse(fixture("invalid/errors.json")) as Record<string, OperationCompilationErrorCode>,
);

describe("Operation compiler", () => {
  test("analyzes one valid Operation with the compiled contract and positioned source model", () => {
    const source = fixture("valid/http.status-read.feature");

    const analysis = analyzeOperation({ source, sourceName: "http.status-read.feature" });

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis).toHaveProperty("document");
    if (!("compiled" in analysis)) throw new Error("Expected a compiled Operation");
    expect(analysis.compiled).toEqual(compileOperation({ source, sourceName: "http.status-read.feature" }));
    expect(analysis.document).toMatchObject({
      kind: "operation",
      operation: "http.status-read",
      environment: [{ name: "serviceUrl", type: "url" }],
      steps: [{ name: "response", type: "http" }],
      produced: [
        { name: "service", type: "string", cardinality: "one" },
        { name: "status", type: "number", cardinality: "one" },
      ],
    });
    expect(analysis.document.steps[0]?.range.start).toEqual({ line: 15, column: 5 });
    expect(analysis.document.selectionRange).toEqual({
      start: { line: 2, column: 25 },
      end: { line: 2, column: 41 },
    });
    expect(analysis.document.environment[0]?.selectionRange).toEqual({
      start: { line: 8, column: 9 },
      end: { line: 8, column: 19 },
    });
    expect(analysis.document.steps[0]?.selectionRange).toEqual({
      start: { line: 15, column: 16 },
      end: { line: 15, column: 24 },
    });
  });

  test("analyzes one semantic error at its source line", () => {
    const source = fixture("invalid/http-unknown-environment.feature");

    const analysis = analyzeOperation({ source, sourceName: "http-unknown-environment.feature" });

    expect(analysis.diagnostics).toEqual([{
        code: "unknown-environment",
        message: 'HTTP "response" uses undeclared Environment "otherUrl"',
        sourceName: "http-unknown-environment.feature",
        range: {
          start: { line: 14, column: 5 },
          end: { line: 14, column: 78 },
        },
      }]);
    expect(analysis.document).toMatchObject({
      operation: "http.invalid",
      environment: [{ name: "serviceUrl" }],
      steps: [{ name: "response", type: "http" }],
      produced: [{ name: "status" }],
    });
  });

  test("analyzes invalid Gherkin at the parser error location", () => {
    const analysis = analyzeOperation({
      source: "Scenario: before feature\n",
      sourceName: "invalid.feature",
    });

    expect(analysis.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid-operation",
        sourceName: "invalid.feature",
        range: {
          start: { line: 1, column: 1 },
          end: { line: 1, column: 25 },
        },
      }),
    ]);
  });

  test.each([
    ["git.head-read.feature", "git.head-read.compiled.json"],
    ["file.package-read.feature", "file.package-read.compiled.json"],
    ["file.license-read.feature", "file.license-read.compiled.json"],
    ["http.status-read.feature", "http.status-read.compiled.json"],
    ["http.text-read.feature", "http.text-read.compiled.json"],
    ["shell.prefixed-argument.feature", "shell.prefixed-argument.compiled.json"],
    ["http.segments-query.feature", "http.segments-query.compiled.json"],
  ])("compiles %s to the closed runner contract", (feature, artifact) => {
    const source = fixture(`valid/${feature}`);
    const expected = JSON.parse(fixture(`valid/${artifact}`));

    const compiled = compileOperation({ source, sourceName: feature });
    const { source: compiledSource, ...contract } = compiled;

    expect(compiledSource).toBe(source);
    expect(contract).toEqual(expected);
    expect(() => validateCompiledOperation(JSON.parse(JSON.stringify(compiled)))).not.toThrow();
    if (feature === "git.head-read.feature") {
      expect(source).toBe(
        readFileSync(new URL("../../../assets/operations/git.head-read.feature", import.meta.url), "utf8"),
      );
    }
    if (feature === "http.status-read.feature" || feature === "http.text-read.feature") {
      expect(source).toBe(
        readFileSync(new URL(`../../../assets/operations/${feature}`, import.meta.url), "utf8"),
      );
    }
  });

  test("compiles the catalog Operations that append one Input as a one-segment path list", () => {
    const source = readFileSync(new URL("../../../assets/operations/jira.issue-read.feature", import.meta.url), "utf8");

    const compiled = compileOperation({ source, sourceName: "jira.issue-read.feature" });

    expect(compiled.steps[0]).toMatchObject({
      type: "http",
      http: { method: "GET", url: { environment: "jiraIssueUrl" }, path: [{ kind: "input", input: "issue" }], format: "json" },
    });
    expect(compiled.steps[0]).not.toHaveProperty("http.appendInputs");
  });

  test.each([
    "karate.test-run.feature",
    "karate.defect-reproduce.feature",
    "karate.change-reproduce.feature",
    "karate.change-verify.feature",
  ])("passes the TRUST execution id to Maven in %s", (feature) => {
    const source = readFileSync(new URL(`../../../assets/operations/${feature}`, import.meta.url), "utf8");

    const compiled = compileOperation({ source, sourceName: feature });
    const testStep = compiled.steps.find((step) => step.name === "test");

    expect(testStep).toMatchObject({
      type: "shell",
      shell: {
        executable: "mvn",
        arguments: expect.arrayContaining([{
          kind: "execution",
          field: "id",
          prefix: "-Dtrust.execution.id=",
        }]),
      },
    });
  });

  test.each([
    ["maven.change-install.feature", "install"],
    ["maven.dependency-verify.feature", "dependency"],
  ])("compiles the Maven library dependency Operation %s", (feature, stepName) => {
    const source = readFileSync(new URL(`../../../assets/operations/${feature}`, import.meta.url), "utf8");

    const compiled = compileOperation({ source, sourceName: feature });

    expect(compiled.steps.find((step) => step.name === stepName)).toMatchObject({
      type: "shell",
      shell: { executable: "mvn" },
    });
    expect(() => validateCompiledOperation(JSON.parse(JSON.stringify(compiled)))).not.toThrow();
  });

  test("compiles fixed filters over an HTTP trace body", () => {
    const source = readFileSync(new URL("../../../assets/operations/telemetry.project-trace-read.feature", import.meta.url), "utf8");

    const compiled = compileOperation({ source, sourceName: "telemetry.project-trace-read.feature" });

    expect(compiled.steps).toEqual([expect.objectContaining({ name: "trace", type: "http" })]);
    expect(compiled.produce.expression).toContain('key = "trust.execution.id"');
  });

  test("maps only the exact Jira Done status to done", () => {
    const source = readFileSync(new URL("../../../assets/operations/jira.issue-read.feature", import.meta.url), "utf8");

    const compiled = compileOperation({ source, sourceName: "jira.issue-read.feature" });

    expect(compiled.produced.properties.workflowStatus).toMatchObject({
      enum: ["todo", "in-progress", "in-review", "done", "other"],
    });
    expect(compiled.produce.expression).toContain('status.name = "Done" ? "done" : "other"');
  });

  test("reports a misordered HTTP clause with the expected order", () => {
    const analysis = analyzeOperation({
      source: fixture("invalid/http-query-before-appending.feature"),
      sourceName: "http-query-before-appending.feature",
    });

    expect(analysis.diagnostics).toEqual([expect.objectContaining({
      code: "unknown-step",
      message: expect.stringContaining('expected with query or with header or with Input as JSON body or with JSONata body or with Text body or and reads before "appending"'),
    })]);
    expect(analysis.document?.steps).toEqual([expect.objectContaining({ name: "comments", type: "http" })]);
  });

  test("reports a semantic capture rejected after the Step Grammar matched", () => {
    const source = fixture("valid/http.status-read.feature")
      .replace('to Environment "serviceUrl" and reads', 'to Environment "serviceUrl" appending literal "" and reads');

    const analysis = analyzeOperation({ source, sourceName: "http-empty-segment.feature" });

    expect(analysis.diagnostics).toEqual([expect.objectContaining({
      code: "unknown-step",
      message: expect.stringContaining('appending literal expects a non-empty "<segment>"'),
    })]);
    expect(analysis.document?.steps).toEqual([expect.objectContaining({ name: "response", type: "http" })]);
  });

  test("does not expose an invalid status modifier as an HTTP action Step", () => {
    const source = fixture("valid/http.status-read.feature").replace(
      "    Then Produce with JSONata",
      '    And HTTP "bad name" accepts statuses\n      | status |\n      | 404    |\n    Then Produce with JSONata',
    );

    const analysis = analyzeOperation({ source, sourceName: "http-invalid-status-name.feature" });

    expect(analysis.diagnostics).toEqual([expect.objectContaining({ code: "unknown-step" })]);
    expect(analysis.document?.steps).toEqual([expect.objectContaining({ name: "response", type: "http" })]);
  });

  test("accepts every registered application HTTP method, including QUERY", () => {
    for (const method of HTTP_METHODS) {
      const source = `# language: en
@trust-dsl:1 @operation:http.method-${method.toLowerCase()} @version:1.0.0
Feature: Send ${method}

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "request" sends "${method}" to Environment "serviceUrl" and reads Text
    Then Produce with JSONata
      """
      { "status": steps.request.status }
      """
`;

      expect(compileOperation({ source, sourceName: `${method}.feature` }).steps[0]).toMatchObject({
        type: "http",
        http: { method },
      });
    }
  });

  test("refuses interim informational statuses as accepted terminal responses", () => {
    const source = fixture("valid/http.status-read.feature").replace(
      "    Then Produce with JSONata",
      "    And HTTP \"response\" accepts statuses\n      | status |\n      | 103    |\n    Then Produce with JSONata",
    );

    expect(() => compileOperation({ source, sourceName: "http.interim-status.feature" }))
      .toThrow(/must be terminal: 101 or an integer from 200 to 599/);
  });

  test("exposes the free-text Feature description without touching the executable contract", () => {
    const source = fixture("valid/git.head-read.described.feature");

    const described = compileOperation({ source, sourceName: "git.head-read.described.feature" });
    const plain = compileOperation({ source: fixture("valid/git.head-read.feature"), sourceName: "git.head-read.feature" });
    const analysis = analyzeOperation({ source, sourceName: "git.head-read.described.feature" });

    expect(described.description).toBe(
      "Reads the checked-out revision of one project below the workspace and tells whether its\nworking tree carries local changes.\n\nExit codes other than 0 interrupt the Operation.",
    );
    expect(plain).not.toHaveProperty("description");
    expect(analysis.document?.description).toBe(described.description);
    const { description: _description, source: _source, ...contract } = described;
    const { source: _plainSource, ...plainContract } = plain;
    expect(contract).toEqual(plainContract);
    expect(() => validateCompiledOperation(JSON.parse(JSON.stringify(described)))).not.toThrow();
  });

  test("keeps free @x-<key>:<value> classification tags out of execution and grouped by key", () => {
    const source = fixture("valid/git.head-read.classified.feature");

    const compiled = compileOperation({ source, sourceName: "git.head-read.classified.feature" });
    const plain = compileOperation({
      source: fixture("valid/git.head-read.feature"),
      sourceName: "git.head-read.feature",
    });

    expect(compiled.classification).toEqual({
      family: ["software-delivery"],
      nature: ["observe"],
      team: ["platform", "sre"],
    });
    expect(plain).not.toHaveProperty("classification");
    const { classification: _classification, source: _source, ...contract } = compiled;
    const { source: _plainSource, ...plainContract } = plain;
    expect(contract).toEqual(plainContract);
    expect(() => validateCompiledOperation(JSON.parse(JSON.stringify(compiled)))).not.toThrow();
  });

  test("rejects a CompiledOperation that differs from its source", () => {
    const compiled = compileOperation({
      source: fixture("valid/git.head-read.feature"),
      sourceName: "git.head-read.feature",
    });

    expect(() => validateCompiledOperation({ ...compiled, contract: "other" }))
      .toThrow(CompiledOperationValidationError);
  });

  test("the error manifest lists every invalid fixture", () => {
    const files = readdirSync(invalidDirectory)
      .filter((name) => name.endsWith(".feature"))
      .sort();

    expect(files).toEqual(invalidCases.map(([file]) => file).sort());
  });

  test.each(invalidCases)("rejects %s with %s", (file, errorCode) => {
    let thrown: unknown;

    try {
      compileOperation({ source: fixture(`invalid/${file}`), sourceName: file });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OperationCompilationError);
    expect(thrown).toMatchObject({ code: errorCode, sourceName: file });
  });
});
