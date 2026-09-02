import { createHash, randomUUID } from "node:crypto";

import { projectOperationEnvironment } from "@trust/operation";

import { checkDependenciesSatisfied } from "../check/actionability.js";
import { qualifyCheck, validateFacts } from "../check/qualification.js";
import type {
  ActiveCheckQualification,
  Attempt,
  CheckSnapshot,
  Fact,
  PlanMode,
  PlanEscalation,
  PlanRevision,
  RuntimeJsonObject,
} from "../model.js";
import type { Clock } from "../time.js";
import type { Database } from "../database/database.js";
import type { AttemptCreation, AttemptStore } from "../attempt/store.js";
import type { SnapshotStore } from "../snapshot/store.js";
import type { FactStore } from "../fact/store.js";
import type { PlanStore } from "./store.js";
import type { SessionStore } from "../session/store.js";
import type { Procedures } from "../procedure/procedures.js";
import type { EnvironmentService } from "../environment/service.js";
import { buildPlanRevision, validateAgentDeclarations } from "./build.js";
import type { PlanEvents } from "./events.js";
import type { EscalationStore } from "./escalation-store.js";
import { completesPlanOnValidation, dependentCheckUris, isIntentValue, MAX_INTENT_LENGTH } from "./intent.js";

export const DEFAULT_SESSION_DURATION_MS = 24 * 60 * 60 * 1_000;

export type PlanRuntimeErrorCode =
  | "invalid-plan-engagement"
  | "invalid-plan-declarations"
  | "procedure-not-found"
  | "plan-conflict"
  | "check-not-found"
  | "fact-batch-rejected"
  | "attempt-not-found"
  | "facts-present"
  | "facts-missing"
  | "check-not-escalatable";

export class PlanRuntimeError extends Error {
  constructor(readonly code: PlanRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanRuntimeError";
  }
}

class IntentInUseError extends Error {}
class PlanEscalatedDuringAdmissionError extends Error {}
class AdmissionPlanChangedError extends Error {}

interface SessionChange {
  readonly id: string;
  readonly plan: string;
  readonly state: "open" | "expired";
  readonly at: string;
}

export interface PlanEngagementInput {
  readonly contract: "trust.plan-engagement-request@1";
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly plan: string;
  readonly environment: string;
  readonly rootInputs: RuntimeJsonObject;
  /** Defaults to "live". A dry-run Plan is driven by the operator: Facts come through the RPC boundary and no environment is resolved. */
  readonly mode?: PlanMode;
}

export interface PlanEngagementResult {
  readonly contract: "trust.plan-engagement@1";
  readonly status: "ENGAGED";
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly plan: string;
  readonly environment: string;
  readonly mode: PlanMode;
  readonly revision: number;
  readonly checkUris: readonly string[];
}

export interface PlanDeclarationReplacementInput {
  readonly contract: "trust.plan-declaration-replacement-request@1";
  readonly plan: string;
  readonly expectedRevision: number;
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

export interface CheckEscalationInput {
  readonly contract: "trust.check-escalation-request@1";
  readonly checkUri: string;
  readonly attemptHandle: string;
  readonly blockingReason: string;
  readonly forbiddenFurtherAction: string;
}

export interface CheckEscalationResult {
  readonly contract: "trust.check-escalation@1";
  readonly status: "ESCALATED";
  readonly plan: string;
  readonly checkUri: string;
  readonly snapshotId: string;
  readonly blockingReason: string;
  readonly forbiddenFurtherAction: string;
  readonly escalatedAt: string;
}

export interface PlanResumptionResult {
  readonly contract: "trust.plan-resumption@1";
  readonly status: "RESUMED";
  readonly plan: string;
  readonly escalationId: string;
  readonly resumeReason: string;
  readonly resumedAt: string;
}

export interface PlanResumptionInput {
  readonly plan: string;
  readonly escalationId: string;
  readonly resumeReason: string;
}

export interface CheckAttemptAdmissionInput {
  readonly contract: "trust.check-admission-request@1";
  readonly attemptKey: string;
  readonly checkUri: string;
  readonly reobserve?: boolean;
  readonly intent?: string;
  readonly nextIntent?: string;
}

export type CheckAttemptAdmissionResult =
  | {
      readonly contract: "trust.check-admission@1";
      readonly status: "ADMITTED";
      readonly attemptKey: string;
      readonly attemptHandle: string;
      readonly executionId: string;
      readonly checkUri: string;
      readonly operation: import("@trust/operation").CompiledOperation;
      readonly actionInput: RuntimeJsonObject;
      readonly environment: RuntimeJsonObject;
      readonly expiresAt: string;
    }
  | Refusal;

interface Refusal {
  readonly contract: "trust.check-admission@1";
  readonly status: "REFUSED";
  readonly attemptKey: string;
  readonly reasonCode: string;
  readonly reason: string;
  readonly next: { readonly action: "READ_PLAN" };
}

export interface FactBatchInput {
  readonly attemptKey: string;
  readonly attemptHandle: string;
  readonly executionId: string;
  readonly checkUri: string;
  readonly facts: readonly RuntimeJsonObject[];
  readonly recordedAt: string;
}

export interface FactBatchResult {
  readonly acceptedFactIds: readonly string[];
  readonly duplicateFactIds: readonly string[];
}

export interface AttemptFinalizationResult {
  readonly contract: "trust.attempt-finalization@1";
  readonly attemptHandle: string;
  readonly plan: string;
  readonly checkUri: string;
  readonly verdict: "VALIDATED" | "NOT_VALIDATED";
  readonly reasonCode: string;
  readonly reason: string;
  readonly checklistDelta: CheckSnapshot["checklistDelta"];
}

export interface AttemptInterruptionResult {
  readonly contract: "trust.attempt-interruption@1";
  readonly status: "INTERRUPTED";
  readonly attemptHandle: string;
}

export interface PlanRuntimeDependencies {
  readonly clock: Clock;
  readonly database: Database;
  readonly semanticAuthority: string;
  readonly environmentService: EnvironmentService;
  readonly procedures: Procedures;
  readonly planStore: PlanStore;
  readonly sessionStore: SessionStore;
  readonly attemptStore: AttemptStore;
  readonly factStore: FactStore;
  readonly snapshotStore: SnapshotStore;
  readonly escalationStore: EscalationStore;
  readonly planEvents: PlanEvents;
  readonly sessionDurationMs: number;
}

export class PlanRuntime {
  readonly #clock: Clock;
  readonly #database: Database;
  readonly #authority: string;
  readonly #environments: EnvironmentService;
  readonly #procedures: Procedures;
  readonly #plans: PlanStore;
  readonly #sessions: SessionStore;
  readonly #attempts: AttemptStore;
  readonly #facts: FactStore;
  readonly #snapshots: SnapshotStore;
  readonly #escalations: EscalationStore;
  readonly #events: PlanEvents;
  readonly #sessionDurationMs: number;

  constructor(dependencies: PlanRuntimeDependencies) {
    if (!Number.isSafeInteger(dependencies.sessionDurationMs) || dependencies.sessionDurationMs <= 0) {
      throw new TypeError("sessionDurationMs must be a positive integer");
    }
    this.#clock = dependencies.clock;
    this.#database = dependencies.database;
    this.#authority = dependencies.semanticAuthority;
    this.#environments = dependencies.environmentService;
    this.#procedures = dependencies.procedures;
    this.#plans = dependencies.planStore;
    this.#sessions = dependencies.sessionStore;
    this.#attempts = dependencies.attemptStore;
    this.#facts = dependencies.factStore;
    this.#snapshots = dependencies.snapshotStore;
    this.#escalations = dependencies.escalationStore;
    this.#events = dependencies.planEvents;
    this.#sessionDurationMs = dependencies.sessionDurationMs;
  }

