import { startRuntime } from "./server.js";
import { normalizeAuthority } from "./check/uri.js";
import { DEFAULT_SKILL_OPERABILITY_POLICY } from "./skill/model.js";
import { parseRegistryPrincipalConfigurations } from "./skill/configured-authority.js";
import type { SkillPolicy } from "./skill/admission.js";
import {
  parseEnvironments,
  readOperations,
} from "./configuration.js";

const host = process.env.TRUST_HOST ?? "127.0.0.1";
const rawPort = process.env.TRUST_PORT ?? "4318";
const port = Number(rawPort);
const databasePath = process.env.TRUST_DATABASE_PATH ?? ".trust/trust.sqlite";
const semanticAuthority = normalizeAuthority(
  process.env.TRUST_SEMANTIC_AUTHORITY ?? "localhost:4318",
);
const skillPolicy = parseSkillPolicy(process.env.TRUST_SKILL_POLICY);
const operations = process.env.TRUST_OPERATIONS_DIRECTORY === undefined
  ? []
  : readOperations(process.env.TRUST_OPERATIONS_DIRECTORY);
const environments = parseEnvironments(
  process.env.TRUST_ENVIRONMENTS_JSON,
);
const registryPrincipalConfigurations = skillPolicy === "verified"
  ? parseRegistryPrincipalConfigurations(process.env.TRUST_REGISTRY_PRINCIPALS_JSON)
  : [];
const skillOperabilityPolicy = {
  maxClockSkewMs: durationFromEnvironment(
    "TRUST_SKILL_MAX_CLOCK_SKEW_MS",
    DEFAULT_SKILL_OPERABILITY_POLICY.maxClockSkewMs,
    true,
  ),
  maxLeaseDurationMs: durationFromEnvironment(
    "TRUST_SKILL_MAX_LEASE_DURATION_MS",
    DEFAULT_SKILL_OPERABILITY_POLICY.maxLeaseDurationMs,
  ),
  maxProbeAgeMs: durationFromEnvironment(
    "TRUST_SKILL_MAX_PROBE_AGE_MS",
    DEFAULT_SKILL_OPERABILITY_POLICY.maxProbeAgeMs,
  ),
};

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid TRUST_PORT '${rawPort}'.`);
}

const runtime = await startRuntime({
  host,
  port,
  databasePath,
  semanticAuthority,
  registryPrincipalConfigurations,
  skillPolicy,
  skillOperabilityPolicy,
  operations,
  environments,
});
process.stdout.write(`TRUST runtime listening on ${runtime.host}:${runtime.port}\n`);

const shutdown = async (): Promise<void> => {
  await runtime.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function durationFromEnvironment(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`Invalid ${name} '${raw}'.`);
  }
  return value;
}

function parseSkillPolicy(value: string | undefined): SkillPolicy {
  if (value === undefined || value.trim() === "" || value === "local") return "local";
  if (value === "verified") return "verified";
  throw new TypeError(`TRUST_SKILL_POLICY must be 'local' or 'verified', received '${value}'.`);
}
