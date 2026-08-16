import { createHash, randomUUID } from "node:crypto";

import { checkDependenciesSatisfied } from "../check/actionability.js";
import { qualifyCheck, validateFacts } from "../check/qualification.js";
import type {
  ActiveCheckQualification,
  Attempt,
  CheckSnapshot,
  Fact,
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

export const DEFAULT_SESSION_DURATION_MS = 24 * 60 * 60 * 1_000;

export type PlanRuntimeErrorCode =
  | "invalid-plan-engagement"
  | "invalid-plan-declarations"
  | "procedure-not-found"
  | "plan-conflict"
  | "check-not-found"
  | "fact-batch-rejected"
  | "attempt-not-found"
  | "facts-missing";

export class PlanRuntimeError extends Error {
  constructor(readonly code: PlanRuntimeErrorCode, message: string, options?: ErrorOptions) {
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
      readonly attemptHandle: string;
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
}

export interface FactBatchInput {
  readonly attemptKey: string;
  readonly attemptHandle: string;
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
  readonly verdict: "VALIDATED" | "NOT_VALIDATED";
  readonly reasonCode: string;
  readonly reason: string;
  readonly checklistDelta: CheckSnapshot["checklistDelta"];
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
    this.#sessionDurationMs = dependencies.sessionDurationMs;
  }

  async engage(input: PlanEngagementInput): Promise<PlanEngagementResult> {
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
    let revision: PlanRevision;
    try {
      revision = buildPlanRevision({
        authority: this.#authority,
        procedure: published.procedure,
        plan: input.plan,
        environment: input.environment,
        rootInputs: input.rootInputs,
        revision: 1,
      });
    } catch (error) {
      throw new PlanRuntimeError("invalid-plan-engagement", message(error), { cause: error });
    }
    const existing = await this.#plans.findPlan(input.plan);
    if (existing) {
      const current = await this.#plans.readRevision(input.plan, existing.currentRevision);
      if (!current || current.definitionDigest !== revision.definitionDigest
        || canonicalJson(existing.rootInputs) !== canonicalJson(revision.rootInputs)
        || existing.environment !== revision.environment) {
        throw new PlanRuntimeError("plan-conflict", `Plan ${input.plan} is already engaged with another Procedure or context`);
      }
      await this.#ensureSession(input.plan);
      return engagement(existing.currentRevision, current, input);
    }
    const now = this.#now();
    await this.#database.transaction().execute(async (transaction) => {
      await this.#plans.using(transaction).saveRevision(revision, now.toISOString());
      await this.#sessions.using(transaction).create({
        id: randomUUID(),
        planSlug: input.plan,
        state: "open",
        openedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.#sessionDurationMs).toISOString(),
      });
    });
    return engagement(1, revision, input);
  }

  async replaceDeclarations(input: PlanDeclarationReplacementInput): Promise<PlanDeclarationReplacementResult> {
    const plan = await this.#plans.findPlan(input.plan);
    const current = plan ? await this.#plans.readRevision(plan.slug, plan.currentRevision) : undefined;
    const published = plan ? await this.#procedures.find(plan.procedure, plan.procedureVersion) : undefined;
    if (!plan || !current || !published || plan.currentRevision !== input.expectedRevision) {
      throw new PlanRuntimeError("plan-conflict", `Plan ${input.plan} is unavailable or changed`);
    }
    let declarations: RuntimeJsonObject;
    try {
      declarations = validateAgentDeclarations(
        published.procedure.roles,
        plan.rootInputs,
        input.declarations,
      );
    } catch (error) {
      throw new PlanRuntimeError("invalid-plan-declarations", message(error), { cause: error });
    }
    if (canonicalJson(declarations) === canonicalJson(current.agentDeclarations)) {
      return declarationResult(current, current);
    }
    const next = buildPlanRevision({
      authority: this.#authority,
      procedure: published.procedure,
      plan: plan.slug,
      environment: plan.environment,
      rootInputs: plan.rootInputs,
      declarations,
      revision: plan.currentRevision + 1,
      roleValues: current.roleValues,
      checkValues: current.checkValues,
    });
    await this.#database.transaction().execute(async (transaction) => {
      await this.#plans.using(transaction).saveRevision(next, this.#now().toISOString());
    });
    await this.#ensureSession(plan.slug);
    return declarationResult(current, next);
  }

  async admitCheck(input: CheckAttemptAdmissionInput): Promise<CheckAttemptAdmissionResult> {
    if (input.contract !== "trust.check-admission-request@1") {
      return refuse("trust.check-admission@1", input.attemptKey, "invalid-admission-contract", "Unsupported admission contract");
    }
    let resolved = await this.#resolveAdmission(input.attemptKey, input.checkUri);
    if ("refusal" in resolved) return { contract: "trust.check-admission@1", ...resolved.refusal };
    const creation = await this.#createAttempt(resolved);
    if (!creation.created && resolved.existing === undefined) {
      resolved = await this.#resolveAdmission(input.attemptKey, input.checkUri);
      if ("refusal" in resolved) return { contract: "trust.check-admission@1", ...resolved.refusal };
    }
    const attempt = creation.attempt;
    return {
      contract: "trust.check-admission@1",
      status: "ADMITTED",
      attemptKey: attempt.attemptKey,
      attemptHandle: attempt.handle,
      checkUri: attempt.checkUri,
      operation: resolved.check.operation,
      actionInput: attempt.actionInput,
      environment: this.#environments.resolve(attempt.environment) ?? {},
      expiresAt: attempt.expiresAt,
    };
  }

  async ingestFacts(input: FactBatchInput): Promise<FactBatchResult> {
    return this.#database.transaction().execute(async (transaction) => {
      const attempts = this.#attempts.using(transaction);
      const attempt = await attempts.lockPending(input.attemptHandle);
      if (!attempt) {
        const existing = await attempts.find(input.attemptHandle);
        if (!existing) {
          throw new PlanRuntimeError("attempt-not-found", `Runner Attempt ${input.attemptHandle} is unknown`);
        }
        throw new PlanRuntimeError("fact-batch-rejected", "Fact batch belongs to a finalized Attempt");
      }
      return this.#ingest(attempt, input, transaction);
    });
  }

  async #ingest(attempt: Attempt, input: FactBatchInput, database: Database): Promise<FactBatchResult> {
    if (attempt.attemptKey !== input.attemptKey || attempt.checkUri !== input.checkUri) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch does not match its admitted Attempt");
    }
    if (Date.parse(attempt.expiresAt) <= this.#now().getTime()) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch belongs to an expired Attempt");
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

  async #finalize(attempt: Attempt): Promise<AttemptFinalizationResult> {
    const initialPlan = await this.#plans.findPlan(attempt.planSlug);
    const published = initialPlan
      ? await this.#procedures.find(initialPlan.procedure, initialPlan.procedureVersion)
      : undefined;
    return this.#database.transaction().execute(async (transaction) => {
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
          ...currentAttempt.finalization,
        };
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
      let validated;
      let qualification;
      try {
        validated = validateFacts(check, facts);
        qualification = qualifyCheck(check, validated, current.checkValues);
      } catch (error) {
        throw new PlanRuntimeError("facts-missing", message(error), { cause: error });
      }
      const affected = dependentChecks(current.checks, check.uri);
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
      const result = finalization(snapshot);
      await attempts.finalize(attempt.handle, calculatedAt, {
        verdict: result.verdict,
        reasonCode: result.reasonCode,
        reason: result.reason,
        checklistDelta: result.checklistDelta,
      });
      return result;
    });
  }

  async #resolveAdmission(attemptKey: string, checkUri: string): Promise<AdmissionResolution | AdmissionFailure> {
    const existing = await this.#attempts.findByKey(attemptKey);
    if (existing) {
      if (existing.checkUri !== checkUri) {
        return { refusal: refusal(attemptKey, "attempt-key-conflict", "Attempt key is already bound to another Check") };
      }
      if (existing.state !== "pending") {
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
      return { attemptKey, check, plan, session, existing };
    }
    const check = await this.#plans.findCurrentCheck(checkUri);
    const plan = check ? await this.#plans.findPlan(check.planSlug) : undefined;
    if (!check || !plan) return { refusal: refusal(attemptKey, "check-not-found", "The semantic Check URI is unknown") };
    const [activeQualifications, checks] = await Promise.all([
      this.#snapshots.listActive(plan.slug, plan.currentRevision),
      this.#plans.listCurrentChecks(plan.slug),
    ]);
    const active = new Set(activeQualifications.map((item) => item.checkUri));
    if (!checkDependenciesSatisfied(check, checks, (uri) => active.has(uri))) {
      return { refusal: refusal(attemptKey, "check-not-actionable", "The Check dependencies are not satisfied") };
    }
    const session = await this.#sessions.findAvailable(plan.slug, this.#now());
    if (!session) {
      return { refusal: refusal(attemptKey, "session-unavailable", "The Plan has no active Session") };
    }
    return { attemptKey, check, plan, session };
  }

  async #createAttempt(
    resolved: AdmissionResolution,
  ): Promise<AttemptCreation> {
    if (resolved.existing) return { attempt: resolved.existing, created: false };
    const now = this.#now();
    const attempt: Attempt = {
      handle: randomUUID(),
      attemptKey: resolved.attemptKey,
      planSlug: resolved.plan.slug,
      planRevision: resolved.plan.currentRevision,
      checkUri: resolved.check.uri,
      compiledCheckDigest: resolved.check.compiledCheckDigest,
      sessionId: resolved.session.id,
      operation: resolved.check.check.operation,
      operationDigest: resolved.check.check.operationDigest,
      actionInput: resolved.check.actionInput,
      environment: resolved.plan.environment,
      state: "pending",
      admittedAt: now.toISOString(),
      expiresAt: resolved.session.expiresAt,
    };
    return this.#attempts.createOrFind(attempt);
  }

  async #ensureSession(plan: string): Promise<void> {
    const current = await this.#sessions.findOpen(plan);
    const now = this.#now();
    if (current && Date.parse(current.expiresAt) > now.getTime()) return;
    if (current) await this.#sessions.changeState(current.id, "expired", now.toISOString());
    await this.#sessions.create({
      id: randomUUID(),
      planSlug: plan,
      state: "open",
      openedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#sessionDurationMs).toISOString(),
    });
  }

  #now(): Date {
    const now = this.#clock.now();
    if (Number.isNaN(now.getTime())) throw new Error("Clock returned an invalid instant");
    return now;
  }
}

