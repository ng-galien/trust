import { createHash, randomUUID } from "node:crypto";
import type {
  AccessContext,
  AttemptFinalizationResult,
  AttemptInterruptionResult,
  CheckAttemptAdmissionInput,
  CheckAttemptAdmissionResult,
  CheckEscalationInput,
  CheckEscalationResult,
  ExternalPrincipal,
  Fact,
  FactBatchInput,
  FactBatchResult,
  MissionDeclarations,
  PlanDeclarationReplacementInput,
  PlanDeclarationReplacementResult,
  PlanEngagementInput,
  PlanEngagementResult,
  PlanMode,
  PlanRelaunchInput,
  PlanRelaunchResult,
  PlanResumptionInput,
  PlanResumptionResult,
  Refusal,
  ResolvedMissions,
  RuntimeJsonObject,
} from "@trust/extension-sdk";
import { OperationCompilationError, projectOperationCredentials, projectOperationEnvironment } from "@trust/operation";
import {
  type AgentDeclaration,
  CatalogProcedureCompilationError,
  type CompiledProcedure,
  type ControlledLanguageFinding,
  validateDeclaredInvocationResults,
} from "@trust/procedure";
import { AccessError } from "../access/error.js";
import { type AccessService, samePrincipal } from "../access/service.js";
import type { AttemptCreation, AttemptStore } from "../attempt/store.js";
import { checkDependenciesSatisfied } from "../check/actionability.js";
import { qualifyCheck, validateFacts } from "../check/qualification.js";
import type { CredentialService } from "../credential/service.js";
import type { Database } from "../database/database.js";
import type { EnvironmentService } from "../environment/service.js";
import type { FactStore } from "../fact/store.js";
import type { ActiveCheckQualification, Attempt, CheckSnapshot, PlanEscalation, PlanRevision } from "../model.js";
import type { Procedures } from "../procedure/procedures.js";
import type { SessionStore } from "../session/store.js";
import type { SnapshotStore } from "../snapshot/store.js";
import type { Clock } from "../time.js";
import { ControlledLanguageUnavailableError, type Vocabularies } from "../vocabulary/vocabularies.js";
import { buildPlanRevision, validateAgentDeclarations, validateRootInputs } from "./build.js";
import { ancestorBlocker, invocationDependencyDigest, readComposition, synchronizeChildren } from "./children.js";
import type { EscalationStore } from "./escalation-store.js";
import type { PlanEvents } from "./events.js";
import { completesPlanOnValidation, dependentCheckUris, isIntentValue, MAX_INTENT_LENGTH } from "./intent.js";
import { normalizePlanMetadata } from "./metadata.js";
import { parseMissionDeclarations } from "./mission-declarations.js";
import type { PlanStore } from "./store.js";
import { planTransaction } from "./transaction.js";

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
  | "check-not-escalatable"
  | "controlled-language"
  | "controlled-language-unavailable";

export class PlanRuntimeError extends Error {
  constructor(
    readonly code: PlanRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
    /** Controlled language findings; present only for the `controlled-language` code. */
    readonly findings: readonly ControlledLanguageFinding[] = [],
  ) {
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

export interface PlanRuntimeDependencies {
  readonly accessService: AccessService;
  readonly clock: Clock;
  readonly database: Database;
  readonly semanticAuthority: string;
  readonly environmentService: EnvironmentService;
  readonly credentialService: CredentialService;
  readonly procedures: Procedures;
  readonly planStore: PlanStore;
  readonly sessionStore: SessionStore;
  readonly attemptStore: AttemptStore;
  readonly factStore: FactStore;
  readonly snapshotStore: SnapshotStore;
  readonly escalationStore: EscalationStore;
  readonly planEvents: PlanEvents;
  readonly sessionDurationMs: number;
  readonly vocabularies: Vocabularies;
}

export class PlanRuntime {
  readonly #access: AccessService;
  readonly #clock: Clock;
  readonly #database: Database;
  readonly #authority: string;
  readonly #environments: EnvironmentService;
  readonly #credentials: CredentialService;
  readonly #procedures: Procedures;
  readonly #plans: PlanStore;
  readonly #sessions: SessionStore;
  readonly #attempts: AttemptStore;
  readonly #facts: FactStore;
  readonly #snapshots: SnapshotStore;
  readonly #escalations: EscalationStore;
  readonly #events: PlanEvents;
  readonly #sessionDurationMs: number;
  readonly #vocabularies: Vocabularies;

  constructor(dependencies: PlanRuntimeDependencies) {
    if (!Number.isSafeInteger(dependencies.sessionDurationMs) || dependencies.sessionDurationMs <= 0) {
      throw new TypeError("sessionDurationMs must be a positive integer");
    }
    this.#access = dependencies.accessService;
    this.#clock = dependencies.clock;
    this.#database = dependencies.database;
    this.#authority = dependencies.semanticAuthority;
    this.#environments = dependencies.environmentService;
    this.#credentials = dependencies.credentialService;
    this.#procedures = dependencies.procedures;
    this.#plans = dependencies.planStore;
    this.#sessions = dependencies.sessionStore;
    this.#attempts = dependencies.attemptStore;
    this.#facts = dependencies.factStore;
    this.#snapshots = dependencies.snapshotStore;
    this.#escalations = dependencies.escalationStore;
    this.#events = dependencies.planEvents;
    this.#sessionDurationMs = dependencies.sessionDurationMs;
    this.#vocabularies = dependencies.vocabularies;
  }

  /**
   * Controlled language findings on prose that an agent declares on a Plan, before the call changes anything.
   * When the control cannot run, it throws {@link ControlledLanguageUnavailableError}: no text passes without control.
   */
  async #controlDeclarations(
    planSlug: string,
    revision: number,
    declarations: readonly AgentDeclaration[],
  ): Promise<readonly ControlledLanguageFinding[]> {
    const planRevision = await this.#plans.readRevision(planSlug, revision);
    if (!planRevision)
      throw new ControlledLanguageUnavailableError(
        `Revision ${revision} of Plan ${planSlug} cannot be read, so its controlled language cannot be applied.`,
      );
    return this.#vocabularies.controlDeclarations(planRevision.resolvedProcedure, declarations);
  }

  async #authorizePlan(
    access: AccessContext | undefined,
    action: string,
    slug: string,
    database = this.#database,
  ): Promise<void> {
    this.#access.authorize(access, action);
    const plan = await this.#plans.using(database).findPlan(slug);
    if (plan) this.#access.authorize(access, action, plan.creator);
  }

