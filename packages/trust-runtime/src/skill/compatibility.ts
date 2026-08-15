import type {
  ReleaseCompatibilityResult,
  SkillRequirement,
} from "./model.js";
import {
  isCanonicalCapability,
  isPrefixedSha256,
  isRawSha256,
  SkillRegistryError,
} from "./model.js";
import type { SkillStore } from "../sqlite/skills.js";
import type { Clock } from "../time.js";

export interface SkillCompatibilityDependencies {
  readonly clock: Clock;
  readonly skillStore: SkillStore;
}

export class SkillCompatibility {
  readonly #clock: Clock;
  readonly #store: SkillStore;

  constructor({ clock, skillStore }: SkillCompatibilityDependencies) {
    this.#clock = clock;
    this.#store = skillStore;
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
    const release = this.#store.findReleaseClaim(releaseDigest);
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
  if (!isCanonicalCapability(requirement.capability)) {
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
