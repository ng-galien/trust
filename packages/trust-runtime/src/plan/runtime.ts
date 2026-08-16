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
import type { SkillEnvelope } from "../skill/model.js";
import type { Clock } from "../time.js";
import type { DatabaseDriver } from "../sqlite/database.js";
import type { AttemptStore } from "../sqlite/attempts.js";
import type { SnapshotStore } from "../sqlite/snapshots.js";
import type { FactStore } from "../sqlite/facts.js";
import type { PlanStore } from "../sqlite/plans.js";
import type { SessionStore } from "../sqlite/sessions.js";
import type { Procedures } from "../procedure/procedures.js";
import type { SkillAdmission } from "../skill/admission.js";
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

export type SkillAttemptAdmissionResult =
  | {
      readonly contract: "trust.skill-admission@1";
      readonly status: "ADMITTED";
      readonly attemptKey: string;
      readonly attemptHandle: string;
      readonly checkUri: string;
      readonly operation: string;
      readonly operationDigest: string;
      readonly actionInput: RuntimeJsonObject;
      readonly expiresAt: string;
    }
  | Refusal;

interface Refusal {
  readonly contract: "trust.check-admission@1" | "trust.skill-admission@1";
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

export interface SkillFactBatchInput extends FactBatchInput {
  readonly releaseDigest: string;
  readonly environment: string;
  readonly deploymentKey: string;
  readonly envelope: SkillEnvelope;
  readonly runtimeIdentity: string;
  readonly processIdentity: string;
}

export interface SkillFactBatchResult {
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
  readonly databaseDriver: DatabaseDriver;
  readonly semanticAuthority: string;
  readonly environmentService: EnvironmentService;
  readonly procedures: Procedures;
  readonly planStore: PlanStore;
  readonly sessionStore: SessionStore;
  readonly attemptStore: AttemptStore;
  readonly factStore: FactStore;
  readonly snapshotStore: SnapshotStore;
  readonly skillAdmission: SkillAdmission;
  readonly sessionDurationMs: number;
}

export class PlanRuntime {
  readonly #clock: Clock;
  readonly #database: DatabaseDriver;
  readonly #authority: string;
  readonly #environments: EnvironmentService;
  readonly #procedures: Procedures;
  readonly #plans: PlanStore;
  readonly #sessions: SessionStore;
  readonly #attempts: AttemptStore;
  readonly #facts: FactStore;
  readonly #snapshots: SnapshotStore;
  readonly #skillAdmission: SkillAdmission;
  readonly #sessionDurationMs: number;

  constructor(dependencies: PlanRuntimeDependencies) {
    if (!Number.isSafeInteger(dependencies.sessionDurationMs) || dependencies.sessionDurationMs <= 0) {
      throw new TypeError("sessionDurationMs must be a positive integer");
    }
    this.#clock = dependencies.clock;
    this.#database = dependencies.databaseDriver;
    this.#authority = dependencies.semanticAuthority;
    this.#environments = dependencies.environmentService;
    this.#procedures = dependencies.procedures;
    this.#plans = dependencies.planStore;
    this.#sessions = dependencies.sessionStore;
    this.#attempts = dependencies.attemptStore;
    this.#facts = dependencies.factStore;
    this.#snapshots = dependencies.snapshotStore;
    this.#skillAdmission = dependencies.skillAdmission;
    this.#sessionDurationMs = dependencies.sessionDurationMs;
  }