  async #initialRevision(input: PlanEngagementInput): Promise<PlanRevision> {
    if (input.contract !== "trust.plan-engagement-request@1") {
      throw new PlanRuntimeError("invalid-plan-engagement", "Unsupported Plan engagement contract");
    }
    const published = await this.#procedures.find(input.procedure, input.procedureVersion);
    if (!published) {
      throw new PlanRuntimeError("procedure-not-found", `Procedure ${input.procedure}@${input.procedureVersion} is not published`);
    }
    if (!this.#environments.resolve(input.environment)) {
      throw new PlanRuntimeError("invalid-plan-engagement", `Environment "${input.environment}" is not configured`);
    }
    const mode: PlanMode = input.mode ?? "live";
    try {
      return buildPlanRevision({
        authority: this.#authority,
        procedure: published.procedure,
        plan: input.plan,
        environment: input.environment,
        mode,
        rootInputs: input.rootInputs,
        revision: 1,
      });
    } catch (error) {
      throw new PlanRuntimeError("invalid-plan-engagement", message(error), { cause: error });
    }
  }

  async #saveInitialRevision(database: Database, revision: PlanRevision, at: Date, sessionId: string): Promise<void> {
    await this.#plans.using(database).saveRevision(revision, at.toISOString());
    await this.#sessions.using(database).create({
      id: sessionId,
      planSlug: revision.planSlug,
      state: "open",
      openedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + this.#sessionDurationMs).toISOString(),
    });
  }

  #publishEngagement(plan: string, at: Date, sessionId: string): void {
    this.#events.publish({ type: "plan.engaged", at: at.toISOString(), plan, revision: 1 });
    this.#sessionEvent(sessionId, plan, "open", at.toISOString());
  }

  async engage(input: PlanEngagementInput): Promise<PlanEngagementResult> {
    const revision = await this.#initialRevision(input);
    const existing = await this.#plans.findPlan(input.plan);
    if (existing) {
      const current = await this.#plans.readRevision(input.plan, existing.currentRevision);
      if (!current || current.definitionDigest !== revision.definitionDigest
        || canonicalJson(existing.rootInputs) !== canonicalJson(revision.rootInputs)
        || existing.environment !== revision.environment
        || existing.mode !== revision.mode) {
        throw new PlanRuntimeError("plan-conflict", `Plan ${input.plan} is already engaged with another Procedure or context`);
      }
      await this.#ensureSession(input.plan);
      return engagement(existing.currentRevision, current);
    }
    const now = this.#now();
    const sessionId = randomUUID();
    await this.#database.transaction().execute(async (transaction) => {
      await this.#saveInitialRevision(transaction, revision, now, sessionId);
    });
    this.#publishEngagement(input.plan, now, sessionId);
    return engagement(1, revision);
  }

  /** Start one dry-run again from revision 1 without any externally visible deleted state. */
  async reset(planSlug: string): Promise<PlanEngagementResult> {
    const plan = await this.#plans.findPlan(planSlug);
    if (!plan) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is unknown`);
    if (plan.mode !== "dry-run") throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is a live Plan and cannot be reset`);
    const revision = await this.#initialRevision({
      contract: "trust.plan-engagement-request@1",
      procedure: plan.procedure,
      procedureVersion: plan.procedureVersion,
      plan: plan.slug,
      environment: plan.environment,
      rootInputs: plan.rootInputs,
      mode: plan.mode,
    });
    const now = this.#now();
    const sessionId = randomUUID();
    await this.#database.transaction().execute(async (transaction) => {
      await this.#plans.using(transaction).remove(planSlug);
      await this.#saveInitialRevision(transaction, revision, now, sessionId);
    });
    this.#events.publish({ type: "plan.removed", at: now.toISOString(), plan: planSlug });
    this.#publishEngagement(planSlug, now, sessionId);
    return engagement(1, revision);
  }

  /** Erase a dry-run Plan entirely (a blocked rehearsal starts over). Live Plans are audit history: refused. */
  async remove(planSlug: string): Promise<{ readonly plan: string; readonly removed: true }> {
    const plan = await this.#plans.findPlan(planSlug);
    if (!plan) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is unknown`);
    if (plan.mode !== "dry-run") throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is a live Plan and cannot be removed`);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#plans.using(transaction).remove(planSlug);
    });
    this.#events.publish({ type: "plan.removed", at: this.#now().toISOString(), plan: planSlug });
    return { plan: planSlug, removed: true };
  }

  async close(planSlug: string): Promise<{ readonly plan: string; readonly closed: boolean }> {
    const plan = await this.#plans.findPlan(planSlug);
    if (!plan) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is unknown`);
    const session = await this.#sessions.findOpen(planSlug);
    if (!session) return { plan: planSlug, closed: false };
    const closedAt = this.#now().toISOString();
    await this.#sessions.changeState(session.id, "closed", closedAt);
    this.#sessionEvent(session.id, planSlug, "closed", closedAt);
    return { plan: planSlug, closed: true };
  }

  async escalateCheck(input: CheckEscalationInput): Promise<CheckEscalationResult> {
    if (input.contract !== "trust.check-escalation-request@1"
      || input.attemptHandle.length === 0
      || !isEscalationDeclaration(input.blockingReason)
      || !isEscalationDeclaration(input.forbiddenFurtherAction)) {
      throw new PlanRuntimeError(
        "check-not-escalatable",
        "Escalation requires a non-empty blockingReason and forbiddenFurtherAction of at most 4096 characters",
      );
    }
    let escalation: PlanEscalation | undefined;
    let escalationCreated = false;
    await this.#database.transaction().execute(async (transaction) => {
      const plans = this.#plans.using(transaction);
      const escalations = this.#escalations.using(transaction);
      const snapshots = this.#snapshots.using(transaction);
      const attempts = this.#attempts.using(transaction);
      const facts = this.#facts.using(transaction);
      const requestedAttempt = await attempts.find(input.attemptHandle);
      const plan = requestedAttempt ? await plans.findPlan(requestedAttempt.planSlug) : undefined;
      if (!requestedAttempt || !plan || requestedAttempt.checkUri !== input.checkUri
        || requestedAttempt.state !== "finalized"
        || requestedAttempt.finalization?.verdict !== "NOT_VALIDATED") {
        throw new PlanRuntimeError(
          "check-not-escalatable",
          "Escalation must reference its finalized NOT_VALIDATED Attempt",
        );
      }
      const acceptedFacts = await facts.list(requestedAttempt.handle);
      const snapshot = await snapshots.findEquivalent(
        requestedAttempt.checkUri,
        requestedAttempt.compiledCheckDigest,
        acceptedFacts.map(({ id }) => id),
      );
      if (!snapshot || snapshot.verdict !== "NOT_VALIDATED") {
        throw new PlanRuntimeError("check-not-escalatable", "The requested NOT_VALIDATED qualification is unavailable");
      }
      const previousEscalation = await escalations.findByAttempt(requestedAttempt.handle);
      if (previousEscalation) {
        if (previousEscalation.blockingReason === input.blockingReason
          && previousEscalation.forbiddenFurtherAction === input.forbiddenFurtherAction) {
          escalation = previousEscalation;
          return;
        }
        throw new PlanRuntimeError(
          "check-not-escalatable",
          "This NOT_VALIDATED Attempt has already been escalated with other declarations",
        );
      }
      const check = await plans.findCurrentCheck(input.checkUri);
      if (!check || check.planSlug !== plan.slug) {
        throw new PlanRuntimeError("check-not-found", "The semantic Check URI is unknown");
      }
      if (!await plans.lockCurrentRevision(plan.slug, plan.currentRevision)) {
        throw new PlanRuntimeError("check-not-escalatable", `Plan ${plan.slug} changed while escalation was requested`);
      }
      const activeEscalation = await escalations.findActive(plan.slug);
      if (activeEscalation) {
        throw new PlanRuntimeError("check-not-escalatable", `Plan ${plan.slug} is already escalated`);
      }
      const requestedAt = this.#now().toISOString();
      const pendingAttempt = await attempts.findLivePendingByPlan(plan.slug, requestedAt);
      if (pendingAttempt) {
        throw new PlanRuntimeError(
          "check-not-escalatable",
          `Plan ${plan.slug} has pending Attempt ${pendingAttempt.handle}`,
        );
      }
      const active = await snapshots.listActive(plan.slug, plan.currentRevision);
      if (active.some(({ checkUri }) => checkUri === check.uri)) {
        throw new PlanRuntimeError("check-not-escalatable", `Check ${check.uri} is already satisfied`);
      }
      const latestAttempt = await attempts.findLatestByCheck(check.uri);
      if (!latestAttempt || latestAttempt.handle !== requestedAttempt.handle
        || latestAttempt.state !== "finalized"
        || latestAttempt.compiledCheckDigest !== check.compiledCheckDigest
        || latestAttempt.finalization?.verdict !== "NOT_VALIDATED") {
        throw new PlanRuntimeError(
          "check-not-escalatable",
          "The latest Attempt for the current Check must be finalized as NOT_VALIDATED",
        );
      }
      const escalatedAt = this.#now().toISOString();
      escalation = {
        id: randomUUID(),
        planSlug: plan.slug,
        planRevision: plan.currentRevision,
        snapshotPlanRevision: snapshot.planRevision,
        checkUri: check.uri,
        compiledCheckDigest: check.compiledCheckDigest,
        snapshotId: snapshot.id,
        attemptHandle: requestedAttempt.handle,
        blockingReason: input.blockingReason,
        forbiddenFurtherAction: input.forbiddenFurtherAction,
        escalatedAt,
      };
      await escalations.create(escalation);
      escalationCreated = true;
    });
    if (!escalation) throw new Error("Escalation transaction did not produce a result");
    if (escalationCreated) {
      this.#events.publish({
        type: "plan.state",
        at: escalation.escalatedAt,
        plan: escalation.planSlug,
        workState: "ESCALATED",
      });
    }
    return {
      contract: "trust.check-escalation@1",
      status: "ESCALATED",
      plan: escalation.planSlug,
      checkUri: escalation.checkUri,
      snapshotId: escalation.snapshotId,
      blockingReason: escalation.blockingReason,
      forbiddenFurtherAction: escalation.forbiddenFurtherAction,
      escalatedAt: escalation.escalatedAt,
    };
  }

  async resumePlan(input: PlanResumptionInput): Promise<PlanResumptionResult> {
    if (!isEscalationDeclaration(input.resumeReason)) {
      throw new PlanRuntimeError("plan-conflict", "Plan resumption requires a non-empty resumeReason of at most 4096 characters");
    }
    const planSlug = input.plan;
    const now = this.#now();
    const resumedAt = now.toISOString();
    let escalation: PlanEscalation | undefined;
    let resumed = false;
    let sessionEvents: readonly SessionChange[] = [];
    await this.#database.transaction().execute(async (transaction) => {
      const plans = this.#plans.using(transaction);
      const plan = await plans.findPlan(planSlug);
      if (!plan) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is unknown`);
      if (!await plans.lockCurrentRevision(plan.slug, plan.currentRevision)) {
        throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} changed while resumption was requested`);
      }
      const escalations = this.#escalations.using(transaction);
      const activeEscalation = await escalations.findActive(planSlug);
      if (!activeEscalation) {
        const requestedEscalation = await escalations.find(input.escalationId);
        if (requestedEscalation?.planSlug === planSlug && requestedEscalation.resumedAt) {
          if (requestedEscalation.resumeReason !== input.resumeReason) {
            throw new PlanRuntimeError("plan-conflict", `Escalation ${input.escalationId} was resumed with another reason`);
          }
          escalation = requestedEscalation;
          return;
        }
        throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is not escalated`);
      }
      if (activeEscalation.id !== input.escalationId) {
        const requestedEscalation = await escalations.find(input.escalationId);
        if (requestedEscalation?.planSlug === planSlug && requestedEscalation.resumedAt) {
          if (requestedEscalation.resumeReason !== input.resumeReason) {
            throw new PlanRuntimeError("plan-conflict", `Escalation ${input.escalationId} was resumed with another reason`);
          }
          escalation = requestedEscalation;
          return;
        }
        throw new PlanRuntimeError("plan-conflict", `Escalation ${input.escalationId} is not active for Plan ${planSlug}`);
      }
      sessionEvents = await this.#ensureSessionIn(transaction, planSlug, now);
      escalation = await escalations.resume(input.escalationId, resumedAt, input.resumeReason);
      if (!escalation) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is not escalated`);
      resumed = true;
    });
    if (!escalation) throw new Error("Plan resumption transaction did not produce a result");
    if (resumed) {
      this.#publishSessionChanges(sessionEvents);
      this.#events.publish({ type: "plan.state", at: resumedAt, plan: planSlug, workState: "IN_PROGRESS" });
    }
    return {
      contract: "trust.plan-resumption@1",
      status: "RESUMED",
      plan: planSlug,
      escalationId: escalation.id,
      resumeReason: escalation.resumeReason ?? input.resumeReason,
      resumedAt: escalation.resumedAt ?? resumedAt,
    };
  }

  async replaceDeclarations(input: PlanDeclarationReplacementInput): Promise<PlanDeclarationReplacementResult> {
    const plan = await this.#plans.findPlan(input.plan);
    const current = plan ? await this.#plans.readRevision(plan.slug, plan.currentRevision) : undefined;
    const published = plan ? await this.#procedures.find(plan.procedure, plan.procedureVersion) : undefined;
    if (!plan || !current || !published || plan.currentRevision !== input.expectedRevision) {
      throw new PlanRuntimeError("plan-conflict", `Plan ${input.plan} is unavailable or changed`);
    }
    if (await this.#escalations.findActive(plan.slug)) {
      throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} is escalated and must be resumed by an operator`);
    }
    let declarations: RuntimeJsonObject;
    try {
      declarations = validateAgentDeclarations(
        published.procedure.roles,
        plan.rootInputs,
        plan.slug,
        input.declarations,
      );
    } catch (error) {
      throw new PlanRuntimeError("invalid-plan-declarations", message(error), { cause: error });
    }
    if (canonicalJson(declarations) === canonicalJson(current.agentDeclarations)) {
      await this.#database.transaction().execute(async (transaction) => {
        const plans = this.#plans.using(transaction);
        const transactionalPlan = await plans.findPlan(plan.slug);
        if (!transactionalPlan || transactionalPlan.currentRevision !== input.expectedRevision
          || !await plans.lockCurrentRevision(plan.slug, input.expectedRevision)) {
          throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} changed while declarations were requested`);
        }
        if (await this.#escalations.using(transaction).findActive(plan.slug)) {
          throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} is escalated and must be resumed by an operator`);
        }
      });
      return declarationResult(current, current);
    }
    const activeBefore = await this.#snapshots.listActive(plan.slug, plan.currentRevision);
    let roleValues = current.roleValues;
    let checkValues = current.checkValues;
    let next: PlanRevision;
    let retained: readonly ActiveCheckQualification[];
    while (true) {
      next = buildPlanRevision({
        authority: this.#authority,
        procedure: published.procedure,
        plan: plan.slug,
        environment: plan.environment,
        mode: plan.mode,
        rootInputs: plan.rootInputs,
        declarations,
        revision: plan.currentRevision + 1,
        roleValues,
        checkValues,
        pruneUnavailableRoleValues: true,
      });
      // Checks untouched by the new declarations keep their active qualification (same URI, same semantic digest).
      const nextChecks = new Map(next.checks.map((candidate) => [candidate.uri, candidate]));
      const retainedCandidates = activeBefore
        .filter((item) => nextChecks.get(item.checkUri)?.compiledCheckDigest === item.compiledCheckDigest)
        .map((item) => ({ ...item, planRevision: next.revision }));
      retained = retainQualifiedDependencies(retainedCandidates, next.checks);
      const retainedProviders = new Set(retained.map((item) => item.checkUri));
      roleValues = next.roleValues.filter((item) => retainedProviders.has(item.providerCheckUri));
      checkValues = next.checkValues.filter((item) => retainedProviders.has(item.providerCheckUri));
      if (roleValues.length === next.roleValues.length && checkValues.length === next.checkValues.length) break;
    }
    const missingDeclarations = published.procedure.roles.some((role) => (
      role.source.kind === "agent-declaration" && role.source.optional !== true
        && !Object.hasOwn(declarations, role.name)
    ));
    const nextChecklistComplete = !missingDeclarations && retained.length === next.checks.length;
    const now = this.#now();
    try {
      await this.#database.transaction().execute(async (transaction) => {
        const plans = this.#plans.using(transaction);
        const chainedPlan = await plans.findPlan(plan.slug);
        if (!chainedPlan || chainedPlan.currentRevision !== input.expectedRevision
          || !await plans.lockCurrentRevision(plan.slug, input.expectedRevision)) {
          throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} changed while declarations were requested`);
        }
        if (await this.#escalations.using(transaction).findActive(plan.slug)) {
          throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} is escalated and must be resumed by an operator`);
        }
        if (chainedPlan.intentChaining && chainedPlan.currentIntentAttemptKey !== undefined) {
          const attempts = this.#attempts.using(transaction);
          const sessions = this.#sessions.using(transaction);
          const owner = await attempts.findByKey(chainedPlan.currentIntentAttemptKey);
          const ownerSession = owner ? await sessions.findById(owner.sessionId) : undefined;
          const ownerIsPending = owner?.state === "pending"
            && ownerSession?.state === "open"
            && Date.parse(owner.expiresAt) > now.getTime();
          if (ownerIsPending) {
            throw new PlanRuntimeError(
              "plan-conflict",
              `Plan ${plan.slug} has a pending Attempt for its current intent`,
            );
          }
          if (chainedPlan.currentIntent === undefined) {
            throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} has an invalid intent reservation`);
          }
          await plans.releaseIntentAttempt(
            plan.slug,
            chainedPlan.currentIntent,
            chainedPlan.currentIntentAttemptKey,
          );
        }
        await plans.saveRevision(next, now.toISOString());
        await this.#snapshots.using(transaction).saveActiveForRevision(plan.slug, next.revision, retained);
        if (chainedPlan?.intentChaining && nextChecklistComplete
          && chainedPlan.intentChainState !== "COMPLETE") {
          await plans.completeIntentWithoutAttempt(plan.slug);
        } else if (chainedPlan?.intentChaining && chainedPlan.intentChainState === "COMPLETE"
          && !nextChecklistComplete) {
          await plans.restartIntent(plan.slug);
        }
      });
    } catch (error) {
      if (isEscalatedPersistenceError(error)) {
        throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} is escalated and must be resumed by an operator`);
      }
      throw error;
    }
    await this.#ensureSession(plan.slug);
    const result = declarationResult(current, next);
    this.#events.publish({
      type: "plan.revision",
      at: this.#now().toISOString(),
      plan: plan.slug,
      revision: next.revision,
      cause: "declarations",
      checklistDelta: {
        newlySatisfied: [],
        newlyOpened: result.openedCheckUris,
        unchanged: retained.map((item) => item.checkUri).sort(),
      },
      removedCheckUris: result.removedCheckUris,
    });
    return result;
  }

  async admitCheck(input: CheckAttemptAdmissionInput): Promise<CheckAttemptAdmissionResult> {
    if (input.contract !== "trust.check-admission-request@1") {
      return refuse("trust.check-admission@1", input.attemptKey, "invalid-admission-contract", "Unsupported admission contract");
    }
    if (input.intent !== undefined && !isIntentValue(input.intent)) {
      return refuse("trust.check-admission@1", input.attemptKey, "intent-invalid", `intent must contain 1 to ${MAX_INTENT_LENGTH} characters, be trimmed and single-line, and contain no control character`);
    }
    if (input.nextIntent !== undefined && !isIntentValue(input.nextIntent)) {
      return refuse("trust.check-admission@1", input.attemptKey, "intent-invalid", `nextIntent must contain 1 to ${MAX_INTENT_LENGTH} characters, be trimmed and single-line, and contain no control character`);
    }
    let resolved = await this.#resolveAdmission(
      input.attemptKey,
      input.checkUri,
      input.reobserve === true,
      input.intent,
      input.nextIntent,
    );
    if ("refusal" in resolved) return { contract: "trust.check-admission@1", ...resolved.refusal };
    let creation: AttemptCreation;
    try {
      creation = await this.#createAttempt(resolved);
    } catch (error) {
      if (error instanceof PlanEscalatedDuringAdmissionError || isEscalatedPersistenceError(error)) {
        return refuse(
          "trust.check-admission@1",
          input.attemptKey,
          "check-not-actionable",
          "The Plan is escalated and must be resumed by an operator",
        );
      }
      if (error instanceof AdmissionPlanChangedError) {
        return refuse(
          "trust.check-admission@1",
          input.attemptKey,
          "check-not-actionable",
          "The Plan changed while admission was requested; read it again",
        );
      }
      if (error instanceof IntentInUseError) {
        return refuse(
          "trust.check-admission@1",
          input.attemptKey,
          "intent-in-use",
          "The current intent is already reserved by another Attempt; read the Plan again",
        );
      }
      throw error;
    }
    if (!creation.created && resolved.existing === undefined) {
      resolved = await this.#resolveAdmission(
        input.attemptKey,
        input.checkUri,
        input.reobserve === true,
        input.intent,
        input.nextIntent,
      );
      if ("refusal" in resolved) return { contract: "trust.check-admission@1", ...resolved.refusal };
    }
    const attempt = creation.attempt;
    return {
      contract: "trust.check-admission@1",
      status: "ADMITTED",
      attemptKey: attempt.attemptKey,
      attemptHandle: attempt.handle,
      executionId: attempt.executionId,
      checkUri: attempt.checkUri,
      operation: resolved.check.operation,
      actionInput: attempt.actionInput,
      // A dry-run never hands out environment values: nothing external is executed for it.
      // A live grant carries only the values the Operation declares (its environment schema is closed).
      environment: resolved.plan.mode === "dry-run"
        ? {}
        : projectOperationEnvironment(resolved.check.operation, this.#environments.resolve(attempt.environment) ?? {}).environment,
      expiresAt: attempt.expiresAt,
    };
  }

  async #ingestFacts(input: FactBatchInput): Promise<FactBatchResult> {
    return this.#database.transaction().execute(async (transaction) => {
      const attempts = this.#attempts.using(transaction);
      const attempt = await attempts.lockPending(input.attemptHandle);
      if (!attempt) {
        const existing = await attempts.find(input.attemptHandle);
        if (!existing) {
          throw new PlanRuntimeError("attempt-not-found", `Runner Attempt ${input.attemptHandle} is unknown`);
        }
        throw new PlanRuntimeError(
          "fact-batch-rejected",
          existing.state === "interrupted"
            ? "Fact batch belongs to an interrupted Attempt"
            : "Fact batch belongs to a finalized Attempt",
        );
      }
      return this.#ingest(attempt, input, transaction);
    });
  }

  async ingestDryRunFacts(input: FactBatchInput): Promise<FactBatchResult> {
    await this.#requireAttemptMode(input.attemptHandle, "dry-run", "Operator");
    return this.#ingestFacts(input);
  }

  async ingestLiveFacts(input: FactBatchInput): Promise<FactBatchResult> {
    await this.#requireAttemptMode(input.attemptHandle, "live", "Runner");
    return this.#ingestFacts(input);
  }

  async #ingest(attempt: Attempt, input: FactBatchInput, database: Database): Promise<FactBatchResult> {
    if (attempt.attemptKey !== input.attemptKey
      || attempt.executionId !== input.executionId
      || attempt.checkUri !== input.checkUri) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch does not match its admitted Attempt");
    }
    if (Date.parse(attempt.expiresAt) <= this.#now().getTime()) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch belongs to an expired Attempt");
    }
    const [plan, session] = await Promise.all([
      this.#plans.using(database).findPlan(attempt.planSlug),
      this.#sessions.using(database).findById(attempt.sessionId),
    ]);
    if (!session || session.state !== "open") {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch belongs to an Attempt whose Session is no longer open");
    }
    if (attempt.intent !== undefined && (!plan?.intentChaining
      || plan.currentIntent !== attempt.intent
      || plan.currentIntentAttemptKey !== attempt.attemptKey)) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch belongs to an Attempt that no longer owns the current intent");
    }
    if (input.facts.length === 0 || Number.isNaN(Date.parse(input.recordedAt))) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch must contain Facts and a valid recordedAt instant");
    }
    const check = await this.#plans.using(database).findCheckAtRevision(
      attempt.planSlug,
      attempt.planRevision,
      attempt.checkUri,
    );
    if (!check || check.compiledCheckDigest !== attempt.compiledCheckDigest) {
      throw new PlanRuntimeError("fact-batch-rejected", "The admitted Check is unavailable");
    }
    const facts = input.facts.map((payload, index) => fact(attempt, payload, index, input.recordedAt));
    try {
      validateFacts(check, facts);
      const result = await this.#facts.using(database).append(facts);
      return { acceptedFactIds: result.acceptedIds, duplicateFactIds: result.duplicateIds };
    } catch (error) {
      throw new PlanRuntimeError("fact-batch-rejected", message(error), { cause: error });
    }
  }

  async finalizeCheck(attemptHandle: string): Promise<AttemptFinalizationResult> {
    const attempt = await this.#attempts.find(attemptHandle);
    if (!attempt) {
      throw new PlanRuntimeError("attempt-not-found", `Runner Attempt ${attemptHandle} is unknown`);
    }
    return this.#finalize(attempt);
  }

  async interruptCheck(attemptHandle: string): Promise<AttemptInterruptionResult> {
    const result = (): AttemptInterruptionResult => ({
      contract: "trust.attempt-interruption@1",
      status: "INTERRUPTED",
      attemptHandle,
    });
    return this.#database.transaction().execute(async (transaction) => {
      const attempts = this.#attempts.using(transaction);
      const facts = this.#facts.using(transaction);
      const plans = this.#plans.using(transaction);
      const lockedAttempt = await attempts.lockPending(attemptHandle);
      const attempt = lockedAttempt ?? await attempts.find(attemptHandle);
      if (!attempt) {
        throw new PlanRuntimeError("attempt-not-found", `Runner Attempt ${attemptHandle} is unknown`);
      }
      if (attempt.state === "interrupted") return result();
      if (attempt.state === "finalized") {
        throw new PlanRuntimeError("plan-conflict", "A finalized Attempt cannot be interrupted");
      }
      if ((await facts.list(attemptHandle)).length > 0) {
        throw new PlanRuntimeError("facts-present", "An Attempt with accepted Facts cannot be interrupted");
      }
      if (attempt.intent !== undefined) {
        const plan = await plans.findPlan(attempt.planSlug);
        if (plan?.currentIntent === attempt.intent
          && plan.currentIntentAttemptKey === attempt.attemptKey) {
          await plans.releaseIntentAttempt(plan.slug, attempt.intent, attempt.attemptKey);
        }
      }
      await attempts.interrupt(attemptHandle, this.#now().toISOString());
      return result();
    });
  }

  async #finalize(attempt: Attempt): Promise<AttemptFinalizationResult> {
    const initialPlan = await this.#plans.findPlan(attempt.planSlug);
    const published = initialPlan
      ? await this.#procedures.find(initialPlan.procedure, initialPlan.procedureVersion)
      : undefined;
    let revisionEvent: { revision: number; at: string; result: AttemptFinalizationResult } | undefined;
    const finalized = await this.#database.transaction().execute(async (transaction) => {
      const attempts = this.#attempts.using(transaction);
      const factsStore = this.#facts.using(transaction);
      const plans = this.#plans.using(transaction);
      const snapshots = this.#snapshots.using(transaction);
      const lockedAttempt = await attempts.lockPending(attempt.handle);
      const currentAttempt = lockedAttempt ?? await attempts.find(attempt.handle);
      if (!currentAttempt) {
        throw new PlanRuntimeError("attempt-not-found", `Attempt ${attempt.handle} is unknown`);
      }
      if (currentAttempt.state === "finalized") {
        if (!currentAttempt.finalization) {
          throw new PlanRuntimeError("plan-conflict", `Finalized Attempt ${currentAttempt.handle} has no result`);
        }
        return {
          contract: "trust.attempt-finalization@1",
          attemptHandle: currentAttempt.handle,
          plan: currentAttempt.planSlug,
          checkUri: currentAttempt.checkUri,
          ...currentAttempt.finalization,
        } satisfies AttemptFinalizationResult;
      }
      if (currentAttempt.state === "interrupted") {
        throw new PlanRuntimeError("plan-conflict", `Interrupted Attempt ${currentAttempt.handle} cannot be finalized`);
      }
      const facts = await factsStore.list(attempt.handle);
      if (facts.length === 0) throw new PlanRuntimeError("facts-missing", "The Check is unchanged until TRUST accepts Facts");
      const check = await plans.findCheckAtRevision(attempt.planSlug, attempt.planRevision, attempt.checkUri);
      const plan = await plans.findPlan(attempt.planSlug);
      const current = plan ? await plans.readRevision(plan.slug, plan.currentRevision) : undefined;
      const currentCheck = current?.checks.find((candidate) => candidate.uri === attempt.checkUri);
      const activeBefore = plan ? await snapshots.listActive(plan.slug, plan.currentRevision) : [];
      const activeUris = new Set(activeBefore.map((item) => item.checkUri));
      if (!check || !plan || !current || !published || !currentCheck
        || currentCheck.compiledCheckDigest !== attempt.compiledCheckDigest
        || !checkDependenciesSatisfied(currentCheck, current.checks, (uri) => activeUris.has(uri))) {
        throw new PlanRuntimeError("plan-conflict", "The admitted Check is no longer current or actionable");
      }
      if (activeUris.has(check.uri) && !currentAttempt.reobserve) {
        throw new PlanRuntimeError("plan-conflict", "The admitted Check is already satisfied and this Attempt is not a re-observation");
      }
      let validated;
      let qualification;
      try {
        validated = validateFacts(check, facts);
        qualification = qualifyCheck(check, validated, current.checkValues);
      } catch (error) {
        throw new PlanRuntimeError("facts-missing", message(error), { cause: error });
      }
      const affected = dependentCheckUris(current.checks, check.uri);
      affected.add(check.uri);
      const nextRevisionNumber = plan.currentRevision + 1;
      const nextCheckValues = current.checkValues.filter((item) => !affected.has(item.providerCheckUri));
      const nextRoleValues = current.roleValues.filter((item) => !affected.has(item.providerCheckUri));
      if (qualification.verdict === "VALIDATED") {
        nextCheckValues.push({
          checkName: check.check.name,
          providerCheckUri: check.uri,
          parents: Object.freeze({
            ...check.scope.parents,
            [check.scope.role]: cloneJson(check.scope.value),
          }),
          values: validated.values,
        });
        for (const production of check.check.materializes) {
          const role = published.procedure.roles.find((candidate) => candidate.name === production.role);
          if (!role) throw new PlanRuntimeError("plan-conflict", `Role ${production.role} is unavailable`);
          const raw = validated.values[production.field];
          const values = role.cardinality === "many" && Array.isArray(raw) ? raw : [raw];
          const parents = Object.freeze(Object.fromEntries(role.parents.map((parent) => {
            const value = check.context[parent.role];
            if (value === undefined || Array.isArray(value)) {
              throw new PlanRuntimeError(
                "plan-conflict",
                `Check ${check.check.name} cannot identify parent ${parent.role}`,
              );
            }
            return [parent.role, cloneJson(value)];
          })));
          for (const value of values) {
            nextRoleValues.push({
              role: production.role,
              value: cloneJson(value),
              parents,
              providerCheckUri: check.uri,
            });
          }
        }
      }
      const next = buildPlanRevision({
        authority: this.#authority,
        procedure: published.procedure,
        plan: plan.slug,
        environment: plan.environment,
        mode: plan.mode,
        rootInputs: plan.rootInputs,
        declarations: current.agentDeclarations,
        revision: nextRevisionNumber,
        roleValues: nextRoleValues,
        checkValues: nextCheckValues,
      });
      const nextChecks = new Map(next.checks.map((candidate) => [candidate.uri, candidate]));
      const retained = activeBefore.filter((item) => {
        const nextCheck = nextChecks.get(item.checkUri);
        return !affected.has(item.checkUri)
          && nextCheck !== undefined
          && nextCheck.compiledCheckDigest === item.compiledCheckDigest;
      })
        .map((item) => ({ ...item, planRevision: nextRevisionNumber }));
      const factIds = facts.map((item) => item.id);
      const calculatedAt = this.#now().toISOString();
      const delta = {
        newlySatisfied: qualification.verdict === "VALIDATED" && !activeUris.has(check.uri) ? [check.uri] : [],
        newlyOpened: [...affected].filter((uri) => uri !== check.uri && activeUris.has(uri)).sort(),
        unchanged: qualification.verdict === "NOT_VALIDATED" && !activeUris.has(check.uri) ? [check.uri] : [],
      };
      const snapshotBase = {
        attemptHandle: attempt.handle,
        planSlug: attempt.planSlug,
        planRevision: attempt.planRevision,
        checkUri: check.uri,
        compiledCheckDigest: check.compiledCheckDigest,
        state: qualification.verdict === "VALIDATED" ? "satisfied" as const : "open" as const,
        verdict: qualification.verdict,
        reasonCode: qualification.reasonCode,
        reason: qualification.reason,
        factIds,
        checklistDelta: delta,
        calculatedAt,
      };
      const snapshot: CheckSnapshot = { id: digest(snapshotBase), ...snapshotBase };
      const equivalent = await snapshots.findEquivalent(check.uri, check.compiledCheckDigest, factIds);
      if (!equivalent) await snapshots.append(snapshot);
      const activeSnapshot = equivalent ?? snapshot;
      const activeAfter: ActiveCheckQualification[] = [...retained];
      if (qualification.verdict === "VALIDATED") {
        activeAfter.push({
          planSlug: plan.slug,
          planRevision: nextRevisionNumber,
          checkUri: check.uri,
          compiledCheckDigest: check.compiledCheckDigest,
          snapshotId: activeSnapshot.id,
          activationDigest: digest({ plan: plan.slug, revision: nextRevisionNumber, check: check.uri, factIds }),
        });
      }
      await plans.saveRevision(next, calculatedAt);
      await snapshots.saveActiveForRevision(plan.slug, nextRevisionNumber, activeAfter);
      if (qualification.verdict === "VALIDATED" && plan.intentChaining) {
        if (!currentAttempt.intent || plan.currentIntent !== currentAttempt.intent
          || plan.currentIntentAttemptKey !== currentAttempt.attemptKey) {
          throw new PlanRuntimeError("plan-conflict", "The admitted intent is no longer current for this Plan");
        }
        const missingDeclarations = published.procedure.roles.some((role) => (
          role.source.kind === "agent-declaration" && role.source.optional !== true
            && !Object.hasOwn(current.agentDeclarations, role.name)
        ));
        const checklistComplete = !missingDeclarations && activeAfter.length === next.checks.length;
        if (checklistComplete && currentAttempt.nextIntent !== undefined) {
          throw new PlanRuntimeError("plan-conflict", "nextIntent must be omitted when completing the Plan");
        }
        if (!checklistComplete && currentAttempt.nextIntent === undefined) {
          throw new PlanRuntimeError("plan-conflict", "nextIntent is required while the Plan remains in progress");
        }
        await plans.advanceIntent(
          plan.slug,
          currentAttempt.intent,
          currentAttempt.nextIntent,
          checklistComplete,
          currentAttempt.attemptKey,
        );
      } else if (qualification.verdict === "NOT_VALIDATED" && plan.intentChaining) {
        if (!currentAttempt.intent || plan.currentIntent !== currentAttempt.intent
          || plan.currentIntentAttemptKey !== currentAttempt.attemptKey) {
          throw new PlanRuntimeError("plan-conflict", "The admitted intent is no longer current for this Plan");
        }
        await plans.releaseIntentAttempt(plan.slug, currentAttempt.intent, currentAttempt.attemptKey);
      }
      const result = finalization(snapshot);
      await attempts.finalize(attempt.handle, calculatedAt, {
        verdict: result.verdict,
        reasonCode: result.reasonCode,
        reason: result.reason,
        checklistDelta: result.checklistDelta,
      });
      revisionEvent = { revision: nextRevisionNumber, at: calculatedAt, result };
      return result;
    });
    if (revisionEvent !== undefined) {
      this.#events.publish({
        type: "plan.revision",
        at: revisionEvent.at,
        plan: attempt.planSlug,
        revision: revisionEvent.revision,
        cause: "verdict",
        checklistDelta: revisionEvent.result.checklistDelta,
      });
    }
    return finalized;
  }

  async #resolveAdmission(
    attemptKey: string,
    checkUri: string,
    reobserve: boolean,
    intent: string | undefined,
    nextIntent: string | undefined,
  ): Promise<AdmissionResolution | AdmissionFailure> {
    const existing = await this.#attempts.findByKey(attemptKey);
    if (existing) {
      if (existing.checkUri !== checkUri) {
        return { refusal: refusal(attemptKey, "attempt-key-conflict", "Attempt key is already bound to another Check") };
      }
      if (existing.state === "interrupted") {
        return { refusal: refusal(attemptKey, "attempt-interrupted", "Attempt key is already interrupted") };
      }
      if (existing.state === "finalized") {
        return { refusal: refusal(attemptKey, "attempt-finalized", "Attempt key is already finalized") };
      }
      if (Date.parse(existing.expiresAt) <= this.#now().getTime()) {
        return { refusal: refusal(attemptKey, "attempt-expired", "Attempt key is expired") };
      }
      const [check, plan, session] = await Promise.all([
        this.#plans.findCheckAtRevision(existing.planSlug, existing.planRevision, existing.checkUri),
        this.#plans.findPlan(existing.planSlug),
        this.#sessions.findById(existing.sessionId),
      ]);
      if (!check || !plan || !session) return { refusal: refusal(attemptKey, "check-not-found", "The Check is unavailable") };
      if (session.state !== "open") {
        return { refusal: refusal(attemptKey, "attempt-expired", "Attempt Session is no longer open") };
      }
      if (plan.intentChaining && (plan.currentIntentAttemptKey !== existing.attemptKey
        || plan.currentIntent !== existing.intent)) {
        return { refusal: refusal(attemptKey, "attempt-expired", "Attempt no longer owns the Plan's current intent") };
      }
      if (existing.reobserve !== reobserve) {
        return { refusal: refusal(attemptKey, "attempt-key-conflict", "Attempt key is already bound to another admission intent") };
      }
      const requestedIntent = reobserve && intent === undefined && plan.intentChaining
        && existing.intent === `Re-observe Check "${check.check.name}" for Plan "${plan.slug}"`
        ? existing.intent
        : intent;
      if (existing.intent !== requestedIntent || existing.nextIntent !== nextIntent) {
        return { refusal: refusal(attemptKey, "attempt-key-conflict", "Attempt key is already bound to another intent chain") };
      }
      return { attemptKey, check, plan, session, reobserve: existing.reobserve, existing };
    }
    const check = await this.#plans.findCurrentCheck(checkUri);
    let plan = check ? await this.#plans.findPlan(check.planSlug) : undefined;
    if (!check || !plan) return { refusal: refusal(attemptKey, "check-not-found", "The semantic Check URI is unknown") };
    if (await this.#escalations.findActive(plan.slug)) {
      return { refusal: refusal(attemptKey, "check-not-actionable", "The Plan is escalated and must be resumed by an operator") };
    }
    const [activeQualifications, checks] = await Promise.all([
      this.#snapshots.listActive(plan.slug, plan.currentRevision),
      this.#plans.listCurrentChecks(plan.slug),
    ]);
    const active = new Set(activeQualifications.map((item) => item.checkUri));
    if (reobserve && plan.mode !== "dry-run") {
      return { refusal: refusal(attemptKey, "check-not-actionable", "Only a dry-run Plan can explicitly re-observe a satisfied Check") };
    }
    if (reobserve && !active.has(check.uri)) {
      return { refusal: refusal(attemptKey, "check-not-actionable", "Only a satisfied Check can be explicitly re-observed") };
    }
    if (active.has(check.uri) && !reobserve) {
      return { refusal: refusal(attemptKey, "check-not-actionable", "The Check is already satisfied") };
    }
    if (!checkDependenciesSatisfied(check, checks, (uri) => active.has(uri))) {
      return { refusal: refusal(attemptKey, "check-not-actionable", "The Check dependencies are not satisfied") };
    }
    const session = await this.#sessions.findAvailable(plan.slug, this.#now());
    if (!session) {
      return { refusal: refusal(attemptKey, "session-unavailable", "The Plan has no active Session") };
    }
    let admittedIntent = intent;
    let restartIntent: string | undefined;
    if (reobserve && plan.mode === "dry-run" && plan.intentChaining && plan.intentChainState === "COMPLETE") {
      const reobservationIntent = `Re-observe Check "${check.check.name}" for Plan "${plan.slug}"`;
      plan = { ...plan, intentChainState: "ACTIVE", currentIntent: reobservationIntent };
      admittedIntent = reobservationIntent;
      restartIntent = reobservationIntent;
    }
    const intentFailure = await this.#validateIntentAdmission(plan, check, checks, active, admittedIntent, nextIntent);
    if (intentFailure) return { refusal: refusal(attemptKey, intentFailure.reasonCode, intentFailure.reason) };
    return {
      attemptKey,
      check,
      plan,
      session,
      reobserve,
      ...(admittedIntent === undefined ? {} : { intent: admittedIntent }),
      ...(nextIntent === undefined ? {} : { nextIntent }),
      ...(restartIntent === undefined ? {} : { restartIntent }),
    };
  }

  async #validateIntentAdmission(
    plan: import("../model.js").Plan,
    check: import("../model.js").PlanCheck,
    checks: readonly import("../model.js").PlanCheck[],
    active: ReadonlySet<string>,
    intent: string | undefined,
    nextIntent: string | undefined,
  ): Promise<{ readonly reasonCode: string; readonly reason: string } | undefined> {
    if (!plan.intentChaining) {
      return intent === undefined && nextIntent === undefined
        ? undefined
        : { reasonCode: "intent-not-enabled", reason: "This Plan does not use intent chaining; invoke the opaque Check URI without intent parameters" };
    }
    if (plan.intentChainState !== "ACTIVE" || plan.currentIntent === undefined) {
      return { reasonCode: "intent-not-started", reason: "Intent chaining has not started; read the Plan before running a Check" };
    }
    if (intent === undefined) {
      return { reasonCode: "intent-required", reason: "Intent chaining is required; use the exact current intent returned by plan.read" };
    }
    if (intent !== plan.currentIntent) {
      return { reasonCode: "intent-mismatch", reason: "Intent does not match the Plan's current intent; read the Plan again and use the exact intent value" };
    }
    if (nextIntent === intent) {
      return { reasonCode: "next-intent-unchanged", reason: "nextIntent must change the Plan's current intent" };
    }
    const revision = await this.#plans.readRevision(plan.slug, plan.currentRevision);
    const published = await this.#procedures.find(plan.procedure, plan.procedureVersion);
    const finalCandidate = revision !== undefined && published !== undefined
      ? completesPlanOnValidation({ procedure: published.procedure, revision, checks, activeCheckUris: active, check })
      : false;
    if (finalCandidate && nextIntent !== undefined) {
      return { reasonCode: "next-intent-unexpected", reason: "nextIntent must be omitted when completing the Plan" };
    }
    if (!finalCandidate && nextIntent === undefined) {
      return { reasonCode: "next-intent-required", reason: "nextIntent is required while the Plan remains in progress" };
    }
    return undefined;
  }

  async #createAttempt(
    resolved: AdmissionResolution,
  ): Promise<AttemptCreation> {
    const now = this.#now();
    const attempt: Attempt = {
      handle: randomUUID(),
      attemptKey: resolved.attemptKey,
      executionId: randomUUID(),
      planSlug: resolved.plan.slug,
      planRevision: resolved.plan.currentRevision,
      checkUri: resolved.check.uri,
      compiledCheckDigest: resolved.check.compiledCheckDigest,
      sessionId: resolved.session.id,
      operation: resolved.check.check.operation,
      operationDigest: resolved.check.check.operationDigest,
      actionInput: resolved.check.actionInput,
      environment: resolved.plan.environment,
      reobserve: resolved.reobserve,
      ...(resolved.intent === undefined ? {} : { intent: resolved.intent }),
      ...(resolved.nextIntent === undefined ? {} : { nextIntent: resolved.nextIntent }),
      state: "pending",
      admittedAt: now.toISOString(),
      expiresAt: resolved.session.expiresAt,
    };
    return this.#database.transaction().execute(async (transaction) => {
      const attempts = this.#attempts.using(transaction);
      const plans = this.#plans.using(transaction);
      const transactionalPlan = await plans.findPlan(resolved.plan.slug);
      if (!transactionalPlan || transactionalPlan.currentRevision !== resolved.plan.currentRevision
        || !await plans.lockCurrentRevision(resolved.plan.slug, resolved.plan.currentRevision)) {
        throw new AdmissionPlanChangedError();
      }
      if (await this.#escalations.using(transaction).findActive(resolved.plan.slug)) {
        throw new PlanEscalatedDuringAdmissionError();
      }
      if (resolved.existing) {
        const locked = await attempts.lockPending(resolved.existing.handle);
        if (!locked) throw new AdmissionPlanChangedError();
        return { attempt: locked, created: false };
      }
      const concurrent = await attempts.findByKey(attempt.attemptKey);
      if (concurrent) return { attempt: concurrent, created: false };
      if (resolved.plan.intentChaining && resolved.intent !== undefined) {
        const reserved = resolved.restartIntent === undefined
          ? await plans.bindIntentAttempt(
              resolved.plan.slug,
              resolved.intent,
              resolved.check.uri,
              resolved.attemptKey,
              resolved.plan.currentRevision,
            )
          : await plans.restartIntentForAttempt(
              resolved.plan.slug,
              resolved.restartIntent,
              resolved.check.uri,
              resolved.attemptKey,
              resolved.plan.currentRevision,
            );
        if (!reserved) throw new IntentInUseError();
      }
      const creation = await attempts.createOrFind(attempt);
      if (!creation.created) throw new Error("the Attempt key changed while its intent was being reserved");
      return creation;
    });
  }

  async #ensureSession(plan: string): Promise<void> {
    const now = this.#now();
    const changes = await this.#database.transaction().execute(
      (transaction) => this.#ensureSessionIn(transaction, plan, now),
    );
    this.#publishSessionChanges(changes);
  }

  async #ensureSessionIn(database: Database, plan: string, now: Date): Promise<readonly SessionChange[]> {
    const sessions = this.#sessions.using(database);
    const plans = this.#plans.using(database);
    const attempts = this.#attempts.using(database);
    const changes: SessionChange[] = [];
    const current = await sessions.findOpen(plan);
    if (current && Date.parse(current.expiresAt) > now.getTime()) return changes;
    if (current) {
      await sessions.changeState(current.id, "expired", now.toISOString());
      changes.push({ id: current.id, plan, state: "expired", at: now.toISOString() });
    }
    const chainedPlan = await plans.findPlan(plan);
    if (chainedPlan?.currentIntent !== undefined && chainedPlan.currentIntentAttemptKey !== undefined) {
      const owner = await attempts.findByKey(chainedPlan.currentIntentAttemptKey);
      const ownerSession = owner ? await sessions.findById(owner.sessionId) : undefined;
      if (!owner || !ownerSession || ownerSession.state !== "open" || Date.parse(owner.expiresAt) <= now.getTime()) {
        await plans.releaseIntentAttempt(
          chainedPlan.slug,
          chainedPlan.currentIntent,
          chainedPlan.currentIntentAttemptKey,
        );
      }
    }
    const id = randomUUID();
    await sessions.create({
      id,
      planSlug: plan,
      state: "open",
      openedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#sessionDurationMs).toISOString(),
    });
    changes.push({ id, plan, state: "open", at: now.toISOString() });
    return changes;
  }

  #publishSessionChanges(changes: readonly SessionChange[]): void {
    for (const change of changes) this.#sessionEvent(change.id, change.plan, change.state, change.at);
  }

  #sessionEvent(id: string, plan: string, state: "open" | "closed" | "expired", at: string): void {
    this.#events.publish({ type: "session.changed", at, plan, session: { id, state } });
  }

  async #requireAttemptMode(attemptHandle: string, mode: PlanMode, caller: "Operator" | "Runner"): Promise<void> {
    const attempt = await this.#attempts.find(attemptHandle);
    const plan = attempt ? await this.#plans.findPlan(attempt.planSlug) : undefined;
    if (!attempt || !plan) {
      throw new PlanRuntimeError("attempt-not-found", `${caller} Attempt ${attemptHandle} is unknown`);
    }
    if (plan.mode !== mode) {
      throw new PlanRuntimeError(
        "fact-batch-rejected",
        `${caller} Facts are accepted only for a ${mode} Plan`,
      );
    }
  }

  #now(): Date {
    const now = this.#clock.now();
    if (Number.isNaN(now.getTime())) throw new Error("Clock returned an invalid instant");
    return now;
  }
}

