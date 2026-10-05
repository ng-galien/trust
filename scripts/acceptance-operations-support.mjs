// Disposable public boundary shared by the acceptance tests of the acceptance.* Operation drafts: a real runtime
// process, a temporary workspace holding the fixed helper, and the packaged Runner.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startPublicRuntime } from "../packages/trust-runtime/dist/acceptance/support/runtime-process.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);

export const SCOPE = `    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe a disposable workspace. | Claim anything about another workspace. |`;

/**
 * Starts a runtime whose "local" Environment is a new workspace holding the `helpers` (names below scripts/) and
 * saves the `operations` (source paths below assets/operations/) in that disposable runtime only.
 */
export async function startWorkspace(prefix, { helpers, operations }) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TRUST_")));
  await mkdir(path.join(directory, "operations"));
  await mkdir(path.join(directory, "workspace/scripts"), { recursive: true });
  const workspace = path.join(directory, "workspace");
  for (const helper of helpers)
    await copyFile(path.join(root, "scripts", helper), path.join(workspace, "scripts", helper));
  await writeFile(path.join(directory, "extensions.json"), '{"extensions":[]}');
  const runtime = await startPublicRuntime(prefix, {
    extensionsFile: path.join(directory, "extensions.json"),
    operationsDirectory: path.join(directory, "operations"),
  });
  const rpc = async (method, params) => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body));
    return body.result;
  };
  for (const source of operations)
    await rpc("operation.save", {
      sourceName: path.basename(source),
      source: await readFile(path.join(root, "assets/operations", source), "utf8"),
    });
  await rpc("environment.save", { environment: "local", values: { workspaceRoot: workspace } });
  const read = (plan) => rpc("plan.read", { plan });
  return {
    directory,
    workspace,
    rpc,
    publish: (source) => rpc("procedure.publish", { source }),
    check: async (plan, name) => (await read(plan)).checks.find((item) => item.name === name),
    write: async (relative, content) => {
      await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await writeFile(path.join(workspace, relative), content);
    },
    engage: (procedure, plan, rootInputs) =>
      rpc("plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure,
        procedureVersion: "1.0.0",
        plan,
        environment: "local",
        rootInputs,
      }),
    /**
     * Runs one Check through the packaged Runner. A completed attempt returns its TRUST qualification and the
     * helper's observation lines; an interrupted Operation returns the Runner's exit code and message instead.
     */
    run: async (plan, name) => {
      const check = (await read(plan)).checks.find((item) => item.name === name);
      assert.ok(check, name);
      const output = await exec(
        process.execPath,
        [path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"), check.checkUri, "--json"],
        {
          env: {
            ...env,
            TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
            TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
          },
          timeout: 110000,
        },
      ).catch((error) => error);
      if (output.code) return { interrupted: true, code: output.code, message: output.stderr };
      const result = JSON.parse(output.stdout).result;
      assert.equal(result.status, "COMPLETED", JSON.stringify(result));
      const lines = Object.values(result.actionOutcome)[0].stdout.trimEnd().split("\n");
      return { ...result.qualification, lines, report: JSON.parse(lines.at(-1)) };
    },
    close: async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
