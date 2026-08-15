import { createHash, randomUUID } from "node:crypto";

import {
  checkDependenciesSatisfied,
  checkIsActionable,
} from "../domain/check-actionability.js";
import {
  qualifyValidatedFactBatch,
  validateFactsForCheck,
} from "../domain/check-qualification.js";
import {
  materializePlanRevision,
  replaceValidatedFactBatch,
  validateAgentDeclarations,
} from "../domain/plan-materialization.js";
import type {
  ActiveCheckQualification,
  CheckSnapshot,
  Execution,
  Fact,
  MaterializedCheck,
  MaterializedPlanRevision,
  MaterializedRoleIncarnation,
  MaterializationOutputContract,
  RuntimeJsonObject,
  SkillMaterializationOutputGrant,
} from "../domain/runtime-model.js";
import type { SkillEnvelope } from "../domain/skill-registry.js";
import type {
  CompiledAutonomousProcedureDefinition,
  CompiledAutonomousResourceRole,
} from "@trust/procedure";
import type { CheckSnapshotRepository } from "../infrastructure/repositories/check-snapshot-repository.js";
import type { ExecutionRepository } from "../infrastructure/repositories/execution-repository.js";
import type { FactRepository } from "../infrastructure/repositories/fact-repository.js";
import type { PlanRepository } from "../infrastructure/repositories/plan-repository.js";
import type { SessionRepository } from "../infrastructure/repositories/session-repository.js";
import type { ProcedureDefinitionService } from "./procedure-definition-service.js";
import type { Clock } from "../ports/clock.js";
import type { DatabaseDriver } from "../ports/database.js";
import type { SkillAdmissionService } from "./skill-admission-service.js";
import type { CompiledOperation } from "@trust/operation";
import type { ExecutionDefinitionService } from "./execution-definition-service.js";

const SESSION_DURATION_MS = 24 * 60 * 60 * 1_000;
const RUNNER_RELEASE_DIGEST = `sha256:${"0".repeat(64)}`;
const RUNNER_DEPLOYMENT_KEY = "trust-runner";
const RUNNER_RUNTIME_IDENTITY = "urn:trust:local:runner";
const RUNNER_PROCESS_IDENTITY = "urn:trust:local:runner-process";
export type PlanRuntimeErrorCode =
  | "invalid-plan-engagement"
  | "invalid-plan-declarations"
  | "procedure-not-found"
  | "plan-conflict"
  | "check-not-found"
  | "fact-batch-rejected"
  | "execution-not-found"
  | "facts-missing";

export class PlanRuntimeError extends Error {
  constructor(
    readonly code: PlanRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlanRuntimeError";
  }
}

export interface PlanEngagementInput {
  readonly contract: "trust.plan-engagement-request@1";
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly plan: string;
  readonly environment: string;
  readonly rootInputs: RuntimeJsonObject;
}

export interface PlanEngagementResult {
  readonly contract: "trust.plan-engagement@1";
  readonly status: "ENGAGED";
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly plan: string;
  readonly environment: string;
  readonly revision: number;
  readonly checkUris: readonly string[];
}

export interface PlanDeclarationReplacementInput {
  readonly contract: "trust.plan-declaration-replacement-request@1";
  readonly plan: string;
  readonly expectedRevision: number;
  /** Complete current snapshot for every Feature role declared by the agent. */
  readonly declarations: RuntimeJsonObject;
}

export interface PlanDeclarationReplacementResult {
  readonly contract: "trust.plan-declaration-replacement@1";
  readonly status: "REPLACED";
  readonly plan: string;
  readonly revision: number;
  readonly declarations: RuntimeJsonObject;
  readonly checkUris: readonly string[];
  readonly removedCheckUris: readonly string[];
  readonly openedCheckUris: readonly string[];
}

export interface SkillAttemptAdmissionInput {
  readonly contract: "trust.skill-admission-request@1";
  readonly attemptKey: string;
  readonly checkUri: string;
  readonly releaseDigest: string;
  readonly environment: string;
  readonly deploymentKey: string;
  readonly envelope: SkillEnvelope;
  readonly runtimeIdentity: string;
  readonly processIdentity: string;
}

export interface CheckAttemptAdmissionInput {
  readonly contract: "trust.check-admission-request@1";
  readonly attemptKey: string;
  readonly checkUri: string;
}

export type CheckAttemptAdmissionResult =
  | {
      readonly contract: "trust.check-admission@1";
      readonly status: "ADMITTED";
      readonly attemptKey: string;
      readonly executionHandle: string;
      readonly checkUri: string;
      readonly capability: string;
      readonly actionInput: RuntimeJsonObject;
      readonly materializationContract: readonly SkillMaterializationOutputGrant[];
      readonly operation: CompiledOperation;
      readonly environment: RuntimeJsonObject;
      readonly expiresAt: string;
    }
  | {
      readonly contract: "trust.check-admission@1";
      readonly status: "REFUSED";
      readonly attemptKey: string;
      readonly reasonCode: string;
      readonly reason: string;
    };

export type SkillAttemptAdmissionResult =
  | {
      readonly contract: "trust.skill-admission@1";
      readonly status: "ADMITTED";
      readonly attemptKey: string;
      readonly executionHandle: string;
      readonly checkUri: string;
      readonly capability: string;
      readonly actionContractDigest: string;
      readonly actionInput: RuntimeJsonObject;
      readonly materializationContract: readonly SkillMaterializationOutputGrant[];
      readonly releaseDigest: string;
      readonly environment: string;
      readonly deploymentKey: string;
      readonly envelope: SkillEnvelope;
      readonly runtimeIdentity: string;
      readonly processIdentity: string;
      readonly expiresAt: string;
    }
  | {
      readonly contract: "trust.skill-admission@1";
      readonly status: "REFUSED";
      readonly attemptKey: string;
      readonly reasonCode: string;
      readonly reason: string;
    };

