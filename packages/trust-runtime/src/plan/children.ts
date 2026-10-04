import { createHash, randomUUID } from "node:crypto";
import type { DescendantEscalation, InvocationView, PlanImportedResult } from "@trust/extension-sdk";
import type { ChildGenerationTable, Database } from "../database/database.js";
import type { PlanCheck, PlanRevision } from "../model.js";
import { SnapshotStore } from "../snapshot/store.js";
import { buildPlanRevision } from "./build.js";
import { semanticJson } from "./semantic-json.js";
import { PlanStore } from "./store.js";
import { readOnce } from "./transaction.js";

export interface CompositionState {
  complete: boolean;
  blockers: string[];
  ownEscalation: DescendantEscalation | null;
  descendantEscalations: DescendantEscalation[];
  invocations: InvocationView[];
  scenarios: Set<string>;
  parent: import("@trust/extension-sdk").PlanParentView | null;
}

export function ancestorBlocker(database: Database, plan: string): Promise<string | undefined> {
  return readOnce(database, `ancestor:${plan}`, () => findAncestorBlocker(database, plan));
}

async function findAncestorBlocker(database: Database, plan: string): Promise<string | undefined> {
  const seen = new Set<string>();
  let current = plan;
  while (!seen.has(current)) {
    seen.add(current);
    const relation = await database
      .selectFrom("child_generations")
      .selectAll()
      .where("child_plan", "=", current)
      .executeTakeFirst();
    if (!relation) return undefined;
    if (relation.superseded_at !== null) return "The child invocation generation is superseded";
    current = relation.parent_plan;
    const escalation = await database
      .selectFrom("plan_escalations")
      .select("escalation_id")
      .where("plan_slug", "=", current)
      .where("resumed_at", "is", null)
      .executeTakeFirst();
    if (escalation) return "An ancestor Plan is escalated";
  }
  throw new Error("Cyclic child Plan relation");
}

export async function invocationDependencyDigest(database: Database, check: PlanCheck): Promise<string | undefined> {
  const plans = new PlanStore({ database });
  const plan = (await plans.findPlan(check.planSlug))!;
  const revision = (await plans.readRevision(plan.slug, plan.currentRevision))!;
  const dependencies = revision.invocations.filter((value) =>
    check.scenarioDependencies.includes(value.definition.scenario),
  );
  if (!dependencies.length) return undefined;
  const signature = await Promise.all(
    dependencies.map(async (dependency) => {
      const relation = await database
        .selectFrom("child_generations")
        .selectAll()
        .where("parent_plan", "=", plan.slug)
        .where("invocation_id", "=", dependency.id)
        .where("superseded_at", "is", null)
        .executeTakeFirst();
      return {
        id: dependency.id,
        child: relation?.child_plan,
        generation: relation?.generation,
        revision: relation ? (await plans.findPlan(relation.child_plan))?.currentRevision : undefined,
      };
    }),
  );
  return hash(signature);
}

/**
 * The Attempt of a child Plan of any generation of this invocation, or of one of their descendants, that blocks the
 * removal of its mission: a finalized Attempt gave a verdict, a pending Attempt before its expiry may be running.
 */
export async function invocationBlockingAttempt(
  database: Database,
  parentPlan: string,
  invocationId: string,
  at: string,
): Promise<"verdict" | "running" | undefined> {
  const generations = await database
    .selectFrom("child_generations")
    .select("child_plan")
    .where("parent_plan", "=", parentPlan)
    .where("invocation_id", "=", invocationId)
    .execute();
  const plans = new Set(generations.map((value) => value.child_plan));
  let frontier = [...plans];
  while (frontier.length) {
    const descendants = await database
      .selectFrom("child_generations")
      .select("child_plan")
      .where("parent_plan", "in", frontier)
      .execute();
    frontier = descendants.map((value) => value.child_plan).filter((value) => !plans.has(value));
    for (const value of frontier) plans.add(value);
  }
  if (!plans.size) return undefined;
  const blocking = await database
    .selectFrom("attempts")
    .select("state")
    .where("plan_slug", "in", [...plans])
    .where((attempt) =>
      attempt.or([
        attempt("state", "=", "finalized"),
        attempt.and([attempt("state", "=", "pending"), attempt("expires_at", ">", at)]),
      ]),
    )
    .orderBy("state")
    .limit(1)
    .executeTakeFirst();
  if (!blocking) return undefined;
  return blocking.state === "finalized" ? "verdict" : "running";
}

export function readComposition(database: Database, slug: string): Promise<CompositionState> {
  return readOnce(database, `composition:${slug}`, () => composition(database, slug));
}

