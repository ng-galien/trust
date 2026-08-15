import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { checkIsActionable } from "../domain/check-actionability.js";
import type { CheckSnapshot, MaterializedCheck } from "../domain/runtime-model.js";
import type { CheckSnapshotRepository } from "../infrastructure/repositories/check-snapshot-repository.js";
import type { PlanRepository } from "../infrastructure/repositories/plan-repository.js";
import type { SessionRepository } from "../infrastructure/repositories/session-repository.js";
import type { ProcedureDefinitionService } from "./procedure-definition-service.js";

const DEFAULT_PROCEDURE_PAGE_SIZE = 49_152;
const MAX_PROCEDURE_PAGE_SIZE = 65_536;
const CURSOR_VERSION = 1;

export type AgentReadErrorCode =
  | "check-not-found"
  | "plan-not-found"
  | "revision-not-found"
  | "invalid-procedure-page";

export class AgentReadError extends Error {
  constructor(
    readonly code: AgentReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentReadError";
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

export interface AgentPlanView {
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
  readonly checks: readonly AgentPlanCheckView[];
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

export interface AgentPlanCheckView {
  readonly checkUri: string;
  readonly name: string;
  readonly scenario: string;
  readonly target: string | null;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly capability: string;
  readonly state: "OPEN" | "SATISFIED";
  readonly actionable: boolean;
  readonly blockedBy: readonly string[];
  readonly latestVerdict: "VALIDATED" | "NOT_VALIDATED" | null;
  readonly latestReasonCode: string | null;
  readonly reason: string | null;
}

export interface AgentSessionView {
  readonly plan: string;
  readonly state: "OPEN" | "UNAVAILABLE";
  readonly activeRevision: number;
  readonly workState: "IN_PROGRESS" | "COMPLETE";
  readonly checklistComplete: boolean;
  readonly satisfiedChecks: number;
  readonly openChecks: number;
}

export interface AgentCheckView {
  readonly checkUri: string;
  readonly name: string;
  readonly scenario: string;
  readonly target: string | null;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly state: "OPEN" | "SATISFIED";
  readonly actionable: boolean;
  readonly blockedBy: readonly string[];
  readonly capability: string;
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

export interface AgentReadServiceDependencies {
  readonly planRepository: PlanRepository;
  readonly sessionRepository: SessionRepository;
  readonly checkSnapshotRepository: CheckSnapshotRepository;
  readonly procedureDefinitionService: ProcedureDefinitionService;
}

/**
 * Bounded application projection for autonomous agents.
 *
 * It reads the same Plan runtime state and Check service used by RPC, but exposes
 * neither persistence DTOs nor runtime identities to the MCP presentation.
 */
export class AgentReadService {
  readonly #plans: PlanRepository;
  readonly #sessions: SessionRepository;
  readonly #snapshots: CheckSnapshotRepository;
  readonly #procedures: ProcedureDefinitionService;
  readonly #cursorSecret = randomBytes(32);

  constructor({
    planRepository,
    sessionRepository,
    checkSnapshotRepository,
    procedureDefinitionService,
  }: AgentReadServiceDependencies) {
    this.#plans = planRepository;
    this.#sessions = sessionRepository;
    this.#snapshots = checkSnapshotRepository;
    this.#procedures = procedureDefinitionService;
  }

  readProcedure(input: ProcedureReadInput): ProcedureReadView {
    const { check, plan } = this.#resolve(input.checkUri);
    const revision = this.#plans.findMaterializedRevision(plan.slug, plan.currentRevision);
    if (!revision) {
      throw new AgentReadError(
        "revision-not-found",
        `The active revision for Plan ${plan.slug} is unavailable`,
      );
    }
    const limit = input.limit ?? DEFAULT_PROCEDURE_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROCEDURE_PAGE_SIZE) {
      throw new AgentReadError(
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
      throw new AgentReadError(
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

  readPlan(checkUri: string): AgentPlanView {
    const { plan } = this.#resolve(checkUri);
    return this.readPlanBySlug(plan.slug);
  }

  readPlanBySlug(planSlug: string): AgentPlanView {
    const plan = this.#plans.findPlan(planSlug);
    if (!plan) {
      throw new AgentReadError("plan-not-found", `Plan ${planSlug} is unavailable`);
    }
    const revision = this.#plans.findMaterializedRevision(plan.slug, plan.currentRevision);
    if (!revision) {
      throw new AgentReadError(
        "revision-not-found",
        `The active revision for Plan ${plan.slug} is unavailable`,
      );
    }
    const definition = this.#procedures.find(plan.procedure, plan.procedureVersion)?.definition;
    if (!definition) {
      throw new AgentReadError(
        "revision-not-found",
        `The published definition for Plan ${plan.slug} is unavailable`,
      );
    }
    const declarationRoles = definition.roles
      .filter((role) => role.materialization.kind === "agent-declaration")
      .map((role) => ({
        role: role.name,
        type: role.valueType,
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

  readSession(checkUri: string): AgentSessionView {
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

  readCheck(checkUri: string): AgentCheckView {
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
      capability: view.capability,
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
    current: NonNullable<ReturnType<PlanRepository["findMaterializedRevision"]>>,
    currentActive: ReadonlySet<string>,
  ): AgentPlanView["latestRevisionChange"] {
    const previous = current.revision > 1
      ? this.#plans.findMaterializedRevision(planSlug, current.revision - 1)
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
    readonly check: MaterializedCheck;
    readonly plan: NonNullable<ReturnType<PlanRepository["findPlan"]>>;
  } {
    if (checkUri.length === 0 || checkUri.length > 2_048) {
      throw new AgentReadError("check-not-found", "The semantic Check URI is unknown");
    }
    const check = this.#plans.findCurrentCheck(checkUri);
    if (!check) {
      throw new AgentReadError("check-not-found", "The semantic Check URI is unknown");
    }
    const plan = this.#plans.findPlan(check.planSlug);
    if (!plan) {
      throw new AgentReadError("plan-not-found", "The Check has no active Plan");
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
    throw new AgentReadError(
      "invalid-procedure-page",
      "Procedure cursor is invalid or no longer belongs to this Check",
    );
  }
}

function checkView(
  check: MaterializedCheck,
  checks: readonly MaterializedCheck[],
  active: ReadonlySet<string>,
  latest: CheckSnapshot | undefined,
): AgentPlanCheckView {
  const blockedBy = checkBlockers(check, checks, active);
  return {
    checkUri: check.uri,
    name: check.template.name,
    scenario: check.scenario,
    target: check.expansion[0] ?? null,
    inputs: check.actionInput,
    capability: check.template.capabilityContract.capability,
    state: active.has(check.uri) ? "SATISFIED" : "OPEN",
    actionable: checkIsActionable(check, checks, (uri) => active.has(uri)),
    blockedBy,
    latestVerdict: latest?.verdict ?? null,
    latestReasonCode: latest?.reasonCode ?? null,
    reason: latest?.reason ?? null,
  };
}

function checkBlockers(
  check: MaterializedCheck,
  checks: readonly MaterializedCheck[],
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
      dependency.observationDigest === undefined
      || !checks.some((candidate) => candidate.uri === dependency.providerCheckUri)
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
