import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
// The test drives the installed Code Moniker CLI; a machine without it skips the test.
const codeMoniker = await execute("code-moniker", ["--version"]).then(
  () => false,
  (error) => (error.code === "ENOENT" ? "the code-moniker CLI is not installed" : false),
);
const dispatchRule = "authority-call-flow-uses-canonical-dispatch";
const assertionRule = "authority-call-flow-rejects-variant-assertions";

// Exercises the public Code Moniker CLI with the actual project rules. These
// are syntax-policy fixtures, not inferred-type or runtime-behavior tests.
test("Code Moniker rejects ad-hoc dispatch but accepts visitors, predicates and transport routing", {
  skip: codeMoniker,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-canonical-dispatch-"));
  const put = async (relative, source) => {
    const file = path.join(directory, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  };
  const check = async () => {
    let output;
    let exitCode = 0;
    try {
      output = await execute("code-moniker", ["check", ".", "--format", "json", "--report"], {
        cwd: directory,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      assert.equal(error.code, 1, "Only an actual policy rejection is expected");
      output = error;
      exitCode = error.code;
    }
    return { exitCode, result: JSON.parse(output.stdout) };
  };
  try {
    await put(".code-moniker.toml", await readFile(path.join(root, ".code-moniker.toml"), "utf8"));
    await put(
      "packages/trust-runtime/src/http/transport.ts",
      `
export function transport(method: string) {
  switch (method) { case "GET": return "read"; default: return "refuse"; }
}
`,
    );
    const good = `
import { matchOperationStep } from "@trust/operation/match";
export function label(step: OperationStep) {
  return matchOperationStep(step, { shell: () => "command", http: () => "request", "file-read": () => "file", postgresql: () => "SQL" });
}
export function predicate(value: unknown) { if (typeof value === "string") return true; return false; }
export const explanation = "switch (step.type) is forbidden; else if (step.type === 'http') is an example";
// switch (step.type) { default: break; }
`;
    const target = "packages/trust-runner/src/operation/run.ts";
    const tsxTarget = "packages/trust-ui/src/resources/operations/overview-view.tsx";
    await put(target, good);
    await put(tsxTarget, good);
    const accepted = await check();
    assert.equal(accepted.exitCode, 0, JSON.stringify(accepted.result));
    for (const language of ["ts", "tsx"]) {
      const report = accepted.result.rule_report.find((item) => item.rule_id === `${language}.module.${dispatchRule}`);
      assert.ok(report?.antecedent_matches > 0, `${language} scope must not pass vacuously`);
      assert.equal(report.violations, 0);
    }
    for (const [name, source, rule] of [
      [
        "switch",
        `export function bad(step: OperationStep) { switch (step.type) { case "shell": return step.shell; default: return step.file; } }`,
        dispatchRule,
      ],
      [
        "else-if",
        `export function bad(step: OperationStep) { if (step.type === "shell") return step.shell; else if (step.type === "http") return step.http; else return step.file; }`,
        dispatchRule,
      ],
      [
        "ternary",
        `export function bad(step: OperationStep) { return step.type === "shell" ? step.shell : step.file; }`,
        dispatchRule,
      ],
      [
        "early-return",
        `export function bad(step: OperationStep) { if (step.type === "shell") return step.shell; return step.file; }`,
        dispatchRule,
      ],
      [
        "subscript",
        `export function bad(step: OperationStep) { if (step["type"] === "shell") return step.shell; return step.file; }`,
        dispatchRule,
      ],
      ["assertion", `export function bad(step: OperationStep) { return step as ShellStep; }`, assertionRule],
      [
        "destructure",
        `export function bad(step: OperationStep) { const { type: tag } = step; return tag === "shell" ? step.shell : step.file; }`,
        "authority-call-flow-keeps-discriminants-in-matchers",
      ],
      [
        "extract",
        `export function bad(step: OperationStep) { const tag = step.type; return tag === "shell" ? step.shell : step.file; }`,
        "authority-call-flow-keeps-discriminants-in-matchers",
      ],
    ]) {
      for (const [file, language] of [
        [target, "ts"],
        [tsxTarget, "tsx"],
      ]) {
        await put(file, source);
        const rejected = await check();
        assert.equal(rejected.exitCode, 1, `${language} ${name} must fail`);
        assert.ok(
          rejected.result.summary.failed_rules.some((item) => item.rule_id === `${language}.module.${rule}`),
          JSON.stringify(rejected.result),
        );
        await put(file, good);
      }
    }
    const discovered = "packages/trust-ui/src/new-consumer.ts";
    for (const [description, source] of [
      [
        "renamed import",
        `import type { OperationStep as Step } from "@trust/operation"; export function bad(step: Step) { if (step.type === "shell") return step.shell; return step.file; }`,
      ],
      [
        "local alias",
        `import type { OperationStep } from "@trust/operation"; type Local = OperationStep; export function bad(step: Local) { return step.type === "shell" ? step.shell : step.file; }`,
      ],
    ]) {
      await put(discovered, source);
      const rejected = await check();
      assert.equal(rejected.exitCode, 1, `${description} must be discovered by its canonical import`);
      const extracted = JSON.parse(
        (
          await execute("code-moniker", ["extract", discovered, "--kind", "imports_symbol", "--format", "json"], {
            cwd: directory,
          })
        ).stdout,
      );
      assert.ok(
        extracted.matches.refs.some((ref) => ref.target.endsWith("/path:OperationStep")),
        description,
      );
    }
    // The local import still targets PublicStep, but the forbidden upstream relay
    // is rejected independently. Renaming an export does not evade the boundary.
    await put(
      "packages/trust-ui/src/contracts.ts",
      `export type { OperationStep as PublicStep } from "@trust/operation";`,
    );
    await put(
      discovered,
      `import type { PublicStep } from "./contracts"; export function bad(step: PublicStep) { return step.type === "shell" ? step.shell : step.file; }`,
    );
    const reexport = JSON.parse(
      (
        await execute("code-moniker", ["extract", discovered, "--kind", "imports_symbol", "--format", "json"], {
          cwd: directory,
        })
      ).stdout,
    );
    assert.ok(reexport.matches.refs.some((ref) => ref.target.endsWith("/path:PublicStep")));
    const relay = await check();
    assert.equal(relay.exitCode, 1);
    assert.ok(
      relay.result.summary.failed_rules.some(
        (item) => item.rule_id === "refs.authority-dependency-excludes-consumer-contract-relays",
      ),
    );
    await put(discovered, "export const safe = true;");
    await put("packages/trust-ui/src/contracts.ts", "export const unrelated = true;");
    await put("packages/trust-operation/src/operation.ts", "export interface OperationStep { type: string }");
    await put("packages/trust-operation/src/index.ts", `export type { OperationStep } from "./operation";`);
    assert.equal((await check()).exitCode, 0, "Canonical package facade remains valid");
    for (const source of [
      `export type { OperationStep } from "@trust/operation";`,
      `export type { OperationStep as Step } from "@trust/operation";`,
      `export * from "@trust/extension-sdk";`,
    ]) {
      await put("packages/trust-ui/src/contracts.ts", source);
      const rejected = await check();
      assert.equal(rejected.exitCode, 1);
      assert.ok(
        rejected.result.summary.failed_rules.some(
          (item) => item.rule_id === "refs.authority-dependency-excludes-consumer-contract-relays",
        ),
      );
    }
    await put("packages/trust-ui/src/contracts.ts", "export const unrelated = true;");
    await put(
      discovered,
      `import { matchOperationStep as visit } from "@trust/operation"; export const render = visit;`,
    );
    const rootMatcher = await check();
    assert.equal(rootMatcher.exitCode, 1);
    assert.ok(
      rootMatcher.result.summary.failed_rules.some(
        (item) => item.rule_id === "refs.authority-dependency-uses-matcher-subpath",
      ),
    );
    await put(
      discovered,
      `import { matchOperationStep as visit } from "@trust/operation/match"; export const render = visit;`,
    );
    assert.equal((await check()).exitCode, 0, "Aliased matcher import from public subpath remains valid");
    await put(
      discovered,
      `import { matchMissionDefinition } from "@trust/extension-sdk"; export const visit = matchMissionDefinition;`,
    );
    const sdkRootMatcher = await check();
    assert.equal(sdkRootMatcher.exitCode, 1);
    assert.ok(
      sdkRootMatcher.result.summary.failed_rules.some(
        (item) => item.rule_id === "refs.authority-dependency-uses-matcher-subpath",
      ),
    );
    await put(
      discovered,
      `import { matchMissionDefinition } from "@trust/extension-sdk/match"; export const visit = matchMissionDefinition;`,
    );
    assert.equal((await check()).exitCode, 0, "SDK matcher subpath is sanctioned");
    await put(
      discovered,
      `import type { MissionDefinition as Definition } from "@trust/extension-sdk"; export function bad(value: Definition) { return value.kind === "published"; }`,
    );
    const sdkDispatch = await check();
    assert.equal(sdkDispatch.exitCode, 1);
    assert.ok(sdkDispatch.result.summary.failed_rules.some((item) => item.rule_id === `ts.module.${dispatchRule}`));
    await put(
      discovered,
      `import type { MissionDefinition } from "@trust/extension-sdk"; export function sameSource(value: {procedure:{source:string}}, source: string) { return value.procedure.source === source; }`,
    );
    assert.equal((await check()).exitCode, 0, "Authored Procedure source is not a MissionDefinition discriminant");
    for (const extension of ["ts", "tsx"]) {
      const roleConsumer = `packages/trust-ui/src/role-consumer.${extension}`;
      for (const access of ["value.source", 'value["source"]']) {
        await put(
          roleConsumer,
          `import type { CompiledProcedureRole as Role } from "@trust/procedure"; export function bad(value: Role) { return ${access} === "root"; }`,
        );
        const roleDispatch = await check();
        assert.equal(roleDispatch.exitCode, 1, "Role source comparisons must use their canonical matcher");
        assert.ok(
          roleDispatch.result.summary.failed_rules.some(
            (item) => item.rule_id === `${extension}.module.${dispatchRule}`,
          ),
        );
      }
      await put(roleConsumer, "export const safe = true;");
    }
    await put(discovered, "export const safe = true;");
    await put(
      "packages/trust-runtime/src/plan/mission-declarations.ts",
      `import type { MissionDefinition } from "@trust/extension-sdk"; export function parse(value: any): MissionDefinition | undefined { if (value.kind === "published") return {kind:"published",reference:"example@1.0.0"}; return undefined; }`,
    );
    assert.equal((await check()).exitCode, 0, "Mission JSON validation remains a separate boundary");
    for (const module of ["template-source-editor", "template-renderer"]) {
      const editor = `packages/trust-ui/src/resources/templates/${module}.tsx`;
      for (const behavior of [
        "scanTemplatePlaceholders",
        "validateTemplateParameters",
        "validateTemplateDefinition",
        "materializeTemplate",
      ]) {
        await put(editor, `import { ${behavior} } from "@trust/extension-sdk"; export const forbidden = ${behavior};`);
        const rejected = await check();
        assert.equal(rejected.exitCode, 1, `${module} must not become a template semantic authority`);
        assert.ok(
          rejected.result.summary.failed_rules.some(
            (item) =>
              item.rule_id === "refs.editor-dependency-on-authority-language-behavior-goes-through-language-server",
          ),
          JSON.stringify(rejected.result),
        );
      }
      await put(
        editor,
        `import type { TemplateParameter } from "@trust/extension-sdk"; export const parameters: TemplateParameter[] = [];`,
      );
      assert.equal((await check()).exitCode, 0, "Template editor may transport canonical contracts");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
