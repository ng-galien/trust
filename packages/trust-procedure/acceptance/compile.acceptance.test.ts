import { readFileSync, readdirSync } from "node:fs";

import { compileAutonomousProcedureDefinition } from "@trust/procedure";
import { describe, expect, test } from "vitest";

const gitStatusProcedure = readFileSync(
  new URL("../../../assets/procedures/00-git-status.feature", import.meta.url),
  "utf8",
);

describe("Procedure compiler", () => {
  test("compiles every Procedure in the product catalog", () => {
    const catalog = new URL("../../../assets/procedures/", import.meta.url);
    const files = readdirSync(catalog).filter((file) => file.endsWith(".feature")).sort();

    expect(files).toEqual([
      "00-git-status.feature",
      "01-defect-correction-multi-project.feature",
      "02-end-to-end-red-green.feature",
      "03-end-to-end-green.feature",
    ]);
    for (const file of files) {
      const compiled = compileAutonomousProcedureDefinition({
        source: readFileSync(new URL(file, catalog), "utf8"),
        sourceName: file,
      });
      expect(compiled.procedure).toBeTruthy();
      expect(compiled.checkTemplates.length).toBeGreaterThan(0);
    }
  });

  test("keeps clause words inside a quoted role name", () => {
    const role = "repository and materializes output";
    const source = gitStatusProcedure
      .replace('    And one "repository"', `    And one "${role}"`)
      .replace('on "repository" as input "repository"', `on "${role}" as input "repository"`);

    const compiled = compileAutonomousProcedureDefinition({
      source,
      sourceName: "quoted-clause-role.feature",
    });

    expect(compiled.roles.some((candidate) => candidate.name === role)).toBe(true);
    expect(compiled.checkTemplates[0]?.inputBindings).toEqual([
      { input: "repository", role, selection: "one" },
    ]);
    expect(compiled.checkTemplates[0]?.materializes).toEqual([]);
  });
});