interface AdmissionResolution {
  readonly attemptKey: string;
  readonly check: import("../model.js").PlanCheck;
  readonly plan: import("../model.js").Plan;
  readonly session: import("../model.js").Session;
  readonly existing?: Attempt;
}

interface AdmissionFailure { readonly refusal: Omit<Refusal, "contract"> }

function finalization(snapshot: CheckSnapshot): AttemptFinalizationResult {
  return {
    contract: "trust.attempt-finalization@1",
    attemptHandle: snapshot.attemptHandle,
    verdict: snapshot.verdict,
    reasonCode: snapshot.reasonCode,
    reason: snapshot.reason,
    checklistDelta: snapshot.checklistDelta,
  };
}

function engagement(revision: number, planRevision: PlanRevision, input: PlanEngagementInput): PlanEngagementResult {
  return {
    contract: "trust.plan-engagement@1",
    status: "ENGAGED",
    procedure: input.procedure,
    procedureVersion: input.procedureVersion,
    plan: input.plan,
    environment: input.environment,
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

function dependentChecks(checks: readonly import("../model.js").PlanCheck[], providerUri: string): Set<string> {
  const affected = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const check of checks) {
      if (affected.has(check.uri) || check.uri === providerUri) continue;
      const depends = check.checkDependencies.some((item) => item.providerCheckUri === providerUri || affected.has(item.providerCheckUri))
        || check.scenarioDependencies.some((scenario) => checks.some((candidate) => candidate.scenario === scenario && (candidate.uri === providerUri || affected.has(candidate.uri))));
      if (depends) { affected.add(check.uri); changed = true; }
    }
  }
  return affected;
}

function refuse(contract: Refusal["contract"], attemptKey: string, reasonCode: string, reason: string): Refusal {
  return { contract, status: "REFUSED", attemptKey, reasonCode, reason };
}

function refusal(attemptKey: string, reasonCode: string, reason: string): Omit<Refusal, "contract"> {
  return { status: "REFUSED", attemptKey, reasonCode, reason };
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
