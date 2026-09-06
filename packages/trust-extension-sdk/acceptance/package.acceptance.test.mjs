import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("packaged public contracts compile an isolated extension without the runtime", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-sdk-"));
  try {
    // Consume only published package contents, outside workspace module resolution.
    for (const [name, source] of [
      ["@trust/extension-sdk", "packages/trust-extension-sdk"],
      ["@trust/operation", "packages/trust-operation"],
      ["@trust/procedure", "packages/trust-procedure"],
      ["@trust/gherkin", "packages/trust-gherkin"],
      ["@cucumber/messages", "node_modules/@cucumber/messages"],
    ]) {
      const output = execFileSync(
        "npm",
        [
          "pack",
          path.join(root, source),
          "--cache",
          path.join(directory, "cache"),
          "--workspaces=false",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          directory,
        ],
        { cwd: directory, encoding: "utf8" },
      );
      const packed = JSON.parse(output);
      const entry = Array.isArray(packed) ? packed[0] : packed[name];
      assert.ok(entry?.filename, `Package archive missing for ${name}: ${output}`);
      const archive = entry.filename;
      const target = path.join(directory, "node_modules", name);
      await mkdir(target, { recursive: true });
      execFileSync("tar", ["-xzf", path.join(directory, archive), "--strip-components=1", "-C", target]);
    }
    await assert.rejects(access(path.join(directory, "node_modules/@trust/runtime")));
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
    const guide = await readFile(path.join(root, "packages/trust-extension-sdk/README.md"), "utf8");
    const examples = Array.from(guide.matchAll(/^```typescript\n([\s\S]*?)^```/gm), (match) => match[1]);
    assert.ok(examples.length > 0, "The minimal SDK guide must supply its compilable example");
    const exampleFiles = examples.map((_, index) => `documented-example-${index}.ts`);
    for (const [index, source] of examples.entries())
      await writeFile(path.join(directory, exampleFiles[index]), source);
    await writeFile(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "NodeNext",
          target: "ES2023",
          types: [],
          skipLibCheck: false,
        },
        files: ["extension.ts", ...exampleFiles],
      }),
    );
    await writeFile(
      path.join(directory, "extension.ts"),
      `
import type { ExtensionFactory, ExtensionPageProps, PlanView, PlanSummaryView, CheckAttemptAdmissionResult, CheckFinalizationResult, PlanEvent } from "@trust/extension-sdk";
export const createExtension: ExtensionFactory = ({ publishChanged }) => ({
  async prepare() {}, async start() { publishChanged(); }, async stop() {}, async read(input) { return input; }
});
export function page(props: ExtensionPageProps, plan: PlanView, summary: PlanSummaryView, admission: CheckAttemptAdmissionResult, result: CheckFinalizationResult, event: PlanEvent) {
  props.navigation?.navigate(props.navigation.planHref(plan.plan, plan.mode));
  const parent = plan.parent === null ? "root" : plan.parent.plan;
  return [parent, summary.checkCount, admission.status, result.next.action, event.type];
}
`,
    );
    execFileSync(
      process.execPath,
      [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(directory, "tsconfig.json")],
      { cwd: directory, stdio: "pipe" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
