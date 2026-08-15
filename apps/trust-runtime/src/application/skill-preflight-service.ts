import type {
  EnvironmentPreflightResult,
  PreflightReasonCode,
  PreflightRequirementResult,
  PreflightStatus,
  SkillOperabilityPolicy,
  SkillRequirement,
} from "../domain/skill-registry.js";
import {
  isCanonicalRegistrySlug,
  SkillRegistryError,
} from "../domain/skill-registry.js";
import type { SkillRegistryRepository } from "../infrastructure/repositories/skill-registry-repository.js";
import type { Clock } from "../ports/clock.js";
import {
  assertSkillRequirement,
  type SkillReleaseCompatibilityService,
} from "./skill-release-compatibility-service.js";

export interface SkillPreflightServiceDependencies {
  readonly clock: Clock;
  readonly skillOperabilityPolicy: SkillOperabilityPolicy;
  readonly skillRegistryRepository: SkillRegistryRepository;
  readonly skillReleaseCompatibilityService: SkillReleaseCompatibilityService;
}

export class SkillPreflightService {
  readonly #clock: Clock;
  readonly #operabilityPolicy: SkillOperabilityPolicy;
  readonly #repository: SkillRegistryRepository;
  readonly #compatibility: SkillReleaseCompatibilityService;

  constructor({
    clock,
    skillOperabilityPolicy,
    skillRegistryRepository,
    skillReleaseCompatibilityService,
  }: SkillPreflightServiceDependencies) {
    this.#clock = clock;
    this.#operabilityPolicy = skillOperabilityPolicy;
    this.#repository = skillRegistryRepository;
    this.#compatibility = skillReleaseCompatibilityService;
  }

  evaluateRequirement(
    environment: string,
    requirement: SkillRequirement,
  ): PreflightRequirementResult {
    const evaluatedAt = this.#clock.now();
    return this.#evaluateRequirement(environment, requirement, evaluatedAt);
  }

  evaluateEnvironment(
    environment: string,
    requirements: readonly SkillRequirement[],
  ): EnvironmentPreflightResult {
    assertEnvironment(environment);
    if (requirements.length === 0) {
      throw new SkillRegistryError(
        "invalid-requirement",
        "environment preflight requires at least one exact Skill requirement",
      );
    }
    const exactRequirements = new Set<string>();
    for (const requirement of requirements) {
      assertSkillRequirement(requirement);
      const key = [
        requirement.capability,
        requirement.actionContractDigest,
      ].join("\0");
      if (exactRequirements.has(key)) {
        throw new SkillRegistryError(
          "invalid-requirement",
          `environment preflight repeats requirement ${requirement.capability}`,
        );
      }
      exactRequirements.add(key);
    }
    const evaluatedAt = this.#clock.now();
    const results = requirements.map((requirement) =>
      this.#evaluateRequirement(environment, requirement, evaluatedAt),
    );
    return {
      environment,
      status: results.every((result) => result.status === "READY") ? "READY" : "NOT_OPERABLE",
      requirements: results,
      evaluatedAt: evaluatedAt.toISOString(),
      authorizesPlanEngagement: false,
    };
  }

