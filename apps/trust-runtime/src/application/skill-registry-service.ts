import type {
  DeploymentAnnouncement,
  DeploymentAuthorization,
  DeploymentSelection,
  RegisteredDeploymentAnnouncement,
  RegisteredSkillRelease,
  ReleaseAuthorization,
  SkillEnvelope,
  SkillOperabilityPolicy,
  SkillRequirement,
  SkillReleaseClaim,
  VerifiedDistribution,
} from "../domain/skill-registry.js";
import {
  isCanonicalProbe,
  isCanonicalRegistrySlug,
  isCanonicalSkill,
  isCanonicalSkillAction,
  isExactSemanticVersion,
  isPrefixedSha256,
  isRawSha256,
  SkillRegistryError,
} from "../domain/skill-registry.js";
import type { SkillRegistryRepository } from "../infrastructure/repositories/skill-registry-repository.js";
import type { Clock } from "../ports/clock.js";
import type { ProcedureDefinitionService } from "./procedure-definition-service.js";
import type { SkillReleaseCompatibilityService } from "./skill-release-compatibility-service.js";

export interface SkillRegistryServiceDependencies {
  readonly clock: Clock;
  readonly procedureDefinitionService: ProcedureDefinitionService;
  readonly skillOperabilityPolicy: SkillOperabilityPolicy;
  readonly skillRegistryRepository: SkillRegistryRepository;
  readonly skillReleaseCompatibilityService: SkillReleaseCompatibilityService;
}

export interface ReleaseAuthorizationInput {
  readonly environment: string;
  readonly releaseDigest: string;
  readonly authorizedBy: string;
}

export interface DeploymentAuthorizationInput extends ReleaseAuthorizationInput {
  readonly logicalDeploymentKey: string;
  readonly envelope: SkillEnvelope;
  readonly runtimeIdentity: string;
}

export interface DeploymentSelectionInput {
  readonly environment: string;
  readonly capability: string;
  readonly actionContractDigest: string;
  readonly logicalDeploymentKey: string;
  readonly selectedBy: string;
}

export interface VerifiedDistributionInput {
  readonly distributionDigest: string;
  readonly releaseDigest: string;
  readonly issuer: string;
  readonly verifiedAt: string;
  readonly signature: string;
}

export class SkillRegistryService {
  readonly #clock: Clock;
  readonly #procedureDefinitions: ProcedureDefinitionService;
  readonly #operabilityPolicy: SkillOperabilityPolicy;
  readonly #repository: SkillRegistryRepository;
  readonly #releaseCompatibility: SkillReleaseCompatibilityService;

  constructor({
    clock,
    procedureDefinitionService,
    skillOperabilityPolicy,
    skillRegistryRepository,
    skillReleaseCompatibilityService,
  }: SkillRegistryServiceDependencies) {
    this.#clock = clock;
    this.#procedureDefinitions = procedureDefinitionService;
    assertOperabilityPolicy(skillOperabilityPolicy);
    this.#operabilityPolicy = skillOperabilityPolicy;
    this.#repository = skillRegistryRepository;
    this.#releaseCompatibility = skillReleaseCompatibilityService;
  }

