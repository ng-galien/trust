import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { checkIsActionable } from "../check/actionability.js";
import type { CheckSnapshot, PlanCheck } from "../model.js";
import type { SnapshotStore } from "../sqlite/snapshots.js";
import type { PlanStore } from "../sqlite/plans.js";
import type { SessionStore } from "../sqlite/sessions.js";
import type { Procedures } from "../procedure/procedures.js";

const DEFAULT_PROCEDURE_PAGE_SIZE = 49_152;
const MAX_PROCEDURE_PAGE_SIZE = 65_536;
const CURSOR_VERSION = 1;

export type ReadErrorCode =
  | "check-not-found"
  | "plan-not-found"
  | "revision-not-found"
  | "invalid-procedure-page";

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
}

export interface PlanCheckView {
  readonly checkUri: string;
  readonly name: string;
  readonly scenario: string;
  readonly target: string | null;
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
}

export interface CheckView {
  readonly checkUri: string;
  readonly name: string;
  readonly scenario: string;
  readonly target: string | null;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly state: "OPEN" | "SATISFIED";
  readonly actionable: boolean;
  readonly blockedBy: readonly string[];
  readonly operation: string;
  readonly latestVerdict: "VALIDATED" | "NOT_VALIDATED" | null;
  readonly latestReasonCode: string | null;
  readonly reason: string | null;
  readonly history: readonly {
    readonly verdict: "VALIDATED" | "NOT_VALIDATED";
    readonly reasonCode: string;
    readonly reason: string;
    readonly checklistDelta: CheckSnapshot["checklistDelta"];
  }[];
}

export interface PlanReaderDependencies {
  readonly planStore: PlanStore;
  readonly sessionStore: SessionStore;
  readonly snapshotStore: SnapshotStore;
  readonly procedures: Procedures;
}

export class PlanReader {
  readonly #plans: PlanStore;
  readonly #sessions: SessionStore;
  readonly #snapshots: SnapshotStore;
  readonly #procedures: Procedures;
  readonly #cursorSecret = randomBytes(32);

  constructor({
    planStore,
    sessionStore,
    snapshotStore,
    procedures,
  }: PlanReaderDependencies) {
    this.#plans = planStore;
    this.#sessions = sessionStore;
    this.#snapshots = snapshotStore;
    this.#procedures = procedures;
  }

