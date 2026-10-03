import { publicTrustConfiguration } from "@trust/extension-sdk";
import { createRunnerAuthorization } from "../auth/credentials.js";
import { CheckClient } from "../check/client.js";
import { type CheckResult, createCheckRunner } from "../check/run.js";
import { createRunnerLogging } from "../diagnostics/pino.js";
import { OtlpFactExporter } from "../telemetry/otlp.js";
import { readRunnerConfiguration } from "./configuration.js";
import { runnerStartupConfiguration } from "./startup.js";

export interface RunnerCliOptions {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export async function runCli(options: RunnerCliOptions = {}): Promise<number> {
  const argv = [...(options.argv ?? process.argv.slice(2))];
  const startup = await runnerStartupConfiguration(options.environment ?? process.env);
  const environment = startup.environment;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  if (argv.length === 1 && argv[0] === "--print-config") {
    stdout(`${JSON.stringify(publicTrustConfiguration(startup.resolved), null, 2)}\n`);
    return 0;
  }
  const json = remove(argv, "--json");
  const logging = createRunnerLogging(environment);
  let configuration: ReturnType<typeof readRunnerConfiguration>;
  try {
    configuration = readRunnerConfiguration(argv);
  } catch (error) {
    logging.logger.warn({ event: "runner.invocation.invalid" }, "Runner configuration is invalid");
    logging.close();
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (argv.length !== 1 || argv[0]?.startsWith("trust://") !== true) {
    logging.logger.warn({ event: "runner.invocation.invalid" }, "Runner invocation is invalid");
    logging.close();
    stderr("usage: trust-runner <trust://check-uri> [--json] [--path <absolute-directory>]…\n");
    return 2;
  }
  try {
    const endpoint = startup.resolved.configuration.runner.rpcEndpoint;
    const otlpEndpoint = startup.resolved.configuration.runner.otlpEndpoint;
    const authorization = createRunnerAuthorization(environment, endpoint, otlpEndpoint);
    const runner = createCheckRunner({
      checkClient: new CheckClient(endpoint, 30_000, authorization),
      facts: new OtlpFactExporter(otlpEndpoint, 30_000, authorization),
      ...(authorization === undefined ? {} : { http: { runtimeRpc: { endpoint, authorization } } }),
      diagnostics: logging.diagnostics,
      shell: {
        additionalPath: [...startup.resolved.configuration.runner.additionalPath, ...configuration.additionalPath],
        processEnvironment: environment,
        timeoutMs: startup.resolved.configuration.runner.shellTimeoutMs,
      },
    });
    const result = await runner.run(argv[0]);
    stdout(json ? `${JSON.stringify(result, null, 2)}\n` : report(result));
    return 0;
  } catch (error) {
    logging.logger.error({ err: error, event: "runner.invocation.failed" }, "Runner invocation failed");
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    logging.close();
  }
}

function report(result: CheckResult): string {
  if (result.result.status === "REFUSED") {
    return [
      "Status: REFUSED",
      `Check: ${result.checkUri}`,
      `Code: ${result.result.reasonCode}`,
      `Reason: ${result.result.reason}`,
      "Next: READ_PLAN",
      "",
    ].join("\n");
  }
  const next =
    result.next.action === "RUN_CHECKS" || result.next.action === "RETRY_OR_ESCALATE"
      ? [
          `Next: ${result.next.action}`,
          ...result.next.checks.flatMap((check) => [
            `- ${check.name}: ${check.successReason}`,
            `  Check: ${check.checkUri}`,
            "  Authorized scope:",
            ...check.actionScope.authorized.map((item) => `  - ${item}`),
            "  Forbidden scope:",
            ...check.actionScope.forbidden.map((item) => `  - ${item}`),
          ]),
        ]
      : [`Next: ${result.next.action}`];
  return [
    "Status: COMPLETED",
    `Check: ${result.checkUri}`,
    `Attempt: ${result.result.attemptHandle}`,
    `Verdict: ${result.result.qualification.verdict}`,
    `Code: ${result.result.qualification.reasonCode}`,
    `Reason: ${result.result.qualification.reason}`,
    `Action output: ${JSON.stringify(result.result.actionOutcome)}`,
    ...next,
    "",
  ].join("\n");
}

function remove(argv: string[], value: string): boolean {
  const index = argv.indexOf(value);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
}