async function composition(database: Database, slug: string): Promise<CompositionState> {
  const plans = new PlanStore({ database });
  const plan = await plans.findPlan(slug);
  if (!plan) throw new Error("Unknown composed Plan");
  const revision = (await plans.readRevision(slug, plan.currentRevision))!;
  const procedure = revision.resolvedProcedure;
  const active = await new SnapshotStore({ database }).listActive(slug, plan.currentRevision);
  const activeUris = new Set(active.map((value) => value.checkUri));
  const relations = await database
    .selectFrom("child_generations")
    .selectAll()
    .where("parent_plan", "=", slug)
    .orderBy("generation")
    .execute();
  const parent = await database
    .selectFrom("child_generations")
    .selectAll()
    .where("child_plan", "=", slug)
    .executeTakeFirst();
  const invocations: InvocationView[] = [];
  const descendantEscalations = new Map<string, DescendantEscalation>();
  for (const invocation of revision.invocations) {
    const history = relations.filter((value) => value.invocation_id === invocation.id);
    const current = history.find((value) => value.superseded_at === null);
    const childState = current ? await readComposition(database, current.child_plan) : undefined;
    const childComplete = childState?.complete === true;
    if (current && childState) {
      for (const escalation of [
        ...(childState.ownEscalation ? [childState.ownEscalation] : []),
        ...childState.descendantEscalations,
      ]) {
        descendantEscalations.set(escalation.escalationId, {
          ...escalation,
          path: [
            {
              parentPlan: slug,
              invocationId: invocation.id,
              generation: current.generation,
              childPlan: current.child_plan,
            },
            ...escalation.path,
          ],
        });
      }
    }
    invocations.push({
      id: invocation.id,
      ...(invocation.mission ? { mission: invocation.mission } : {}),
      name: invocation.definition.name,
      scenario: invocation.definition.scenario,
      state: !current ? "WAITING" : childComplete ? "SATISFIED" : "RUNNING",
      blockedBy: childState?.blockers ?? [],
      childPlan: current?.child_plan ?? null,
      generation: current?.generation ?? null,
      history: history.map((value) => ({
        generation: value.generation,
        childPlan: value.child_plan,
        supersededAt: value.superseded_at,
      })),
    });
  }
  const scenarios = new Set<string>();
  for (const scenario of procedure.scenarios) {
    const checks = revision.checks.filter((value) => value.scenario === scenario.slug);
    const children = invocations.filter((value) => value.scenario === scenario.slug);
    if (
      scenario.checks.every((name) => checks.some((value) => value.check.name === name)) &&
      checks.every((value) => activeUris.has(value.uri)) &&
      scenario.invocations.every((name) => children.some((value) => value.name === name)) &&
      children.every((value) => value.state === "SATISFIED")
    )
      scenarios.add(scenario.slug);
  }
  for (const invocation of invocations) {
    const definition = revision.invocations.find((value) => value.id === invocation.id)!;
    invocation.blockedBy.push(
      ...definition.scenarioDependencies
        .filter((value) => !scenarios.has(value))
        .map((value) => `Scenario ${value} is not satisfied`),
    );
  }
  const missingDeclarations =
    (procedure.missionCollections ?? []).some((value) => !revision.missionDeclarations[value.name]?.length) ||
    procedure.roles.some(
      (role) =>
        role.source.kind === "agent-declaration" &&
        role.source.optional !== true &&
        !Object.hasOwn(revision.agentDeclarations, role.name),
    );
  const missingResults = procedure.roles
    .filter((role) => role.returned === true)
    .filter((role) => ![...revision.roleValues, ...revision.importedValues].some((value) => value.role === role.name));
  const escalated = await database
    .selectFrom("plan_escalations")
    .selectAll()
    .where("plan_slug", "=", slug)
    .where("resumed_at", "is", null)
    .executeTakeFirst();
  return {
    ownEscalation: escalated
      ? {
          plan: slug,
          mode: plan.mode,
          title: plan.metadata.title ?? slug,
          escalationId: escalated.escalation_id,
          checkUri: escalated.check_uri,
          blockingReason: escalated.blocking_reason,
          forbiddenFurtherAction: escalated.forbidden_further_action,
          escalatedAt: escalated.escalated_at,
          path: [],
        }
      : null,
    descendantEscalations: [...descendantEscalations.values()],
    blockers: [
      ...(escalated ? [`Plan ${slug} is escalated: ${escalated.blocking_reason}`] : []),
      ...invocations.flatMap((value) => value.blockedBy),
      ...missingResults.map((role) => `Returned Result ${role.name} is not validated`),
    ],
    complete:
      !missingDeclarations &&
      !escalated &&
      missingResults.length === 0 &&
      active.length === revision.checks.length &&
      procedure.invocations.every((value) => invocations.some((invocation) => invocation.name === value.name)) &&
      (procedure.declaredInvocations ?? []).every((value) =>
        invocations.some((invocation) => invocation.name === value.name),
      ) &&
      invocations.every((value) => value.state === "SATISFIED"),
    invocations,
    scenarios,
    parent: parent
      ? {
          plan: parent.parent_plan,
          invocationId: parent.invocation_id,
          generation: parent.generation,
          current: parent.superseded_at === null,
        }
      : null,
  };
}