function isEscalationDeclaration(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4_096 && value.trim().length > 0 && value === value.trim();
}

function isEscalatedPersistenceError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Plan is escalated");
}

interface AdmissionResolution {
  readonly attemptKey: string;
  readonly check: import("../model.js").PlanCheck;
  readonly plan: import("../model.js").Plan;
  readonly session: import("../model.js").Session;
  readonly reobserve: boolean;
  readonly intent?: string;
  readonly nextIntent?: string;
  readonly restartIntent?: string;
  readonly existing?: Attempt;
}

interface AdmissionFailure { readonly refusal: Omit<Refusal, "contract"> }

function finalization(snapshot: CheckSnapshot): AttemptFinalizationResult {
  return {
    contract: "trust.attempt-finalization@1",
    attemptHandle: snapshot.attemptHandle,
    plan: snapshot.planSlug,
    checkUri: snapshot.checkUri,
    verdict: snapshot.verdict,
    reasonCode: snapshot.reasonCode,
    reason: snapshot.reason,
    checklistDelta: snapshot.checklistDelta,
  };
}

function engagement(revision: number, planRevision: PlanRevision): PlanEngagementResult {
  return {
    contract: "trust.plan-engagement@1",
    status: "ENGAGED",
    procedure: planRevision.procedure,
    procedureVersion: planRevision.procedureVersion,
    plan: planRevision.planSlug,
    environment: planRevision.environment,
    mode: planRevision.mode,
    revision,
    checkUris: planRevision.checks.map((check) => check.uri).sort(),
  };
}