export interface SkillFactBatchInput {
  readonly attemptKey: string;
  readonly executionHandle: string;
  readonly checkUri: string;
  readonly releaseDigest: string;
  readonly environment: string;
  readonly deploymentKey: string;
  readonly envelope: SkillEnvelope;
  readonly runtimeIdentity: string;
  readonly processIdentity: string;
  readonly facts: readonly RuntimeJsonObject[];
  readonly recordedAt: string;
}

export interface CheckFactBatchInput {
  readonly attemptKey: string;
  readonly executionHandle: string;
  readonly checkUri: string;
  readonly facts: readonly RuntimeJsonObject[];
  readonly recordedAt: string;
}

export interface SkillFactBatchResult {
  readonly acceptedFactIds: readonly string[];
  readonly duplicateFactIds: readonly string[];
}

export interface SkillFinalizationResult {
  readonly contract: "trust.skill-finalization@1";
  readonly executionHandle: string;
  readonly verdict: "VALIDATED" | "NOT_VALIDATED";
  readonly reasonCode: string;
  readonly reason: string;
  readonly checklistDelta: {
    readonly newlySatisfied: readonly string[];
    readonly newlyOpened: readonly string[];
    readonly unchanged: readonly string[];
  };
}

export interface SkillFinalizationCaller {
  readonly runtimeIdentity: string;
  readonly processIdentity: string;
}

export interface PlanRuntimeServiceDependencies {
  readonly clock: Clock;
  readonly databaseDriver: DatabaseDriver;
  readonly semanticAuthority: string;
  readonly procedureDefinitionService: ProcedureDefinitionService;
  readonly planRepository: PlanRepository;
  readonly sessionRepository: SessionRepository;
  readonly executionRepository: ExecutionRepository;
  readonly factRepository: FactRepository;
  readonly checkSnapshotRepository: CheckSnapshotRepository;
  readonly skillAdmissionService: SkillAdmissionService;
  readonly executionDefinitionService: ExecutionDefinitionService;
}

export class PlanRuntimeService {
  readonly #clock: Clock;
  readonly #database: DatabaseDriver;
  readonly #semanticAuthority: string;
  readonly #procedures: ProcedureDefinitionService;
  readonly #plans: PlanRepository;
  readonly #sessions: SessionRepository;
  readonly #executions: ExecutionRepository;
  readonly #facts: FactRepository;
  readonly #snapshots: CheckSnapshotRepository;
  readonly #skillAdmission: SkillAdmissionService;
  readonly #executionDefinitions: ExecutionDefinitionService;

  constructor(dependencies: PlanRuntimeServiceDependencies) {
    this.#clock = dependencies.clock;
    this.#database = dependencies.databaseDriver;
    this.#semanticAuthority = dependencies.semanticAuthority;
    this.#procedures = dependencies.procedureDefinitionService;
    this.#plans = dependencies.planRepository;
    this.#sessions = dependencies.sessionRepository;
    this.#executions = dependencies.executionRepository;
    this.#facts = dependencies.factRepository;
    this.#snapshots = dependencies.checkSnapshotRepository;
    this.#skillAdmission = dependencies.skillAdmissionService;
    this.#executionDefinitions = dependencies.executionDefinitionService;
  }

  engage(input: PlanEngagementInput): PlanEngagementResult {
    if (input.contract !== "trust.plan-engagement-request@1") {
      throw new PlanRuntimeError(
        "invalid-plan-engagement",
        "Plan engagement contract is unsupported",
      );
    }
    const published = this.#procedures.find(input.procedure, input.procedureVersion);
    if (!published) {
      throw new PlanRuntimeError(
        "procedure-not-found",
        `procedure ${input.procedure}@${input.procedureVersion} is not published`,
      );
    }

    let materialized;
    try {
      materialized = materializePlanRevision({
        authority: this.#semanticAuthority,
        definition: published.definition,
        planSlug: input.plan,
        environment: input.environment,
        rootInputs: input.rootInputs,
        revision: 1,
      });
    } catch (error) {
      throw new PlanRuntimeError(
        "invalid-plan-engagement",
        error instanceof Error ? error.message : "Plan engagement is invalid",
        { cause: error },
      );
    }

    const existing = this.#plans.findPlan(input.plan);
    if (existing) {
      if (
        existing.procedure !== input.procedure
        || existing.procedureVersion !== input.procedureVersion
        || existing.environment !== input.environment
        || canonicalJson(existing.rootInputs) !== canonicalJson(materialized.rootInputs)
        || this.#plans.findRevision(input.plan, existing.currentRevision)?.definitionDigest
          !== published.definition.definitionDigest
      ) {
        throw new PlanRuntimeError(
          "plan-conflict",
          `Plan ${input.plan} is already engaged with another immutable definition or context`,
        );
      }
      this.#ensureOpenSession(input.plan);
      const current = this.#plans.findMaterializedRevision(
        input.plan,
        existing.currentRevision,
      );
      if (!current) {
        throw new PlanRuntimeError(
          "plan-conflict",
          `Plan ${input.plan} has no readable current revision`,
        );
      }
      return engagementResult(existing.currentRevision, current, input);
    }

