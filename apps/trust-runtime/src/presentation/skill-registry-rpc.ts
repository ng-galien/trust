import type { SkillPreflightService } from "../application/skill-preflight-service.js";
import type { SkillRegistryService } from "../application/skill-registry-service.js";
import type {
  DeploymentAnnouncement,
  SkillReleaseClaim,
  SkillRequirement,
} from "../domain/skill-registry.js";
import type { Clock } from "../ports/clock.js";
import type { RegistryAuthority } from "../ports/registry-authority.js";
import {
  SKILL_DEPLOYMENT_ANNOUNCE_METHOD,
  SKILL_DEPLOYMENT_AUTHORIZATION_SET_METHOD,
  SKILL_DEPLOYMENT_SELECTION_SET_METHOD,
  SKILL_ENVIRONMENT_PREFLIGHT_METHOD,
  SKILL_RELEASE_AUTHORIZATION_SET_METHOD,
  SKILL_RELEASE_CLAIM_METHOD,
  SKILL_VERIFIED_DISTRIBUTION_RECORD_METHOD,
  type SkillAuthorizationSetResult,
  type SkillDeploymentAnnounceResult,
  type SkillDeploymentSelectionSetResult,
  type SkillEnvironmentPreflightResult,
  type SkillReleaseClaimResult,
  type SkillRequirementPreflightDto,
  type VerifiedSkillDistributionRecordResult,
} from "./rpc-contract.js";

export interface SkillRegistryRpcDependencies {
  readonly clock: Clock;
  readonly registryAuthority: RegistryAuthority;
  readonly skillRegistryService: SkillRegistryService;
  readonly skillPreflightService: SkillPreflightService;
}

export interface SkillRegistryRpcRequestContext {
  readonly authorizationHeader?: string;
  readonly processAuthorizationHeader?: string;
}

export class InvalidSkillRegistryRpcParams extends Error {
  constructor() {
    super("Invalid Skill registry RPC params");
    this.name = "InvalidSkillRegistryRpcParams";
  }
}

export const isSkillRegistryRpcMethod = (method: string): boolean =>
  method === SKILL_RELEASE_CLAIM_METHOD ||
  method === SKILL_VERIFIED_DISTRIBUTION_RECORD_METHOD ||
  method === SKILL_RELEASE_AUTHORIZATION_SET_METHOD ||
  method === SKILL_DEPLOYMENT_AUTHORIZATION_SET_METHOD ||
  method === SKILL_DEPLOYMENT_SELECTION_SET_METHOD ||
  method === SKILL_DEPLOYMENT_ANNOUNCE_METHOD ||
  method === SKILL_ENVIRONMENT_PREFLIGHT_METHOD;

