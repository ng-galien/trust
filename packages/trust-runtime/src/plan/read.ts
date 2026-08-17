import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { checkIsActionable } from "../check/actionability.js";
import type { Attempt, CheckSnapshot, Fact, Plan, PlanCheck, PlanMode, PlanRevision } from "../model.js";
import type { AttemptStore } from "../attempt/store.js";
import type { FactStore } from "../fact/store.js";
import type { SnapshotStore } from "../snapshot/store.js";
import type { PlanStore } from "./store.js";
import type { SessionStore } from "../session/store.js";
import type { Procedures } from "../procedure/procedures.js";
import type { Clock } from "../time.js";

const DEFAULT_PROCEDURE_PAGE_SIZE = 49_152;
const MAX_PROCEDURE_PAGE_SIZE = 65_536;
const CURSOR_VERSION = 1;
const DEFAULT_LIST_PAGE_SIZE = 50;
const MAX_LIST_PAGE_SIZE = 200;

export type ReadErrorCode =
  | "check-not-found"
  | "plan-not-found"
  | "revision-not-found"
  | "invalid-procedure-page"
  | "invalid-list-page";

export interface PlanListInput {
  readonly filter?: { readonly procedure?: string; readonly mode?: PlanMode };
  readonly cursor?: string;
  readonly limit?: number;
}

export interface HistoryListInput {
  readonly filter?: {
    readonly plan?: string;
    readonly procedure?: string;
    readonly mode?: PlanMode;
    readonly verdict?: CheckSnapshot["verdict"];
    readonly since?: string;
    readonly until?: string;
  };
  readonly cursor?: string;
  readonly limit?: number;
}

export class ReadError extends Error {
  constructor(
    readonly code: ReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReadError";
  }
}