    const now = this.#now();
    this.#database.transaction(() => {
      this.#plans.saveMaterializedRevision(materialized, now.toISOString());
      this.#sessions.create({
        id: randomUUID(),
        planSlug: input.plan,
        state: "open",
        openedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_DURATION_MS).toISOString(),
      });
    });
    return engagementResult(1, materialized, input);
  }

  replaceDeclarations(
    input: PlanDeclarationReplacementInput,
  ): PlanDeclarationReplacementResult {
    if (input.contract !== "trust.plan-declaration-replacement-request@1") {
      throw new PlanRuntimeError(
        "invalid-plan-declarations",
        "Plan declaration replacement contract is unsupported",
      );
    }
    const plan = this.#plans.findPlan(input.plan);
    if (!plan) {
      throw new PlanRuntimeError("plan-conflict", `Plan ${input.plan} is not engaged`);
    }
    if (plan.currentRevision !== input.expectedRevision) {
      throw new PlanRuntimeError(
        "plan-conflict",
        `Plan ${input.plan} is at revision ${plan.currentRevision}, not ${input.expectedRevision}`,
      );
    }
    const current = this.#plans.findMaterializedRevision(plan.slug, plan.currentRevision);
    const published = this.#procedures.find(plan.procedure, plan.procedureVersion);
    if (!current || !published) {
      throw new PlanRuntimeError(
        "plan-conflict",
        `Plan ${input.plan} has no readable current procedure revision`,
      );
    }

    let declarations: RuntimeJsonObject;
    try {
      declarations = validateAgentDeclarations(
        published.definition.roles,
        plan.rootInputs,
        input.declarations,
      );
    } catch (error) {
      throw new PlanRuntimeError(
        "invalid-plan-declarations",
        error instanceof Error ? error.message : "Plan declarations are invalid",
        { cause: error },
      );
    }
    if (canonicalJson(declarations) === canonicalJson(current.agentDeclarations)) {
      this.#ensureOpenSession(plan.slug);
      return declarationReplacementResult(current, current, declarations);
    }

    const nextPlanRevision = plan.currentRevision + 1;
    const changedRoles = changedDeclarationRoles(current.agentDeclarations, declarations);
    const activations = declarationActivations(
      current.agentDeclarationActivations,
      declarations,
      changedRoles,
      plan.slug,
      nextPlanRevision,
    );
    const invalidated = declarationDependentCheckUris(current.checks, changedRoles);
    const materializationState = withoutInvalidatedProviders(current, invalidated);
    const activeBefore = this.#snapshots.listActive(plan.slug, current.revision);
    const plannedActive = activeBefore
      .filter((entry) => !invalidated.has(entry.checkUri))
      .map((entry) => ({
        planSlug: plan.slug,
        planRevision: nextPlanRevision,
        checkUri: entry.checkUri,
        activationDigest: entry.activationDigest,
      }));
    let nextRevision: MaterializedPlanRevision;
    try {
      nextRevision = materializePlanRevision({
        authority: this.#semanticAuthority,
        definition: published.definition,
        planSlug: plan.slug,
        environment: plan.environment,
        rootInputs: plan.rootInputs,
        agentDeclarations: declarations,
        agentDeclarationActivations: activations,
        revision: nextPlanRevision,
        materializationState,
        instantiatedChecks: current.checks,
        authoritativelyRemovedAgentDeclarations: removedAgentDeclarationTargets(
          published.definition.roles,
          current.agentDeclarations,
          declarations,
        ),
        activeQualifications: plannedActive,
      });
    } catch (error) {
      throw new PlanRuntimeError(
        "invalid-plan-declarations",
        error instanceof Error ? error.message : "Plan declarations cannot be materialized",
        { cause: error },
      );
    }

    const nextChecks = new Map(nextRevision.checks.map((check) => [check.uri, check]));
    const activeAfter = activeBefore
      .filter((entry) => !invalidated.has(entry.checkUri))
      .filter((entry) => nextChecks.get(entry.checkUri)?.compiledCheckDigest === entry.compiledCheckDigest)
      .map((entry) => ({ ...entry, planRevision: nextPlanRevision }));
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      const latest = this.#plans.findPlan(plan.slug);
      if (latest?.currentRevision !== input.expectedRevision) {
        throw new PlanRuntimeError(
          "plan-conflict",
          `Plan ${input.plan} changed while declarations were being replaced`,
        );
      }
      this.#plans.saveMaterializedRevision(nextRevision, now);
      this.#snapshots.saveActiveForRevision(plan.slug, nextPlanRevision, activeAfter);
    });
    this.#ensureOpenSession(plan.slug);
    return declarationReplacementResult(current, nextRevision, declarations);
  }

  admit(input: SkillAttemptAdmissionInput): SkillAttemptAdmissionResult {
    if (input.contract !== "trust.skill-admission-request@1") {
      return refused(input.attemptKey, "invalid-admission-contract", "unsupported admission contract");
    }
    const existing = this.#executions.findByAttemptKey(input.attemptKey);
    if (existing) {
      return executionMatchesAdmission(existing, input)
        ? admitted(existing)
        : refused(
            input.attemptKey,
            "attempt-key-conflict",
            "attemptKey is already bound to another immutable delegation",
          );
    }

    const check = this.#plans.findCurrentCheck(input.checkUri);
    if (!check) {
      return refused(input.attemptKey, "check-not-found", "the semantic Check URI is unknown");
    }
    const plan = this.#plans.findPlan(check.planSlug);
    if (!plan || plan.environment !== input.environment) {
      return refused(
        input.attemptKey,
        "environment-mismatch",
        "the requested environment does not own this Check",
      );
    }
    const currentChecks = this.#plans.listCurrentChecks(check.planSlug);
    const satisfied = this.#activeCheckUris(check.planSlug);
    if (!checkDependenciesSatisfied(check, currentChecks, (uri) => satisfied.has(uri))) {
      return refused(
        input.attemptKey,
        "check-not-actionable",
        "the Check dependencies are not yet satisfied",
      );
    }
    if (check.checkDependencies.some((dependency) => dependency.observationDigest === undefined)) {
      return refused(
        input.attemptKey,
        "check-not-actionable",
        "the upstream Check observations are not yet available",
      );
    }
    const capability = check.template.capabilityContract.capability;
    const published = this.#procedures.find(plan.procedure, plan.procedureVersion);
    const publishedRequirement = published?.definition.requiredCapabilities.find(
      (candidate) =>
        candidate.capability === capability
        && candidate.actionContractDigest === check.template.capabilityContract.digest,
    );
    if (!publishedRequirement) {
      return refused(
        input.attemptKey,
        "published-capability-missing",
        "the current Check has no exact capability contract in its published Feature",
      );
    }
    const skillAdmission = this.#skillAdmission.admit({
      environment: input.environment,
      requirement: {
        capability: publishedRequirement.capability,
        actionContractDigest: publishedRequirement.actionContractDigest,
      },
      releaseDigest: input.releaseDigest,
      deploymentKey: input.deploymentKey,
      envelope: input.envelope,
      runtimeIdentity: input.runtimeIdentity,
      processIdentity: input.processIdentity,
    });
    if (skillAdmission.status === "REFUSED") {
      return refused(input.attemptKey, skillAdmission.reasonCode, skillAdmission.reason);
    }
    const session = this.#sessions.findOpen(plan.slug);
    const now = this.#now();
    if (!session || Date.parse(session.expiresAt) <= now.getTime()) {
      return refused(input.attemptKey, "session-unavailable", "the Plan has no active Session");
    }
    const execution: Execution = {
      handle: randomUUID(),
      attemptKey: input.attemptKey,
      planSlug: check.planSlug,
      planRevision: check.planRevision,
      checkUri: input.checkUri,
      compiledCheckDigest: check.compiledCheckDigest,
      sessionId: session.id,
      capability,
      actionContractDigest: publishedRequirement.actionContractDigest,
      actionInput: check.actionInput,
      materializationContract: check.materializationContract,
      releaseDigest: input.releaseDigest,
      environment: input.environment,
      deploymentKey: input.deploymentKey,
      envelope: input.envelope,
      runtimeIdentity: input.runtimeIdentity,
      processIdentity: input.processIdentity,
      state: "pending",
      grantedAt: now.toISOString(),
      expiresAt: skillAdmission.leaseExpiresAt === undefined
        ? session.expiresAt
        : new Date(
            Math.min(Date.parse(session.expiresAt), Date.parse(skillAdmission.leaseExpiresAt)),
          ).toISOString(),
    };
    this.#database.transaction(() => this.#executions.create(execution));
    return admitted(execution);
  }

  admitCheck(input: CheckAttemptAdmissionInput): CheckAttemptAdmissionResult {
    if (input.contract !== "trust.check-admission-request@1") {
      return checkRefused(input.attemptKey, "invalid-admission-contract", "unsupported admission contract");
    }
    const check = this.#plans.findCurrentCheck(input.checkUri);
    if (!check) {
      return checkRefused(input.attemptKey, "check-not-found", "the semantic Check URI is unknown");
    }
    const plan = this.#plans.findPlan(check.planSlug);
    if (!plan) {
      return checkRefused(input.attemptKey, "check-not-found", "the semantic Check URI is unknown");
    }
    const capability = check.template.capabilityContract.capability;
    const operation = this.#executionDefinitions.find(capability);
    if (!operation) {
      return checkRefused(
        input.attemptKey,
        "execution-not-defined",
        `no execution is defined for capability ${capability}`,
      );
    }
    const environment = this.#executionDefinitions.environment(plan.environment);
    if (!environment) {
      return checkRefused(
        input.attemptKey,
        "environment-not-defined",
        `execution environment ${plan.environment} is not defined`,
      );
    }
    const result = this.admit({
      contract: "trust.skill-admission-request@1",
      attemptKey: input.attemptKey,
      checkUri: input.checkUri,
      releaseDigest: RUNNER_RELEASE_DIGEST,
      environment: plan.environment,
      deploymentKey: RUNNER_DEPLOYMENT_KEY,
      envelope: "cli",
      runtimeIdentity: RUNNER_RUNTIME_IDENTITY,
      processIdentity: RUNNER_PROCESS_IDENTITY,
    });
    if (result.status === "REFUSED") {
      return checkRefused(result.attemptKey, result.reasonCode, result.reason);
    }
    return {
      contract: "trust.check-admission@1",
      status: "ADMITTED",
      attemptKey: result.attemptKey,
      executionHandle: result.executionHandle,
      checkUri: result.checkUri,
      capability: result.capability,
      actionInput: result.actionInput,
      materializationContract: result.materializationContract,
      operation,
      environment,
      expiresAt: result.expiresAt,
    };
  }

  finalizeCheck(executionHandle: string): SkillFinalizationResult {
    return this.finalize(executionHandle, {
      runtimeIdentity: RUNNER_RUNTIME_IDENTITY,
      processIdentity: RUNNER_PROCESS_IDENTITY,
    });
  }

  ingestFacts(input: SkillFactBatchInput): SkillFactBatchResult {
    const execution = this.#executions.findByHandle(input.executionHandle);
    if (!execution) {
      throw new PlanRuntimeError(
        "execution-not-found",
        `execution ${input.executionHandle} is unknown`,
      );
    }
    if (!traceMatchesExecution(execution, input)) {
      throw new PlanRuntimeError(
        "fact-batch-rejected",
        "Fact trace identity does not match its immutable delegation",
      );
    }
    if (input.facts.length === 0 || !isInstant(input.recordedAt)) {
      throw new PlanRuntimeError(
        "fact-batch-rejected",
        "Fact trace must contain at least one Fact and a valid recordedAt instant",
      );
    }
    const check = this.#plans.findCheckAtRevision(
      execution.planSlug,
      execution.planRevision,
      execution.checkUri,
    );
    if (!check || check.compiledCheckDigest !== execution.compiledCheckDigest) {
      throw new PlanRuntimeError(
        "fact-batch-rejected",
        "the admitted compiled Check is unavailable",
      );
    }
    const facts = input.facts.map((payload, index) => toFact(execution, payload, index, input.recordedAt));
    try {
      const historicalRevision = this.#plans.findMaterializedRevision(
        execution.planSlug,
        execution.planRevision,
      );
      if (!historicalRevision) {
        throw new Error("the admitted Plan revision is unavailable");
      }
      const plan = this.#plans.findPlan(execution.planSlug);
      const currentRevision = plan
        ? this.#plans.findMaterializedRevision(plan.slug, plan.currentRevision)
        : undefined;
      const currentCheck = currentRevision?.checks.find(
        (candidate) => candidate.uri === execution.checkUri,
      );
      if (
        !currentRevision
        || !currentCheck
        || currentCheck.compiledCheckDigest !== execution.compiledCheckDigest
      ) {
        throw new Error("the admitted compiled Check is no longer current");
      }
      const active = this.#activeCheckUris(execution.planSlug);
      if (!checkDependenciesSatisfied(currentCheck, currentRevision.checks, (uri) => active.has(uri))) {
        throw new Error("the admitted Check dependencies are no longer satisfied");
      }
      const batch = validateFactsForCheck(check, facts, {
        requireCompleteMaterialization: false,
      });
      const qualification = qualifyValidatedFactBatch(check, batch, {
        validatedOutputs: historicalRevision.validatedOutputs,
        validatedCheckObservations: historicalRevision.validatedCheckObservations,
      });
      if (qualification.verdict === "VALIDATED") {
        validateFactsForCheck(check, facts);
      }
      const appended = this.#facts.append(facts);
      return {
        acceptedFactIds: appended.acceptedIds,
        duplicateFactIds: appended.duplicateIds,
      };
    } catch (error) {
      throw new PlanRuntimeError(
        "fact-batch-rejected",
        error instanceof Error ? error.message : "Fact trace was rejected",
        { cause: error },
      );
    }
  }

  ingestCheckFacts(input: CheckFactBatchInput): SkillFactBatchResult {
    const execution = this.#executions.findByHandle(input.executionHandle);
    if (!execution) {
      throw new PlanRuntimeError(
        "execution-not-found",
        `execution ${input.executionHandle} is unknown`,
      );
    }
    return this.ingestFacts({
      ...input,
      releaseDigest: execution.releaseDigest,
      environment: execution.environment,
      deploymentKey: execution.deploymentKey,
      envelope: execution.envelope,
      runtimeIdentity: execution.runtimeIdentity,
      processIdentity: execution.processIdentity,
    });
  }

  finalize(
    executionHandle: string,
    caller: SkillFinalizationCaller,
  ): SkillFinalizationResult {
    return this.#database.transaction(() => {
      const execution = this.#executions.findByHandle(executionHandle);
      if (!execution) {
        throw new PlanRuntimeError(
          "execution-not-found",
          `execution ${executionHandle} is unknown`,
        );
      }
      if (!this.#skillAdmission.ownsExecution(execution, caller)) {
        throw new PlanRuntimeError(
          "execution-not-found",
          `execution ${executionHandle} is not owned by the authenticated Skill process`,
        );
      }
      const facts = this.#facts.listForExecution(execution.handle);
      if (facts.length === 0) {
        throw new PlanRuntimeError(
          "facts-missing",
          "a Check remains unchanged until TRUST has accepted at least one Fact",
        );
      }
      const check = this.#plans.findCheckAtRevision(
        execution.planSlug,
        execution.planRevision,
        execution.checkUri,
      );
      if (!check || check.compiledCheckDigest !== execution.compiledCheckDigest) {
        throw new PlanRuntimeError(
          "check-not-found",
          "the admitted compiled Check is unavailable",
        );
      }
      const historicalRevision = this.#plans.findMaterializedRevision(
        execution.planSlug,
        execution.planRevision,
      );
      if (!historicalRevision) {
        throw new PlanRuntimeError(
          "check-not-found",
          "the admitted Plan revision is unavailable",
        );
      }
      let batch;
      let qualification;
      try {
        batch = validateFactsForCheck(check, facts, {
          requireCompleteMaterialization: false,
        });
        qualification = qualifyValidatedFactBatch(check, batch, {
          validatedOutputs: historicalRevision.validatedOutputs,
          validatedCheckObservations: historicalRevision.validatedCheckObservations,
        });
        if (qualification.verdict === "VALIDATED") {
          batch = validateFactsForCheck(check, facts);
        }
      } catch (error) {
        throw new PlanRuntimeError(
          "facts-missing",
          error instanceof Error ? error.message : "the accepted Facts cannot qualify this Check",
          { cause: error },
        );
      }
      const plan = this.#plans.findPlan(execution.planSlug);
      const currentRevision = plan
        ? this.#plans.findMaterializedRevision(plan.slug, plan.currentRevision)
        : undefined;
      const published = plan
        ? this.#procedures.find(plan.procedure, plan.procedureVersion)
        : undefined;
      const currentCheck = currentRevision?.checks.find((candidate) => candidate.uri === check.uri);
      const activeCurrent = plan ? this.#activeCheckUris(plan.slug) : new Set<string>();
      if (
        !plan
        || !currentRevision
        || !published
        || !currentCheck
        || currentCheck.compiledCheckDigest !== check.compiledCheckDigest
        || !checkDependenciesSatisfied(
          currentCheck,
          currentRevision.checks,
          (uri) => activeCurrent.has(uri),
        )
      ) {
        throw new PlanRuntimeError(
          "plan-conflict",
          `Check ${check.uri} is no longer current in Plan ${execution.planSlug}`,
        );
      }

      const factIds = facts.map((fact) => fact.id);
      const equivalent = this.#snapshots.findEquivalent(
        execution.checkUri,
        execution.compiledCheckDigest,
        factIds,
      );
      const activeBefore = this.#snapshots.listActive(plan.slug, currentRevision.revision);
      const activeBeforeByUri = new Map(activeBefore.map((entry) => [entry.checkUri, entry]));
      if (equivalent && activeBeforeByUri.get(check.uri)?.snapshotId === equivalent.id) {
        this.#executions.changeState(execution.handle, "finalized", this.#now().toISOString());
        return finalizationResult(equivalent, execution.handle);
      }

      const replacedProviders = dependentCheckUris(currentRevision.checks, check.uri);
      replacedProviders.add(check.uri);
      const nextPlanRevision = plan.currentRevision + 1;
      const nextActivationDigest = qualification.verdict === "VALIDATED"
        ? canonicalDigest({
            schema: "trust.check-qualification-activation@1",
            planSlug: plan.slug,
            planRevision: nextPlanRevision,
            checkUri: check.uri,
            compiledCheckDigest: check.compiledCheckDigest,
            factIds,
          })
        : undefined;
      const plannedActiveQualifications = activeBefore
        .filter((entry) => !replacedProviders.has(entry.checkUri))
        .map((entry) => ({
          planSlug: plan.slug,
          planRevision: nextPlanRevision,
          checkUri: entry.checkUri,
          activationDigest: entry.activationDigest,
        }));
      if (nextActivationDigest !== undefined) {
        plannedActiveQualifications.push({
          planSlug: plan.slug,
          planRevision: nextPlanRevision,
          checkUri: check.uri,
          activationDigest: nextActivationDigest,
        });
      }
      const materializationProviders = new Set(replacedProviders);
      if (qualification.verdict === "NOT_VALIDATED") {
        // Keep the last known context visible while its provider is not good.
        // Dependency gates prevent every consumer from being delegated until
        // the provider is validated again.
        materializationProviders.delete(check.uri);
      }
      let materializationState;
      try {
        materializationState = replaceValidatedFactBatch(
          currentRevision,
          qualification.verdict === "VALIDATED" ? batch : undefined,
          materializationProviders,
        );
      } catch (error) {
        throw new PlanRuntimeError(
          "plan-conflict",
          error instanceof Error ? error.message : "the Plan materialization cannot be replaced",
          { cause: error },
        );
      }
      const authoritativelyRemovedRoleIncarnations =
        qualification.verdict === "VALIDATED"
          ? removedProviderRoleIncarnations(currentRevision, batch.roleIncarnations, check.uri)
          : [];
      const nextRevision = materializePlanRevision({
        authority: this.#semanticAuthority,
        definition: published.definition,
        planSlug: plan.slug,
        environment: plan.environment,
        rootInputs: plan.rootInputs,
        agentDeclarations: currentRevision.agentDeclarations,
        agentDeclarationActivations: currentRevision.agentDeclarationActivations,
        revision: nextPlanRevision,
        materializationState,
        instantiatedChecks: currentRevision.checks,
        authoritativelyRemovedRoleIncarnations,
        activeQualifications: plannedActiveQualifications,
      });

      const nextChecksByUri = new Map(nextRevision.checks.map((candidate) => [candidate.uri, candidate]));
      const retained = activeBefore.filter((entry) => {
        const nextCheck = nextChecksByUri.get(entry.checkUri);
        return !replacedProviders.has(entry.checkUri)
          && nextCheck?.compiledCheckDigest === entry.compiledCheckDigest;
      });
      const activeAfterUris = new Set(retained.map((entry) => entry.checkUri));
      if (qualification.verdict === "VALIDATED") activeAfterUris.add(check.uri);
      const activeBeforeUris = new Set(activeBefore.map((entry) => entry.checkUri));
      const actionableBefore = actionableCheckUris(currentRevision.checks, activeBeforeUris);
      const actionableAfter = actionableCheckUris(nextRevision.checks, activeAfterUris);
      const newlyOpened = new Set(
        [...actionableAfter].filter((uri) => !actionableBefore.has(uri)),
      );
      for (const uri of activeBeforeUris) {
        if (!activeAfterUris.has(uri) && nextChecksByUri.has(uri)) newlyOpened.add(uri);
      }
      const checklistDelta = {
        newlySatisfied: [...activeAfterUris]
          .filter((uri) => !activeBeforeUris.has(uri))
          .sort(),
        newlyOpened: [...newlyOpened].sort(),
        unchanged: [] as string[],
      };
      if (
        checklistDelta.newlySatisfied.length === 0
        && checklistDelta.newlyOpened.length === 0
      ) {
        checklistDelta.unchanged.push(check.uri);
      }
      const calculatedAt = this.#now().toISOString();
      const snapshotBase = {
        executionHandle: execution.handle,
        planSlug: check.planSlug,
        planRevision: check.planRevision,
        checkUri: check.uri,
        compiledCheckDigest: check.compiledCheckDigest,
        state: qualification.verdict === "VALIDATED" ? "satisfied" : "open",
        verdict: qualification.verdict,
        reasonCode: qualification.reasonCode,
        reason: qualification.reason,
        factIds,
        checklistDelta,
        calculatedAt,
      } satisfies Omit<CheckSnapshot, "id">;
      const snapshot: CheckSnapshot = {
        id: canonicalDigest(snapshotBase),
        ...snapshotBase,
      };
      const activeSnapshot = equivalent ?? snapshot;
      if (!equivalent) this.#snapshots.append(snapshot);
      this.#plans.saveMaterializedRevision(nextRevision, calculatedAt);
      const activeAfter: ActiveCheckQualification[] = retained.map((entry) => ({
        ...entry,
        planRevision: nextRevision.revision,
      }));
      if (qualification.verdict === "VALIDATED") {
        if (nextActivationDigest === undefined) {
          throw new PlanRuntimeError(
            "plan-conflict",
            `Check ${check.uri} has no current qualification activation`,
          );
        }
        const nextCheck = nextChecksByUri.get(check.uri);
        if (!nextCheck || nextCheck.compiledCheckDigest !== check.compiledCheckDigest) {
          throw new PlanRuntimeError(
            "plan-conflict",
            `Check ${check.uri} cannot remain current after its own qualification`,
          );
        }
        activeAfter.push({
          planSlug: plan.slug,
          planRevision: nextRevision.revision,
          checkUri: check.uri,
          compiledCheckDigest: nextCheck.compiledCheckDigest,
          snapshotId: activeSnapshot.id,
          activationDigest: nextActivationDigest,
        });
      }
      this.#snapshots.saveActiveForRevision(plan.slug, nextRevision.revision, activeAfter);
      this.#executions.changeState(execution.handle, "finalized", calculatedAt);
      return finalizationResult({
        ...activeSnapshot,
        executionHandle: execution.handle,
        checklistDelta,
        calculatedAt,
      });
    });
  }

  #activeCheckUris(planSlug: string): Set<string> {
    const plan = this.#plans.findPlan(planSlug);
    if (!plan) return new Set();
    return new Set(
      this.#snapshots
        .listActive(plan.slug, plan.currentRevision)
        .map((entry) => entry.checkUri),
    );
  }

  #ensureOpenSession(planSlug: string): void {
    const current = this.#sessions.findOpen(planSlug);
    const now = this.#now();
    if (current && Date.parse(current.expiresAt) > now.getTime()) return;
    this.#database.transaction(() => {
      if (current) this.#sessions.changeState(current.id, "expired", now.toISOString());
      this.#sessions.create({
        id: randomUUID(),
        planSlug,
        state: "open",
        openedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_DURATION_MS).toISOString(),
      });
    });
  }

  #now(): Date {
    const value = this.#clock.now();
    if (!Number.isFinite(value.getTime())) throw new TypeError("runtime Clock returned an invalid Date");
    return value;
  }
}