export function executeSkillRegistryRpc(
  method: string,
  params: unknown,
  dependencies: SkillRegistryRpcDependencies,
  context: SkillRegistryRpcRequestContext,
): unknown {
  switch (method) {
    case SKILL_RELEASE_CLAIM_METHOD: {
      const release = parseReleaseClaim(params);
      dependencies.registryAuthority.authorize({
        ...context,
        anyRoleOf: ["publisher"],
        assertedIdentity: release.publisher,
      });
      const registered = dependencies.skillRegistryService.registerRelease(release);
      return {
        releaseDigest: registered.claim.releaseDigest,
        recordedAt: registered.registeredAt,
      } satisfies SkillReleaseClaimResult;
    }
    case SKILL_VERIFIED_DISTRIBUTION_RECORD_METHOD: {
      const distribution = parseDistribution(params);
      dependencies.registryAuthority.authorize({
        ...context,
        anyRoleOf: ["distribution-verifier"],
        assertedIdentity: distribution.issuer,
        signedRecord: {
          value: signedDistributionRecord(distribution),
          signature: distribution.signature,
        },
      });
      const verified = dependencies.skillRegistryService.recordVerifiedDistribution(distribution);
      return {
        releaseDigest: verified.releaseDigest,
        distributionDigest: verified.distributionDigest,
        verifiedAt: verified.verifiedAt,
      } satisfies VerifiedSkillDistributionRecordResult;
    }
    case SKILL_RELEASE_AUTHORIZATION_SET_METHOD: {
      const input = parseReleaseAuthorization(params);
      const principal = dependencies.registryAuthority.authorize({
        ...context,
        anyRoleOf: ["operator"],
      });
      const effectiveAt =
        input.decision === "ALLOW"
          ? dependencies.skillRegistryService.authorizeRelease({
              environment: input.environment,
              releaseDigest: input.releaseDigest,
              authorizedBy: principal.identity,
            }).authorizedAt
          : (dependencies.skillRegistryService.revokeRelease(
              input.environment,
              input.releaseDigest,
            ), dependencies.clock.now().toISOString());
      return { decision: input.decision, effectiveAt } satisfies SkillAuthorizationSetResult;
    }
    case SKILL_DEPLOYMENT_AUTHORIZATION_SET_METHOD: {
      const input = parseDeploymentAuthorization(params);
      const principal = dependencies.registryAuthority.authorize({
        ...context,
        anyRoleOf: ["operator"],
      });
      const effectiveAt =
        input.decision === "ALLOW"
          ? dependencies.skillRegistryService.authorizeDeployment({
              environment: input.environment,
              logicalDeploymentKey: input.deploymentKey,
              releaseDigest: input.releaseDigest,
              envelope: input.envelope,
              runtimeIdentity: input.runtimeIdentity,
              authorizedBy: principal.identity,
            }).authorizedAt
          : (dependencies.skillRegistryService.revokeDeployment(
              input.environment,
              input.deploymentKey,
              input.releaseDigest,
              input.envelope,
              input.runtimeIdentity,
            ), dependencies.clock.now().toISOString());
      return { decision: input.decision, effectiveAt } satisfies SkillAuthorizationSetResult;
    }
    case SKILL_DEPLOYMENT_SELECTION_SET_METHOD: {
      const input = parseSelection(params);
      const principal = dependencies.registryAuthority.authorize({
        ...context,
        anyRoleOf: ["operator"],
      });
      if (input.deploymentKey === null) {
        dependencies.skillRegistryService.clearSelection(input.environment, input.requirement);
        return {
          environment: input.environment,
          requirement: input.requirement,
          deploymentKey: null,
          selectedAt: null,
        } satisfies SkillDeploymentSelectionSetResult;
      }
      const selected = dependencies.skillRegistryService.selectDeployment({
        environment: input.environment,
        ...input.requirement,
        logicalDeploymentKey: input.deploymentKey,
        selectedBy: principal.identity,
      });
      return {
        environment: selected.environment,
        requirement: {
          capability: selected.capability,
          actionContractDigest: selected.actionContractDigest,
        },
        deploymentKey: selected.logicalDeploymentKey,
        selectedAt: selected.selectedAt,
      } satisfies SkillDeploymentSelectionSetResult;
    }
    case SKILL_DEPLOYMENT_ANNOUNCE_METHOD: {
      const announcement = parseDeploymentAnnouncement(params);
      dependencies.registryAuthority.authorize({
        ...(context.authorizationHeader === undefined
          ? {}
          : { authorizationHeader: context.authorizationHeader }),
        anyRoleOf: ["runtime"],
        assertedIdentity: announcement.runtimeIdentity,
      });
      dependencies.registryAuthority.authorize({
        ...(context.processAuthorizationHeader === undefined
          ? {}
          : { authorizationHeader: context.processAuthorizationHeader }),
        anyRoleOf: ["runtime-process"],
        assertedIdentity: announcement.processIdentity,
      });
      const recorded = dependencies.skillRegistryService.announceDeployment(announcement);
      return {
        environment: recorded.environment,
        deploymentKey: recorded.logicalDeploymentKey,
        announcedAt: recorded.announcedAt,
        recordedAt: recorded.recordedAt,
        leaseExpiresAt: recorded.leaseExpiresAt,
      } satisfies SkillDeploymentAnnounceResult;
    }
    case SKILL_ENVIRONMENT_PREFLIGHT_METHOD:
      dependencies.registryAuthority.authorize({
        ...context,
        anyRoleOf: ["observer", "operator"],
      });
      return projectEnvironmentPreflight(
        dependencies.skillPreflightService.evaluateEnvironment(
          ...parseEnvironmentPreflight(params),
        ),
      );
    default:
      throw new Error(`unsupported Skill registry method: ${method}`);
  }
}

function signedDistributionRecord(distribution: ReturnType<typeof parseDistribution>): unknown {
  return {
    contract: "trust.verified-skill-distribution@1",
    releaseDigest: distribution.releaseDigest,
    distributionDigest: distribution.distributionDigest,
    issuer: distribution.issuer,
    verifiedAt: distribution.verifiedAt,
  };
}

