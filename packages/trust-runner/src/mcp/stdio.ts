import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createRunnerAuthorization } from "../auth/credentials.js";

import { CheckClient } from "../check/client.js";
import { createCheckRunner } from "../check/run.js";
import { readRunnerConfiguration } from "../cli/configuration.js";
import { runnerStartupConfiguration } from "../cli/startup.js";
import { createRunnerLogging } from "../diagnostics/pino.js";
import { OtlpFactExporter } from "../telemetry/otlp.js";
import { createMcpHandler, parseError } from "./protocol.js";

export interface McpStdioOptions {
  readonly argv?: readonly string[];
  readonly input?: Readable;
  readonly output?: Writable;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export async function runMcpStdio(options: McpStdioOptions = {}): Promise<void> {
  const argv = [...(options.argv ?? process.argv.slice(2))];
  const configuration = readRunnerConfiguration(argv);
  if (argv.length !== 0)
    throw new TypeError("Runner MCP accepts only repeatable --path <absolute-directory> startup options");
  const startup = await runnerStartupConfiguration(options.environment ?? process.env);
  const environment = startup.environment;
  const endpoint = startup.resolved.configuration.runner.rpcEndpoint;
  const otlpEndpoint = startup.resolved.configuration.runner.otlpEndpoint;
  const authorization = createRunnerAuthorization(environment, endpoint, otlpEndpoint);
  const logging = createRunnerLogging(environment);
  const runner = createCheckRunner({
    checkClient: new CheckClient(endpoint, 30_000, authorization),
    facts: new OtlpFactExporter(otlpEndpoint, 30_000, authorization),
    diagnostics: logging.diagnostics,
    shell: {
      additionalPath: [...startup.resolved.configuration.runner.additionalPath, ...configuration.additionalPath],
      processEnvironment: environment,
      timeoutMs: startup.resolved.configuration.runner.shellTimeoutMs,
    },
  });
  const handle = createMcpHandler(runner);
  const lines = createInterface({
    input: options.input ?? process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  const output = options.output ?? process.stdout;
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        logging.logger.warn({ event: "runner.mcp.parse_failed" }, "Runner MCP input is not valid JSON");
        output.write(`${JSON.stringify(parseError())}\n`);
        continue;
      }
      const response = await handle(message);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    logging.close();
  }
}