function engagementResult(
  revision: number,
  materialized: { readonly checks: readonly MaterializedCheck[] },
  input: PlanEngagementInput,
): PlanEngagementResult {
  return {
    contract: "trust.plan-engagement@1",
    status: "ENGAGED",
    procedure: input.procedure,
    procedureVersion: input.procedureVersion,
    plan: input.plan,
    environment: input.environment,
    revision,
    checkUris: materialized.checks.map((check) => check.uri).sort(),
  };
}

function refused(
  attemptKey: string,
  reasonCode: string,
  reason: string,
): Extract<SkillAttemptAdmissionResult, { status: "REFUSED" }> {
  return {
    contract: "trust.skill-admission@1",
    status: "REFUSED",
    attemptKey,
    reasonCode,
    reason,
  };
}

function checkRefused(
  attemptKey: string,
  reasonCode: string,
  reason: string,
): Extract<CheckAttemptAdmissionResult, { status: "REFUSED" }> {
  return {
    contract: "trust.check-admission@1",
    status: "REFUSED",
    attemptKey,
    reasonCode,
    reason,
  };
}

function admitted(
  execution: Execution,
): Extract<SkillAttemptAdmissionResult, { status: "ADMITTED" }> {
  return {
    contract: "trust.skill-admission@1",
    status: "ADMITTED",
    attemptKey: execution.attemptKey,
    executionHandle: execution.handle,
    checkUri: execution.checkUri,
    capability: execution.capability,
    actionContractDigest: execution.actionContractDigest,
    actionInput: execution.actionInput,
    materializationContract: skillMaterializationGrant(execution.materializationContract),
    releaseDigest: execution.releaseDigest,
    environment: execution.environment,
    deploymentKey: execution.deploymentKey,
    envelope: execution.envelope,
    runtimeIdentity: execution.runtimeIdentity,
    processIdentity: execution.processIdentity,
    expiresAt: execution.expiresAt,
  };
}

