import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegistryPrincipalConfiguration } from "../../src/skill/authority.js";
import type { RuntimeJsonObject } from "../../src/model.js";

const buildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface PublicRuntimeProcess {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface PublicRuntimeOptions {
  readonly databasePath?: string;
  readonly maxClockSkewMs?: number;
  readonly maxLeaseDurationMs?: number;
  readonly maxProbeAgeMs?: number;
  readonly registryPrincipalConfigurations?: readonly RegistryPrincipalConfiguration[];
  readonly skillPolicy?: "local" | "verified";
  readonly operationsDirectory?: string;
  readonly environments?: Readonly<Record<string, RuntimeJsonObject>>;
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
      TRUST_SKILL_POLICY: options.skillPolicy ?? "verified",
      TRUST_REGISTRY_PRINCIPALS_JSON:
        options.registryPrincipalConfigurations === undefined
          ? ""
          : JSON.stringify(options.registryPrincipalConfigurations),
      ...(options.operationsDirectory === undefined
        ? {}
        : { TRUST_OPERATIONS_DIRECTORY: options.operationsDirectory }),
      ...(options.environments === undefined
        ? {}
        : { TRUST_ENVIRONMENTS_JSON: JSON.stringify(options.environments) }),
      ...(options.maxClockSkewMs === undefined
        ? {}
        : { TRUST_SKILL_MAX_CLOCK_SKEW_MS: String(options.maxClockSkewMs) }),
      ...(options.maxLeaseDurationMs === undefined
        ? {}
        : { TRUST_SKILL_MAX_LEASE_DURATION_MS: String(options.maxLeaseDurationMs) }),
      ...(options.maxProbeAgeMs === undefined
        ? {}
        : { TRUST_SKILL_MAX_PROBE_AGE_MS: String(options.maxProbeAgeMs) }),
    },
    stdio: "pipe",
  });

  try {
    const endpoint = await listeningEndpoint(runtime);
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