  registerRelease(claim: SkillReleaseClaim): RegisteredSkillRelease {
    assertReleaseClaim(claim);
    return this.#repository.saveReleaseClaim(
      canonicalReleaseClaim(claim),
      this.#clock.now().toISOString(),
    );
  }

  recordVerifiedDistribution(input: VerifiedDistributionInput): VerifiedDistribution {
    if (!isPrefixedSha256(input.distributionDigest)) {
      invalid("invalid-distribution", "distributionDigest must be sha256:<64 lowercase hex>");
    }
    if (!isPrefixedSha256(input.releaseDigest)) {
      invalid("invalid-distribution", "releaseDigest must be sha256:<64 lowercase hex>");
    }
    assertAbsoluteIdentity(input.issuer, "distribution issuer", "invalid-distribution");
    assertInstant(input.verifiedAt, "distribution verifiedAt", "invalid-distribution");
    assertSignature(input.signature, "distribution signature", "invalid-distribution");
    this.#requireRelease(input.releaseDigest);
    return this.#repository.saveVerifiedDistribution(input);
  }

  authorizeRelease(input: ReleaseAuthorizationInput): ReleaseAuthorization {
    assertEnvironment(input.environment, "invalid-authorization");
    assertReleaseDigest(input.releaseDigest, "invalid-authorization");
    assertAbsoluteIdentity(input.authorizedBy, "authorization actor", "invalid-authorization");
    const release = this.#requireRelease(input.releaseDigest);
    for (const implementation of release.claim.implements) {
      const published = this.#procedureDefinitions.findCapabilityRequirement(
        implementation.capability,
        implementation.actionContractDigest,
      );
      if (!published) {
        throw new SkillRegistryError(
          "invalid-authorization",
          `release ${input.releaseDigest} cannot be approved because ${implementation.capability} at Action Contract ${implementation.actionContractDigest} is not published`,
        );
      }
      const canonicalRequirement: SkillRequirement = {
        capability: published.capability,
        actionContractDigest: published.actionContractDigest,
      };
      const compatibility = this.#releaseCompatibility.evaluate(
        input.releaseDigest,
        canonicalRequirement,
      );
      if (compatibility.status !== "COMPATIBLE") {
        throw new SkillRegistryError(
          "invalid-authorization",
          `release ${input.releaseDigest} cannot be approved: ${compatibility.reason}`,
        );
      }
    }
    return this.#repository.saveReleaseAuthorization({
      ...input,
      authorizedAt: this.#clock.now().toISOString(),
    });
  }

  revokeRelease(environment: string, releaseDigest: string): boolean {
    assertEnvironment(environment, "invalid-authorization");
    assertReleaseDigest(releaseDigest, "invalid-authorization");
    return this.#repository.removeReleaseAuthorization(environment, releaseDigest);
  }

  authorizeDeployment(input: DeploymentAuthorizationInput): DeploymentAuthorization {
    assertEnvironment(input.environment, "invalid-authorization");
    assertLogicalDeploymentKey(input.logicalDeploymentKey, "invalid-authorization");
    assertReleaseDigest(input.releaseDigest, "invalid-authorization");
    assertEnvelope(input.envelope, "invalid-authorization");
    assertAbsoluteIdentity(input.runtimeIdentity, "runtime identity", "invalid-authorization");
    assertAbsoluteIdentity(input.authorizedBy, "authorization actor", "invalid-authorization");
    const release = this.#requireRelease(input.releaseDigest);
    assertReleaseSupportsEnvelope(release.claim, input.envelope, "invalid-authorization");
    return this.#repository.saveDeploymentAuthorization({
      ...input,
      authorizedAt: this.#clock.now().toISOString(),
    });
  }

  revokeDeployment(
    environment: string,
    logicalDeploymentKey: string,
    releaseDigest: string,
    envelope: SkillEnvelope,
    runtimeIdentity: string,
  ): boolean {
    assertEnvironment(environment, "invalid-authorization");
    assertLogicalDeploymentKey(logicalDeploymentKey, "invalid-authorization");
    assertReleaseDigest(releaseDigest, "invalid-authorization");
    assertEnvelope(envelope, "invalid-authorization");
    assertAbsoluteIdentity(runtimeIdentity, "runtime identity", "invalid-authorization");
    return this.#repository.removeDeploymentAuthorization(
      environment,
      logicalDeploymentKey,
      releaseDigest,
      envelope,
      runtimeIdentity,
    );
  }

  selectDeployment(input: DeploymentSelectionInput): DeploymentSelection {
    assertEnvironment(input.environment, "invalid-selection");
    assertLogicalDeploymentKey(input.logicalDeploymentKey, "invalid-selection");
    if (!isCanonicalSkillAction(input.capability)) {
      invalid("invalid-selection", "capability must use canonical <domain>.<operation> syntax");
    }
    if (!isRawSha256(input.actionContractDigest)) {
      invalid("invalid-selection", "actionContractDigest must be 64 lowercase hex");
    }
    assertAbsoluteIdentity(input.selectedBy, "selection actor", "invalid-selection");
    return this.#repository.saveSelection({
      ...input,
      selectedAt: this.#clock.now().toISOString(),
    });
  }

  clearSelection(environment: string, requirement: SkillRequirement): boolean {
    assertEnvironment(environment, "invalid-selection");
    if (!isCanonicalSkillAction(requirement.capability)) {
      invalid("invalid-selection", "capability must use canonical <domain>.<operation> syntax");
    }
    if (!isRawSha256(requirement.actionContractDigest)) {
      invalid("invalid-selection", "actionContractDigest must be 64 lowercase hex");
    }
    return this.#repository.removeSelection(environment, requirement);
  }

  announceDeployment(announcement: DeploymentAnnouncement): RegisteredDeploymentAnnouncement {
    const now = this.#clock.now();
    assertDeploymentAnnouncement(announcement, now, this.#operabilityPolicy);
    const release = this.#requireRelease(announcement.releaseDigest);
    assertReleaseSupportsEnvelope(
      release.claim,
      announcement.envelope,
      "invalid-deployment-announcement",
    );

    const declaredProbes = new Set(release.claim.probes);
    if (announcement.probes.length !== declaredProbes.size) {
      invalid(
        "invalid-deployment-announcement",
        `deployment probes must match release ${announcement.releaseDigest} exactly`,
      );
    }
    for (const probe of announcement.probes) {
      if (!declaredProbes.has(probe.name)) {
        invalid(
          "invalid-deployment-announcement",
          `probe ${probe.name} is not declared by release ${announcement.releaseDigest}`,
        );
      }
    }

    const registered: RegisteredDeploymentAnnouncement = {
      ...announcement,
      recordedAt: now.toISOString(),
    };
    return this.#repository.saveDeploymentAnnouncement(registered, now.toISOString());
  }

  #requireRelease(releaseDigest: string): RegisteredSkillRelease {
    const release = this.#repository.findReleaseClaim(releaseDigest);
    if (!release) {
      throw new SkillRegistryError("unknown-release", `unknown Skill release: ${releaseDigest}`);
    }
    return release;
  }
}

