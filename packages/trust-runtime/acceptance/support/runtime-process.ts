import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentValues } from "../../src/environment/service.js";

const buildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface PublicRuntimeProcess {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface PublicRuntimeOptions {
  readonly databasePath?: string;
  readonly operationsDirectory?: string;
  readonly environments?: Readonly<Record<string, EnvironmentValues>>;
  readonly sessionDurationMs?: number;
  readonly trialTimeoutMs?: number;
}

export async function startPublicRuntime(
  prefix = "trust-runtime-",
  options: PublicRuntimeOptions = {},
): Promise<PublicRuntimeProcess> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), prefix));
  const runtime = spawn(process.execPath, [path.join(buildRoot, "src/index.js")], {
    env: {
      ...process.env,
      TRUST_HOST: "127.0.0.1",
      TRUST_PORT: "0",
      TRUST_DATABASE_PATH: options.databasePath ?? path.join(dataDirectory, "trust.sqlite"),
      ...(options.operationsDirectory === undefined
        ? {}
        : { TRUST_OPERATIONS_DIRECTORY: options.operationsDirectory }),
      ...(options.sessionDurationMs === undefined
        ? {}
        : { TRUST_SESSION_DURATION_MS: String(options.sessionDurationMs) }),
      ...(options.trialTimeoutMs === undefined
        ? {}
        : { TRUST_TRIAL_TIMEOUT_MS: String(options.trialTimeoutMs) }),
    },
    stdio: "pipe",
  });

  try {
    const endpoint = await listeningEndpoint(runtime);
    for (const [environment, values] of Object.entries(options.environments ?? {})) {
      await configureEnvironment(endpoint, environment, values);
    }
    return {
      endpoint,
      close: async () => {
        if (runtime.exitCode === null && runtime.signalCode === null) {
          runtime.kill("SIGTERM");
          await once(runtime, "exit");
        }
        await rm(dataDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    runtime.kill("SIGTERM");
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function configureEnvironment(
  endpoint: string,
  environment: string,
  values: EnvironmentValues,
): Promise<void> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `environment-${environment}`,
      method: "environment.save",
      params: { environment, values },
    }),
  });
  const envelope = await response.json() as { readonly error?: unknown };
  if (!response.ok || envelope.error !== undefined) {
    throw new Error(`TRUST runtime rejected Environment "${environment}": ${JSON.stringify(envelope.error)}`);
  }
}

function listeningEndpoint(runtime: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`TRUST runtime did not listen within 10 seconds. stderr=${stderr}`));
    }, 10_000);
    timeout.unref();
    const cleanup = (): void => {
      clearTimeout(timeout);
      runtime.stdout.off("data", onStdout);
      runtime.stderr.off("data", onStderr);
      runtime.off("error", onError);
      runtime.off("exit", onExit);
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      const match = stdout.match(/TRUST runtime listening on (127\.0\.0\.1):(\d+)/);
      if (!match?.[1] || !match[2]) return;
      cleanup();
      resolve(`http://${match[1]}:${match[2]}`);
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `TRUST runtime stopped before listening (code=${String(code)}, signal=${String(signal)}). stderr=${stderr}`,
        ),
      );
    };
    runtime.stdout.on("data", onStdout);
    runtime.stderr.on("data", onStderr);
    runtime.once("error", onError);
    runtime.once("exit", onExit);
  });
}