  engage(input: PlanEngagementInput): PlanEngagementResult {
    if (input.contract !== "trust.plan-engagement-request@1") {
      throw new PlanRuntimeError("invalid-plan-engagement", "Unsupported Plan engagement contract");
    }
    const published = this.#procedures.find(input.procedure, input.procedureVersion);
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
    const existing = this.#plans.findPlan(input.plan);
    if (existing) {
      const current = this.#plans.readRevision(input.plan, existing.currentRevision);
      if (!current || current.definitionDigest !== revision.definitionDigest
        || canonicalJson(existing.rootInputs) !== canonicalJson(revision.rootInputs)
        || existing.environment !== revision.environment) {
        throw new PlanRuntimeError("plan-conflict", `Plan ${input.plan} is already engaged with another Procedure or context`);
      }
      this.#ensureSession(input.plan);
      return engagement(existing.currentRevision, current, input);
    }
    const now = this.#now();
    this.#database.transaction(() => {
      this.#plans.saveRevision(revision, now.toISOString());
      this.#sessions.create({
        id: randomUUID(),
        planSlug: input.plan,
        state: "open",
        openedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.#sessionDurationMs).toISOString(),
      });
    });
    return engagement(1, revision, input);
  }

  replaceDeclarations(input: PlanDeclarationReplacementInput) {
    const plan = this.#plans.findPlan(input.plan);
    const current = plan && this.#plans.readRevision(plan.slug, plan.currentRevision);
    const published = plan && this.#procedures.find(plan.procedure, plan.procedureVersion);
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
    this.#plans.saveRevision(next, this.#now().toISOString());
    this.#ensureSession(plan.slug);
    return declarationResult(current, next);
  }

  admitCheck(input: CheckAttemptAdmissionInput): CheckAttemptAdmissionResult {
    if (input.contract !== "trust.check-admission-request@1") {
      return refuse("trust.check-admission@1", input.attemptKey, "invalid-admission-contract", "Unsupported admission contract");
    }
    const resolved = this.#resolveAdmission(input.attemptKey, input.checkUri);
    if ("refusal" in resolved) return { contract: "trust.check-admission@1", ...resolved.refusal };
    if (resolved.existing && resolved.existing.owner.kind !== "runner") {
      return refuse("trust.check-admission@1", input.attemptKey, "attempt-owner-mismatch", "Attempt key belongs to a Skill");
    }
    const attempt = this.#createAttempt(resolved, { kind: "runner" });
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

  admitSkill(input: SkillAttemptAdmissionInput): SkillAttemptAdmissionResult {
    if (input.contract !== "trust.skill-admission-request@1") {
      return refuse("trust.skill-admission@1", input.attemptKey, "invalid-admission-contract", "Unsupported admission contract");
    }
    const resolved = this.#resolveAdmission(input.attemptKey, input.checkUri);
    if ("refusal" in resolved) return { contract: "trust.skill-admission@1", ...resolved.refusal };
    if (resolved.plan.environment !== input.environment) {
      return refuse("trust.skill-admission@1", input.attemptKey, "environment-mismatch", "The Skill environment does not own this Check");
    }
    if (resolved.existing && (resolved.existing.owner.kind !== "skill"
      || resolved.existing.owner.releaseDigest !== input.releaseDigest
      || resolved.existing.owner.deploymentKey !== input.deploymentKey
      || resolved.existing.owner.envelope !== input.envelope
      || resolved.existing.owner.runtimeIdentity !== input.runtimeIdentity
      || resolved.existing.owner.processIdentity !== input.processIdentity)) {
      return refuse("trust.skill-admission@1", input.attemptKey, "attempt-owner-mismatch", "Attempt key belongs to another caller");
    }
    const decision = this.#skillAdmission.admit({
      environment: input.environment,
      requirement: {
        capability: resolved.check.check.operation,
        actionContractDigest: resolved.check.check.operationDigest,
      },
      releaseDigest: input.releaseDigest,
      deploymentKey: input.deploymentKey,
      envelope: input.envelope,
      runtimeIdentity: input.runtimeIdentity,
      processIdentity: input.processIdentity,
    });
    if (decision.status === "REFUSED") {
      return refuse("trust.skill-admission@1", input.attemptKey, decision.reasonCode, decision.reason);
    }
    const attempt = this.#createAttempt(resolved, {
      kind: "skill",
      releaseDigest: input.releaseDigest,
      deploymentKey: input.deploymentKey,
      envelope: input.envelope,
      runtimeIdentity: input.runtimeIdentity,
      processIdentity: input.processIdentity,
    }, decision.leaseExpiresAt);
    return {
      contract: "trust.skill-admission@1",
      status: "ADMITTED",
      attemptKey: attempt.attemptKey,
      attemptHandle: attempt.handle,
      checkUri: attempt.checkUri,
      operation: attempt.operation,
      operationDigest: attempt.operationDigest,
      actionInput: attempt.actionInput,
      expiresAt: attempt.expiresAt,
    };
  }

  ingestFacts(input: FactBatchInput): SkillFactBatchResult {
    const attempt = this.#attempts.find(input.attemptHandle);
    if (!attempt) {
      throw new PlanRuntimeError("attempt-not-found", `Runner Attempt ${input.attemptHandle} is unknown`);
    }
    if (attempt.owner.kind !== "runner") {
      throw new PlanRuntimeError("fact-batch-rejected", "Runner Fact batch does not match a Runner Attempt");
    }
    return this.#ingest(attempt, input);
  }

  #ingest(attempt: Attempt, input: FactBatchInput): SkillFactBatchResult {
    if (attempt.attemptKey !== input.attemptKey || attempt.checkUri !== input.checkUri) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch does not match its admitted Attempt");
    }
    if (attempt.state !== "pending") {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch belongs to a finalized Attempt");
    }
    if (Date.parse(attempt.expiresAt) <= this.#now().getTime()) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch belongs to an expired Attempt");
    }
    if (input.facts.length === 0 || Number.isNaN(Date.parse(input.recordedAt))) {
      throw new PlanRuntimeError("fact-batch-rejected", "Fact batch must contain Facts and a valid recordedAt instant");
    }
    const check = this.#plans.findCheckAtRevision(attempt.planSlug, attempt.planRevision, attempt.checkUri);
    if (!check || check.compiledCheckDigest !== attempt.compiledCheckDigest) {
      throw new PlanRuntimeError("fact-batch-rejected", "The admitted Check is unavailable");
    }
    const facts = input.facts.map((payload, index) => fact(attempt, payload, index, input.recordedAt));
    try {
      validateFacts(check, facts);
      const result = this.#facts.append(facts);
      return { acceptedFactIds: result.acceptedIds, duplicateFactIds: result.duplicateIds };
    } catch (error) {
      throw new PlanRuntimeError("fact-batch-rejected", message(error), { cause: error });
    }
  }

  ingestSkillFacts(input: SkillFactBatchInput): SkillFactBatchResult {
    const attempt = this.#attempts.find(input.attemptHandle);
    if (!attempt || attempt.owner.kind !== "skill"
      || attempt.owner.releaseDigest !== input.releaseDigest
      || attempt.environment !== input.environment
      || attempt.owner.deploymentKey !== input.deploymentKey
      || attempt.owner.envelope !== input.envelope
      || attempt.owner.runtimeIdentity !== input.runtimeIdentity
      || attempt.owner.processIdentity !== input.processIdentity) {
      throw new PlanRuntimeError("fact-batch-rejected", "Skill Fact batch does not match its admitted Attempt");
    }
    return this.#ingest(attempt, input);
  }

  finalizeCheck(attemptHandle: string): AttemptFinalizationResult {
    const attempt = this.#attempts.find(attemptHandle);
    if (!attempt || attempt.owner.kind !== "runner") {
      throw new PlanRuntimeError("attempt-not-found", `Runner Attempt ${attemptHandle} is unknown`);
    }
    return this.#finalize(attempt);
  }

  finalizeSkill(attemptHandle: string, caller: { runtimeIdentity: string; processIdentity: string }): AttemptFinalizationResult {
    const attempt = this.#attempts.find(attemptHandle);
    if (!attempt || !this.#skillAdmission.ownsAttempt(attempt, caller)) {
      throw new PlanRuntimeError("attempt-not-found", `Skill Attempt ${attemptHandle} is unknown`);
    }
    return this.#finalize(attempt);
  }

  #finalize(attempt: Attempt): AttemptFinalizationResult {
    return this.#database.transaction(() => {
      const currentAttempt = this.#attempts.find(attempt.handle);
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
      const facts = this.#facts.list(attempt.handle);
      if (facts.length === 0) throw new PlanRuntimeError("facts-missing", "The Check is unchanged until TRUST accepts Facts");
      const check = this.#plans.findCheckAtRevision(attempt.planSlug, attempt.planRevision, attempt.checkUri);
      const plan = this.#plans.findPlan(attempt.planSlug);
      const current = plan && this.#plans.readRevision(plan.slug, plan.currentRevision);
      const published = plan && this.#procedures.find(plan.procedure, plan.procedureVersion);
      const currentCheck = current?.checks.find((candidate) => candidate.uri === attempt.checkUri);
      const activeBefore = plan ? this.#snapshots.listActive(plan.slug, plan.currentRevision) : [];
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
      const equivalent = this.#snapshots.findEquivalent(check.uri, check.compiledCheckDigest, factIds);
      if (!equivalent) this.#snapshots.append(snapshot);
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
      this.#plans.saveRevision(next, calculatedAt);
      this.#snapshots.saveActiveForRevision(plan.slug, nextRevisionNumber, activeAfter);
      const result = finalization(snapshot);
      this.#attempts.finalize(attempt.handle, calculatedAt, {
        verdict: result.verdict,
        reasonCode: result.reasonCode,
        reason: result.reason,
        checklistDelta: result.checklistDelta,
      });
      return result;
    });
  }

  #resolveAdmission(attemptKey: string, checkUri: string): AdmissionResolution | AdmissionFailure {
    const existing = this.#attempts.findByKey(attemptKey);
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
      const check = this.#plans.findCheckAtRevision(existing.planSlug, existing.planRevision, existing.checkUri);
      const plan = this.#plans.findPlan(existing.planSlug);
      const session = this.#sessions.findById(existing.sessionId);
      if (!check || !plan || !session) return { refusal: refusal(attemptKey, "check-not-found", "The Check is unavailable") };
      return { attemptKey, check, plan, session, existing };
    }
    const check = this.#plans.findCurrentCheck(checkUri);
    const plan = check && this.#plans.findPlan(check.planSlug);
    if (!check || !plan) return { refusal: refusal(attemptKey, "check-not-found", "The semantic Check URI is unknown") };
    const active = new Set(this.#snapshots.listActive(plan.slug, plan.currentRevision).map((item) => item.checkUri));
    if (!checkDependenciesSatisfied(check, this.#plans.listCurrentChecks(plan.slug), (uri) => active.has(uri))) {
      return { refusal: refusal(attemptKey, "check-not-actionable", "The Check dependencies are not satisfied") };
    }
    const session = this.#sessions.findAvailable(plan.slug, this.#now());
    if (!session) {
      return { refusal: refusal(attemptKey, "session-unavailable", "The Plan has no active Session") };
    }
    return { attemptKey, check, plan, session };
  }

  #createAttempt(
    resolved: AdmissionResolution,
    owner: Attempt["owner"],
    leaseExpiresAt?: string,
  ): Attempt {
    if (resolved.existing) return resolved.existing;
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
      owner,
      state: "pending",
      admittedAt: now.toISOString(),
      expiresAt: leaseExpiresAt === undefined
        ? resolved.session.expiresAt
        : new Date(Math.min(Date.parse(resolved.session.expiresAt), Date.parse(leaseExpiresAt))).toISOString(),
    };
    this.#attempts.create(attempt);
    return attempt;
  }

  #ensureSession(plan: string): void {
    const current = this.#sessions.findOpen(plan);
    const now = this.#now();
    if (current && Date.parse(current.expiresAt) > now.getTime()) return;
    if (current) this.#sessions.changeState(current.id, "expired", now.toISOString());
    this.#sessions.create({
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