function assertReleaseClaim(claim: SkillReleaseClaim): void {
  assertOnlyKeys(
    claim,
    ["skill", "version", "releaseDigest", "publisher", "implements", "entrypoints", "probes"],
    "release claim",
    "invalid-release-claim",
  );
  if (!isCanonicalSkill(claim.skill)) {
    invalid("invalid-release-claim", "skill must be a canonical dotted identifier");
  }
  if (!isExactSemanticVersion(claim.version)) {
    invalid("invalid-release-claim", "version must be an exact semantic version");
  }
  assertReleaseDigest(claim.releaseDigest, "invalid-release-claim");
  assertAbsoluteIdentity(claim.publisher, "publisher", "invalid-release-claim");
  if (claim.implements.length === 0) {
    invalid("invalid-release-claim", "a release must claim at least one capability");
  }

    const exactClaims = new Set<string>();
    for (const implementation of claim.implements) {
      assertOnlyKeys(
        implementation,
        ["capability", "actionContractDigest"],
        `capability claim ${implementation.capability}`,
        "invalid-release-claim",
      );
    if (!isCanonicalSkillAction(implementation.capability)) {
      invalid(
        "invalid-release-claim",
        `capability ${implementation.capability} must use canonical <domain>.<operation> syntax`,
      );
    }
    const exactClaim = `${implementation.capability}\0${implementation.actionContractDigest}`;
    if (exactClaims.has(exactClaim)) {
      invalid("invalid-release-claim", `capability ${implementation.capability} at this digest is claimed more than once`);
    }
    exactClaims.add(exactClaim);
    if (!isRawSha256(implementation.actionContractDigest)) {
      invalid(
        "invalid-release-claim",
        `Action Contract digest for ${implementation.capability} must be 64 lowercase hex`,
      );
    }
  }

  assertOnlyKeys(
    claim.entrypoints,
    ["cli", "mcpStdio", "mcpHttp"],
    "release entrypoints",
    "invalid-release-claim",
  );
  if (!Object.hasOwn(claim.entrypoints, "cli")) {
    invalid("invalid-release-claim", "cli entrypoint is required");
  }
  for (const [name, value] of Object.entries(claim.entrypoints)) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      invalid("invalid-release-claim", `${name} entrypoint must be a non-empty string`);
    }
  }

  if (claim.probes.length === 0) {
    invalid("invalid-release-claim", "a release must declare at least one bounded probe");
  }
  const probes = new Set<string>();
  for (const probe of claim.probes) {
    if (!isCanonicalProbe(probe)) {
      invalid("invalid-release-claim", `probe ${probe} must be a canonical slug`);
    }
    if (probes.has(probe)) {
      invalid("invalid-release-claim", `probe ${probe} is declared more than once`);
    }
    probes.add(probe);
  }
}

