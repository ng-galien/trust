import type { Attempt } from "../model.js";
import type {
  SkillEnvelope,
  SkillRequirement,
} from "./model.js";
import type { SkillStore } from "../sqlite/skills.js";
import type { SkillPreflight } from "./preflight.js";

export type SkillPolicy = "local" | "verified";

export interface SkillAdmissionRequest {
  readonly environment: string;
  readonly requirement: SkillRequirement;
  readonly releaseDigest: string;
  readonly deploymentKey: string;
  readonly envelope: SkillEnvelope;
  readonly runtimeIdentity: string;
  readonly processIdentity: string;
}

export type SkillAdmissionDecision =
  | { readonly status: "ADMITTED"; readonly leaseExpiresAt?: string }
  | { readonly status: "REFUSED"; readonly reasonCode: string; readonly reason: string };

export interface SkillCaller {
  readonly runtimeIdentity: string;
  readonly processIdentity: string;
}

export interface SkillAdmission {
  admit(request: SkillAdmissionRequest): SkillAdmissionDecision;
  ownsAttempt(attempt: Attempt, caller: SkillCaller): boolean;
}

export class LocalSkillAdmission implements SkillAdmission {
  admit(_request: SkillAdmissionRequest): SkillAdmissionDecision {
    return { status: "ADMITTED" };
  }

  ownsAttempt(_attempt: Attempt, _caller: SkillCaller): boolean {
    return true;
  }
}

export interface VerifiedSkillAdmissionDependencies {
  readonly skillPreflight: SkillPreflight;
  readonly skillStore: SkillStore;
}

export class VerifiedSkillAdmission implements SkillAdmission {
  readonly #preflight: SkillPreflight;
  readonly #registry: SkillStore;

  constructor({
    skillPreflight,
    skillStore,
  }: VerifiedSkillAdmissionDependencies) {
    this.#preflight = skillPreflight;
    this.#registry = skillStore;
  }

  admit(request: SkillAdmissionRequest): SkillAdmissionDecision {
    const preflight = this.#preflight.evaluateRequirement(
      request.environment,
      request.requirement,
    );
    if (preflight.status !== "READY") {
      return {
        status: "REFUSED",
        reasonCode: preflight.reasonCode,
        reason: preflight.reason,
      };
    }
    const deployment = preflight.logicalDeploymentKey
      ? this.#registry.findDeploymentAnnouncement(
          request.environment,
          preflight.logicalDeploymentKey,
        )
      : undefined;
    if (
      !deployment
      || preflight.logicalDeploymentKey !== request.deploymentKey
      || preflight.releaseDigest !== request.releaseDigest
      || deployment.envelope !== request.envelope
      || deployment.runtimeIdentity !== request.runtimeIdentity
      || deployment.processIdentity !== request.processIdentity
    ) {
      return {
        status: "REFUSED",
        reasonCode: "deployment-identity-mismatch",
        reason: "the calling Skill process does not match the selected READY deployment",
      };
    }
    return { status: "ADMITTED", leaseExpiresAt: deployment.leaseExpiresAt };
  }

  ownsAttempt(attempt: Attempt, caller: SkillCaller): boolean {
    return attempt.owner.kind === "skill"
      && attempt.owner.runtimeIdentity === caller.runtimeIdentity
      && attempt.owner.processIdentity === caller.processIdentity;
  }
}
