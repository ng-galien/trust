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
      "08-end-to-end-red-green-telemetry.feature",
    ]);

    const catalog = operations();
    for (const file of files) {
      const compiled = compileProcedure({ source: source(file), sourceName: file, operations: catalog });
      expect(compiled.checks.length).toBeGreaterThan(0);
      expect(compiled.operations.length).toBeGreaterThan(0);
      expect(compiled.operations.every((item) => item.definition.operation === item.operation)).toBe(true);
    }
  });

  test("compiles distinct acceptance, library and runtime project paths", () => {
    const compiled = compileProcedure({
      source: source("08-end-to-end-red-green-telemetry.feature"),
      sourceName: "08-end-to-end-red-green-telemetry.feature",
      operations: operations(),
    });

    expect(compiled.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "execution ID",
        cardinality: "one",
        source: { kind: "agent-declaration" },
      }),
      expect.objectContaining({
        name: "trace",
        cardinality: "one",
        parents: [{ role: "runtime project", each: true }],
        source: { kind: "agent-declaration" },
      }),
    ]));
    expect(compiled.checks.find((check) => check.name === "green trace")).toMatchObject({
      operation: "telemetry.project-trace-read",
      target: { role: "runtime project", selection: "each" },
      inputBindings: [
        { input: "project", role: "runtime project", selection: "each" },
        { input: "traceId", role: "trace", selection: "one" },
        { input: "executionId", role: "execution ID", selection: "one" },
      ],
    });
    expect(compiled.checks.find((check) => check.name === "library fix installation")).toMatchObject({
      operation: "maven.change-install",
      target: { role: "library project", selection: "each" },
      materializes: [
        { role: "library fix revision", field: "installedRevision" },
        { role: "installed library dependency", field: "installedDependency" },
      ],
    });
    expect(compiled.checks.find((check) => check.name === "runtime dependency alignment")).toMatchObject({
      operation: "maven.dependency-verify",
      target: { role: "runtime dependency project", selection: "each" },
      inputBindings: [
        { input: "project", role: "runtime dependency project", selection: "each" },
        { input: "dependency", role: "installed library dependency", selection: "one" },
      ],
    });
    expect(compiled.checks.find((check) => check.name === "deployment")).toMatchObject({
      target: { role: "runtime project", selection: "each" },
    });
    expect(compiled.scenarios.find((scenario) => scenario.slug === "runtime-fix-verify")).toMatchObject({
      dependencies: ["dependency-alignment"],
    });
    expect(compiled.checks.find((check) => check.name === "done issue")).toMatchObject({
      operation: "jira.issue-read",
      target: { role: "jira issue", selection: "one" },
    });
    expect(compiled.scenarios.at(-1)).toMatchObject({
      slug: "ticket-done",
      dependencies: ["merge"],
      checks: ["done issue"],
    });
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
      qualification: {
        guards: [{
          conditionLogic: { "===": [{ var: "fact.workingTree" }, "dirty"] },
          failureReasonLogic: "the repository has no local changes",
        }],
      },
    });
  });

  test("compiles optionality only as part of an agent declaration", () => {
    const procedure = source("00-git-status.feature").replace(
      'Given one reference "repository"',
      'Given one reference "repository" declared optionally by agent',
    );
    const compiled = compileProcedure({ source: procedure, operations: operations() });

    expect(compiled.roles.find((role) => role.name === "repository")).toMatchObject({
      name: "repository",
      cardinality: "one",
      source: { kind: "agent-declaration", optional: true },
    });
    expect(compiled.roles.filter((role) => role.name !== "repository").every((role) => (
      role.source.kind !== "agent-declaration" || role.source.optional !== true
    ))).toBe(true);

    expectCompilationError(
      source("00-git-status.feature").replace(
        'Given one reference "repository"',
        'Given one reference "repository" optionally',
      ),
      "invalid-procedure",
    );
    expectCompilationError(
      source("00-git-status.feature").replace(
        'Given one reference "repository"',
        'Given one reference "repository" declared optionally by agent\n    And one string "branch" declared by agent for "repository"',
      ),
      "invalid-procedure",
    );
  });

  test("compiles intent chaining as an optional semantic Procedure rule", () => {
    const procedureSource = source("00-git-status.feature");
    const plain = compileProcedure({ source: procedureSource, operations: operations() });
    const chained = compileProcedure({
      source: procedureSource.replace("@version:2.0.0", "@version:2.0.0 @intent-chaining"),
      operations: operations(),
    });

    expect(plain.intentChaining).toBe(false);
    expect(chained.intentChaining).toBe(true);
    expect(chained.definitionDigest).not.toBe(plain.definitionDigest);
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
      qualification: {
        guards: expect.arrayContaining([
        expect.objectContaining({
          conditionLogic: { ">": [{ var: "fact.admittedAt" }, { var: "checks.consent.signedAt" }] },
          references: expect.arrayContaining([
            expect.objectContaining({ kind: "check", check: "consent", field: "signedAt", valueType: "instant" }),
          ]),
        }),
        ]),
      },
    });
  });

  test("compiles the closed JavaScript expression surface to typed JSON Logic guards", () => {
    const procedure = `# language: en
@trust-dsl:1 @procedure:expression-surface @version:1.0.0
Feature: Exercise the closed qualification expression surface

  Background: Plan context
    Given one reference "project"
    And one reference "baseline revision"
    And many number "limits"
    And one number "threshold"
    And one string "prefix"

  @scenario:surface
  Scenario: Qualify the comparison
    Then Check "surface" runs Operation "git.head-compare"
        on "project" as Input "project"
        using "baseline revision" as Input "baseRevision"
        and must establish "the expression surface is satisfied"
      """js
      (
        Math.min(fact.commitsAhead + 2, Math.max(context.threshold, 1)) >= 1 &&
        Math.abs(-fact.commitsAhead) >= 0 &&
        Math.floor(fact.commitsAhead / 2) <= Math.ceil(fact.commitsAhead / 2) &&
        Math.round(fact.commitsAhead / 2) >= 0 &&
        Math.sqrt(Math.pow(fact.commitsAhead, 2)) >= 0 &&
        fact.commitsAhead % 2 >= 0 &&
        context.limits.length >= 1 &&
        context.limits.includes(context.threshold) &&
        context.limits.some(value => value === context.threshold) &&
        context.limits.every(value => value >= 0) &&
        context.limits.filter(value => value >= 0).length === context.limits.length &&
        context.limits.map(value => value + 1).includes(context.threshold + 1) &&
        context.limits.reduce((total, value) => total + value, 0) >= context.threshold &&
        fact.workingTree.includes("lea") &&
        fact.workingTree.startsWith(context.prefix) &&
        fact.workingTree.endsWith("ean") &&
        fact.workingTree.substring(0, 5).toUpperCase().toLowerCase().trim() === "clean" &&
        fact.headRevision !== context["baseline revision"] &&
        !false &&
        (fact.workingTree === "clean" ? true : false) &&
        [fact.workingTree, "dirty"].includes("clean")
      ) ||
      fail(\`Expression failed for \${fact.workingTree} at \${fact.commitsAhead}\`)
      """
`;
    const compiled = compileProcedure({ source: procedure, sourceName: "expression-surface.feature", operations: operations() });
    const guard = compiled.checks[0]?.qualification.guards[0];
    expect(guard).toBeDefined();
    expect(JSON.stringify(guard?.conditionLogic)).toContain("trust.substring");
    expect(JSON.stringify(guard?.conditionLogic)).toContain("trust.sqrt");
    expect(JSON.stringify(guard?.conditionLogic)).toContain("reduce");
    expect(guard?.failureReasonLogic).toEqual({
      cat: ["Expression failed for ", { var: "fact.workingTree" }, " at ", { var: "fact.commitsAhead" }],
    });
    expect(guard?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "context", role: "limits", valueType: "number", cardinality: "many" }),
      expect.objectContaining({ kind: "context", role: "baseline revision", valueType: "reference", cardinality: "one" }),
    ]));
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
      """js
      fact.commitsAhead >= 1 ||
      fail("the revision is behind")
      """
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
      """js
      fact.project === context.project ||
      fail("another project answered")
      """
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
      source("00-git-status.feature").replace('=== "dirty"', '=== "unknown"'),
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
      """js
      fact.workingTree === "clean" ||
      fail("the project is dirty")
      """

  @scenario:comparison
  Scenario: Compare without a dependency
    Then Check "comparison" runs Operation "git.head-read" on "project" as Input "project" and must establish "the revision matches"
      """js
      fact.headRevision === context["baseline revision"] ||
      fail("the revision does not match")
      """
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