function canonicalReleaseClaim(claim: SkillReleaseClaim): SkillReleaseClaim {
  const implementations = claim.implements
    .map((implementation) => ({
      capability: implementation.capability,
      actionContractDigest: implementation.actionContractDigest,
    }))
    .sort((left, right) =>
      `${left.capability}\0${left.actionContractDigest}`.localeCompare(
        `${right.capability}\0${right.actionContractDigest}`,
      ),
    );
  return {
    skill: claim.skill,
    version: claim.version,
    releaseDigest: claim.releaseDigest,
    publisher: claim.publisher,
    implements: implementations,
    entrypoints: {
      cli: claim.entrypoints.cli,
      ...(claim.entrypoints.mcpStdio === undefined
        ? {}
        : { mcpStdio: claim.entrypoints.mcpStdio }),
      ...(claim.entrypoints.mcpHttp === undefined
        ? {}
        : { mcpHttp: claim.entrypoints.mcpHttp }),
    },
    probes: [...claim.probes].sort(),
  };
}

function assertDeploymentAnnouncement(
  announcement: DeploymentAnnouncement,
  recordedAt: Date,
  policy: SkillOperabilityPolicy,
): void {
  assertEnvironment(announcement.environment, "invalid-deployment-announcement");
  assertLogicalDeploymentKey(
    announcement.logicalDeploymentKey,
    "invalid-deployment-announcement",
  );
  assertEnvelope(announcement.envelope, "invalid-deployment-announcement");
  assertAbsoluteIdentity(
    announcement.runtimeIdentity,
    "runtime identity",
    "invalid-deployment-announcement",
  );
  assertAbsoluteIdentity(
    announcement.processIdentity,
    "process identity",
    "invalid-deployment-announcement",
  );
  if (sameAbsoluteIdentity(announcement.runtimeIdentity, announcement.processIdentity)) {
    invalid(
      "invalid-deployment-announcement",
      "process identity must be distinct from runtime identity",
    );
  }
  assertReleaseDigest(announcement.releaseDigest, "invalid-deployment-announcement");
  if (!isPrefixedSha256(announcement.distributionDigest)) {
    invalid(
      "invalid-deployment-announcement",
      "distributionDigest must be sha256:<64 lowercase hex>",
    );
  }

  assertInstant(
    announcement.announcedAt,
    "deployment announcedAt",
    "invalid-deployment-announcement",
  );
  assertInstant(
    announcement.leaseExpiresAt,
    "deployment lease expiry",
    "invalid-deployment-announcement",
  );
  if (Date.parse(announcement.leaseExpiresAt) <= Date.parse(announcement.announcedAt)) {
    invalid("invalid-deployment-announcement", "deployment lease must expire after announcedAt");
  }
  const recordedAtMs = recordedAt.getTime();
  const announcedAtMs = Date.parse(announcement.announcedAt);
  const leaseExpiresAtMs = Date.parse(announcement.leaseExpiresAt);
  if (announcedAtMs > recordedAtMs + policy.maxClockSkewMs) {
    invalid(
      "deployment-announcement-future",
      `deployment announcedAt exceeds the server clock by more than ${policy.maxClockSkewMs}ms`,
    );
  }
  if (leaseExpiresAtMs <= recordedAtMs) {
    invalid("invalid-deployment-announcement", "deployment lease is already expired at receipt");
  }
  if (leaseExpiresAtMs > recordedAtMs + policy.maxLeaseDurationMs) {
    invalid(
      "deployment-lease-too-long",
      `deployment lease exceeds the maximum duration of ${policy.maxLeaseDurationMs}ms from server receipt`,
    );
  }

  const probes = new Set<string>();
  for (const probe of announcement.probes) {
    if (!isCanonicalProbe(probe.name)) {
      invalid("invalid-deployment-announcement", `probe ${probe.name} must be a canonical slug`);
    }
    if (probes.has(probe.name)) {
      invalid(
        "invalid-deployment-announcement",
        `probe ${probe.name} appears more than once`,
      );
    }
    probes.add(probe.name);
    if (probe.status !== "PASS" && probe.status !== "FAIL") {
      invalid("invalid-deployment-announcement", `probe ${probe.name} has an invalid result`);
    }
    if (probe.reason.trim().length === 0) {
      invalid("invalid-deployment-announcement", `probe ${probe.name} must include a reason`);
    }
    assertInstant(
      probe.observedAt,
      `probe ${probe.name} observedAt`,
      "invalid-deployment-announcement",
    );
    if (Date.parse(probe.observedAt) > Date.parse(announcement.announcedAt)) {
      invalid(
        "invalid-deployment-announcement",
        `probe ${probe.name} cannot be observed after announcedAt`,
      );
    }
    if (Date.parse(probe.observedAt) > recordedAtMs + policy.maxClockSkewMs) {
      invalid(
        "deployment-announcement-future",
        `probe ${probe.name} observation exceeds the server clock by more than ${policy.maxClockSkewMs}ms`,
      );
    }
  }
}

