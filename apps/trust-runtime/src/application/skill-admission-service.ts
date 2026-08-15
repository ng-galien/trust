import type { Execution } from "../domain/runtime-model.js";
import type {
  SkillEnvelope,
  SkillRequirement,
} from "../domain/skill-registry.js";
import type { SkillRegistryRepository } from "../infrastructure/repositories/skill-registry-repository.js";
import type { SkillPreflightService } from "./skill-preflight-service.js";

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

export interface SkillAdmissionService {
  admit(request: SkillAdmissionRequest): SkillAdmissionDecision;
  ownsExecution(execution: Execution, caller: SkillCaller): boolean;
}

export class LocalSkillAdmissionService implements SkillAdmissionService {
  admit(_request: SkillAdmissionRequest): SkillAdmissionDecision {
    return { status: "ADMITTED" };
  }

  ownsExecution(_execution: Execution, _caller: SkillCaller): boolean {
    return true;
  }
}

export interface VerifiedSkillAdmissionServiceDependencies {
  readonly skillPreflightService: SkillPreflightService;
  readonly skillRegistryRepository: SkillRegistryRepository;
}

export class VerifiedSkillAdmissionService implements SkillAdmissionService {
  readonly #preflight: SkillPreflightService;
  readonly #registry: SkillRegistryRepository;

  constructor({
    skillPreflightService,
    skillRegistryRepository,
  }: VerifiedSkillAdmissionServiceDependencies) {
    this.#preflight = skillPreflightService;
    this.#registry = skillRegistryRepository;
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

  ownsExecution(execution: Execution, caller: SkillCaller): boolean {
    return execution.runtimeIdentity === caller.runtimeIdentity
      && execution.processIdentity === caller.processIdentity;
  }
}