  readProcedure(input: ProcedureReadInput): ProcedureReadView {
    const { check, plan } = this.#resolve(input.checkUri);
    const revision = this.#plans.readRevision(plan.slug, plan.currentRevision);
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
    const end = Math.min(offset + limit, revision.source.length);
    return {
      source: revision.source.slice(offset, end),
      ...(end < revision.source.length
        ? { nextCursor: this.#encodeCursor(end, sourceDigest, checkDigest) }
        : {}),
    };
  }

  readPlan(checkUri: string): PlanView {
    const { plan } = this.#resolve(checkUri);
    return this.readPlanBySlug(plan.slug);
  }

  readPlanBySlug(planSlug: string): PlanView {
    const plan = this.#plans.findPlan(planSlug);
    if (!plan) {
      throw new ReadError("plan-not-found", `Plan ${planSlug} is unavailable`);
    }
    const revision = this.#plans.readRevision(plan.slug, plan.currentRevision);
    if (!revision) {
      throw new ReadError(
        "revision-not-found",
        `The active revision for Plan ${plan.slug} is unavailable`,
      );
    }
    const procedure = this.#procedures.find(plan.procedure, plan.procedureVersion)?.procedure;
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
    const checks = this.#plans.listCurrentChecks(plan.slug);
    const active = new Set(
      this.#snapshots
        .listActive(plan.slug, plan.currentRevision)
        .map((qualification) => qualification.checkUri),
    );
    const latestSnapshots = checks
      .map((check) => this.#snapshots.findLatest(check.uri))
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
      .map((check) => checkView(check, checks, active, this.#snapshots.findLatest(check.uri)))
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
      state: "ENGAGED",
      sessionState: this.#sessions.findOpen(plan.slug) === undefined ? "UNAVAILABLE" : "OPEN",
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
      latestRevisionChange: this.#revisionChange(plan.slug, revision, active),
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
    };
  }

  readSession(checkUri: string): SessionView {
    const { plan } = this.#resolve(checkUri);
    const view = this.readPlanBySlug(plan.slug);
    return {
      plan: plan.slug,
      state: view.sessionState,
      activeRevision: plan.currentRevision,
      workState: view.workState,
      checklistComplete: view.checklistComplete,
      satisfiedChecks: view.satisfiedChecks,
      openChecks: view.openChecks.length,
    };
  }

  readCheck(checkUri: string): CheckView {
    const { check, plan } = this.#resolve(checkUri);
    const history = this.#snapshots.listHistory(checkUri);
    const latest = history.at(-1);
    const active = new Set(
      this.#snapshots
        .listActive(plan.slug, plan.currentRevision)
        .map((qualification) => qualification.checkUri),
    );
    const state = active.has(checkUri) ? "SATISFIED" : "OPEN";
    const checks = this.#plans.listCurrentChecks(plan.slug);
    const view = checkView(check, checks, active, latest);
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
      latestVerdict: view.latestVerdict,
      latestReasonCode: view.latestReasonCode,
      reason: view.reason,
      history: history.map((snapshot) => ({
        verdict: snapshot.verdict,
        reasonCode: snapshot.reasonCode,
        reason: snapshot.reason,
        checklistDelta: snapshot.checklistDelta,
      })),
    };
  }

  #revisionChange(
    planSlug: string,
    current: NonNullable<ReturnType<PlanStore["readRevision"]>>,
    currentActive: ReadonlySet<string>,
  ): PlanView["latestRevisionChange"] {
    const previous = current.revision > 1
      ? this.#plans.readRevision(planSlug, current.revision - 1)
      : undefined;
    const previousChecks = new Map((previous?.checks ?? []).map((check) => [check.uri, check]));
    const currentChecks = new Map(current.checks.map((check) => [check.uri, check]));
    const previousActive = new Set(
      previous === undefined
        ? []
        : this.#snapshots.listActive(planSlug, previous.revision).map((entry) => entry.checkUri),
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

  #resolve(checkUri: string): {
    readonly check: PlanCheck;
    readonly plan: NonNullable<ReturnType<PlanStore["findPlan"]>>;
  } {
    if (checkUri.length === 0 || checkUri.length > 2_048) {
      throw new ReadError("check-not-found", "The semantic Check URI is unknown");
    }
    const check = this.#plans.findCurrentCheck(checkUri);
    if (!check) {
      throw new ReadError("check-not-found", "The semantic Check URI is unknown");
    }
    const plan = this.#plans.findPlan(check.planSlug);
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
}

function checkView(
  check: PlanCheck,
  checks: readonly PlanCheck[],
  active: ReadonlySet<string>,
  latest: CheckSnapshot | undefined,
): PlanCheckView {
  const blockedBy = checkBlockers(check, checks, active);
  return {
    checkUri: check.uri,
    name: check.check.name,
    scenario: check.scenario,
    target: check.expansion[0] ?? null,
    inputs: check.actionInput,
    operation: check.check.operation,
    state: active.has(check.uri) ? "SATISFIED" : "OPEN",
    actionable: checkIsActionable(check, checks, (uri) => active.has(uri)),
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
  return Object.freeze([...blockers].sort());
}

function compareSnapshots(left: CheckSnapshot, right: CheckSnapshot): number {
  const byInstant = left.calculatedAt.localeCompare(right.calculatedAt);
  if (byInstant !== 0) return byInstant;
  return left.checkUri.localeCompare(right.checkUri);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