function assertEnvelope(
  envelope: SkillEnvelope,
  code: "invalid-authorization" | "invalid-deployment-announcement",
): void {
  if (envelope !== "cli" && envelope !== "mcp-stdio" && envelope !== "mcp-http") {
    invalid(code, "envelope must be cli, mcp-stdio or mcp-http");
  }
}

function assertReleaseSupportsEnvelope(
  release: SkillReleaseClaim,
  envelope: SkillEnvelope,
  code: "invalid-authorization" | "invalid-deployment-announcement",
): void {
  const entrypoint = envelope === "cli"
    ? release.entrypoints.cli
    : envelope === "mcp-stdio"
      ? release.entrypoints.mcpStdio
      : release.entrypoints.mcpHttp;
  if (entrypoint === undefined) {
    invalid(
      code,
      `release ${release.releaseDigest} does not declare the ${envelope} envelope`,
    );
  }
}

function assertOperabilityPolicy(policy: SkillOperabilityPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxClockSkewMs) ||
    policy.maxClockSkewMs < 0 ||
    !Number.isSafeInteger(policy.maxLeaseDurationMs) ||
    policy.maxLeaseDurationMs <= 0 ||
    !Number.isSafeInteger(policy.maxProbeAgeMs) ||
    policy.maxProbeAgeMs <= 0
  ) {
    throw new Error("Skill operability policy durations must be bounded integer milliseconds");
  }
}

function assertEnvironment(
  environment: string,
  code: "invalid-authorization" | "invalid-selection" | "invalid-deployment-announcement",
): void {
  if (!isCanonicalRegistrySlug(environment)) {
    invalid(code, "environment must be a canonical slug");
  }
}

function assertLogicalDeploymentKey(
  logicalDeploymentKey: string,
  code: "invalid-authorization" | "invalid-selection" | "invalid-deployment-announcement",
): void {
  if (!isCanonicalRegistrySlug(logicalDeploymentKey)) {
    invalid(code, "logical deployment key must be a canonical slug");
  }
}

function assertReleaseDigest(
  releaseDigest: string,
  code:
    | "invalid-release-claim"
    | "invalid-authorization"
    | "invalid-deployment-announcement",
): void {
  if (!isPrefixedSha256(releaseDigest)) {
    invalid(code, "releaseDigest must be sha256:<64 lowercase hex>");
  }
}

function assertAbsoluteIdentity(
  identity: string,
  label: string,
  code:
    | "invalid-release-claim"
    | "invalid-distribution"
    | "invalid-authorization"
    | "invalid-selection"
    | "invalid-deployment-announcement",
): void {
  let parsed: URL;
  try {
    parsed = new URL(identity);
  } catch {
    invalid(code, `${label} must be an absolute URI`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    invalid(code, `${label} must not contain credentials, a query or a fragment`);
  }
}

function assertSignature(
  signature: string,
  label: string,
  code: "invalid-distribution",
): void {
  if (signature.trim().length === 0) {
    invalid(code, `${label} must be non-empty`);
  }
}

function assertOnlyKeys(
  value: object,
  allowed: readonly string[],
  label: string,
  code: "invalid-release-claim",
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected !== undefined) {
    invalid(code, `${label} contains unsupported field ${unexpected}`);
  }
}

function sameAbsoluteIdentity(left: string, right: string): boolean {
  return new URL(left).href === new URL(right).href;
}

function assertInstant(
  value: string,
  label: string,
  code: "invalid-distribution" | "invalid-deployment-announcement",
): void {
  if (!Number.isFinite(Date.parse(value))) {
    invalid(code, `${label} must be a valid timestamp`);
  }
}

function invalid(code: SkillRegistryError["code"], message: string): never {
  throw new SkillRegistryError(code, message);
}