export interface ProcedureReadInput {
  readonly checkUri: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ProcedureReadView {
  readonly source: string;
  readonly nextCursor?: string;
}

export interface PlanView {
  readonly plan: string;
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly environment: string;
  readonly mode: PlanMode;
  readonly rootInputs: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly state: "ENGAGED";
  readonly sessionState: "OPEN" | "UNAVAILABLE";
  readonly workState: "IN_PROGRESS" | "COMPLETE";
  readonly revision: number;
  readonly declarations: Readonly<Record<string, unknown>>;
  readonly declarationRoles: readonly {
    readonly role: string;
    readonly type: string;
    readonly cardinality: string;
    readonly parents: readonly { readonly role: string; readonly each: boolean }[];
  }[];
  readonly missingDeclarations: readonly string[];
  readonly checklistComplete: boolean;
  readonly satisfiedChecks: number;
  readonly openChecks: readonly string[];
  readonly actionableChecks: readonly string[];
  readonly blockedChecks: readonly string[];
  readonly checks: readonly PlanCheckView[];
  readonly latestRevisionChange: {
    readonly fromRevision: number | null;
    readonly toRevision: number;
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly newlySatisfied: readonly string[];
    readonly newlyOpened: readonly string[];
    readonly changed: readonly string[];
    readonly unchanged: readonly string[];
  };
  readonly latestQualification: {
    readonly checkUri: string;
    readonly verdict: "VALIDATED" | "NOT_VALIDATED";
    readonly reasonCode: string;
    readonly reason: string;
    readonly newlySatisfied: readonly string[];
    readonly newlyOpened: readonly string[];
    readonly unchanged: readonly string[];
  } | null;
  readonly revisions: readonly PlanRevisionView[];
  readonly sessions: readonly SessionRecordView[];
}

export interface PlanSummaryView {
  readonly plan: string;
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly environment: string;
  readonly mode: PlanMode;
  readonly revision: number;
  readonly createdAt: string;
  readonly sessionState: "OPEN" | "UNAVAILABLE";
  readonly workState: "IN_PROGRESS" | "COMPLETE";
  readonly satisfiedChecks: number;
  readonly checkCount: number;
}

export interface HistoryView {
  readonly snapshotId: string;
  readonly calculatedAt: string;
  readonly plan: string;
  readonly mode: PlanMode;
  readonly procedure: string;
  readonly checkUri: string;
  readonly checkName: string;
  readonly target: CheckTargetView;
  readonly operation: string;
  readonly attemptHandle: string;
  readonly verdict: CheckSnapshot["verdict"];
  readonly reasonCode: string;
  readonly reason: string;
  readonly factCount: number;
  readonly checklistDelta: CheckSnapshot["checklistDelta"];
}

export interface PlanRevisionView {
  readonly revision: number;
  readonly definitionDigest: string;
  readonly source: string;
  readonly declarations: Readonly<Record<string, unknown>>;
  readonly roleValues: readonly unknown[];
  readonly checkValues: readonly unknown[];
  readonly checkUris: readonly string[];
}

export interface SessionRecordView {
  readonly id: string;
  readonly state: "open" | "closed" | "expired";
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly closedAt?: string;
}

export interface PlanCheckView {
  readonly checkUri: string;
  readonly name: string;
  readonly scenario: string;
  readonly target: CheckTargetView;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly operation: string;
  readonly state: "OPEN" | "SATISFIED";
  readonly actionable: boolean;
  readonly blockedBy: readonly string[];
  readonly latestVerdict: "VALIDATED" | "NOT_VALIDATED" | null;
  readonly latestReasonCode: string | null;
  readonly reason: string | null;
}

export interface SessionView {
  readonly plan: string;
  readonly state: "OPEN" | "UNAVAILABLE";
  readonly activeRevision: number;
  readonly workState: "IN_PROGRESS" | "COMPLETE";
  readonly checklistComplete: boolean;
  readonly satisfiedChecks: number;
  readonly openChecks: number;
  readonly sessions: readonly SessionRecordView[];
}

export interface CheckAttemptView {
  readonly handle: string;
  readonly attemptKey: string;
  readonly sessionId: string;
  readonly state: Attempt["state"];
  readonly admittedAt: string;
  readonly expiresAt: string;
  readonly finalizedAt?: string;
  readonly finalization?: NonNullable<Attempt["finalization"]>;
  readonly facts: readonly Fact[];
}

export interface CheckView {
  readonly checkUri: string;
  readonly name: string;
  readonly scenario: string;
  readonly target: CheckTargetView;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly state: "OPEN" | "SATISFIED";
  readonly actionable: boolean;
  readonly blockedBy: readonly string[];
  readonly operation: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly scenarioDependencies: readonly string[];
  readonly checkDependencies: readonly {
    readonly checkName: string;
    readonly providerCheckUri: string;
  }[];
  readonly latestVerdict: "VALIDATED" | "NOT_VALIDATED" | null;
  readonly latestReasonCode: string | null;
  readonly reason: string | null;
  readonly history: readonly {
    readonly snapshotId: string;
    readonly attemptHandle: string;
    readonly state: "open" | "satisfied";
    readonly verdict: "VALIDATED" | "NOT_VALIDATED";
    readonly reasonCode: string;
    readonly reason: string;
    readonly checklistDelta: CheckSnapshot["checklistDelta"];
    readonly factIds: readonly string[];
    readonly calculatedAt: string;
  }[];
  readonly attempts: readonly CheckAttemptView[];
}

export interface CheckTargetView {
  readonly role: string;
  readonly selection: "one" | "each" | "all";
  readonly value: unknown;
}

export interface PlanReaderDependencies {
  readonly clock: Clock;
  readonly attemptStore: AttemptStore;
  readonly factStore: FactStore;
  readonly planStore: PlanStore;
  readonly sessionStore: SessionStore;
  readonly snapshotStore: SnapshotStore;
  readonly procedures: Procedures;
}

export class PlanReader {
  readonly #clock: Clock;
  readonly #attempts: AttemptStore;
  readonly #facts: FactStore;
  readonly #plans: PlanStore;
  readonly #sessions: SessionStore;
  readonly #snapshots: SnapshotStore;
  readonly #procedures: Procedures;
  readonly #cursorSecret = randomBytes(32);

  constructor({
    attemptStore,
    factStore,
    planStore,
    sessionStore,
    snapshotStore,
    procedures,
    clock,
  }: PlanReaderDependencies) {
    this.#clock = clock;
    this.#attempts = attemptStore;
    this.#facts = factStore;
    this.#plans = planStore;
    this.#sessions = sessionStore;
    this.#snapshots = snapshotStore;
    this.#procedures = procedures;
  }