function skillMaterializationGrant(
  contracts: readonly MaterializationOutputContract[],
): readonly SkillMaterializationOutputGrant[] {
  return contracts.map((contract) => ({
    output: contract.output,
    observation: contract.observation,
    valueType: contract.valueType,
    sourceCardinality: contract.sourceCardinality,
    parents: contract.parents.map((parent) => ({
      kind: parent.kind,
      port: parent.port,
      valueType: parent.valueType,
    })),
  }));
}

function executionMatchesAdmission(
  execution: Execution,
  input: SkillAttemptAdmissionInput,
): boolean {
  return execution.attemptKey === input.attemptKey
    && execution.checkUri === input.checkUri
    && execution.releaseDigest === input.releaseDigest
    && execution.environment === input.environment
    && execution.deploymentKey === input.deploymentKey
    && execution.envelope === input.envelope
    && execution.runtimeIdentity === input.runtimeIdentity
    && execution.processIdentity === input.processIdentity;
}

function traceMatchesExecution(execution: Execution, input: SkillFactBatchInput): boolean {
  return execution.attemptKey === input.attemptKey
    && execution.handle === input.executionHandle
    && execution.checkUri === input.checkUri
    && execution.releaseDigest === input.releaseDigest
    && execution.environment === input.environment
    && execution.deploymentKey === input.deploymentKey
    && execution.envelope === input.envelope
    && execution.runtimeIdentity === input.runtimeIdentity
    && execution.processIdentity === input.processIdentity;
}

