import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CompiledProcedure } from "@trust/procedure";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const invocation = (
  name: string,
  child: string,
  version = "1.0.0",
  binding = 'on "repository" as Input "repository"',
) =>
  `Then Invocation "${name}" runs Procedure "${child}@${version}" ${binding} and must establish "the child Plan is complete"`;
function composed(name: string, steps: string, roles = 'one reference "repository"'): string {
  return `@trust-dsl:1 @procedure:${name} @version:1.0.0
Feature: Compose ${name}
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the declared repositories. | Alter unrelated repositories. |
    And ${roles}
  @scenario:children
  Scenario: Complete children
    ${steps}
`;
}

test("public compilation pins child versions, preserves finite nesting and rejects invalid bindings", async () => {
  const runtime = await startPublicRuntime("trust-child-compiler-", {
    operationsDirectory: path.join(root, "assets/operations"),
  });
  const rpc = async (method: string, source: string, failure?: RegExp): Promise<CompiledProcedure> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params: { source } }),
    });
    const body = (await response.json()) as {
      result?: CompiledProcedure | { procedure: CompiledProcedure };
      error?: unknown;
    };
    if (failure) {
      assert.match(JSON.stringify(body.error), failure);
      return undefined as never;
    }
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    const result = body.result!;
    return typeof result.procedure === "string" ? (result as CompiledProcedure) : result.procedure;
  };
  try {
    const leafSource = await readFile(path.join(root, "assets/procedures/00-git-status.feature"), "utf8");
    const leaf = await rpc("procedure.publish", leafSource);
    assert.equal(leaf.invocations.length, 0);
    const first = await rpc("procedure.publish", composed("first-level", invocation("first", "git-status", "2.0.0")));
    const second = await rpc("procedure.publish", composed("second-level", invocation("second", "first-level")));
    const third = await rpc("procedure.publish", composed("third-level", invocation("third", "second-level")));
    const fourth = await rpc("procedure.publish", composed("fourth-level", invocation("fourth", "third-level")));
    assert.equal(
      third.invocations[0]!.childDefinition.invocations[0]!.childDefinition.invocations[0]!.childDefinition
        .definitionDigest,
      leaf.definitionDigest,
    );
    assert.equal(fourth.invocations[0]!.childDefinition.definitionDigest, third.definitionDigest);
    assert.equal(second.invocations[0]!.procedureDigest, first.definitionDigest);
    const twice = await rpc(
      "procedure.compile",
      composed("twice", `${invocation("left", "first-level")}\n    ${invocation("right", "first-level")}`),
    );
    assert.deepEqual(twice.scenarios[0]!.invocations, ["left", "right"]);
    assert.equal(twice.checks.length, 0);
    assert.equal(twice.invocations[0]!.procedureDigest, twice.invocations[1]!.procedureDigest);
    const each = await rpc(
      "procedure.compile",
      composed(
        "each-child",
        invocation("each", "git-status", "2.0.0", 'on each "repositories" as Input "repository"'),
        'many reference "repositories"',
      ),
    );
    assert.equal(each.invocations[0]!.target?.selection, "each");
    await rpc("procedure.compile", composed("unknown", invocation("child", "missing")), /published Procedure/);
    await rpc(
      "procedure.compile",
      composed("unknown-version", invocation("child", "git-status", "99.0.0")),
      /published Procedure/,
    );
    await rpc(
      "procedure.compile",
      composed("floating", invocation("child", "git-status", "latest")),
      /name@SemVer-selector/,
    );
    await rpc(
      "procedure.compile",
      composed("duplicate", `${invocation("same", "first-level")}\n    ${invocation("same", "first-level")}`),
      /unique name/,
    );
    await rpc(
      "procedure.compile",
      composed("wrong-type", invocation("child", "first-level"), 'one number "repository"'),
      /incompatible types/,
    );
    await rpc(
      "procedure.compile",
      composed("wrong-cardinality", invocation("child", "first-level"), 'many reference "repository"'),
      /unscoped value/,
    );
    await rpc(
      "procedure.compile",
      composed(
        "extra-input",
        invocation(
          "child",
          "first-level",
          "1.0.0",
          'on "repository" as Input "repository" using "repository" as Input "extra"',
        ),
      ),
      /no root Input/,
    );
    await rpc(
      "procedure.compile",
      composed(
        "duplicate-input",
        invocation(
          "child",
          "first-level",
          "1.0.0",
          'on "repository" as Input "repository" using "repository" as Input "repository"',
        ),
      ),
      /repeats Input/,
    );
    await rpc("procedure.compile", composed("self-cycle", invocation("self", "self-cycle")), /cycle/);
    await rpc(
      "procedure.compile",
      composed("git-status", invocation("cycle", "fourth-level")).replace("@version:1.0.0", "@version:2.0.0"),
      /cycle/,
    );
    const manyLeaf = leafSource
      .replace("@procedure:git-status", "@procedure:many-leaf")
      .replace('one reference "repository"', 'many reference "repository"')
      .replace('on "repository"', 'on each "repository"');
    await rpc("procedure.publish", manyLeaf);
    const all = await rpc(
      "procedure.compile",
      composed(
        "all-child",
        invocation("all repositories", "many-leaf", "2.0.0", 'on all "repositories" as Input "repository"'),
        'many reference "repositories"',
      ),
    );
    assert.equal(all.invocations[0]!.target?.selection, "all");
    await rpc(
      "procedure.publish",
      leafSource
        .replace("@procedure:git-status", "@procedure:no-input")
        .replace('Given one reference "repository"', 'Given one reference "repository" fixed as "trust"'),
    );
    const noInput = await rpc(
      "procedure.compile",
      composed("no-input-parent", invocation("child", "no-input", "2.0.0", "")),
    );
    assert.equal(noInput.invocations[0]!.target, undefined);
    assert.deepEqual(noInput.invocations[0]!.inputBindings, []);
    await rpc(
      "procedure.compile",
      composed("missing-all-inputs", invocation("child", "first-level", "1.0.0", "")),
      /does not bind Input/,
    );
    await rpc(
      "procedure.publish",
      leafSource
        .replace("@procedure:git-status", "@procedure:two-inputs")
        .replace(
          'Given one reference "repository"',
          'Given one reference "repository"\n    And one string "description"',
        ),
    );
    await rpc(
      "procedure.compile",
      composed("missing-input", invocation("child", "two-inputs", "2.0.0")),
      /does not bind Input: description/,
    );
    await rpc(
      "procedure.publish",
      leafSource
        .replace("@procedure:git-status", "@procedure:parent-reference")
        .replace(
          'Given one reference "repository"',
          'Given one reference "repository"\n    And one reference "parent"',
        ),
    );
    const parentReference = await rpc(
      "procedure.compile",
      composed(
        "parent-reference-call",
        invocation(
          "child",
          "parent-reference",
          "2.0.0",
          'on "repository" as Input "repository" using plan as Input "parent"',
        ),
      ),
    );
    assert.deepEqual(parentReference.invocations[0]!.inputBindings[1], {
      input: "parent",
      role: "plan",
      selection: "one",
    });
    await rpc(
      "procedure.publish",
      leafSource
        .replace("@procedure:git-status", "@procedure:topology-inputs")
        .replace(
          'Given one reference "repository"',
          'Given one reference "repository"\n    And one string "description" for "repository"',
        ),
    );
    await rpc(
      "procedure.compile",
      composed("unsupported-topology", invocation("child", "topology-inputs", "2.0.0")),
      /parent topology/,
    );
    await rpc(
      "procedure.compile",
      composed("result-export", `${invocation("child", "first-level")}\n      """js\n      true\n      """`),
      /Result exports/,
    );
    await rpc(
      "procedure.publish",
      leafSource.replace('fact.workingTree === "dirty"', 'fact.workingTree === "clean"'),
      /immutable definition/,
    );
    const pinned = await rpc("procedure.compile", composed("pinned", invocation("child", "first-level")));
    assert.equal(pinned.invocations[0]!.childDefinition.invocations[0]!.procedureDigest, leaf.definitionDigest);
  } finally {
    await runtime.close();
  }
});