/** Must run inside the same write transaction as the triggering parent or child change. */
export async function synchronizeChildren(input: {
  database: Database;
  authority: string;
  plan: string;
  at: string;
  create(revision: PlanRevision, creator: import("@trust/extension-sdk").ExternalPrincipal | null): Promise<void>;
}): Promise<Set<string>> {
  const { database } = input;
  const plans = new PlanStore({ database });
  const snapshots = new SnapshotStore({ database });
  let root = input.plan;
  while (true) {
    const parent = await database
      .selectFrom("child_generations")
      .selectAll()
      .where("child_plan", "=", root)
      .executeTakeFirst();
    if (!parent || parent.superseded_at !== null) break;
    root = parent.parent_plan;
  }
  const changed = new Set<string>();
  const visit = async (slug: string): Promise<void> => {
    if (await ancestorBlocker(database, slug)) return;
    const plan = (await plans.findPlan(slug))!;
    const revision = (await plans.readRevision(slug, plan.currentRevision))!;
    const procedure = revision.resolvedProcedure;
    const active = await snapshots.listActive(slug, plan.currentRevision);
    const activeMap = new Map(active.map((value) => [value.checkUri, value]));
    const changedScenarios = new Set<string>();
    // Visit prerequisite scenarios first, including invocation-only scenarios.
    const ordered: string[] = [];
    const order = (name: string) => {
      if (ordered.includes(name)) return;
      for (const dependency of procedure.scenarios.find((value) => value.slug === name)!.dependencies)
        order(dependency);
      ordered.push(name);
    };
    for (const scenario of procedure.scenarios) order(scenario.slug);
    const relations = await database
      .selectFrom("child_generations")
      .selectAll()
      .where("parent_plan", "=", slug)
      .execute();
    for (const relation of relations.filter(
      (value) =>
        value.superseded_at === null &&
        !revision.invocations.some((invocation) => invocation.id === value.invocation_id),
    )) {
      await supersede(relation);
      changed.add(slug);
    }
    for (const scenario of ordered) {
      for (const invocation of revision.invocations.filter((value) => value.definition.scenario === scenario)) {
        const state = await readComposition(database, slug);
        const eligible = invocation.scenarioDependencies.every((value) => state.scenarios.has(value));
        const history = await database
          .selectFrom("child_generations")
          .selectAll()
          .where("parent_plan", "=", slug)
          .where("invocation_id", "=", invocation.id)
          .orderBy("generation", "desc")
          .execute();
        let current = history.find((value) => value.superseded_at === null);
        const signatureInput = {
          definition: invocation.definition.procedureDigest,
          inputs: invocation.rootInputs,
          checks: revision.checks
            .filter((value) => invocation.scenarioDependencies.includes(value.scenario))
            .map((value) => activeMap.get(value.uri)?.activationDigest),
          children: await Promise.all(
            state.invocations
              .filter((value) => invocation.scenarioDependencies.includes(value.scenario))
              .map(async (value) => ({
                id: value.id,
                generation: value.generation,
                revision: value.childPlan ? (await plans.findPlan(value.childPlan))?.currentRevision : null,
              })),
          ),
        };
        const signature = childInputFingerprint(signatureInput);
        if (current && (!eligible || current.comparison_fingerprint !== signature)) {
          await supersede(current);
          current = undefined;
          changed.add(slug);
        }
        if (eligible && !current) {
          const childPlan = `child-${randomUUID()}`;
          const child = invocation.definition.childDefinition;
          const initial = buildPlanRevision({
            authority: input.authority,
            procedure: child,
            plan: childPlan,
            environment: plan.environment,
            mode: plan.mode,
            metadata: { title: invocation.definition.name, labels: [], annotations: {} },
            rootInputs: invocation.rootInputs,
            revision: 1,
          });
          await input.create(initial, plan.creator);
          current = {
            parent_plan: slug,
            invocation_id: invocation.id,
            generation: (history[0]?.generation ?? 0) + 1,
            child_plan: childPlan,
            input_digest: hash(signatureInput),
            comparison_fingerprint: signature,
            observed_revision: 1,
            created_at: input.at,
            superseded_at: null,
          };
          await database.insertInto("child_generations").values(current).execute();
          changed.add(slug);
          changed.add(childPlan);
        }
        if (current) {
          await visit(current.child_plan);
          const childRevision = (await plans.findPlan(current.child_plan))!.currentRevision;
          if (childRevision !== current.observed_revision) {
            changedScenarios.add(invocation.definition.scenario);
            await database
              .updateTable("child_generations")
              .set({ observed_revision: childRevision })
              .where("child_plan", "=", current.child_plan)
              .execute();
            changed.add(slug);
          }
        }
      }
    }
    const state = await readComposition(database, slug);
    const importedValues = await collectImportedResults(database, revision);
    const resultsChanged = semanticJson(importedValues) !== semanticJson(revision.importedValues);
    const invalid = new Set(
      revision.checks
        .filter((check) =>
          check.scenarioDependencies.some(
            (scenario) => !state.scenarios.has(scenario) || changedScenarios.has(scenario),
          ),
        )
        .map((value) => value.uri),
    );
    const withdrawn = active.filter((value) => invalid.has(value.checkUri));
    if (withdrawn.length || changedScenarios.size || resultsChanged) {
      const next = buildPlanRevision({
        authority: input.authority,
        procedure,
        plan: slug,
        environment: plan.environment,
        mode: plan.mode,
        metadata: plan.metadata,
        rootInputs: plan.rootInputs,
        declarations: revision.agentDeclarations,
        missionDeclarations: revision.missionDeclarations,
        resolvedMissions: revision.resolvedMissions,
        roleValues: revision.roleValues.filter((value) => !invalid.has(value.providerCheckUri)),
        importedValues,
        checkValues: revision.checkValues.filter((value) => !invalid.has(value.providerCheckUri)),
        revision: plan.currentRevision + 1,
        pruneUnavailableRoleValues: true,
      });
      await plans.saveRevision(next, input.at);
      await snapshots.saveActiveForRevision(
        slug,
        next.revision,
        active
          .filter(
            (value) =>
              !invalid.has(value.checkUri) &&
              next.checks.some(
                (check) => check.uri === value.checkUri && check.compiledCheckDigest === value.compiledCheckDigest,
              ),
          )
          .map((value) => ({ ...value, planRevision: next.revision })),
      );
      if (plan.intentChainState === "COMPLETE") await plans.restartIntent(slug);
      changed.add(slug);
      await visit(slug);
    } else if (
      state.complete &&
      plan.intentChaining &&
      plan.intentChainState !== "COMPLETE" &&
      plan.currentIntentAttemptKey === undefined
    ) {
      await plans.completeIntentWithoutAttempt(slug);
      changed.add(slug);
    }
  };
  async function supersede(relation: ChildGenerationTable) {
    await database
      .updateTable("child_generations")
      .set({ superseded_at: input.at })
      .where("parent_plan", "=", relation.parent_plan)
      .where("invocation_id", "=", relation.invocation_id)
      .where("generation", "=", relation.generation)
      .where("superseded_at", "is", null)
      .execute();
  }
  await visit(root);
  return changed;
}