function toFact(
  execution: Execution,
  payload: RuntimeJsonObject,
  index: number,
  recordedAt: string,
): Fact {
  const immutablePayload = cloneJson(payload) as RuntimeJsonObject;
  const observedAt = immutablePayload.observedAt;
  if (typeof observedAt !== "string" || !isInstant(observedAt)) {
    throw new PlanRuntimeError(
      "fact-batch-rejected",
      `Fact ${index} must contain a valid observedAt instant`,
    );
  }
  return {
    id: canonicalDigest({
      checkUri: execution.checkUri,
      compiledCheckDigest: execution.compiledCheckDigest,
      capability: execution.capability,
      actionContractDigest: execution.actionContractDigest,
      index,
      payload: immutablePayload,
    }),
    executionHandle: execution.handle,
    checkUri: execution.checkUri,
    compiledCheckDigest: execution.compiledCheckDigest,
    index,
    capability: execution.capability,
    actionContractDigest: execution.actionContractDigest,
    observedAt,
    recordedAt,
    payload: immutablePayload,
  };
}

function finalizationResult(
  snapshot: CheckSnapshot,
  executionHandle = snapshot.executionHandle,
): SkillFinalizationResult {
  return {
    contract: "trust.skill-finalization@1",
    executionHandle,
    verdict: snapshot.verdict,
    reasonCode: snapshot.reasonCode,
    reason: snapshot.reason,
    checklistDelta: snapshot.checklistDelta,
  };
}

