import { readFileSync, readdirSync } from "node:fs";

import {
  analyzeOperation,
  compileOperation,
  CompiledOperationValidationError,
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
          end: { line: 14, column: 61 },
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