  #evaluateRequirement(
    environment: string,
    requirement: SkillRequirement,
    evaluatedAt: Date,
  ): PreflightRequirementResult {
    assertEnvironment(environment);
    assertSkillRequirement(requirement);
    const selection = this.#repository.findSelection(environment, requirement);
    if (!selection) {
      return result(
        environment,
        requirement,
        evaluatedAt,
        "MISSING",
        "deployment-selection-missing",
        `no logical deployment is explicitly selected for ${requirement.capability} and its exact Action Contract`,
      );
    }

    const deployment = this.#repository.findDeploymentAnnouncement(
      environment,
      selection.logicalDeploymentKey,
    );
    if (!deployment) {
      return result(
        environment,
        requirement,
        evaluatedAt,
        "UNAVAILABLE",
        "deployment-announcement-missing",
        `selected deployment ${selection.logicalDeploymentKey} has no current announcement`,
        { logicalDeploymentKey: selection.logicalDeploymentKey },
      );
    }

    const registeredRelease = this.#repository.findReleaseClaim(deployment.releaseDigest);
    const deploymentContext = {
      logicalDeploymentKey: selection.logicalDeploymentKey,
      releaseDigest: deployment.releaseDigest,
      envelope: deployment.envelope,
      ...(registeredRelease === undefined
        ? {}
        : {
            skill: registeredRelease.claim.skill,
            version: registeredRelease.claim.version,
          }),
    };
    const compatibility = this.#compatibility.evaluate(
      deployment.releaseDigest,
      requirement,
      evaluatedAt,
    );
    if (compatibility.status === "MISSING") {
      return result(
        environment,
        requirement,
        evaluatedAt,
        "MISSING",
        compatibility.reasonCode,
        compatibility.reason,
        deploymentContext,
      );
    }
    if (compatibility.status === "INCOMPATIBLE") {
      return result(
        environment,
        requirement,
        evaluatedAt,
        "INCOMPATIBLE",
        compatibility.reasonCode,
        compatibility.reason,
        deploymentContext,
      );
    }

    const distribution = this.#repository.findVerifiedDistribution(
      deployment.distributionDigest,
    );
    if (!distribution || distribution.releaseDigest !== deployment.releaseDigest) {
      return result(
        environment,
        requirement,
        evaluatedAt,
        "INCOMPATIBLE",
        "distribution-release-link-missing",
        `distribution ${deployment.distributionDigest} is not verifiably linked to release ${deployment.releaseDigest}`,
        deploymentContext,
      );
    }

    if (!this.#repository.findReleaseAuthorization(environment, deployment.releaseDigest)) {
      return result(
        environment,
        requirement,
        evaluatedAt,
        "UNAUTHORIZED",
        "release-unauthorized",
        `release ${deployment.releaseDigest} and its publisher are not authorized in ${environment}`,
        deploymentContext,
      );
    }
    if (
      !this.#repository.findDeploymentAuthorization(
        environment,
        selection.logicalDeploymentKey,
        deployment.releaseDigest,
        deployment.envelope,
        deployment.runtimeIdentity,
      )
    ) {
      return result(
        environment,
        requirement,
        evaluatedAt,
        "UNAUTHORIZED",
        "deployment-unauthorized",
        `deployment ${selection.logicalDeploymentKey} is not authorized for release ${deployment.releaseDigest}`,
        deploymentContext,
      );
    }

    if (Date.parse(deployment.leaseExpiresAt) <= evaluatedAt.getTime()) {
      return result(
        environment,
        requirement,
        evaluatedAt,
        "UNAVAILABLE",
        "deployment-lease-expired",
        `deployment ${selection.logicalDeploymentKey} lease expired at ${deployment.leaseExpiresAt}`,
        deploymentContext,
      );
    }

    if (!registeredRelease) {
      return result(
        environment,
        requirement,
        evaluatedAt,
        "MISSING",
        "release-claim-missing",
        `release ${deployment.releaseDigest} is not registered`,
        deploymentContext,
      );
    }
    const probes = new Map(deployment.probes.map((probe) => [probe.name, probe]));
    for (const probeName of registeredRelease.claim.probes) {
      const probe = probes.get(probeName);
      if (!probe) {
        return result(
          environment,
          requirement,
          evaluatedAt,
          "UNAVAILABLE",
          "probe-missing",
          `deployment ${selection.logicalDeploymentKey} did not report required probe ${probeName}`,
          deploymentContext,
        );
      }
      if (evaluatedAt.getTime() - Date.parse(probe.observedAt) > this.#operabilityPolicy.maxProbeAgeMs) {
        return result(
          environment,
          requirement,
          evaluatedAt,
          "UNAVAILABLE",
          "probe-stale",
          `deployment ${selection.logicalDeploymentKey} probe ${probeName} exceeds the maximum age of ${this.#operabilityPolicy.maxProbeAgeMs}ms at preflight evaluation`,
          deploymentContext,
        );
      }
      if (probe.status === "FAIL") {
        return result(
          environment,
          requirement,
          evaluatedAt,
          "UNAVAILABLE",
          "probe-failed",
          `deployment ${selection.logicalDeploymentKey} probe ${probeName} failed: ${probe.reason}`,
          deploymentContext,
        );
      }
    }

    return result(
      environment,
      requirement,
      evaluatedAt,
      "READY",
      "deployment-ready",
      `deployment ${selection.logicalDeploymentKey} is selected, compatible, authorized and available`,
      deploymentContext,
    );
  }
}

interface ResultContext {
  readonly logicalDeploymentKey?: string;
  readonly releaseDigest?: string;
  readonly skill?: string;
  readonly version?: string;
  readonly envelope?: PreflightRequirementResult["envelope"];
}

function result(
  environment: string,
  requirement: SkillRequirement,
  evaluatedAt: Date,
  status: PreflightStatus,
  reasonCode: PreflightReasonCode,
  reason: string,
  context: ResultContext = {},
): PreflightRequirementResult {
  return {
    environment,
    requirement,
    status,
    reasonCode,
    reason,
    evaluatedAt: evaluatedAt.toISOString(),
    authorizesPlanEngagement: false,
    ...(context.logicalDeploymentKey === undefined
      ? {}
      : { logicalDeploymentKey: context.logicalDeploymentKey }),
    ...(context.releaseDigest === undefined ? {} : { releaseDigest: context.releaseDigest }),
    ...(context.skill === undefined ? {} : { skill: context.skill }),
    ...(context.version === undefined ? {} : { version: context.version }),
    ...(context.envelope === undefined ? {} : { envelope: context.envelope }),
  };
}

function assertEnvironment(environment: string): void {
  if (!isCanonicalRegistrySlug(environment)) {
    throw new SkillRegistryError(
      "invalid-requirement",
      "environment must be a canonical lowercase slug",
    );
  }
}