function dependentCheckUris(
  checks: readonly MaterializedCheck[],
  changedCheckUri: string,
): Set<string> {
  const changed = checks.find((check) => check.uri === changedCheckUri);
  if (!changed) return new Set();
  const affectedUris = new Set<string>([changedCheckUri]);
  const affectedScenarios = new Set<string>([changed.scenario]);
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const check of checks) {
      if (affectedUris.has(check.uri)) continue;
      if (
        check.checkDependencies.some(
          (dependency) => affectedUris.has(dependency.providerCheckUri),
        )
        || check.scenarioDependencies.some((scenario) => affectedScenarios.has(scenario))
      ) {
        affectedUris.add(check.uri);
        affectedScenarios.add(check.scenario);
        advanced = true;
      }
    }
  }
  affectedUris.delete(changedCheckUri);
  return affectedUris;
}

function removedProviderRoleIncarnations(
  current: MaterializedPlanRevision,
  accepted: readonly MaterializedRoleIncarnation[],
  providerCheckUri: string,
): readonly MaterializedRoleIncarnation[] {
  return current.roleIncarnations.filter(
    (incarnation) =>
      incarnation.providerCheckUri === providerCheckUri
      && !accepted.some(
        (candidate) =>
          candidate.role === incarnation.role
          && canonicalJson(candidate.value) === canonicalJson(incarnation.value),
      ),
  );
}