  async #authorizeAttempt(
    access: AccessContext | undefined,
    action: string,
    attempt: Attempt,
    database = this.#database,
  ): Promise<void> {
    await this.#authorizePlan(access, action, attempt.planSlug, database);
    if (this.#access.shared && !samePrincipal(this.#access.principal(access), attempt.actor)) {
      throw new AccessError("forbidden", "The authenticated principal does not own this Attempt");
    }
  }

  async #initialRevision(input: PlanEngagementInput, pinned?: CompiledProcedure): Promise<PlanRevision> {
    if (input.contract !== "trust.plan-engagement-request@1") {
      throw new PlanRuntimeError("invalid-plan-engagement", "Unsupported Plan engagement contract");
    }
    let procedure: CompiledProcedure | undefined;
    try {
      procedure = pinned ?? (await this.#procedures.resolve(input.procedure, input.procedureVersion));
    } catch (error) {
      throw new PlanRuntimeError("invalid-plan-engagement", message(error), { cause: error });
    }
    if (!procedure || procedure.procedure !== input.procedure || procedure.version !== input.procedureVersion) {
      throw new PlanRuntimeError(
        "procedure-not-found",
        `Procedure ${input.procedure}@${input.procedureVersion} is not published`,
      );
    }
    if (!this.#environments.resolve(input.environment)) {
      throw new PlanRuntimeError("invalid-plan-engagement", `Environment "${input.environment}" is not configured`);
    }
    const mode: PlanMode = input.mode ?? "live";
    try {
      return buildPlanRevision({
        authority: this.#authority,
        procedure,
        plan: input.plan,
        environment: input.environment,
        mode,
        metadata: normalizePlanMetadata(input.metadata),
        rootInputs: input.rootInputs,
        revision: 1,
      });
    } catch (error) {
      throw new PlanRuntimeError("invalid-plan-engagement", message(error), { cause: error });
    }
  }

  async #saveInitialRevision(
    database: Database,
    revision: PlanRevision,
    at: Date,
    sessionId: string,
    creator: ExternalPrincipal | null,
  ): Promise<void> {
    await this.#plans.using(database).saveRevision(revision, at.toISOString(), creator);
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

  async #synchronizeChildren(database: Database, plan: string): Promise<void> {
    await synchronizeChildren({
      database,
      authority: this.#authority,
      plan,
      at: this.#now().toISOString(),
      create: (revision, creator) => this.#saveInitialRevision(database, revision, this.#now(), randomUUID(), creator),
    });
  }

  async #publishAncestorChanges(plan: string): Promise<void> {
    let current = plan;
    while (true) {
      const parent = await this.#database
        .selectFrom("child_generations")
        .selectAll()
        .where("child_plan", "=", current)
        .where("superseded_at", "is", null)
        .executeTakeFirst();
      if (!parent) return;
      current = parent.parent_plan;
      this.#events.publish({ type: "plan.state", at: this.#now().toISOString(), plan: current });
    }
  }

  async engage(input: PlanEngagementInput, access?: AccessContext): Promise<PlanEngagementResult> {
    await this.#authorizePlan(access, "plan.engage", input.plan);
    const existing = await this.#plans.findPlan(input.plan);
    const pinned = existing ? await this.#plans.readRevision(existing.slug, existing.currentRevision) : undefined;
    const revision = await this.#initialRevision(
      {
        ...input,
        ...(input.metadata === undefined && existing !== undefined ? { metadata: existing.metadata } : {}),
      },
      pinned?.resolvedProcedure,
    );
    if (existing) {
      const current = await this.#plans.readRevision(input.plan, existing.currentRevision);
      if (
        !current ||
        current.definitionDigest !== revision.definitionDigest ||
        canonicalJson(existing.metadata) !== canonicalJson(revision.metadata) ||
        canonicalJson(existing.rootInputs) !== canonicalJson(revision.rootInputs) ||
        existing.environment !== revision.environment ||
        existing.mode !== revision.mode
      ) {
        throw new PlanRuntimeError(
          "plan-conflict",
          `Plan ${input.plan} is already engaged with another Procedure or context`,
        );
      }
      const changes = await planTransaction(this.#database, input.plan, async (transaction) => {
        await this.#authorizePlan(access, "plan.engage", input.plan, transaction);
        const changes = await this.#ensureSessionIn(transaction, input.plan, this.#now());
        await this.#synchronizeChildren(transaction, input.plan);
        return changes;
      });
      this.#publishSessionChanges(changes);
      return engagement(existing.currentRevision, current);
    }
    const now = this.#now();
    const sessionId = randomUUID();
    const created = await planTransaction(this.#database, input.plan, async (transaction) => {
      const plans = this.#plans.using(transaction);
      const concurrent = await plans.findPlan(input.plan);
      if (concurrent) {
        this.#access.authorize(access, "plan.engage", concurrent.creator);
        const current = await plans.readRevision(input.plan, concurrent.currentRevision);
        if (
          !current ||
          current.definitionDigest !== revision.definitionDigest ||
          canonicalJson(concurrent.metadata) !== canonicalJson(revision.metadata) ||
          canonicalJson(concurrent.rootInputs) !== canonicalJson(revision.rootInputs) ||
          concurrent.environment !== revision.environment ||
          concurrent.mode !== revision.mode
        ) {
          throw new PlanRuntimeError(
            "plan-conflict",
            `Plan ${input.plan} is already engaged with another Procedure or context`,
          );
        }
        await this.#synchronizeChildren(transaction, input.plan);
        return { existing: engagement(concurrent.currentRevision, current) };
      }
      await this.#saveInitialRevision(transaction, revision, now, sessionId, this.#access.principal(access));
      await this.#synchronizeChildren(transaction, input.plan);
      return { existing: undefined };
    });
    if (created.existing) return created.existing;
    this.#publishEngagement(input.plan, now, sessionId);
    return engagement(1, revision);
  }

  /** Start one dry-run again from revision 1 without any externally visible deleted state. */
  async reset(planSlug: string, access?: AccessContext): Promise<PlanEngagementResult> {
    await this.#authorizePlan(access, "plan.reset", planSlug);
    const plan = await this.#plans.findPlan(planSlug);
    if (!plan) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is unknown`);
    if (plan.mode !== "dry-run")
      throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is a live Plan and cannot be reset`);
    const pinned = await this.#plans.readRevision(planSlug, plan.currentRevision);
    if (!pinned) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} has no pinned composition`);
    const revision = await this.#initialRevision(
      {
        contract: "trust.plan-engagement-request@1",
        procedure: plan.procedure,
        procedureVersion: plan.procedureVersion,
        plan: plan.slug,
        environment: plan.environment,
        rootInputs: plan.rootInputs,
        metadata: plan.metadata,
        mode: plan.mode,
      },
      pinned.resolvedProcedure,
    );
    const now = this.#now();
    const sessionId = randomUUID();
    await planTransaction(this.#database, planSlug, async (transaction) => {
      await this.#authorizePlan(access, "plan.reset", planSlug, transaction);
      await this.#requireIndependentHistory(transaction, planSlug);
      await this.#plans.using(transaction).remove(planSlug);
      await this.#saveInitialRevision(transaction, revision, now, sessionId, plan.creator);
    });
    this.#events.publish({ type: "plan.removed", at: now.toISOString(), plan: planSlug });
    this.#publishEngagement(planSlug, now, sessionId);
    return engagement(1, revision);
  }

  /** Erase a dry-run Plan entirely (a blocked rehearsal starts over). Live Plans are audit history: refused. */
  async remove(planSlug: string, access?: AccessContext): Promise<{ readonly plan: string; readonly removed: true }> {
    await this.#authorizePlan(access, "plan.remove", planSlug);
    const plan = await this.#plans.findPlan(planSlug);
    if (!plan) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is unknown`);
    if (plan.mode !== "dry-run")
      throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is a live Plan and cannot be removed`);
    await planTransaction(this.#database, planSlug, async (transaction) => {
      await this.#authorizePlan(access, "plan.remove", planSlug, transaction);
      await this.#requireIndependentHistory(transaction, planSlug);
      await this.#plans.using(transaction).remove(planSlug);
    });
    this.#events.publish({ type: "plan.removed", at: this.#now().toISOString(), plan: planSlug });
    return { plan: planSlug, removed: true };
  }

  async #requireIndependentHistory(database: Database, plan: string): Promise<void> {
    const relation = await database
      .selectFrom("child_generations")
      .select("child_plan")
      .where((expression) => expression.or([expression("parent_plan", "=", plan), expression("child_plan", "=", plan)]))
      .executeTakeFirst();
    if (relation)
      throw new PlanRuntimeError(
        "plan-conflict",
        `Plan ${plan} belongs to child composition history and cannot be reset or removed`,
      );
  }

  async close(planSlug: string, access?: AccessContext): Promise<{ readonly plan: string; readonly closed: boolean }> {
    await this.#authorizePlan(access, "plan.close", planSlug);
    const closedAt = this.#now().toISOString();
    const session = await planTransaction(this.#database, planSlug, async (transaction) => {
      await this.#authorizePlan(access, "plan.close", planSlug, transaction);
      const plan = await this.#plans.using(transaction).findPlan(planSlug);
      if (!plan) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is unknown`);
      const sessions = this.#sessions.using(transaction);
      const current = await sessions.findOpen(planSlug);
      if (current) await sessions.changeState(current.id, "closed", closedAt);
      return current;
    });
    if (session) this.#sessionEvent(session.id, planSlug, "closed", closedAt);
    return { plan: planSlug, closed: session !== undefined };
  }

  async escalateCheck(input: CheckEscalationInput, access?: AccessContext): Promise<CheckEscalationResult> {
    this.#access.authorize(access, "check.escalate");
    const accessAttempt = await this.#attempts.find(input.attemptHandle);
    if (accessAttempt) await this.#authorizeAttempt(access, "check.escalate", accessAttempt);
    if (
      input.contract !== "trust.check-escalation-request@1" ||
      input.attemptHandle.length === 0 ||
      !isEscalationDeclaration(input.blockingReason) ||
      !isEscalationDeclaration(input.forbiddenFurtherAction)
    ) {
      throw new PlanRuntimeError(
        "check-not-escalatable",
        "Escalation requires a non-empty blockingReason and forbiddenFurtherAction of at most 4096 characters",
      );
    }
    const requested = await this.#attempts.find(input.attemptHandle);
    if (!requested)
      throw new PlanRuntimeError(
        "check-not-escalatable",
        "Escalation must reference its finalized NOT_VALIDATED Attempt",
      );
    let languageFindings: readonly ControlledLanguageFinding[];
    try {
      languageFindings = await this.#controlDeclarations(requested.planSlug, requested.planRevision, [
        { field: "blocking-reason", text: input.blockingReason },
        { field: "forbidden-further-action", text: input.forbiddenFurtherAction },
      ]);
    } catch (error) {
      if (!(error instanceof ControlledLanguageUnavailableError)) throw error;
      throw new PlanRuntimeError("controlled-language-unavailable", controlledLanguageUnavailable(error), {
        cause: error,
      });
    }
    if (languageFindings.length > 0) {
      throw new PlanRuntimeError(
        "controlled-language",
        controlledLanguageRefusal("The escalation declarations", languageFindings),
        undefined,
        languageFindings,
      );
    }
    const requestedPlan = requested.planSlug;
    let escalation: PlanEscalation | undefined;
    let escalationCreated = false;
    await planTransaction(this.#database, requestedPlan, async (transaction) => {
      await this.#authorizeAttempt(access, "check.escalate", requested, transaction);
      const plans = this.#plans.using(transaction);
      const escalations = this.#escalations.using(transaction);
      const snapshots = this.#snapshots.using(transaction);
      const attempts = this.#attempts.using(transaction);
      const facts = this.#facts.using(transaction);
      const requestedAttempt = await attempts.find(input.attemptHandle);
      const plan = requestedAttempt ? await plans.findPlan(requestedAttempt.planSlug) : undefined;
      if (
        !requestedAttempt ||
        !plan ||
        requestedAttempt.checkUri !== input.checkUri ||
        requestedAttempt.state !== "finalized" ||
        requestedAttempt.finalization?.verdict !== "NOT_VALIDATED"
      ) {
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
        if (
          previousEscalation.blockingReason === input.blockingReason &&
          previousEscalation.forbiddenFurtherAction === input.forbiddenFurtherAction
        ) {
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
      if (!(await plans.lockCurrentRevision(plan.slug, plan.currentRevision))) {
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
      if (
        !latestAttempt ||
        latestAttempt.handle !== requestedAttempt.handle ||
        latestAttempt.state !== "finalized" ||
        latestAttempt.compiledCheckDigest !== check.compiledCheckDigest ||
        latestAttempt.finalization?.verdict !== "NOT_VALIDATED"
      ) {
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
      await this.#synchronizeChildren(transaction, plan.slug);
      escalationCreated = true;
    });
    if (!escalation) throw new Error("Escalation transaction did not produce a result");
    if (escalationCreated) {
      await this.#publishAncestorChanges(escalation.planSlug);
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

  async resumePlan(input: PlanResumptionInput, access?: AccessContext): Promise<PlanResumptionResult> {
    await this.#authorizePlan(access, "plan.resume", input.plan);
    if (!isEscalationDeclaration(input.resumeReason)) {
      throw new PlanRuntimeError(
        "plan-conflict",
        "Plan resumption requires a non-empty resumeReason of at most 4096 characters",
      );
    }
    const planSlug = input.plan;
    const now = this.#now();
    const resumedAt = now.toISOString();
    let escalation: PlanEscalation | undefined;
    let resumed = false;
    let sessionEvents: readonly SessionChange[] = [];
    await planTransaction(this.#database, planSlug, async (transaction) => {
      await this.#authorizePlan(access, "plan.resume", planSlug, transaction);
      const plans = this.#plans.using(transaction);
      const plan = await plans.findPlan(planSlug);
      if (!plan) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is unknown`);
      if (!(await plans.lockCurrentRevision(plan.slug, plan.currentRevision))) {
        throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} changed while resumption was requested`);
      }
      const escalations = this.#escalations.using(transaction);
      const activeEscalation = await escalations.findActive(planSlug);
      if (!activeEscalation) {
        const requestedEscalation = await escalations.find(input.escalationId);
        if (requestedEscalation?.planSlug === planSlug && requestedEscalation.resumedAt) {
          if (requestedEscalation.resumeReason !== input.resumeReason) {
            throw new PlanRuntimeError(
              "plan-conflict",
              `Escalation ${input.escalationId} was resumed with another reason`,
            );
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
            throw new PlanRuntimeError(
              "plan-conflict",
              `Escalation ${input.escalationId} was resumed with another reason`,
            );
          }
          escalation = requestedEscalation;
          return;
        }
        throw new PlanRuntimeError(
          "plan-conflict",
          `Escalation ${input.escalationId} is not active for Plan ${planSlug}`,
        );
      }
      sessionEvents = await this.#ensureSessionIn(transaction, planSlug, now);
      escalation = await escalations.resume(input.escalationId, resumedAt, input.resumeReason);
      if (!escalation) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is not escalated`);
      await this.#synchronizeChildren(transaction, planSlug);
      resumed = true;
    });
    if (!escalation) throw new Error("Plan resumption transaction did not produce a result");
    if (resumed) {
      await this.#publishAncestorChanges(planSlug);
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

  /**
   * Resolves an escalated child Plan by abandoning its invocation generation. The parent synchronization then
   * creates the next generation from the same pinned definition and inputs; the abandoned Plan keeps its history.
   */
  async relaunchPlan(input: PlanRelaunchInput, access?: AccessContext): Promise<PlanRelaunchResult> {
    await this.#authorizePlan(access, "plan.relaunch", input.plan);
    if (!isEscalationDeclaration(input.relaunchReason)) {
      throw new PlanRuntimeError(
        "plan-conflict",
        "Plan relaunch requires a non-empty relaunchReason of at most 4096 characters",
      );
    }
    const planSlug = input.plan;
    const relaunchedAt = this.#now().toISOString();
    const auditReason = `Relaunched as a new invocation generation: ${input.relaunchReason}`;
    let result: PlanRelaunchResult | undefined;
    let relaunched = false;
    await planTransaction(this.#database, planSlug, async (transaction) => {
      await this.#authorizePlan(access, "plan.relaunch", planSlug, transaction);
      const relation = await transaction
        .selectFrom("child_generations")
        .selectAll()
        .where("child_plan", "=", planSlug)
        .executeTakeFirst();
      if (!relation) throw new PlanRuntimeError("plan-conflict", `Plan ${planSlug} is not a child invocation`);
      const escalations = this.#escalations.using(transaction);
      const requested = await escalations.find(input.escalationId);
      if (requested?.planSlug !== planSlug) {
        throw new PlanRuntimeError(
          "plan-conflict",
          `Escalation ${input.escalationId} does not belong to Plan ${planSlug}`,
        );
      }
      if (relation.superseded_at !== null) {
        // A replayed request returns the generation it created; any other resolution is a conflict.
        if (requested.resumeReason !== auditReason) {
          throw new PlanRuntimeError(
            "plan-conflict",
            `Plan ${planSlug} is no longer the current invocation generation`,
          );
        }
      } else {
        const active = await escalations.findActive(planSlug);
        if (active?.id !== input.escalationId) {
          throw new PlanRuntimeError(
            "plan-conflict",
            `Escalation ${input.escalationId} is not active for Plan ${planSlug}`,
          );
        }
        await escalations.resume(input.escalationId, relaunchedAt, auditReason);
        await transaction
          .updateTable("child_generations")
          .set({ superseded_at: relaunchedAt })
          .where("child_plan", "=", planSlug)
          .where("superseded_at", "is", null)
          .execute();
        await this.#synchronizeChildren(transaction, relation.parent_plan);
        relaunched = true;
      }
      const next = await transaction
        .selectFrom("child_generations")
        .selectAll()
        .where("parent_plan", "=", relation.parent_plan)
        .where("invocation_id", "=", relation.invocation_id)
        .where("generation", ">", relation.generation)
        .orderBy("generation")
        .executeTakeFirst();
      if (!next) {
        throw new PlanRuntimeError(
          "plan-conflict",
          `The parent Plan ${relation.parent_plan} cannot start a new generation of this invocation now`,
        );
      }
      const escalation = relaunched ? await escalations.find(input.escalationId) : requested;
      result = {
        contract: "trust.plan-relaunch@1",
        status: "RELAUNCHED",
        plan: planSlug,
        escalationId: input.escalationId,
        relaunchReason: input.relaunchReason,
        relaunchedAt: escalation?.resumedAt ?? relaunchedAt,
        parentPlan: relation.parent_plan,
        invocationId: relation.invocation_id,
        supersededGeneration: relation.generation,
        generation: next.generation,
        childPlan: next.child_plan,
      };
    });
    if (!result) throw new Error("Plan relaunch transaction did not produce a result");
    if (relaunched) {
      this.#events.publish({ type: "plan.state", at: relaunchedAt, plan: planSlug });
      this.#events.publish({ type: "plan.state", at: relaunchedAt, plan: result.parentPlan });
      await this.#publishAncestorChanges(result.parentPlan);
    }
    return result;
  }

  async replaceDeclarations(
    input: PlanDeclarationReplacementInput,
    access?: AccessContext,
  ): Promise<PlanDeclarationReplacementResult> {
    await this.#authorizePlan(access, "plan.declarations.replace", input.plan);
    const plan = await this.#plans.findPlan(input.plan);
    const current = plan ? await this.#plans.readRevision(plan.slug, plan.currentRevision) : undefined;
    if (!plan || !current || plan.currentRevision !== input.expectedRevision) {
      throw new PlanRuntimeError("plan-conflict", `Plan ${input.plan} is unavailable or changed`);
    }
    if (await this.#escalations.findActive(plan.slug)) {
      throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} is escalated and must be resumed by an operator`);
    }
    let declarations: RuntimeJsonObject;
    let missionDeclarations: MissionDeclarations;
    let resolvedMissions: ResolvedMissions;
    try {
      declarations = validateAgentDeclarations(
        current.resolvedProcedure.roles,
        plan.rootInputs,
        plan.slug,
        input.declarations,
      );
      const requested = parseMissionDeclarations(input.missionDeclarations);
      if (input.missionDeclarations !== undefined && requested === undefined)
        throw new TypeError("Invalid mission declarations");
      const accepted: Record<string, MissionDeclarations[string]> = Object.assign(
        Object.create(null),
        current.missionDeclarations,
      );
      const resolved: Record<string, ResolvedMissions[string]> = Object.assign(
        Object.create(null),
        current.resolvedMissions,
      );
      for (const [collection, missions] of Object.entries(requested ?? {})) {
        if (!current.resolvedProcedure.missionCollections?.some((value) => value.name === collection)) {
          throw new TypeError(`Mission collection "${collection}" is not declared by the Procedure`);
        }
        const previous = current.missionDeclarations[collection] ?? [];
        for (const mission of previous) {
          const submitted = missions.find((value) => value.id === mission.id);
          if (!submitted || canonicalJson(submitted) !== canonicalJson(mission)) {
            throw new TypeError(`Accepted mission "${mission.id}" cannot be removed or modified`);
          }
        }
        const compiled = [...(current.resolvedMissions[collection] ?? [])];
        for (const mission of missions) {
          if (previous.some((value) => value.id === mission.id)) continue;
          let phase = "resolution";
          try {
            const procedure = await this.#procedures.resolveMission(mission.definition);
            phase = "inputs";
            validateRootInputs(procedure.roles, mission.rootInputs);
            phase = "results";
            validateDeclaredInvocationResults(current.resolvedProcedure, collection, procedure);
            compiled.push({ id: mission.id, procedure });
          } catch (error) {
            let detail = message(error);
            if (error instanceof OperationCompilationError || error instanceof CatalogProcedureCompilationError) {
              phase = "compilation";
              const position = error.location ? `:${error.location.line}:${error.location.column}` : "";
              detail = `[${error.code}] ${error.sourceName ?? "procedure.feature"}${position}: ${error.message}`;
            }
            throw new TypeError(`Mission collection "${collection}", mission "${mission.id}", ${phase}: ${detail}`, {
              cause: error,
            });
          }
        }
        // Keep acceptance order stable even if an identical submission is reordered.
        accepted[collection] = [
          ...previous,
          ...missions.filter((value) => !previous.some((old) => old.id === value.id)),
        ];
        resolved[collection] = compiled;
      }
      missionDeclarations = accepted;
      resolvedMissions = resolved;
    } catch (error) {
      throw new PlanRuntimeError("invalid-plan-declarations", `${message(error)}. No changes accepted.`, {
        cause: error,
      });
    }
    if (
      canonicalJson(declarations) === canonicalJson(current.agentDeclarations) &&
      canonicalJson(missionDeclarations) === canonicalJson(current.missionDeclarations)
    ) {
      await planTransaction(this.#database, plan.slug, async (transaction) => {
        await this.#authorizePlan(access, "plan.declarations.replace", plan.slug, transaction);
        const plans = this.#plans.using(transaction);
        const transactionalPlan = await plans.findPlan(plan.slug);
        if (
          !transactionalPlan ||
          transactionalPlan.currentRevision !== input.expectedRevision ||
          !(await plans.lockCurrentRevision(plan.slug, input.expectedRevision))
        ) {
          throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} changed while declarations were requested`);
        }
        if (await this.#escalations.using(transaction).findActive(plan.slug)) {
          throw new PlanRuntimeError(
            "plan-conflict",
            `Plan ${plan.slug} is escalated and must be resumed by an operator`,
          );
        }
      });
      return declarationResult(current, current);
    }
    const activeBefore = await this.#snapshots.listActive(plan.slug, plan.currentRevision);
    const changedMissionScenarios = new Set(
      (current.resolvedProcedure.declaredInvocations ?? [])
        .filter(
          (value) =>
            canonicalJson(missionDeclarations[value.collection]) !==
            canonicalJson(current.missionDeclarations[value.collection]),
        )
        .map((value) => value.scenario),
    );
    let roleValues = current.roleValues;
    let checkValues = current.checkValues;
    let next: PlanRevision;
    let retained: readonly ActiveCheckQualification[];
    while (true) {
      next = buildPlanRevision({
        authority: this.#authority,
        procedure: current.resolvedProcedure,
        plan: plan.slug,
        environment: plan.environment,
        mode: plan.mode,
        metadata: plan.metadata,
        rootInputs: plan.rootInputs,
        declarations,
        missionDeclarations,
        resolvedMissions,
        revision: plan.currentRevision + 1,
        roleValues,
        importedValues: current.importedValues,
        checkValues,
        pruneUnavailableRoleValues: true,
      });
      // Checks untouched by the new declarations keep their active qualification (same URI, same semantic digest).
      const nextChecks = new Map(next.checks.map((candidate) => [candidate.uri, candidate]));
      const retainedCandidates = activeBefore
        .filter((item) => {
          const check = nextChecks.get(item.checkUri);
          return (
            check?.compiledCheckDigest === item.compiledCheckDigest &&
            !check.scenarioDependencies.some((value) => changedMissionScenarios.has(value))
          );
        })
        .map((item) => ({ ...item, planRevision: next.revision }));
      retained = retainQualifiedDependencies(retainedCandidates, next.checks);
      const retainedProviders = new Set(retained.map((item) => item.checkUri));
      roleValues = next.roleValues.filter((item) => retainedProviders.has(item.providerCheckUri));
      checkValues = next.checkValues.filter((item) => retainedProviders.has(item.providerCheckUri));
      if (roleValues.length === next.roleValues.length && checkValues.length === next.checkValues.length) break;
    }
    const missingDeclarations = current.resolvedProcedure.roles.some(
      (role) =>
        role.source.kind === "agent-declaration" &&
        role.source.optional !== true &&
        !Object.hasOwn(declarations, role.name),
    );
    const nextChecklistComplete =
      !missingDeclarations &&
      retained.length === next.checks.length &&
      (current.resolvedProcedure.missionCollections ?? []).every(
        (value) => (missionDeclarations[value.name]?.length ?? 0) > 0,
      );
    const now = this.#now();
    try {
      await planTransaction(this.#database, plan.slug, async (transaction) => {
        await this.#authorizePlan(access, "plan.declarations.replace", plan.slug, transaction);
        const plans = this.#plans.using(transaction);
        const chainedPlan = await plans.findPlan(plan.slug);
        if (
          !chainedPlan ||
          chainedPlan.currentRevision !== input.expectedRevision ||
          !(await plans.lockCurrentRevision(plan.slug, input.expectedRevision))
        ) {
          throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} changed while declarations were requested`);
        }
        if (await this.#escalations.using(transaction).findActive(plan.slug)) {
          throw new PlanRuntimeError(
            "plan-conflict",
            `Plan ${plan.slug} is escalated and must be resumed by an operator`,
          );
        }
        if (chainedPlan.intentChaining && chainedPlan.currentIntentAttemptKey !== undefined) {
          const attempts = this.#attempts.using(transaction);
          const sessions = this.#sessions.using(transaction);
          const owner = await attempts.findByKey(chainedPlan.currentIntentAttemptKey);
          const ownerSession = owner ? await sessions.findById(owner.sessionId) : undefined;
          const ownerIsPending =
            owner?.state === "pending" && ownerSession?.state === "open" && Date.parse(owner.expiresAt) > now.getTime();
          if (ownerIsPending) {
            throw new PlanRuntimeError(
              "plan-conflict",
              `Plan ${plan.slug} has a pending Attempt for its current intent`,
            );
          }
          if (chainedPlan.currentIntent === undefined) {
            throw new PlanRuntimeError("plan-conflict", `Plan ${plan.slug} has an invalid intent reservation`);
          }
          await plans.releaseIntentAttempt(plan.slug, chainedPlan.currentIntent, chainedPlan.currentIntentAttemptKey);
        }
        await plans.saveRevision(next, now.toISOString());
        await this.#snapshots.using(transaction).saveActiveForRevision(plan.slug, next.revision, retained);
        const composition = await readComposition(transaction, plan.slug);
        if (
          chainedPlan?.intentChaining &&
          nextChecklistComplete &&
          composition.complete &&
          chainedPlan.intentChainState !== "COMPLETE"
        ) {
          await plans.completeIntentWithoutAttempt(plan.slug);
        } else if (
          chainedPlan?.intentChaining &&
          chainedPlan.intentChainState === "COMPLETE" &&
          (!nextChecklistComplete || !composition.complete)
        ) {
          await plans.restartIntent(plan.slug);
        }
        await this.#synchronizeChildren(transaction, plan.slug);
      });
    } catch (error) {
      if (isEscalatedPersistenceError(error)) {
        throw new PlanRuntimeError(
          "plan-conflict",
          `Plan ${plan.slug} is escalated and must be resumed by an operator`,
        );
      }
      throw error;
    }
    await this.#ensureSession(plan.slug);
    const result = declarationResult(current, next);
    await this.#publishAncestorChanges(plan.slug);
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

  async admitCheck(input: CheckAttemptAdmissionInput, access?: AccessContext): Promise<CheckAttemptAdmissionResult> {
    this.#access.authorize(access, "check.attempt.admit");
    const accessCheck = await this.#plans.findCurrentCheck(input.checkUri);
    if (accessCheck) await this.#authorizePlan(access, "check.attempt.admit", accessCheck.planSlug);
    const accessAttempt = await this.#attempts.findByKey(input.attemptKey);
    if (accessAttempt) await this.#authorizeAttempt(access, "check.attempt.admit", accessAttempt);
    if (input.contract !== "trust.check-admission-request@1") {
      return refuse(
        "trust.check-admission@1",
        input.attemptKey,
        "invalid-admission-contract",
        "Unsupported admission contract",
      );
    }
    if (input.intent !== undefined && !isIntentValue(input.intent)) {
      return refuse(
        "trust.check-admission@1",
        input.attemptKey,
        "intent-invalid",
        `intent must contain 1 to ${MAX_INTENT_LENGTH} characters, be trimmed and single-line, and contain no control character`,
      );
    }
    if (input.nextIntent !== undefined && !isIntentValue(input.nextIntent)) {
      return refuse(
        "trust.check-admission@1",
        input.attemptKey,
        "intent-invalid",
        `nextIntent must contain 1 to ${MAX_INTENT_LENGTH} characters, be trimmed and single-line, and contain no control character`,
      );
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
      creation = await this.#createAttempt(resolved, access);
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
    if (creation.created && attempt.intent !== undefined) {
      this.#events.publish({
        type: "plan.state",
        at: this.#now().toISOString(),
        plan: attempt.planSlug,
        revision: attempt.planRevision,
      });
    }
    const executionConstraint = resolved.check.check.executionConstraint;
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
      environment:
        resolved.plan.mode === "dry-run"
          ? {}
          : projectOperationEnvironment(resolved.check.operation, this.#environments.resolve(attempt.environment) ?? {})
              .environment,
      credentials: resolved.credentials,
      ...(executionConstraint === undefined || resolved.plan.mode === "dry-run" ? {} : { executionConstraint }),
      expiresAt: attempt.expiresAt,
    };
  }

  async #ingestFacts(input: FactBatchInput, access?: AccessContext): Promise<FactBatchResult> {
    const requested = await this.#attempts.find(input.attemptHandle);
    if (!requested) throw new PlanRuntimeError("attempt-not-found", "The requested Attempt is unknown");
    return planTransaction(this.#database, requested.planSlug, async (transaction) => {
      await this.#authorizeAttempt(access, "check.attempt.facts", requested, transaction);
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

  async ingestDryRunFacts(input: FactBatchInput, access?: AccessContext): Promise<FactBatchResult> {
    this.#access.authorize(access, "check.attempt.facts");
    const accessAttempt = await this.#attempts.find(input.attemptHandle);
    if (accessAttempt) await this.#authorizeAttempt(access, "check.attempt.facts", accessAttempt);
    await this.#requireAttemptMode(input.attemptHandle, "dry-run", "Operator");
    return this.#ingestFacts(input, access);
  }

  async ingestLiveFacts(input: FactBatchInput, access?: AccessContext): Promise<FactBatchResult> {
    this.#access.authorize(access, "check.attempt.facts");
    const accessAttempt = await this.#attempts.find(input.attemptHandle);
    if (accessAttempt) await this.#authorizeAttempt(access, "check.attempt.facts", accessAttempt);
    await this.#requireAttemptMode(input.attemptHandle, "live", "Runner");
    return this.#ingestFacts(input, access);
  }

  async #ingest(attempt: Attempt, input: FactBatchInput, database: Database): Promise<FactBatchResult> {
    if (
      attempt.attemptKey !== input.attemptKey ||
      attempt.executionId !== input.executionId ||
      attempt.checkUri !== input.checkUri
    ) {
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
      throw new PlanRuntimeError(
        "fact-batch-rejected",
        "Fact batch belongs to an Attempt whose Session is no longer open",
      );
    }
    if (
      attempt.intent !== undefined &&
      (!plan?.intentChaining ||
        plan.currentIntent !== attempt.intent ||
        plan.currentIntentAttemptKey !== attempt.attemptKey)
    ) {
      throw new PlanRuntimeError(
        "fact-batch-rejected",
        "Fact batch belongs to an Attempt that no longer owns the current intent",
      );
    }
    if (input.facts.length === 0 || Number.isNaN(Date.parse(input.recordedAt))) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch must contain Facts and a valid recordedAt instant");
    }
    const check = await this.#plans
      .using(database)
      .findCheckAtRevision(attempt.planSlug, attempt.planRevision, attempt.checkUri);
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

  async finalizeCheck(attemptHandle: string, access?: AccessContext): Promise<AttemptFinalizationResult> {
    this.#access.authorize(access, "check.attempt.finalize");
    const accessAttempt = await this.#attempts.find(attemptHandle);
    if (accessAttempt) await this.#authorizeAttempt(access, "check.attempt.finalize", accessAttempt);
    const attempt = await this.#attempts.find(attemptHandle);
    if (!attempt) {
      throw new PlanRuntimeError("attempt-not-found", `Runner Attempt ${attemptHandle} is unknown`);
    }
    return this.#finalize(attempt, access);
  }

  async interruptCheck(attemptHandle: string, access?: AccessContext): Promise<AttemptInterruptionResult> {
    this.#access.authorize(access, "check.attempt.interrupt");
    const accessAttempt = await this.#attempts.find(attemptHandle);
    if (accessAttempt) await this.#authorizeAttempt(access, "check.attempt.interrupt", accessAttempt);
    const result = (): AttemptInterruptionResult => ({
      contract: "trust.attempt-interruption@1",
      status: "INTERRUPTED",
      attemptHandle,
    });
    const requested = await this.#attempts.find(attemptHandle);
    if (!requested) throw new PlanRuntimeError("attempt-not-found", "The requested Attempt is unknown");
    let releasedPlan: string | undefined;
    const interruption = await planTransaction(this.#database, requested.planSlug, async (transaction) => {
      await this.#authorizeAttempt(access, "check.attempt.interrupt", requested, transaction);
      const attempts = this.#attempts.using(transaction);
      const facts = this.#facts.using(transaction);
      const plans = this.#plans.using(transaction);
      const lockedAttempt = await attempts.lockPending(attemptHandle);
      const attempt = lockedAttempt ?? (await attempts.find(attemptHandle));
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
        if (plan?.currentIntent === attempt.intent && plan.currentIntentAttemptKey === attempt.attemptKey) {
          await plans.releaseIntentAttempt(plan.slug, attempt.intent, attempt.attemptKey);
          releasedPlan = plan.slug;
        }
      }
      await attempts.interrupt(attemptHandle, this.#now().toISOString());
      return result();
    });
    if (releasedPlan !== undefined)
      this.#events.publish({ type: "plan.state", at: this.#now().toISOString(), plan: releasedPlan });
    return interruption;
  }

  async #finalize(attempt: Attempt, access?: AccessContext): Promise<AttemptFinalizationResult> {
    let revisionEvent: { revision: number; at: string; result: AttemptFinalizationResult } | undefined;
    const finalized = await planTransaction(this.#database, attempt.planSlug, async (transaction) => {
      await this.#authorizeAttempt(access, "check.attempt.finalize", attempt, transaction);
      const attempts = this.#attempts.using(transaction);
      const factsStore = this.#facts.using(transaction);
      const plans = this.#plans.using(transaction);
      const snapshots = this.#snapshots.using(transaction);
      const lockedAttempt = await attempts.lockPending(attempt.handle);
      const currentAttempt = lockedAttempt ?? (await attempts.find(attempt.handle));
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
      if (facts.length === 0)
        throw new PlanRuntimeError("facts-missing", "The Check is unchanged until TRUST accepts Facts");
      const check = await plans.findCheckAtRevision(attempt.planSlug, attempt.planRevision, attempt.checkUri);
      const plan = await plans.findPlan(attempt.planSlug);
      const current = plan ? await plans.readRevision(plan.slug, plan.currentRevision) : undefined;
      const currentCheck = current?.checks.find((candidate) => candidate.uri === attempt.checkUri);
      const activeBefore = plan ? await snapshots.listActive(plan.slug, plan.currentRevision) : [];
      const activeUris = new Set(activeBefore.map((item) => item.checkUri));
      const composition = plan ? await readComposition(transaction, plan.slug) : undefined;
      if (
        plan &&
        currentCheck &&
        currentAttempt.invocationDigest !== (await invocationDependencyDigest(transaction, currentCheck))
      ) {
        if (
          currentAttempt.intent &&
          plan.currentIntent === currentAttempt.intent &&
          plan.currentIntentAttemptKey === currentAttempt.attemptKey
        ) {
          await plans.releaseIntentAttempt(plan.slug, currentAttempt.intent, currentAttempt.attemptKey);
        }
        // Commit the reservation release without discarding accepted historical Facts.
        // The captured dependency digest remains stale, so replay cannot qualify it later.
        return new PlanRuntimeError(
          "plan-conflict",
          "The admitted child invocation generation or qualification changed; read the Plan and select a current Check",
        );
      }
      if (
        !check ||
        !plan ||
        !current ||
        !currentCheck ||
        currentCheck.compiledCheckDigest !== attempt.compiledCheckDigest ||
        !checkDependenciesSatisfied(currentCheck, current.checks, (uri) => activeUris.has(uri), composition?.scenarios)
      ) {
        throw new PlanRuntimeError("plan-conflict", "The admitted Check is no longer current or actionable");
      }
      if (activeUris.has(check.uri) && !currentAttempt.reobserve) {
        throw new PlanRuntimeError(
          "plan-conflict",
          "The admitted Check is already satisfied and this Attempt is not a re-observation",
        );
      }
      let validated: ReturnType<typeof validateFacts>;
      let qualification: ReturnType<typeof qualifyCheck>;
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
          const role = current.resolvedProcedure.roles.find((candidate) => candidate.name === production.role);
          if (!role) throw new PlanRuntimeError("plan-conflict", `Role ${production.role} is unavailable`);
          const raw = validated.values[production.field];
          const values = role.cardinality === "many" && Array.isArray(raw) ? raw : [raw];
          const parents = Object.freeze(
            Object.fromEntries(
              role.parents.map((parent) => {
                const value = check.context[parent.role];
                if (value === undefined || Array.isArray(value)) {
                  throw new PlanRuntimeError(
                    "plan-conflict",
                    `Check ${check.check.name} cannot identify parent ${parent.role}`,
                  );
                }
                return [parent.role, cloneJson(value)];
              }),
            ),
          );
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
        procedure: current.resolvedProcedure,
        plan: plan.slug,
        environment: plan.environment,
        mode: plan.mode,
        metadata: plan.metadata,
        rootInputs: plan.rootInputs,
        declarations: current.agentDeclarations,
        missionDeclarations: current.missionDeclarations,
        resolvedMissions: current.resolvedMissions,
        revision: nextRevisionNumber,
        roleValues: nextRoleValues,
        importedValues: current.importedValues,
        checkValues: nextCheckValues,
      });
      const nextChecks = new Map(next.checks.map((candidate) => [candidate.uri, candidate]));
      const retained = activeBefore
        .filter((item) => {
          const nextCheck = nextChecks.get(item.checkUri);
          return (
            !affected.has(item.checkUri) &&
            nextCheck !== undefined &&
            nextCheck.compiledCheckDigest === item.compiledCheckDigest
          );
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
        state: qualification.verdict === "VALIDATED" ? ("satisfied" as const) : ("open" as const),
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
        if (
          !currentAttempt.intent ||
          plan.currentIntent !== currentAttempt.intent ||
          plan.currentIntentAttemptKey !== currentAttempt.attemptKey
        ) {
          throw new PlanRuntimeError("plan-conflict", "The admitted intent is no longer current for this Plan");
        }
        const missingDeclarations = current.resolvedProcedure.roles.some(
          (role) =>
            role.source.kind === "agent-declaration" &&
            role.source.optional !== true &&
            !Object.hasOwn(current.agentDeclarations, role.name),
        );
        const checklistComplete =
          !missingDeclarations &&
          activeAfter.length === next.checks.length &&
          (await readComposition(transaction, plan.slug)).complete;
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
        if (
          !currentAttempt.intent ||
          plan.currentIntent !== currentAttempt.intent ||
          plan.currentIntentAttemptKey !== currentAttempt.attemptKey
        ) {
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
      await this.#synchronizeChildren(transaction, plan.slug);
      revisionEvent = { revision: nextRevisionNumber, at: calculatedAt, result };
      return result;
    });
    if (finalized instanceof PlanRuntimeError) {
      this.#events.publish({ type: "plan.state", at: this.#now().toISOString(), plan: attempt.planSlug });
      throw finalized;
    }
    if (revisionEvent !== undefined) {
      await this.#publishAncestorChanges(attempt.planSlug);
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
        return {
          refusal: refusal(attemptKey, "attempt-key-conflict", "Attempt key is already bound to another Check"),
        };
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
      if (!check || !plan || !session)
        return { refusal: refusal(attemptKey, "check-not-found", "The Check is unavailable") };
      if (session.state !== "open") {
        return { refusal: refusal(attemptKey, "attempt-expired", "Attempt Session is no longer open") };
      }
      if (
        plan.intentChaining &&
        (plan.currentIntentAttemptKey !== existing.attemptKey || plan.currentIntent !== existing.intent)
      ) {
        return { refusal: refusal(attemptKey, "attempt-expired", "Attempt no longer owns the Plan's current intent") };
      }
      if (existing.reobserve !== reobserve) {
        return {
          refusal: refusal(
            attemptKey,
            "attempt-key-conflict",
            "Attempt key is already bound to another admission intent",
          ),
        };
      }
      const requestedIntent =
        reobserve &&
        intent === undefined &&
        plan.intentChaining &&
        existing.intent === `Re-observe Check "${check.check.name}" for Plan "${plan.slug}"`
          ? existing.intent
          : intent;
      if (existing.intent !== requestedIntent || existing.nextIntent !== nextIntent) {
        return {
          refusal: refusal(attemptKey, "attempt-key-conflict", "Attempt key is already bound to another intent chain"),
        };
      }
      const existingCredentials = this.#admissionCredentials(attemptKey, plan, check);
      if ("refusal" in existingCredentials) return existingCredentials;
      return {
        attemptKey,
        check,
        plan,
        session,
        reobserve: existing.reobserve,
        existing,
        credentials: existingCredentials.credentials,
      };
    }
    const check = await this.#plans.findCurrentCheck(checkUri);
    let plan = check ? await this.#plans.findPlan(check.planSlug) : undefined;
    if (!check || !plan)
      return { refusal: refusal(attemptKey, "check-not-found", "The semantic Check URI is unknown") };
    if (await this.#escalations.findActive(plan.slug)) {
      return {
        refusal: refusal(
          attemptKey,
          "check-not-actionable",
          "The Plan is escalated and must be resumed by an operator",
        ),
      };
    }
    const [activeQualifications, checks] = await Promise.all([
      this.#snapshots.listActive(plan.slug, plan.currentRevision),
      this.#plans.listCurrentChecks(plan.slug),
    ]);
    const active = new Set(activeQualifications.map((item) => item.checkUri));
    if (reobserve && plan.mode !== "dry-run") {
      return {
        refusal: refusal(
          attemptKey,
          "check-not-actionable",
          "Only a dry-run Plan can explicitly re-observe a satisfied Check",
        ),
      };
    }
    if (reobserve && !active.has(check.uri)) {
      return {
        refusal: refusal(attemptKey, "check-not-actionable", "Only a satisfied Check can be explicitly re-observed"),
      };
    }
    if (active.has(check.uri) && !reobserve) {
      return { refusal: refusal(attemptKey, "check-not-actionable", "The Check is already satisfied") };
    }
    const composition = await readComposition(this.#database, plan.slug);
    const ancestryBlock = await ancestorBlocker(this.#database, plan.slug);
    if (ancestryBlock) return { refusal: refusal(attemptKey, "check-not-actionable", ancestryBlock) };
    if (!checkDependenciesSatisfied(check, checks, (uri) => active.has(uri), composition.scenarios)) {
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
    if (nextIntent !== undefined) {
      let findings: readonly ControlledLanguageFinding[];
      try {
        findings = await this.#controlDeclarations(plan.slug, plan.currentRevision, [
          { field: "next-intent", text: nextIntent },
        ]);
      } catch (error) {
        if (!(error instanceof ControlledLanguageUnavailableError)) throw error;
        return {
          refusal: refusal(attemptKey, "controlled-language-unavailable", controlledLanguageUnavailable(error)),
        };
      }
      if (findings.length > 0)
        return {
          refusal: {
            ...refusal(attemptKey, "controlled-language", controlledLanguageRefusal("The nextIntent", findings)),
            findings,
          },
        };
    }
    const admissionCredentials = this.#admissionCredentials(attemptKey, plan, check);
    if ("refusal" in admissionCredentials) return admissionCredentials;
    return {
      attemptKey,
      check,
      plan,
      session,
      reobserve,
      credentials: admissionCredentials.credentials,
      ...(admittedIntent === undefined ? {} : { intent: admittedIntent }),
      ...(nextIntent === undefined ? {} : { nextIntent }),
      ...(restartIntent === undefined ? {} : { restartIntent }),
    };
  }

  /** A dry-run executes nothing external and receives no Credential. A live grant carries exactly the
      Credentials its Operation declares, and is refused while the Plan Environment lacks one. */
  #admissionCredentials(
    attemptKey: string,
    plan: import("../model.js").Plan,
    check: import("../model.js").PlanCheck,
  ): { readonly credentials: Readonly<Record<string, string>> } | AdmissionFailure {
    if (plan.mode === "dry-run") return { credentials: {} };
    const { credentials, missing } = projectOperationCredentials(
      check.operation,
      this.#credentials.resolve(plan.environment),
    );
    if (missing.length === 0) return { credentials };
    return {
      refusal: refusal(
        attemptKey,
        "credential-missing",
        `Environment "${plan.environment}" lacks the Credential${missing.length === 1 ? "" : "s"} ${missing
          .map((name) => `"${name}"`)
          .join(", ")} declared by Operation "${check.operation.operation}@${check.operation.version}"`,
      ),
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
        : {
            reasonCode: "intent-not-enabled",
            reason: "This Plan does not use intent chaining; invoke the opaque Check URI without intent parameters",
          };
    }
    if (plan.intentChainState !== "ACTIVE" || plan.currentIntent === undefined) {
      return {
        reasonCode: "intent-not-started",
        reason: "Intent chaining has not started; read the Plan before running a Check",
      };
    }
    if (intent === undefined) {
      return {
        reasonCode: "intent-required",
        reason: "Intent chaining is required; use the exact current intent returned by plan.read",
      };
    }
    if (intent !== plan.currentIntent) {
      return {
        reasonCode: "intent-mismatch",
        reason: "Intent does not match the Plan's current intent; read the Plan again and use the exact intent value",
      };
    }
    if (nextIntent === intent) {
      return { reasonCode: "next-intent-unchanged", reason: "nextIntent must change the Plan's current intent" };
    }
    const revision = await this.#plans.readRevision(plan.slug, plan.currentRevision);
    const finalCandidate =
      revision !== undefined
        ? completesPlanOnValidation({
            procedure: revision.resolvedProcedure,
            revision,
            checks,
            activeCheckUris: active,
            check,
            invocationsSatisfied:
              (await readComposition(this.#database, plan.slug)).invocations.every(
                (value) => value.state === "SATISFIED",
              ) &&
              revision.resolvedProcedure.invocations.every((value) =>
                revision.invocations.some((invocation) => invocation.definition.name === value.name),
              ) &&
              (revision.resolvedProcedure.declaredInvocations ?? []).every((value) =>
                revision.invocations.some((invocation) => invocation.definition.name === value.name),
              ),
          })
        : false;
    if (finalCandidate && nextIntent !== undefined) {
      return { reasonCode: "next-intent-unexpected", reason: "nextIntent must be omitted when completing the Plan" };
    }
    if (!finalCandidate && nextIntent === undefined) {
      return {
        reasonCode: "next-intent-required",
        reason: "nextIntent is required while the Plan remains in progress",
      };
    }
    return undefined;
  }

  async #createAttempt(resolved: AdmissionResolution, access?: AccessContext): Promise<AttemptCreation> {
    const now = this.#now();
    const attempt: Attempt = {
      actor: this.#access.principal(access),
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
    return planTransaction(this.#database, resolved.plan.slug, async (transaction) => {
      const attempts = this.#attempts.using(transaction);
      const plans = this.#plans.using(transaction);
      const transactionalPlan = await plans.findPlan(resolved.plan.slug);
      if (transactionalPlan) this.#access.authorize(access, "check.attempt.admit", transactionalPlan.creator);
      if (
        !transactionalPlan ||
        transactionalPlan.currentRevision !== resolved.plan.currentRevision ||
        !(await plans.lockCurrentRevision(resolved.plan.slug, resolved.plan.currentRevision))
      ) {
        throw new AdmissionPlanChangedError();
      }
      const session = await this.#sessions.using(transaction).findById(resolved.session.id);
      if (!session || session.state !== "open" || Date.parse(session.expiresAt) <= this.#now().getTime())
        throw new AdmissionPlanChangedError();
      if (await this.#escalations.using(transaction).findActive(resolved.plan.slug)) {
        throw new PlanEscalatedDuringAdmissionError();
      }
      if (await ancestorBlocker(transaction, resolved.plan.slug)) throw new AdmissionPlanChangedError();
      const currentRevision = (await plans.readRevision(resolved.plan.slug, transactionalPlan.currentRevision))!;
      const composition = await readComposition(transaction, resolved.plan.slug);
      const currentActive = await this.#snapshots
        .using(transaction)
        .listActive(resolved.plan.slug, transactionalPlan.currentRevision);
      if (
        !checkDependenciesSatisfied(
          resolved.check,
          currentRevision.checks,
          (uri) => currentActive.some((value) => value.checkUri === uri),
          composition.scenarios,
        )
      )
        throw new AdmissionPlanChangedError();
      const invocationDigest = await invocationDependencyDigest(transaction, resolved.check);
      if (invocationDigest !== undefined) attempt.invocationDigest = invocationDigest;
      if (resolved.existing) {
        const locked = await attempts.lockPending(resolved.existing.handle);
        if (!locked || locked.invocationDigest !== invocationDigest) throw new AdmissionPlanChangedError();
        return { attempt: locked, created: false };
      }
      const concurrent = await attempts.findByKey(attempt.attemptKey);
      if (concurrent) {
        await this.#authorizeAttempt(access, "check.attempt.admit", concurrent, transaction);
        return { attempt: concurrent, created: false };
      }
      if (resolved.plan.intentChaining && resolved.intent !== undefined) {
        const reserved =
          resolved.restartIntent === undefined
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
    const changes = await planTransaction(this.#database, plan, (transaction) =>
      this.#ensureSessionIn(transaction, plan, now),
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
      throw new PlanRuntimeError("fact-batch-rejected", `${caller} Facts are accepted only for a ${mode} Plan`);
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
  /** Held in memory for the grant only; never copied into the persisted Attempt. */
  readonly credentials: Readonly<Record<string, string>>;
}

interface AdmissionFailure {
  readonly refusal: Omit<Refusal, "contract">;
}

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
    metadata: planRevision.metadata,
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
  if (
    payload.kind !== attempt.operation ||
    typeof payload.observedAt !== "string" ||
    Number.isNaN(Date.parse(payload.observedAt)) ||
    !isRecord(payload.values)
  ) {
    throw new PlanRuntimeError(
      "fact-batch-rejected",
      `Fact ${index} must contain the admitted Operation, observedAt and values`,
    );
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

/** Refusal text that names each finding with its field and rule, for surfaces that show only the text. */
function controlledLanguageRefusal(subject: string, findings: readonly ControlledLanguageFinding[]): string {
  return [
    `${subject} breaks the controlled language of the Plan's Procedure. Rewrite and call again.`,
    ...findings.map(({ field, rule, message }) => `[${field} ${rule}] ${message}`),
  ].join("\n");
}

/** Refusal text when the controlled language of a Plan cannot run. */
function controlledLanguageUnavailable(error: ControlledLanguageUnavailableError): string {
  return `The controlled language of the Plan's Procedure cannot be applied. Nothing changed. ${error.message}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
