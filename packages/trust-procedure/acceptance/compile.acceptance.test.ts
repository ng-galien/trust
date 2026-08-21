import { readFileSync, readdirSync } from "node:fs";

import { compileOperation, type CompiledOperation } from "@trust/operation";
import {
  CatalogProcedureCompilationError,
  compileProcedure,
  type ProcedureCompilationErrorCode,
} from "@trust/procedure";
import { describe, expect, test } from "vitest";

const operationCatalog = new URL("../../../assets/operations/", import.meta.url);
const procedureCatalog = new URL("../../../assets/procedures/", import.meta.url);

function operations(): CompiledOperation[] {
  return readdirSync(operationCatalog)
    .filter((file) => file.endsWith(".feature"))
    .sort()
    .map((file) => compileOperation({
      source: readFileSync(new URL(file, operationCatalog), "utf8"),
      sourceName: file,
    }));
}

function source(file: string): string {
  return readFileSync(new URL(file, procedureCatalog), "utf8");
}

describe("Procedure compiler", () => {
  test("compiles the complete software and professional Procedure catalog", () => {
    const files = readdirSync(procedureCatalog).filter((file) => file.endsWith(".feature")).sort();

    expect(files).toEqual([
      "00-git-status.feature",
      "01-mono-project-change.feature",
      "02-integration-test.feature",
      "03-playwright-ui-test.feature",
      "04-end-to-end-red-green.feature",
      "05-patient-admission.feature",
      "06-aircraft-departure.feature",
      "07-food-batch-release.feature",
    ]);

    const catalog = operations();
    for (const file of files) {
      const compiled = compileProcedure({ source: source(file), sourceName: file, operations: catalog });
      expect(compiled.contract).toBe("trust.compiled-procedure@3");
      expect(compiled.checks.length).toBeGreaterThan(0);
      expect(compiled.operations.length).toBeGreaterThan(0);
      expect(compiled.operations.every((item) => item.definition.operation === item.operation)).toBe(true);
    }
  });

  test("incorporates only the exact Operations used by one Procedure", () => {
    const compiled = compileProcedure({
      source: source("00-git-status.feature"),
      sourceName: "00-git-status.feature",
      operations: operations(),
    });

    expect(compiled.operations.map((item) => item.operation)).toEqual(["git.head-read"]);
    expect(compiled.checks[0]).toMatchObject({
      operation: "git.head-read",
      inputBindings: [{ input: "project", role: "repository", selection: "one" }],
      predicates: [{ field: "workingTree", expectation: { kind: "value", value: "dirty" } }],
    });
  });

  test("keeps source presentation outside semantic identity", () => {
    const catalog = operations();
    const procedureSource = source("00-git-status.feature");
    const baseline = compileProcedure({ source: procedureSource, operations: catalog });
    const formattedCatalog = catalog.map((operation) => operation.operation === "git.head-read"
      ? compileOperation({ source: `# editorial comment\n${operation.source}` })
      : operation);
    const formatted = compileProcedure({
      source: `# editorial comment\n${procedureSource}`,
      operations: formattedCatalog,
    });

    expect(formatted.operations[0]?.definition.source).not.toBe(baseline.operations[0]?.definition.source);
    expect(formatted.operations[0]?.digest).toBe(baseline.operations[0]?.digest);
    expect(formatted.definitionDigest).toBe(baseline.definitionDigest);
  });

  test("keeps JSONata presentation outside Operation identity", () => {
    const catalog = operations();
    const baseline = compileProcedure({ source: source("00-git-status.feature"), operations: catalog });
    const formattedCatalog = catalog.map((operation) => operation.operation === "git.head-read"
      ? compileOperation({ source: operation.source.replace(
          "$trim(steps.head.stdout)",
          "$trim( steps.head.stdout )",
        ) })
      : operation);
    const formatted = compileProcedure({
      source: source("00-git-status.feature"),
      operations: formattedCatalog,
    });

    expect(formatted.operations[0]?.digest).toBe(baseline.operations[0]?.digest);
    expect(formatted.definitionDigest).toBe(baseline.definitionDigest);
  });

  test("compiles a correlated document collection and a temporal comparison between Checks", () => {
    const compiled = compileProcedure({
      source: source("05-patient-admission.feature"),
      sourceName: "05-patient-admission.feature",
      operations: operations(),
    });

    expect(compiled.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "required document",
        cardinality: "many",
        parents: [{ role: "admission", each: false }],
        source: { kind: "agent-declaration" },
      }),
      expect.objectContaining({
        name: "document record time",
        type: "instant",
        cardinality: "many",
        parents: [{ role: "required document", each: true }],
        source: { kind: "operation-field", check: "document", field: "recordedAt" },
      }),
    ]));
    expect(compiled.checks.find((check) => check.name === "admission")).toMatchObject({
      inputBindings: expect.arrayContaining([
        { input: "documents", role: "required document", selection: "all" },
        { input: "documentRecordedAt", role: "document record time", selection: "all" },
      ]),
      predicates: expect.arrayContaining([
        expect.objectContaining({
          field: "admittedAt",
          relation: "after",
          expectation: { kind: "check-field", check: "consent", field: "signedAt" },
        }),
      ]),
    });
  });

  test("binds the Plan identifier to one string Input with using plan through the synthesised plan role", () => {
    const procedure = `# language: en
@trust-dsl:1 @procedure:plan-identifier @version:1.0.0
Feature: Pass the Plan identifier to an Operation

  Background: Plan context
    Given one reference "project"
    And one reference "baseline revision"

  @scenario:comparison
  Scenario: Compare with the baseline, tagged with the Plan
    Then Check "comparison" runs Operation "git.head-compare" on "project" as Input "project" using plan as Input "baseRevision" and must establish "the revision is ahead"
      | field        | relation | expectation | failure reason           |
      | commitsAhead | at least | number 1    | "the revision is behind" |
    And the Scenario is satisfied when every Check is validated
`;

    const compiled = compileProcedure({ source: procedure, sourceName: "plan-identifier.feature", operations: operations() });

    expect(compiled.checks[0]?.inputBindings).toEqual([
      { input: "project", role: "project", selection: "one" },
      { input: "baseRevision", role: "plan", selection: "one" },
    ]);
    expect(compiled.roles.map((role) => role.name)).toEqual(["project", "baseline revision", "plan"]);
    expect(compiled.roles.find((role) => role.name === "plan")).toEqual({
      name: "plan",
      type: "string",
      cardinality: "one",
      parents: [],
      source: { kind: "plan-identifier" },
    });
  });

  test("refuses a declared role named plan", () => {
    expectCompilationError(
      source("05-patient-admission.feature").replace('Given one reference "patient"', 'Given one reference "plan"'),
      "invalid-procedure",
    );
  });

  test("rejects using plan on a collection or non-string Input", () => {
    const admission = source("05-patient-admission.feature");
    expectCompilationError(
      admission.replace('using all "required document" as Input "documents"', 'using plan as Input "documents"'),
      "incompatible-cardinality",
    );
    const counting = compileOperation({
      sourceName: "shell.count-read.feature",
      source: `# language: en
@trust-dsl:1 @operation:shell.count-read @version:1.0.0
Feature: Echo one project and one count

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input   | type      | cardinality |
      | project | reference | one         |
      | count   | number    | one         |
    And Produced fields
      | field   | type      | cardinality | domain |
      | project | reference | one         | any    |

  Scenario: Run
    When Shell "echo" runs "true" with cwd from Environment "workspaceRoot" and Input "project"
      | argument |
    Then Produce with JSONata
      """
      { "project": input.project }
      """
`,
    });
    let thrown: unknown;
    try {
      compileProcedure({
        sourceName: "invalid.feature",
        operations: [counting],
        source: `# language: en
@trust-dsl:1 @procedure:plan-as-number @version:1.0.0
Feature: Bind the Plan identifier to a number Input

  Background: Plan context
    Given one reference "project"

  @scenario:count
  Scenario: Count
    Then Check "count" runs Operation "shell.count-read" on "project" as Input "project" using plan as Input "count" and must establish "the project is echoed"
      | field   | relation | expectation       | failure reason             |
      | project | equals   | context "project" | "another project answered" |
    And the Scenario is satisfied when every Check is validated
`,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CatalogProcedureCompilationError);
    expect((thrown as CatalogProcedureCompilationError).code).toBe("incompatible-type");
  });

  const invalidCases: readonly {
    readonly name: string;
    readonly change: (value: string) => string;
    readonly code: ProcedureCompilationErrorCode;
  }[] = [
    {
      name: "unknown Operation",
      change: (value: string) => value.replace('Operation "git.head-read"', 'Operation "git.unknown"'),
      code: "unknown-operation",
    },
    {
      name: "unknown Input",
      change: (value: string) => value.replace('Input "project"', 'Input "unknown"'),
      code: "unknown-input",
    },
    {
      name: "unknown produced field",
      change: (value: string) => value.replace("workingTree", "unknownField"),
      code: "unknown-field",
    },
    {
      name: "unknown context role",
      change: (value: string) => value.replace('on "repository"', 'on "unknown role"'),
      code: "unknown-role",
    },
  ];

  test.each(invalidCases)("rejects $name", ({ change, code }) => {
    expectCompilationError(change(source("00-git-status.feature")), code);
  });

  test("rejects a value outside the produced field domain", () => {
    expectCompilationError(
      source("00-git-status.feature").replace('value "dirty"', 'value "unknown"'),
      "incompatible-type",
    );
  });

  test("rejects an Input binding with another role type", () => {
    expectCompilationError(
      source("00-git-status.feature").replace('one reference "repository"', 'one number "repository"'),
      "incompatible-type",
    );
  });

  test("rejects a materialized role used before its provider Scenario is validated", () => {
    expectCompilationError(
      source("01-mono-project-change.feature").replace('    Given scenario "fix" is validated\n', ""),
      "invalid-dependency",
    );
  });

  test("rejects a materialized role compared before its provider Scenario is validated", () => {
    const procedure = `# language: en
@trust-dsl:1 @procedure:invalid-context-order @version:1.0.0
Feature: Compare a role before its provider Scenario

  Background: Plan context
    Given one reference "project"
    And one reference "baseline revision" for "project"

  @scenario:baseline
  Scenario: Read the baseline
    Then Check "baseline" runs Operation "git.head-read" on "project" as Input "project" and materializes "baseline revision" from field "headRevision" and must establish "the baseline exists"
      | field       | relation | expectation   | failure reason          |
      | workingTree | equals   | value "clean" | "the project is dirty" |
    And the Scenario is satisfied when every Check is validated

  @scenario:comparison
  Scenario: Compare without a dependency
    Then Check "comparison" runs Operation "git.head-read" on "project" as Input "project" and must establish "the revision matches"
      | field        | relation | expectation                 | failure reason                |
      | headRevision | equals   | context "baseline revision" | "the revision does not match" |
    And the Scenario is satisfied when every Check is validated
`;

    expectCompilationError(procedure, "invalid-dependency");
  });

  test("rejects fixed roles whose type or cardinality cannot be represented by one literal", () => {
    expectCompilationError(
      source("04-end-to-end-red-green.feature").replace(
        'one reference "acceptance project" fixed as "payment-acceptance"',
        'many reference "acceptance project" fixed as "payment-acceptance"',
      ),
      "incompatible-cardinality",
    );
    expectCompilationError(
      source("04-end-to-end-red-green.feature").replace(
        'one reference "acceptance project" fixed as "payment-acceptance"',
        'one instant "acceptance project" fixed as "payment-acceptance"',
      ),
      "incompatible-type",
    );
  });

  test("rejects a supplied Operation that differs from its own source", () => {
    const catalog = operations();
    const git = catalog.find((operation) => operation.operation === "git.head-read");
    if (!git) throw new Error("Missing git.head-read Operation");

    let thrown: unknown;
    try {
      compileProcedure({
        source: source("00-git-status.feature"),
        operations: catalog.map((operation) => operation === git
          ? { ...operation, title: "Altered compiled Operation" }
          : operation),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CatalogProcedureCompilationError);
    expect((thrown as CatalogProcedureCompilationError).code).toBe("invalid-procedure");
  });
});

function expectCompilationError(sourceValue: string, code: ProcedureCompilationErrorCode): void {
  let thrown: unknown;
  try {
    compileProcedure({
      source: sourceValue,
      sourceName: "invalid.feature",
      operations: operations(),
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CatalogProcedureCompilationError);
  expect((thrown as CatalogProcedureCompilationError).code).toBe(code);
}