function declarationResult(previous: PlanRevision, current: PlanRevision): PlanDeclarationReplacementResult {
  const previousUris = new Set(previous.checks.map((check) => check.uri));
  const currentUris = new Set(current.checks.map((check) => check.uri));
  return {
    contract: "trust.plan-declaration-replacement@1",
    status: "REPLACED",
    plan: current.planSlug,
    revision: current.revision,
    declarations: current.agentDeclarations,
    checkUris: [...currentUris].sort(),
    removedCheckUris: [...previousUris].filter((uri) => !currentUris.has(uri)).sort(),
    openedCheckUris: [...currentUris].filter((uri) => !previousUris.has(uri)).sort(),
  };
}

function fact(attempt: Attempt, payload: RuntimeJsonObject, index: number, recordedAt: string): Fact {
  if (payload.kind !== attempt.operation || typeof payload.observedAt !== "string"
    || Number.isNaN(Date.parse(payload.observedAt)) || !isRecord(payload.values)) {
    throw new PlanRuntimeError("fact-batch-rejected", `Fact ${index} must contain the admitted Operation, observedAt and values`);
  }
  const values = cloneJson(payload.values);
  return {
    id: digest({
      checkUri: attempt.checkUri,
      compiledCheckDigest: attempt.compiledCheckDigest,
      operation: attempt.operation,
      operationDigest: attempt.operationDigest,
      index,
      observedAt: payload.observedAt,
      values,
    }),
    attemptHandle: attempt.handle,
    executionId: attempt.executionId,
    checkUri: attempt.checkUri,
    compiledCheckDigest: attempt.compiledCheckDigest,
    index,
    operation: attempt.operation,
    operationDigest: attempt.operationDigest,
    observedAt: payload.observedAt,
    recordedAt,
    values,
  };
}

function retainQualifiedDependencies(
  candidates: readonly ActiveCheckQualification[],
  checks: readonly import("../model.js").PlanCheck[],
): readonly ActiveCheckQualification[] {
  const retained = new Map(candidates.map((candidate) => [candidate.checkUri, candidate]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [checkUri] of retained) {
      const check = checks.find((candidate) => candidate.uri === checkUri);
      if (check && checkDependenciesSatisfied(check, checks, (uri) => retained.has(uri))) continue;
      retained.delete(checkUri);
      changed = true;
    }
  }
  return [...retained.values()];
}

function refuse(contract: Refusal["contract"], attemptKey: string, reasonCode: string, reason: string): Refusal {
  return { contract, status: "REFUSED", attemptKey, reasonCode, reason, next: { action: "READ_PLAN" } };
}

function refusal(attemptKey: string, reasonCode: string, reason: string): Omit<Refusal, "contract"> {
  return { status: "REFUSED", attemptKey, reasonCode, reason, next: { action: "READ_PLAN" } };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
