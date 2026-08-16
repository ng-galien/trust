import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { compileOperation, type CompiledOperation } from "@trust/operation";
import { compileProcedure } from "@trust/procedure";
import { runOperation } from "@trust/runner";
import { afterEach, describe, expect, test } from "vitest";

const execute = promisify(execFile);
const operationCatalog = new URL("../../../assets/operations/", import.meta.url);
const procedureCatalog = new URL("../../../assets/procedures/", import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Compiled Procedure runner boundary", () => {
  test("executes the exact Git Operation embedded by the minimal Procedure", async () => {
    const compiled = compileProcedure({
      source: readFileSync(new URL("00-git-status.feature", procedureCatalog), "utf8"),
      sourceName: "00-git-status.feature",
      operations: operations(),
    });
    const check = compiled.checks[0];
    const operation = compiled.operations[0];
    expect(check?.operationDigest).toBe(operation?.digest);
    if (!operation) throw new Error("The Procedure did not embed its Operation");

    const projectsRoot = await mkdtemp(join(tmpdir(), "trust-procedure-runner-"));
    temporaryDirectories.push(projectsRoot);
    const workspaceRoot = join(projectsRoot, "trust-example");
    await mkdir(workspaceRoot);
    await execute("git", ["init", "-q"], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, "tracked.txt"), "baseline\n", "utf8");
    await execute("git", ["add", "tracked.txt"], { cwd: workspaceRoot });
    await execute("git", [
      "-c", "user.name=TRUST Acceptance",
      "-c", "user.email=trust@example.invalid",
      "commit", "-qm", "baseline",
    ], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, "untracked.txt"), "dirty\n", "utf8");

    const result = await runOperation(
      operation.definition,
      { project: "trust-example" },
      { workspaceRoot: projectsRoot },
    );

    expect(result.produced.workingTree).toBe("dirty");
    expect(check?.predicates).toContainEqual(expect.objectContaining({
      field: "workingTree",
      expectation: { kind: "value", value: "dirty" },
    }));
  });
});

function operations(): CompiledOperation[] {
  return readdirSync(operationCatalog)
    .filter((file) => file.endsWith(".feature"))
    .sort()
    .map((file) => compileOperation({
      source: readFileSync(new URL(file, operationCatalog), "utf8"),
      sourceName: file,
    }));
}
