import { CheckClient } from "../check/client.js";
import { createCheckRunner, type CheckResult } from "../check/run.js";
import { createRunnerLogging } from "../diagnostics/pino.js";
import { OtlpFactExporter } from "../telemetry/otlp.js";
import { readRunnerConfiguration } from "./configuration.js";

export interface RunnerCliOptions {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export async function runCli(options: RunnerCliOptions = {}): Promise<number> {
  const argv = [...(options.argv ?? process.argv.slice(2))];
  const environment = options.environment ?? process.env;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const json = remove(argv, "--json");
  const logging = createRunnerLogging(environment);
  let configuration;
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
    const endpoint = environment.TRUST_RPC_ENDPOINT ?? "http://127.0.0.1:4318/rpc";
    const otlpEndpoint = environment.TRUST_OTLP_ENDPOINT ?? "http://127.0.0.1:4318/v1/traces";
    const runner = createCheckRunner({
      checkClient: new CheckClient(endpoint),
      facts: new OtlpFactExporter(otlpEndpoint),
      diagnostics: logging.diagnostics,
      shell: { additionalPath: configuration.additionalPath, processEnvironment: environment },
    });
    const result = await runner.run(argv[0]);
    stdout(json ? `${JSON.stringify(result, null, 2)}\n` : report(result));
    if (result.status === "REFUSED") return 3;
    return result.verdict === "VALIDATED" ? 0 : 4;
  } catch (error) {
    logging.logger.error({ err: error, event: "runner.invocation.failed" }, "Runner invocation failed");
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    logging.close();
  }
}

function report(result: CheckResult): string {
  if (result.status === "REFUSED") {
    return [
      "Status: REFUSED",
      `Check: ${result.checkUri}`,
      `Code: ${result.reasonCode}`,
      `Reason: ${result.reason}`,
      "",
    ].join("\n");
  }
  return [
    "Status: COMPLETED",
    `Check: ${result.checkUri}`,
    `Verdict: ${result.verdict}`,
    `Code: ${result.reasonCode}`,
    `Reason: ${result.reason}`,
    `Action output: ${JSON.stringify(result.actionOutcome)}`,
    "",
  ].join("\n");
}

function remove(argv: string[], value: string): boolean {
  const index = argv.indexOf(value);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
}