  async readProcedure(input: ProcedureReadInput): Promise<ProcedureReadView> {
    const { check, plan } = await this.#resolve(input.checkUri);
    const revision = await this.#plans.readRevision(plan.slug, plan.currentRevision);
    if (!revision) {
      throw new ReadError(
        "revision-not-found",
        `The active revision for Plan ${plan.slug} is unavailable`,
      );
    }
    const limit = input.limit ?? DEFAULT_PROCEDURE_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROCEDURE_PAGE_SIZE) {
      throw new ReadError(
        "invalid-procedure-page",
        `Procedure page limit must be between 1 and ${MAX_PROCEDURE_PAGE_SIZE}`,
      );
    }
    const sourceDigest = digest(revision.source);
    const checkDigest = digest(check.uri);
    const offset = input.cursor === undefined
      ? 0
      : this.#decodeCursor(input.cursor, sourceDigest, checkDigest);
    if (offset > revision.source.length) {
      throw new ReadError(
        "invalid-procedure-page",
        "Procedure cursor is outside the hosted source",
      );
    }
    const maximumEnd = Math.min(offset + limit, revision.source.length);
    const end = maximumEnd === revision.source.length
      ? maximumEnd
      : pageEndAtLineBoundary(revision.source, offset, maximumEnd);
    return {
      source: revision.source.slice(offset, end),
      ...(end < revision.source.length
        ? { nextCursor: this.#encodeCursor(end, sourceDigest, checkDigest) }
        : {}),
    };
  }

  async readPlan(checkUri: string): Promise<PlanView> {
    const { plan } = await this.#resolve(checkUri);
    return this.readPlanBySlug(plan.slug);
  }

  async listPlans(input: PlanListInput = {}): Promise<{ readonly plans: readonly PlanSummaryView[]; readonly nextCursor?: string }> {
    const limit = listLimit(input.limit);
    const scope = cursorScope(input.filter);
    const after = input.cursor === undefined
      ? undefined
      : this.#decodeListCursor(input.cursor, "plans", scope) as { createdAt: string; plan: string };
    const page = await this.#plans.listPlans({
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(after === undefined ? {} : { after }),
      limit: limit + 1,
    });
    const plans = page.slice(0, limit);
    const views = await Promise.all(plans.map(async (plan) => {
      const view = await this.readPlanBySlug(plan.slug);
      return {
        plan: view.plan,
        procedure: view.procedure,
        procedureVersion: view.procedureVersion,
        environment: view.environment,
        mode: view.mode,
        revision: view.revision,
        createdAt: view.createdAt,
        sessionState: view.sessionState,
        workState: view.workState,
        satisfiedChecks: view.satisfiedChecks,
        checkCount: view.checks.length,
      };
    }));
    const last = plans.at(-1);
    return {
      plans: views,
      ...(page.length > limit && last !== undefined
        ? { nextCursor: this.#encodeListCursor("plans", scope, { createdAt: last.createdAt, plan: last.slug }) }
        : {}),
    };
  }