function parseReleaseClaim(params: unknown): SkillReleaseClaim {
  const root = exactRecord(params, ["release"]);
  const release = exactRecord(root.release, [
    "contract",
    "skill",
    "version",
    "releaseDigest",
    "publisher",
    "implements",
    "entrypoints",
    "probes",
  ]);
  if (release.contract !== "trust.skill-release@1") invalid();
  const implementations = array(release.implements).map((candidate) => {
    const claim = exactRecord(candidate, ["capability", "actionContractDigest"]);
    if (
      typeof claim.capability !== "string" ||
      typeof claim.actionContractDigest !== "string"
    ) {
      invalid();
    }
    return {
      capability: claim.capability,
      actionContractDigest: claim.actionContractDigest,
    };
  });
  const entrypoints = exactRecordWithOptional(
    release.entrypoints,
    ["cli"],
    ["mcpStdio", "mcpHttp"],
  );
  if (
    typeof release.skill !== "string" ||
    typeof release.version !== "string" ||
    typeof release.releaseDigest !== "string" ||
    typeof release.publisher !== "string" ||
    typeof entrypoints.cli !== "string" ||
    (entrypoints.mcpStdio !== undefined && typeof entrypoints.mcpStdio !== "string") ||
    (entrypoints.mcpHttp !== undefined && typeof entrypoints.mcpHttp !== "string")
  ) {
    invalid();
  }
  return {
    skill: release.skill,
    version: release.version,
    releaseDigest: release.releaseDigest,
    publisher: release.publisher,
    implements: implementations,
    entrypoints: {
      cli: entrypoints.cli,
      ...(entrypoints.mcpStdio === undefined ? {} : { mcpStdio: entrypoints.mcpStdio }),
      ...(entrypoints.mcpHttp === undefined ? {} : { mcpHttp: entrypoints.mcpHttp }),
    },
    probes: stringArray(release.probes),
  };
}

function parseDistribution(params: unknown): {
  distributionDigest: string;
  releaseDigest: string;
  issuer: string;
  verifiedAt: string;
  signature: string;
} {
  const root = exactRecord(params, ["distribution"]);
  const value = exactRecord(root.distribution, [
    "contract",
    "releaseDigest",
    "distributionDigest",
    "issuer",
    "verifiedAt",
    "signature",
  ]);
  if (
    value.contract !== "trust.verified-skill-distribution@1" ||
    typeof value.releaseDigest !== "string" ||
    typeof value.distributionDigest !== "string" ||
    typeof value.issuer !== "string" ||
    typeof value.verifiedAt !== "string" ||
    typeof value.signature !== "string"
  ) {
    invalid();
  }
  return {
    releaseDigest: value.releaseDigest,
    distributionDigest: value.distributionDigest,
    issuer: value.issuer,
    verifiedAt: value.verifiedAt,
    signature: value.signature,
  };
}

function parseReleaseAuthorization(params: unknown): {
  environment: string;
  releaseDigest: string;
  decision: "ALLOW" | "REVOKE";
} {
  const value = exactRecord(params, ["environment", "releaseDigest", "decision"]);
  if (
    typeof value.environment !== "string" ||
    typeof value.releaseDigest !== "string" ||
    (value.decision !== "ALLOW" && value.decision !== "REVOKE")
  ) invalid();
  return value as ReturnType<typeof parseReleaseAuthorization>;
}

function parseDeploymentAuthorization(params: unknown): {
  environment: string;
  deploymentKey: string;
  releaseDigest: string;
  envelope: "cli" | "mcp-stdio" | "mcp-http";
  runtimeIdentity: string;
  decision: "ALLOW" | "REVOKE";
} {
  const value = exactRecord(params, [
    "environment",
    "deploymentKey",
    "releaseDigest",
    "envelope",
    "runtimeIdentity",
    "decision",
  ]);
  if (
    typeof value.environment !== "string" ||
    typeof value.deploymentKey !== "string" ||
    typeof value.releaseDigest !== "string" ||
    (value.envelope !== "cli" && value.envelope !== "mcp-stdio" && value.envelope !== "mcp-http") ||
    typeof value.runtimeIdentity !== "string" ||
    (value.decision !== "ALLOW" && value.decision !== "REVOKE")
  ) invalid();
  return value as ReturnType<typeof parseDeploymentAuthorization>;
}

function parseSelection(params: unknown): {
  environment: string;
  requirement: SkillRequirement;
  deploymentKey: string | null;
} {
  const value = exactRecord(params, ["environment", "requirement", "deploymentKey"]);
  if (
    typeof value.environment !== "string" ||
    (value.deploymentKey !== null && typeof value.deploymentKey !== "string")
  ) invalid();
  return {
    environment: value.environment,
    requirement: parseRequirement(value.requirement),
    deploymentKey: value.deploymentKey,
  };
}

