import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { EnvironmentValues, StorageConfiguration } from "@trust/extension-sdk";
import { Client } from "pg";

const buildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface PublicRuntimeProcess {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface PublicRuntimeOptions {
  readonly port?: number;
  readonly processEnvironment?: Readonly<Record<string, string>>;
  readonly extensionsFile?: string;
  readonly storage?: StorageConfiguration;
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
  const storage = await acceptanceStorage(
    options.storage ?? { kind: "pglite", directory: path.join(dataDirectory, "pglite") },
  );
  const environment = { ...process.env, ...options.processEnvironment };
  delete environment.TRUST_DATABASE_PATH;
  delete environment.TRUST_DATABASE_URL;
  delete environment.TRUST_PGLITE_DIRECTORY;
  const runtime = spawn(process.execPath, [path.join(buildRoot, "src/index.js")], {
    env: {
      ...environment,
      TRUST_HOST: "127.0.0.1",
      TRUST_PORT: String(options.port ?? 0),
      ...(options.extensionsFile === undefined ? {} : { TRUST_EXTENSIONS_FILE: options.extensionsFile }),
      // Isolated per process unless a test deliberately shares or replaces the sealing key.
      TRUST_CREDENTIAL_KEY_FILE: path.join(dataDirectory, "credential.key"),
      ...(options.processEnvironment?.TRUST_CREDENTIAL_KEY_FILE === undefined
        ? {}
        : { TRUST_CREDENTIAL_KEY_FILE: options.processEnvironment.TRUST_CREDENTIAL_KEY_FILE }),
      TRUST_STORAGE: storage.kind,
      ...(storage.kind === "pglite"
        ? { TRUST_PGLITE_DIRECTORY: storage.directory }
        : { TRUST_DATABASE_URL: storage.connectionString }),
      ...(options.operationsDirectory === undefined ? {} : { TRUST_OPERATIONS_DIRECTORY: options.operationsDirectory }),
      ...(options.sessionDurationMs === undefined
        ? {}
        : { TRUST_SESSION_DURATION_MS: String(options.sessionDurationMs) }),
      ...(options.trialTimeoutMs === undefined ? {} : { TRUST_TRIAL_TIMEOUT_MS: String(options.trialTimeoutMs) }),
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

const postgresTargets = new Map<string, string>();
const createdDatabases: Array<{ admin: string; name: string }> = [];

/** Every acceptance process owns its databases; an explicit directory maps to one restartable target. */
async function acceptanceStorage(storage: StorageConfiguration): Promise<StorageConfiguration> {
  const admin = process.env.TRUST_ACCEPTANCE_POSTGRES_URL;
  if (storage.kind === "postgresql" || !admin) return storage;
  const existing = postgresTargets.get(storage.directory);
  if (existing) return { kind: "postgresql", connectionString: existing };
  const name = `trust_acceptance_${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    createdDatabases.push({ admin, name });
  } finally {
    await client.end();
  }
  const target = new URL(admin);
  target.pathname = `/${name}`;
  postgresTargets.set(storage.directory, target.href);
  return { kind: "postgresql", connectionString: target.href };
}

after(async () => {
  for (const { admin, name } of createdDatabases) {
    const client = new Client({ connectionString: admin });
    await client.connect();
    try {
      await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  }
});

async function configureEnvironment(endpoint: string, environment: string, values: EnvironmentValues): Promise<void> {
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
  const envelope = (await response.json()) as { readonly error?: unknown };
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