  async listHistory(input: HistoryListInput = {}): Promise<{ readonly snapshots: readonly HistoryView[]; readonly nextCursor?: string }> {
    const limit = listLimit(input.limit);
    const scope = cursorScope(input.filter);
    const after = input.cursor === undefined
      ? undefined
      : this.#decodeListCursor(input.cursor, "history", scope) as { calculatedAt: string; snapshotId: string };
    const page = await this.#snapshots.listHistoryPage({
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(after === undefined ? {} : { after }),
      limit: limit + 1,
    });
    const records = page.slice(0, limit);
    const snapshots = records.map(({ snapshot, procedure, mode, check }) => ({
      snapshotId: snapshot.id,
      calculatedAt: snapshot.calculatedAt,
      plan: snapshot.planSlug,
      mode,
      procedure,
      checkUri: snapshot.checkUri,
      checkName: check.check.name,
      target: {
        role: check.scope.role,
        selection: check.check.target.selection,
        value: check.scope.value,
      },
      operation: check.check.operation,
      attemptHandle: snapshot.attemptHandle,
      verdict: snapshot.verdict,
      reasonCode: snapshot.reasonCode,
      reason: snapshot.reason,
      factCount: snapshot.factIds.length,
      checklistDelta: snapshot.checklistDelta,
    }));
    const last = records.at(-1)?.snapshot;
    return {
      snapshots,
      ...(page.length > limit && last !== undefined
        ? { nextCursor: this.#encodeListCursor("history", scope, { calculatedAt: last.calculatedAt, snapshotId: last.id }) }
        : {}),
    };
  }

  async readPlanBySlug(planSlug: string): Promise<PlanView> {
    const plan = await this.#plans.findPlan(planSlug);
    if (!plan) {
      throw new ReadError("plan-not-found", `Plan ${planSlug} is unavailable`);
    }
    const revision = await this.#plans.readRevision(plan.slug, plan.currentRevision);
    if (!revision) {
      throw new ReadError(
        "revision-not-found",
        `The active revision for Plan ${plan.slug} is unavailable`,
      );
    }
    const procedure = (await this.#procedures.find(plan.procedure, plan.procedureVersion))?.procedure;
    if (!procedure) {
      throw new ReadError(
        "revision-not-found",
        `The published Procedure for Plan ${plan.slug} is unavailable`,
      );
    }
    const declarationRoles = procedure.roles
      .filter((role) => role.source.kind === "agent-declaration")
      .map((role) => ({
        role: role.name,
        type: role.type,
        cardinality: role.cardinality,
        parents: role.parents,
      }));
    const [checks, availableSession, activeQualifications] = await Promise.all([
      this.#plans.listCurrentChecks(plan.slug),
      this.#sessions.findAvailable(plan.slug, this.#now()),
      this.#snapshots.listActive(plan.slug, plan.currentRevision),
    ]);
    const sessionAvailable = availableSession !== undefined;
    const active = new Set(
      activeQualifications.map((qualification) => qualification.checkUri),
    );
    const latestByCheck = await Promise.all(checks.map((check) => this.#snapshots.findLatest(check.uri)));
    const latestSnapshots = latestByCheck
      .filter((snapshot): snapshot is CheckSnapshot => snapshot !== undefined);
    const latestQualification = [...latestSnapshots].sort(compareSnapshots).at(-1);
    const missingDeclarations = declarationRoles
      .filter(({ role }) => !Object.hasOwn(revision.agentDeclarations, role))
      .map(({ role }) => role);
    const openChecks = checks
      .filter((check) => !active.has(check.uri))
      .map((check) => check.uri)
      .sort();
    const checkViews = checks
      .map((check, index) => checkView(
        check,
        checks,
        active,
        latestByCheck[index],
        sessionAvailable,
      ))
      .sort((left, right) => left.checkUri.localeCompare(right.checkUri));
    const actionableChecks = checkViews
      .filter((check) => check.actionable)
      .map((check) => check.checkUri);
    const blockedChecks = checkViews
      .filter((check) => check.state === "OPEN" && !check.actionable)
      .map((check) => check.checkUri);
    const checklistComplete = missingDeclarations.length === 0 && openChecks.length === 0;
    return {
      plan: plan.slug,
      procedure: plan.procedure,
      procedureVersion: plan.procedureVersion,
      environment: plan.environment,
      mode: plan.mode,
      rootInputs: plan.rootInputs,
      createdAt: plan.createdAt,
      state: "ENGAGED",
      sessionState: sessionAvailable ? "OPEN" : "UNAVAILABLE",
      workState: checklistComplete ? "COMPLETE" : "IN_PROGRESS",
      revision: plan.currentRevision,
      declarations: revision.agentDeclarations,
      declarationRoles,
      missingDeclarations,
      checklistComplete,
      satisfiedChecks: active.size,
      openChecks,
      actionableChecks,
      blockedChecks,
      checks: checkViews,
      latestRevisionChange: await this.#revisionChange(plan.slug, revision, active),
      latestQualification: latestQualification === undefined
        ? null
        : {
            checkUri: latestQualification.checkUri,
            verdict: latestQualification.verdict,
            reasonCode: latestQualification.reasonCode,
            reason: latestQualification.reason,
            newlySatisfied: [...latestQualification.checklistDelta.newlySatisfied].sort(),
            newlyOpened: [...latestQualification.checklistDelta.newlyOpened].sort(),
            unchanged: [...latestQualification.checklistDelta.unchanged].sort(),
          },
      revisions: (await this.#plans.listRevisions(plan.slug)).map((item) => ({
        revision: item.revision,
        definitionDigest: item.definitionDigest,
        source: item.source,
        declarations: item.agentDeclarations,
        roleValues: item.roleValues,
        checkValues: item.checkValues,
        checkUris: item.checks.map((check) => check.uri),
      })),
      sessions: (await this.#sessions.listForPlan(plan.slug)).map(sessionRecord),
    };
  }

  async readSession(checkUri: string): Promise<SessionView> {
    const { plan } = await this.#resolve(checkUri);
    const view = await this.readPlanBySlug(plan.slug);
    return {
      plan: plan.slug,
      state: view.sessionState,
      activeRevision: plan.currentRevision,
      workState: view.workState,
      checklistComplete: view.checklistComplete,
      satisfiedChecks: view.satisfiedChecks,
      openChecks: view.openChecks.length,
      sessions: view.sessions,
    };
  }

  async readCheck(checkUri: string): Promise<CheckView> {
    const { check, plan } = await this.#resolve(checkUri);
    const [history, activeQualifications, checks, availableSession, storedAttempts] = await Promise.all([
      this.#snapshots.listHistory(checkUri),
      this.#snapshots.listActive(plan.slug, plan.currentRevision),
      this.#plans.listCurrentChecks(plan.slug),
      this.#sessions.findAvailable(plan.slug, this.#now()),
      this.#attempts.listByCheck(checkUri),
    ]);
    const latest = history.at(-1);
    const active = new Set(activeQualifications.map((qualification) => qualification.checkUri));
    const state = active.has(checkUri) ? "SATISFIED" : "OPEN";
    const sessionAvailable = availableSession !== undefined;
    const view = checkView(check, checks, active, latest, sessionAvailable);
    const attempts = await Promise.all(storedAttempts.map(async (attempt) => ({
      handle: attempt.handle,
      attemptKey: attempt.attemptKey,
      sessionId: attempt.sessionId,
      state: attempt.state,
      admittedAt: attempt.admittedAt,
      expiresAt: attempt.expiresAt,
      ...(attempt.finalizedAt === undefined ? {} : { finalizedAt: attempt.finalizedAt }),
      ...(attempt.finalization === undefined ? {} : { finalization: attempt.finalization }),
      facts: await this.#facts.list(attempt.handle),
    })));
    return {
      checkUri,
      name: view.name,
      scenario: view.scenario,
      target: view.target,
      inputs: check.actionInput,
      state,
      actionable: view.actionable,
      blockedBy: view.blockedBy,
      operation: view.operation,
      context: check.context,
      scenarioDependencies: check.scenarioDependencies,
      checkDependencies: check.checkDependencies,
      latestVerdict: view.latestVerdict,
      latestReasonCode: view.latestReasonCode,
      reason: view.reason,
      history: history.map((snapshot) => ({
        snapshotId: snapshot.id,
        attemptHandle: snapshot.attemptHandle,
        state: snapshot.state,
        verdict: snapshot.verdict,
        reasonCode: snapshot.reasonCode,
        reason: snapshot.reason,
        checklistDelta: snapshot.checklistDelta,
        factIds: snapshot.factIds,
        calculatedAt: snapshot.calculatedAt,
      })),
      attempts,
    };
  }

  async #revisionChange(
    planSlug: string,
    current: PlanRevision,
    currentActive: ReadonlySet<string>,
  ): Promise<PlanView["latestRevisionChange"]> {
    const previous = current.revision > 1
      ? await this.#plans.readRevision(planSlug, current.revision - 1)
      : undefined;
    const previousChecks = new Map((previous?.checks ?? []).map((check) => [check.uri, check]));
    const currentChecks = new Map(current.checks.map((check) => [check.uri, check]));
    const previousActive = new Set(
      previous === undefined
        ? []
        : (await this.#snapshots.listActive(planSlug, previous.revision)).map((entry) => entry.checkUri),
    );
    const added = [...currentChecks.keys()].filter((uri) => !previousChecks.has(uri)).sort();
    const removed = [...previousChecks.keys()].filter((uri) => !currentChecks.has(uri)).sort();
    const newlySatisfied = [...currentChecks.keys()]
      .filter((uri) => currentActive.has(uri) && !previousActive.has(uri))
      .sort();
    const newlyOpened = [...currentChecks.keys()]
      .filter((uri) => !currentActive.has(uri) && previousActive.has(uri))
      .sort();
    const changed = [...currentChecks.entries()]
      .filter(([uri, check]) => {
        const prior = previousChecks.get(uri);
        return prior !== undefined
          && prior.compiledCheckDigest !== check.compiledCheckDigest
          && !newlySatisfied.includes(uri)
          && !newlyOpened.includes(uri);
      })
      .map(([uri]) => uri)
      .sort();
    const classified = new Set([...added, ...newlySatisfied, ...newlyOpened, ...changed]);
    const unchanged = [...currentChecks.keys()]
      .filter((uri) => previousChecks.has(uri) && !classified.has(uri))
      .sort();
    return {
      fromRevision: previous?.revision ?? null,
      toRevision: current.revision,
      added,
      removed,
      newlySatisfied,
      newlyOpened,
      changed,
      unchanged,
    };
  }

  #now(): Date {
    const now = this.#clock.now();
    if (Number.isNaN(now.getTime())) throw new Error("Clock returned an invalid instant");
    return now;
  }

  async #resolve(checkUri: string): Promise<{
    readonly check: PlanCheck;
    readonly plan: Plan;
  }> {
    if (checkUri.length === 0 || checkUri.length > 2_048) {
      throw new ReadError("check-not-found", "The semantic Check URI is unknown");
    }
    const check = await this.#plans.findCurrentCheck(checkUri);
    if (!check) {
      throw new ReadError("check-not-found", "The semantic Check URI is unknown");
    }
    const plan = await this.#plans.findPlan(check.planSlug);
    if (!plan) {
      throw new ReadError("plan-not-found", "The Check has no active Plan");
    }
    return { check, plan };
  }

  #encodeCursor(offset: number, sourceDigest: string, checkDigest: string): string {
    const payload = Buffer.from(
      JSON.stringify({ v: CURSOR_VERSION, offset, sourceDigest, checkDigest }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.#cursorSecret)
      .update(payload, "utf8")
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  #decodeCursor(cursor: string, sourceDigest: string, checkDigest: string): number {
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra !== undefined) return this.#invalidCursor();
    const expected = createHmac("sha256", this.#cursorSecret)
      .update(payload, "utf8")
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      return this.#invalidCursor();
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return this.#invalidCursor();
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    } catch {
      return this.#invalidCursor();
    }
    if (
      !isRecord(decoded)
      || decoded.v !== CURSOR_VERSION
      || !Number.isSafeInteger(decoded.offset)
      || (decoded.offset as number) < 0
      || decoded.sourceDigest !== sourceDigest
      || decoded.checkDigest !== checkDigest
      || Object.keys(decoded).length !== 4
    ) {
      return this.#invalidCursor();
    }
    return decoded.offset as number;
  }

  #invalidCursor(): never {
    throw new ReadError(
      "invalid-procedure-page",
      "Procedure cursor is invalid or no longer belongs to this Check",
    );
  }

  #encodeListCursor(kind: "plans" | "history", scope: string, key: Record<string, string>): string {
    const payload = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, kind, scope, key }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#cursorSecret).update(payload, "utf8").digest("base64url");
    return `${payload}.${signature}`;
  }

  #decodeListCursor(cursor: string, kind: "plans" | "history", scope: string): Record<string, string> {
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra !== undefined) return this.#invalidListCursor();
    const expected = createHmac("sha256", this.#cursorSecret).update(payload, "utf8").digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return this.#invalidListCursor();
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      if (!isRecord(decoded) || decoded.v !== CURSOR_VERSION || decoded.kind !== kind || decoded.scope !== scope
        || !isRecord(decoded.key) || Object.values(decoded.key).some((value) => typeof value !== "string")
        || !validListKey(kind, decoded.key)) {
        return this.#invalidListCursor();
      }
      return decoded.key as Record<string, string>;
    } catch {
      return this.#invalidListCursor();
    }
  }

  #invalidListCursor(): never {
    throw new ReadError("invalid-list-page", "List cursor is invalid or belongs to another filter");
  }
}

function listLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIST_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_PAGE_SIZE) {
    throw new ReadError("invalid-list-page", `List page limit must be between 1 and ${MAX_LIST_PAGE_SIZE}`);
  }
  return limit;
}

function cursorScope(filter: Readonly<Record<string, unknown>> | undefined): string {
  return JSON.stringify(Object.fromEntries(Object.entries(filter ?? {}).sort(([left], [right]) => left.localeCompare(right))));
}

function validListKey(kind: "plans" | "history", key: Record<string, unknown>): boolean {
  const expected = kind === "plans" ? ["createdAt", "plan"] : ["calculatedAt", "snapshotId"];
  return Object.keys(key).length === expected.length && expected.every((name) => typeof key[name] === "string");
}

function checkView(
  check: PlanCheck,
  checks: readonly PlanCheck[],
  active: ReadonlySet<string>,
  latest: CheckSnapshot | undefined,
  sessionAvailable: boolean,
): PlanCheckView {
  const blockedBy = checkBlockers(check, checks, active, sessionAvailable);
  return {
    checkUri: check.uri,
    name: check.check.name,
    scenario: check.scenario,
    target: {
      role: check.scope.role,
      selection: check.check.target.selection,
      value: check.scope.value,
    },
    inputs: check.actionInput,
    operation: check.check.operation,
    state: active.has(check.uri) ? "SATISFIED" : "OPEN",
    actionable: sessionAvailable && checkIsActionable(check, checks, (uri) => active.has(uri)),
    blockedBy,
    latestVerdict: latest?.verdict ?? null,
    latestReasonCode: latest?.reasonCode ?? null,
    reason: latest?.reason ?? null,
  };
}

