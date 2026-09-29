#!/usr/bin/env node
// Runs one closed quality gate of a delegated mission with fixed commands and reports it on four lines:
// gate, passed (1 or 0), findings, one-line summary. It always exits 0 so the Runner records the observation.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 600000;
const run = (command, args) => runIn(".", command, args);
const runIn = (directory, command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: directory, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk) => {
      if (output.length < 4 * 1024 * 1024) output += chunk;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(error.message) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? -1 : code, output });
    });
  });

const gates = {
  /** Code Moniker, the single architecture analyzer, over the whole repository. */
  async architecture() {
    const result = await run("code-moniker", ["check", ".", "--report"]);
    const match = result.output.match(/(\d+) violation\(s\)/u);
    const violations = match ? Number(match[1]) : -1;
    return {
      passed: result.code === 0 && violations === 0,
      findings: violations < 0 ? 1 : violations,
      summary: match ? match[0] : `code-moniker exited with ${result.code}`,
    };
  },
  /** Typecheck of the interface packages and Biome errors in them. */
  async interface() {
    const checks = [
      ["npm", ["run", "typecheck", "--workspace=@trust/ui"]],
      ["npm", ["run", "typecheck", "--workspace=@trust/web"]],
      ["npx", ["biome", "check", "--diagnostic-level=error", "packages/trust-ui", "apps/trust-web"]],
    ];
    const failed = [];
    for (const [command, args] of checks) {
      const result = await run(command, args);
      if (result.code !== 0) failed.push(`${command} ${args.join(" ")}`);
    }
    return {
      passed: failed.length === 0,
      findings: failed.length,
      summary: failed.length ? `failed: ${failed.join("; ")}` : "typecheck and Biome pass",
    };
  },
  /** Every change of the checkout, submodules and untracked files included, is committed by the coordinator. */
  async committed() {
    const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
    const head = await run("git", ["rev-parse", "--short", "HEAD"]);
    const pending = status.code === 0 ? status.output.split("\n").filter((line) => line.trim()) : [];
    return {
      passed: status.code === 0 && pending.length === 0,
      findings: status.code === 0 ? pending.length : 1,
      summary:
        status.code !== 0
          ? "git status failed"
          : pending.length
            ? `${pending.length} uncommitted: ${pending
                .slice(0, 5)
                .map((line) => line.slice(3))
                .join(", ")}`
            : `committed at ${head.output.trim()}`,
    };
  },
  /** The integrated documentation suite: fr/en mirror, compiling Gherkin fences and captured screenshots. */
  async documentation() {
    const result = await runIn("apps/trust-web", "npx", [
      "playwright",
      "test",
      "--config",
      "playwright.config.ts",
      "--project",
      "acceptance",
      "--reporter=line",
      "acceptance/docs.acceptance.spec.ts",
    ]);
    const failed = result.output.match(/(\d+) failed/u);
    return {
      passed: result.code === 0,
      findings: result.code === 0 ? 0 : failed ? Number(failed[1]) : 1,
      summary: result.code === 0 ? "documentation suite passes" : (failed?.[0] ?? `exited with ${result.code}`),
    };
  },
};

const [gate, ...rest] = process.argv.slice(2);
const execute = Object.hasOwn(gates, gate) && rest.length === 0 ? gates[gate] : null;
const result = execute
  ? await execute()
  : { passed: false, findings: 1, summary: `unknown gate; expected one of ${Object.keys(gates).join(", ")}` };
process.stdout.write(
  `${gate ?? ""}\n${result.passed ? 1 : 0}\n${result.findings}\n${result.summary.replace(/\s+/g, " ").slice(0, 400)}\n`,
);