function actionableCheckUris(
  checks: readonly MaterializedCheck[],
  satisfied: ReadonlySet<string>,
): Set<string> {
  return new Set(
    checks
      .filter((check) => checkIsActionable(
        check,
        checks,
        (checkUri) => satisfied.has(checkUri),
      ))
      .map((check) => check.uri),
  );
}

function changedDeclarationRoles(
  current: RuntimeJsonObject,
  next: RuntimeJsonObject,
): ReadonlySet<string> {
  return new Set(
    [...new Set([...Object.keys(current), ...Object.keys(next)])]
      .filter((role) => {
        const currentHas = Object.hasOwn(current, role);
        const nextHas = Object.hasOwn(next, role);
        return currentHas !== nextHas
          || (currentHas && canonicalJson(current[role]) !== canonicalJson(next[role]));
      }),
  );
}

function declarationActivations(
  current: Readonly<Record<string, string>>,
  declarations: RuntimeJsonObject,
  changedRoles: ReadonlySet<string>,
  planSlug: string,
  planRevision: number,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.keys(declarations).sort().map((role) => [
      role,
      changedRoles.has(role) || current[role] === undefined
        ? canonicalDigest({
            schema: "trust.agent-declaration-activation@1",
            planSlug,
            planRevision,
            role,
            value: declarations[role],
          })
        : current[role],
    ]),
  ));
}

function declarationDependentCheckUris(
  checks: readonly MaterializedCheck[],
  changedRoles: ReadonlySet<string>,
): ReadonlySet<string> {
  const direct = checks.filter((check) =>
    check.template.inputBindings.some((binding) => changedRoles.has(binding.role))
  );
  const affected = new Set(direct.map((check) => check.uri));
  for (const check of direct) {
    for (const dependent of dependentCheckUris(checks, check.uri)) affected.add(dependent);
  }
  return affected;
}

function withoutInvalidatedProviders(
  current: MaterializedPlanRevision,
  invalidated: ReadonlySet<string>,
): Pick<
  MaterializedPlanRevision,
  "roleIncarnations" | "validatedOutputs" | "validatedCheckObservations"
> {
  return Object.freeze({
    roleIncarnations: Object.freeze(current.roleIncarnations.filter(
      ({ providerCheckUri }) => !invalidated.has(providerCheckUri),
    )),
    validatedOutputs: Object.freeze(current.validatedOutputs.filter(
      ({ providerCheckUri }) => !invalidated.has(providerCheckUri),
    )),
    validatedCheckObservations: Object.freeze(current.validatedCheckObservations.filter(
      ({ providerCheckUri }) => !invalidated.has(providerCheckUri),
    )),
  });
}

function removedAgentDeclarationTargets(
  roles: readonly CompiledAutonomousResourceRole[],
  current: RuntimeJsonObject,
  next: RuntimeJsonObject,
): readonly { readonly role: string; readonly value: unknown }[] {
  const removed: { role: string; value: unknown }[] = [];
  for (const role of roles) {
    if (role.materialization.kind !== "agent-declaration") continue;
    const currentValues = declarationRoleValues(role, current[role.name]);
    const nextValues = declarationRoleValues(role, next[role.name]);
    for (const value of currentValues) {
      if (!nextValues.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) {
        removed.push({ role: role.name, value });
      }
    }
  }
  return Object.freeze(removed.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))));
}

function declarationRoleValues(
  role: CompiledAutonomousResourceRole,
  raw: unknown,
): readonly unknown[] {
  if (raw === undefined) return [];
  if (role.parents.some((parent) => parent.each)) {
    return (raw as readonly { readonly value: unknown }[]).map((entry) => entry.value);
  }
  return role.cardinality === "many" ? raw as readonly unknown[] : [raw];
}

function declarationReplacementResult(
  previous: MaterializedPlanRevision,
  current: MaterializedPlanRevision,
  declarations: RuntimeJsonObject,
): PlanDeclarationReplacementResult {
  const previousByUri = new Map(previous.checks.map((check) => [check.uri, check]));
  const currentUris = new Set(current.checks.map((check) => check.uri));
  return {
    contract: "trust.plan-declaration-replacement@1",
    status: "REPLACED",
    plan: current.planSlug,
    revision: current.revision,
    declarations,
    checkUris: current.checks.map((check) => check.uri),
    removedCheckUris: previous.checks
      .filter((check) => !currentUris.has(check.uri))
      .map((check) => check.uri)
      .sort(),
    openedCheckUris: current.checks
      .filter((check) => previousByUri.get(check.uri)?.compiledCheckDigest !== check.compiledCheckDigest)
      .map((check) => check.uri)
      .sort(),
  };
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const primitive = JSON.stringify(value);
    if (primitive === undefined) throw new TypeError("value is not JSON serializable");
    return primitive;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("value is not JSON serializable");
  return JSON.parse(serialized) as T;
}

function isInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
