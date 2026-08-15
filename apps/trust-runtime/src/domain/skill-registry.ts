export type SkillEnvelope = "cli" | "mcp-stdio" | "mcp-http";

export interface SkillOperabilityPolicy {
  readonly maxClockSkewMs: number;
  readonly maxLeaseDurationMs: number;
  readonly maxProbeAgeMs: number;
}

export const DEFAULT_SKILL_OPERABILITY_POLICY: SkillOperabilityPolicy = Object.freeze({
  maxClockSkewMs: 5_000,
  maxLeaseDurationMs: 120_000,
  maxProbeAgeMs: 60_000,
});

export interface SkillReleaseCapabilityClaim {
  readonly capability: string;
  readonly actionContractDigest: string;
}

export interface SkillReleaseEntrypoints {
  readonly cli: string;
  readonly mcpStdio?: string;
  readonly mcpHttp?: string;
}

export interface SkillReleaseClaim {
  readonly skill: string;
  readonly version: string;
  readonly releaseDigest: string;
  readonly publisher: string;
  readonly implements: readonly SkillReleaseCapabilityClaim[];
  readonly entrypoints: SkillReleaseEntrypoints;
  readonly probes: readonly string[];
}

export interface RegisteredSkillRelease {
  readonly claim: SkillReleaseClaim;
  readonly registeredAt: string;
}

export interface VerifiedDistribution {
  readonly distributionDigest: string;
  readonly releaseDigest: string;
  readonly issuer: string;
  readonly signature: string;
  readonly verifiedAt: string;
}

export interface ReleaseAuthorization {
  readonly environment: string;
  readonly releaseDigest: string;
  readonly authorizedBy: string;
  readonly authorizedAt: string;
}

export interface DeploymentAuthorization {
  readonly environment: string;
  readonly logicalDeploymentKey: string;
  readonly releaseDigest: string;
  readonly envelope: SkillEnvelope;
  readonly runtimeIdentity: string;
  readonly authorizedBy: string;
  readonly authorizedAt: string;
}

export interface DeploymentSelection {
  readonly environment: string;
  readonly capability: string;
  readonly actionContractDigest: string;
  readonly logicalDeploymentKey: string;
  readonly selectedBy: string;
  readonly selectedAt: string;
}

export type SkillProbeResultValue = "PASS" | "FAIL";

export interface SkillProbeResult {
  readonly name: string;
  readonly status: SkillProbeResultValue;
  readonly reason: string;
  readonly observedAt: string;
}

export interface DeploymentAnnouncement {
  readonly environment: string;
  readonly logicalDeploymentKey: string;
  readonly envelope: SkillEnvelope;
  readonly runtimeIdentity: string;
  readonly processIdentity: string;
  readonly releaseDigest: string;
  readonly distributionDigest: string;
  readonly probes: readonly SkillProbeResult[];
  readonly announcedAt: string;
  readonly leaseExpiresAt: string;
}

export interface RegisteredDeploymentAnnouncement extends DeploymentAnnouncement {
  readonly recordedAt: string;
}

export interface SkillRequirement {
  readonly capability: string;
  readonly actionContractDigest: string;
}

export type ReleaseCompatibilityStatus =
  | "MISSING"
  | "INCOMPATIBLE"
  | "COMPATIBLE";

export type ReleaseCompatibilityReasonCode =
  | "release-claim-missing"
  | "capability-not-implemented"
  | "action-contract-digest-mismatch"
  | "release-compatible";

export interface ReleaseCompatibilityResult {
  readonly releaseDigest: string;
  readonly requirement: SkillRequirement;
  readonly status: ReleaseCompatibilityStatus;
  readonly reasonCode: ReleaseCompatibilityReasonCode;
  readonly reason: string;
  readonly evaluatedAt: string;
}

export type PreflightStatus =
  | "MISSING"
  | "INCOMPATIBLE"
  | "UNAUTHORIZED"
  | "UNAVAILABLE"
  | "READY";

export type PreflightReasonCode =
  | ReleaseCompatibilityReasonCode
  | "deployment-selection-missing"
  | "deployment-announcement-missing"
  | "distribution-release-link-missing"
  | "release-unauthorized"
  | "deployment-unauthorized"
  | "deployment-lease-expired"
  | "probe-missing"
  | "probe-stale"
  | "probe-failed"
  | "deployment-ready";

export interface PreflightRequirementResult {
  readonly environment: string;
  readonly requirement: SkillRequirement;
  readonly status: PreflightStatus;
  readonly reasonCode: PreflightReasonCode;
  readonly reason: string;
  readonly evaluatedAt: string;
  readonly authorizesPlanEngagement: false;
  readonly logicalDeploymentKey?: string;
  readonly releaseDigest?: string;
  readonly skill?: string;
  readonly version?: string;
  readonly envelope?: SkillEnvelope;
}

export interface EnvironmentPreflightResult {
  readonly environment: string;
  readonly status: "NOT_OPERABLE" | "READY";
  readonly requirements: readonly PreflightRequirementResult[];
  readonly evaluatedAt: string;
  readonly authorizesPlanEngagement: false;
}

export type SkillRegistryErrorCode =
  | "invalid-release-claim"
  | "invalid-requirement"
  | "release-digest-collision"
  | "release-version-collision"
  | "unknown-release"
  | "invalid-distribution"
  | "distribution-digest-collision"
  | "invalid-authorization"
  | "invalid-selection"
  | "invalid-deployment-announcement"
  | "deployment-announcement-future"
  | "deployment-announcement-non-monotonic"
  | "deployment-lease-too-long"
  | "deployment-already-active";

export class SkillRegistryError extends Error {
  constructor(
    readonly code: SkillRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

const RAW_SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z]+(?:[.-][0-9a-z]+)*)?$/;
const CANONICAL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CANONICAL_SKILL_ACTION = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const CANONICAL_SKILL = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const CANONICAL_PROBE = /^[a-z][a-z0-9-]{0,63}$/;

export function isRawSha256(value: string): boolean {
  return RAW_SHA256.test(value);
}

export function isPrefixedSha256(value: string): boolean {
  return PREFIXED_SHA256.test(value);
}

export function isCanonicalSkillAction(value: string): boolean {
  return CANONICAL_SKILL_ACTION.test(value);
}

export function isCanonicalSkill(value: string): boolean {
  return CANONICAL_SKILL.test(value);
}

export function isCanonicalRegistrySlug(value: string): boolean {
  return CANONICAL_SLUG.test(value);
}

export function isCanonicalProbe(value: string): boolean {
  return CANONICAL_PROBE.test(value);
}

export function isExactSemanticVersion(value: string): boolean {
  return SEMANTIC_VERSION.test(value);
}
