import type {
  ReleaseCompatibilityResult,
  SkillRequirement,
} from "../domain/skill-registry.js";
import {
  isCanonicalSkillAction,
  isPrefixedSha256,
  isRawSha256,
  SkillRegistryError,
} from "../domain/skill-registry.js";
import type { SkillRegistryRepository } from "../infrastructure/repositories/skill-registry-repository.js";
import type { Clock } from "../ports/clock.js";

export interface SkillReleaseCompatibilityServiceDependencies {
  readonly clock: Clock;
  readonly skillRegistryRepository: SkillRegistryRepository;
}

export class SkillReleaseCompatibilityService {
  readonly #clock: Clock;
  readonly #repository: SkillRegistryRepository;

  constructor({ clock, skillRegistryRepository }: SkillReleaseCompatibilityServiceDependencies) {
    this.#clock = clock;
    this.#repository = skillRegistryRepository;
  }

  evaluate(
    releaseDigest: string,
    requirement: SkillRequirement,
    evaluatedAt: Date = this.#clock.now(),
  ): ReleaseCompatibilityResult {
    assertSkillRequirement(requirement);
    if (!isPrefixedSha256(releaseDigest)) {
      throw new SkillRegistryError(
        "invalid-requirement",
        "releaseDigest must be sha256:<64 lowercase hex>",
      );
    }

    const base = {
      releaseDigest,
      requirement,
      evaluatedAt: evaluatedAt.toISOString(),
    };
    const release = this.#repository.findReleaseClaim(releaseDigest);
    if (!release) {
      return {
        ...base,
        status: "MISSING",
        reasonCode: "release-claim-missing",
        reason: `release ${releaseDigest} is not registered`,
      };
    }

    const capabilityClaims = release.claim.implements.filter(
      (candidate) => candidate.capability === requirement.capability,
    );
    if (capabilityClaims.length === 0) {
      return {
        ...base,
        status: "INCOMPATIBLE",
        reasonCode: "capability-not-implemented",
        reason: `release ${releaseDigest} does not claim capability ${requirement.capability}`,
      };
    }
    if (!capabilityClaims.some(
      (candidate) => candidate.actionContractDigest === requirement.actionContractDigest,
    )) {
      return {
        ...base,
        status: "INCOMPATIBLE",
        reasonCode: "action-contract-digest-mismatch",
        reason:
          `expected Action Contract ${requirement.actionContractDigest}; ` +
          `release claims ${capabilityClaims.map((candidate) => candidate.actionContractDigest).sort().join(", ")}`,
      };
    }

    return {
      ...base,
      status: "COMPATIBLE",
      reasonCode: "release-compatible",
      reason: `release ${releaseDigest} implements the exact Action Contract ${requirement.actionContractDigest}`,
    };
  }
}

export function assertSkillRequirement(requirement: SkillRequirement): void {
  if (!isCanonicalSkillAction(requirement.capability)) {
    throw new SkillRegistryError(
      "invalid-requirement",
      "capability must use canonical <domain>.<operation> syntax",
    );
  }
  if (!isRawSha256(requirement.actionContractDigest)) {
    throw new SkillRegistryError(
      "invalid-requirement",
      "actionContractDigest must be 64 lowercase hex",
    );
  }
}