async function collectImportedResults(database: Database, revision: PlanRevision): Promise<PlanImportedResult[]> {
  const plans = new PlanStore({ database });
  const values: PlanImportedResult[] = [];
  for (const invocation of revision.invocations) {
    if (invocation.definition.materializes.length === 0) continue;
    const relation = await database
      .selectFrom("child_generations")
      .selectAll()
      .where("parent_plan", "=", revision.planSlug)
      .where("invocation_id", "=", invocation.id)
      .where("superseded_at", "is", null)
      .executeTakeFirst();
    if (!relation || !(await readComposition(database, relation.child_plan)).complete) continue;
    const childPlan = (await plans.findPlan(relation.child_plan))!;
    const child = (await plans.readRevision(relation.child_plan, childPlan.currentRevision))!;
    for (const binding of invocation.definition.materializes) {
      const parentRole = revision.resolvedProcedure.roles.find((role) => role.name === binding.role)!;
      const results = [...child.roleValues, ...child.importedValues].filter((item) => item.role === binding.result);
      if (results.length === 0) throw new TypeError(`Completed child has no Result "${binding.result}"`);
      const parents = Object.fromEntries(
        parentRole.parents.map(({ role }) => {
          const input = invocation.definition.inputBindings.find((candidate) => candidate.role === role);
          if (!input || !Object.hasOwn(invocation.rootInputs, input.input))
            throw new TypeError(`Invocation Result "${binding.role}" has no parent coordinate "${role}"`);
          return [role, invocation.rootInputs[input.input]];
        }),
      );
      for (const result of results)
        values.push({
          role: binding.role,
          result: binding.result,
          value: result.value,
          parents,
          invocationId: invocation.id,
          childPlan: relation.child_plan,
          childRevision: childPlan.currentRevision,
        });
    }
  }
  return values.sort((a, b) => semanticJson(a).localeCompare(semanticJson(b)));
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Derived comparison identity; historical input_digest is retained as provenance. */
export function childInputFingerprint(signature: unknown): string {
  return createHash("sha256").update(semanticJson(signature)).digest("hex");
}