function checkBlockers(
  check: PlanCheck,
  checks: readonly PlanCheck[],
  active: ReadonlySet<string>,
  sessionAvailable: boolean,
): readonly string[] {
  if (active.has(check.uri)) return Object.freeze([]);
  const blockers = new Set<string>();
  for (const scenario of check.scenarioDependencies) {
    const dependencies = checks.filter((candidate) => candidate.scenario === scenario);
    if (dependencies.length === 0) {
      blockers.add(`scenario ${scenario} has no current Check`);
      continue;
    }
    for (const dependency of dependencies) {
      if (!active.has(dependency.uri)) blockers.add(dependency.uri);
    }
  }
  for (const dependency of check.checkDependencies) {
    if (
      !checks.some((candidate) => candidate.uri === dependency.providerCheckUri)
      || !active.has(dependency.providerCheckUri)
    ) {
      blockers.add(dependency.providerCheckUri);
    }
  }
  if (check.currentContextDigest === undefined && blockers.size === 0) {
    blockers.add("current Plan context is unavailable");
  }
  if (!sessionAvailable && blockers.size === 0) {
    blockers.add("Plan Session is unavailable");
  }
  return Object.freeze([...blockers].sort());
}

function compareSnapshots(left: CheckSnapshot, right: CheckSnapshot): number {
  const byInstant = left.calculatedAt.localeCompare(right.calculatedAt);
  if (byInstant !== 0) return byInstant;
  return left.checkUri.localeCompare(right.checkUri);
}

function sessionRecord(session: {
  readonly id: string;
  readonly state: "open" | "closed" | "expired";
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly closedAt?: string;
}): SessionRecordView {
  return {
    id: session.id,
    state: session.state,
    openedAt: session.openedAt,
    expiresAt: session.expiresAt,
    ...(session.closedAt === undefined ? {} : { closedAt: session.closedAt }),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pageEndAtLineBoundary(source: string, offset: number, maximumEnd: number): number {
  const newline = source.lastIndexOf("\n", maximumEnd - 1);
  return newline >= offset ? newline + 1 : maximumEnd;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