function parseDeploymentAnnouncement(params: unknown): DeploymentAnnouncement {
  const root = exactRecord(params, ["announcement"]);
  const value = exactRecordWithOptional(root.announcement, [
    "environment",
    "deploymentKey",
    "envelope",
    "runtimeIdentity",
    "processIdentity",
    "releaseDigest",
    "distributionDigest",
    "probes",
    "announcedAt",
    "leaseExpiresAt",
  ], []);
  if (
    typeof value.environment !== "string" ||
    typeof value.deploymentKey !== "string" ||
    (value.envelope !== "cli" && value.envelope !== "mcp-stdio" && value.envelope !== "mcp-http") ||
    typeof value.runtimeIdentity !== "string" ||
    typeof value.processIdentity !== "string" ||
    typeof value.releaseDigest !== "string" ||
    typeof value.distributionDigest !== "string" ||
    typeof value.announcedAt !== "string" ||
    typeof value.leaseExpiresAt !== "string"
  ) invalid();
  const probes = array(value.probes).map((candidate) => {
    const probe = exactRecord(candidate, ["name", "status", "reason", "observedAt"]);
    if (
      typeof probe.name !== "string" ||
      (probe.status !== "PASS" && probe.status !== "FAIL") ||
      typeof probe.reason !== "string" ||
      typeof probe.observedAt !== "string"
    ) invalid();
    const status: "PASS" | "FAIL" = probe.status;
    return {
      name: probe.name,
      status,
      reason: probe.reason,
      observedAt: probe.observedAt,
    };
  });
  return {
    environment: value.environment,
    logicalDeploymentKey: value.deploymentKey,
    envelope: value.envelope,
    runtimeIdentity: value.runtimeIdentity,
    processIdentity: value.processIdentity,
    releaseDigest: value.releaseDigest,
    distributionDigest: value.distributionDigest,
    probes,
    announcedAt: value.announcedAt,
    leaseExpiresAt: value.leaseExpiresAt,
  };
}

function parseEnvironmentPreflight(params: unknown): [string, readonly SkillRequirement[]] {
  const value = exactRecord(params, ["environment", "requirements"]);
  if (typeof value.environment !== "string") invalid();
  return [value.environment, array(value.requirements).map(parseRequirement)];
}

function parseRequirement(value: unknown): SkillRequirement {
  const requirement = exactRecord(value, [
    "capability",
    "actionContractDigest",
  ]);
  if (
    typeof requirement.capability !== "string" ||
    typeof requirement.actionContractDigest !== "string"
  ) invalid();
  return {
    capability: requirement.capability,
    actionContractDigest: requirement.actionContractDigest,
  };
}

function projectEnvironmentPreflight(
  result: ReturnType<SkillPreflightService["evaluateEnvironment"]>,
): SkillEnvironmentPreflightResult {
  const coverage = result.requirements.map((item): SkillRequirementPreflightDto => ({
    ...item.requirement,
    status: item.status,
    reasonCode: projectReasonCode(item.reasonCode),
    reason: item.reason,
    ...(item.logicalDeploymentKey === undefined
      ? {}
      : { deploymentKey: item.logicalDeploymentKey }),
    ...(item.envelope === undefined ? {} : { envelope: item.envelope }),
    ...(item.skill === undefined ? {} : { skill: item.skill }),
    ...(item.version === undefined ? {} : { version: item.version }),
  }));
  const ready = coverage.filter((item) => item.status === "READY").length;
  return {
    contract: "trust.environment-preflight@1",
    scope: "environment",
    environment: result.environment,
    evaluatedAt: result.evaluatedAt,
    status: result.status,
    authorizesPlanEngagement: false,
    summary: {
      required: coverage.length,
      ready,
      blocked: coverage.length - ready,
    },
    coverage,
  };
}

function projectReasonCode(
  reason: ReturnType<SkillPreflightService["evaluateRequirement"]>["reasonCode"],
): SkillRequirementPreflightDto["reasonCode"] {
  switch (reason) {
    case "release-compatible": return "release-compatible";
    case "deployment-selection-missing":
    case "deployment-announcement-missing":
    case "release-claim-missing":
    case "capability-not-implemented":
    case "action-contract-digest-mismatch":
    case "distribution-release-link-missing":
    case "release-unauthorized":
    case "deployment-unauthorized":
    case "deployment-lease-expired":
    case "probe-missing":
    case "probe-failed":
    case "probe-stale":
    case "deployment-ready":
      return reason;
  }
}

function exactRecordWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) invalid();
  return record;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (
    Object.keys(record).some((key) => !expected.has(key)) ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) invalid();
  return record;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function stringArray(value: unknown): readonly string[] {
  const values = array(value);
  if (values.some((item) => typeof item !== "string")) invalid();
  return values as readonly string[];
}

function invalid(): never {
  throw new InvalidSkillRegistryRpcParams();
}
