#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const runner = path.resolve(import.meta.dirname, "../packages/trust-runner/dist/skill/trust/scripts/auth.js");
const child = spawn(process.execPath, [runner, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("error", () => {
  process.stderr.write("Packaged authentication helper is unavailable. Build the Runner skill first.\n");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
