import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CheckAttemptAdmissionResult,
  type CheckView,
  PLAN_ACCESS_ACTIONS,
  type PlanCancellationResult,
  type PlanSummaryView,
  type SessionView,
} from "@trust/extension-sdk";
import { afterAll, beforeAll } from "vitest";
import { test } from "./support/fixtures.js";

// The file runs compiled from dist/acceptance or directly as TypeScript from acceptance; both use the built runtime.
const here = path.dirname(fileURLToPath(import.meta.url));
const runtimePackage = path.resolve(here, here.endsWith(`${path.sep}dist${path.sep}acceptance`) ? "../.." : "..");
const { cancellationClient } = (await import(
  pathToFileURL(path.join(runtimePackage, "dist/acceptance/support/plan-cancellation.js")).href
)) as typeof import("./support/plan-cancellation.js");
const fixedAuthentication = await import(
  pathToFileURL(path.join(runtimePackage, "acceptance/fixed-auth-support.mjs")).href
);

const issuer: string = fixedAuthentication.issuer;
// The fixed principal owns every Plan it engages; the "own" form of each Plan permission, plan.cancel included.
const scopes = [
  ...PLAN_ACCESS_ACTIONS.map((action) => `trust.${action}.own`),
  "trust.procedure.publish",
  "trust.procedure.read",
  "trust.environment.save",
];
assert.ok(scopes.includes("trust.plan.cancel.own"));

let runtime: { endpoint: string; start(): Promise<void>; close(): Promise<void> };
let client: ReturnType<typeof cancellationClient>;

beforeAll(async () => {
  runtime = await fixedAuthentication.fixture({ authentication: fixedAuthentication.fixed({ scopes }) });
  await runtime.start();
  client = cancellationClient(runtime.endpoint);
  await client.publish();
});

afterAll(async () => {
  await runtime?.close();
});

const reason = "The owner abandoned this work; nobody will finish it.";

/** Read the Plan event stream until one event matches, while `action` runs. */
async function eventDuring(predicate: (event: Record<string, unknown>) => boolean, action: () => Promise<unknown>) {
  const controller = new AbortController();
  const response = await fetch(`${runtime.endpoint}/events/plans`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const found = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return undefined;
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split("\n\n")) {
        const data = block
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data === undefined) continue;
        const event = JSON.parse(data) as Record<string, unknown>;
        if (predicate(event)) return event;
      }
    }
  })();
  try {
    await action();
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000));
    return await Promise.race([found, timeout]);
  } finally {
    controller.abort();
  }
}

test("PCN-010 AC1 the cancellation of a root Plan records date, author and reason and the Plan is CANCELLED", {
  timeout: 30_000,
}, async () => {
  const plan = "pcn-ac1";
  await client.engage(plan, "pcn-root");
  const pending = await client.admit(await client.checkUri(plan, "survey"), "pcn-ac1-pending");
  assert.equal(pending.status, "ADMITTED");
  assert.equal((await client.read(plan)).workState, "IN_PROGRESS");

  const before = Date.now();
  let result: PlanCancellationResult | undefined;
  const event = await eventDuring(
    (candidate) => candidate.type === "plan.state" && candidate.plan === plan && candidate.workState === "CANCELLED",
    async () => {
      result = await client.rpc<PlanCancellationResult>("plan.cancel", { plan, reason });
    },
  );
  assert.ok(result);
  assert.equal(result.contract, "trust.plan-cancellation@1");
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.plan, plan);
  assert.equal(result.reason, reason);
  assert.deepEqual(result.cancelledBy, { issuer, subject: "alice" });
  const cancelledAt = Date.parse(result.cancelledAt);
  assert.ok(cancelledAt >= before - 1_000 && cancelledAt <= Date.now() + 1_000, result.cancelledAt);
  assert.deepEqual(result.cancelledPlans, [plan]);
  assert.deepEqual(result.interruptedAttempts, [pending.attemptHandle]);
  assert.ok(event, "a Plan event announces the cancellation");
  assert.equal(event.at, result.cancelledAt);

  const view = await client.read(plan);
  assert.equal(view.workState, "CANCELLED");
  assert.equal(view.checklistComplete, false);
  assert.deepEqual(view.cancellation, {
    rootPlan: plan,
    cancelledAt: result.cancelledAt,
    cancelledBy: { issuer, subject: "alice" },
    reason,
  });
  assert.equal(view.sessionState, "UNAVAILABLE");
  assert.ok(view.sessions.length > 0 && view.sessions.every((session) => session.state !== "open"));
  assert.equal(view.sessions.find((session) => session.closedAt === result!.cancelledAt)?.state, "closed");
  assert.deepEqual(view.actionableChecks, []);

  const check = await client.rpc<CheckView>("check.read", {
    contract: "trust.check-read-request@1",
    checkUri: pending.checkUri,
  });
  assert.equal(check.attempts.find((attempt) => attempt.handle === pending.attemptHandle)?.state, "interrupted");

  const session = await client.rpc<SessionView>("session.read", { plan });
  assert.equal(session.workState, "CANCELLED");
  assert.equal(session.state, "UNAVAILABLE");

  const listed = await client.rpc<{ plans: PlanSummaryView[] }>("plan.list", {});
  const summary = listed.plans.find((candidate) => candidate.plan === plan);
  assert.equal(summary?.workState, "CANCELLED");
  assert.deepEqual(summary?.cancellation, view.cancellation);
});

test("PCN-010 AC2 the current child Plans of a cancelled Plan and their descendants are CANCELLED", {
  timeout: 30_000,
}, async () => {
  const plan = "pcn-ac2";
  const { child, leaf } = await client.composition(plan);
  const unrelated = "pcn-ac2-unrelated";
  const other = await client.composition(unrelated);
  const childAttempt = await client.admit(await client.checkUri(child, "inspection"), "pcn-ac2-child-pending");
  const leafAttempt = await client.admit(await client.checkUri(leaf, "diagnostic"), "pcn-ac2-leaf-pending");
  assert.equal(childAttempt.status, "ADMITTED");
  assert.equal(leafAttempt.status, "ADMITTED");

  const result = await client.rpc<PlanCancellationResult>("plan.cancel", { plan, reason });
  assert.deepEqual(result.cancelledPlans, [plan, child, leaf]);
  assert.deepEqual(
    [...result.interruptedAttempts].sort(),
    [childAttempt.attemptHandle, leafAttempt.attemptHandle].sort(),
  );

  for (const descendant of [child, leaf]) {
    const view = await client.read(descendant);
    assert.equal(view.workState, "CANCELLED", descendant);
    assert.deepEqual(view.cancellation, {
      rootPlan: plan,
      cancelledAt: result.cancelledAt,
      cancelledBy: { issuer, subject: "alice" },
      reason,
    });
    assert.equal(view.sessionState, "UNAVAILABLE");
    assert.deepEqual(view.actionableChecks, []);
  }
  const listed = await client.rpc<{ plans: PlanSummaryView[] }>("plan.list", {});
  for (const descendant of [plan, child, leaf]) {
    assert.equal(listed.plans.find((candidate) => candidate.plan === descendant)?.workState, "CANCELLED");
  }
  for (const untouched of [unrelated, other.child, other.leaf]) {
    const view = await client.read(untouched);
    assert.equal(view.workState, "IN_PROGRESS", untouched);
    assert.equal(view.cancellation, null);
    assert.equal(view.sessionState, "OPEN");
  }
});

test("PCN-010 AC3 a cancelled Plan refuses an Attempt, a declarations replacement, a resume and a relaunch and the refusal names the cancellation", {
  timeout: 30_000,
}, async () => {
  const plan = "pcn-ac3";
  const { child, leaf } = await client.composition(plan);
  const inspection = await client.checkUri(child, "inspection");
  const failed = await client.qualify(inspection, "pcn-ac3-child-dirty", false);
  await client.escalate(inspection, failed.attemptHandle);
  const escalationId = (await client.read(child)).activeEscalation?.escalationId;
  assert.ok(escalationId, "the child Plan is escalated before the cancellation");

  await client.rpc("plan.cancel", { plan, reason });
  const namesCancellation = (text: string | undefined, cancelled: string) => {
    assert.ok(text, "the refusal has a message");
    assert.match(text, new RegExp(`Plan ${cancelled} is CANCELLED`));
    assert.ok(text.includes(reason), text);
    if (cancelled !== plan) assert.ok(text.includes(`with its root Plan ${plan}`), text);
  };

  for (const [target, name] of [
    [plan, "survey"],
    [leaf, "diagnostic"],
  ] as const) {
    const admission = await client.rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: await client.checkUri(target, name),
      attemptKey: `pcn-ac3-after-${target}`,
    });
    assert.equal(admission.status, "REFUSED");
    assert.ok(admission.status === "REFUSED");
    assert.equal(admission.reasonCode, "plan-cancelled");
    namesCancellation(admission.reason, target);
  }

  const replacement = await client.refused("plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan,
    expectedRevision: (await client.read(plan)).revision,
    declarations: {},
    missionDeclarations: {
      work: [
        ...((await client.read(plan)).missionDeclarations?.work ?? []),
        {
          id: "late",
          definition: { kind: "published", reference: "pcn-leaf@1.0.0" },
          rootInputs: { repository: "late-repository" },
        },
      ],
    },
  });
  assert.equal(replacement.data?.reason, "plan-cancelled");
  namesCancellation(replacement.data?.message, plan);

  const resumption = await client.refused("plan.resume", {
    plan: child,
    escalationId,
    resumeReason: "The repository is clean again.",
  });
  assert.equal(resumption.data?.reason, "plan-cancelled");
  namesCancellation(resumption.data?.message, child);

  const relaunch = await client.refused("plan.relaunch", {
    plan: child,
    escalationId,
    relaunchReason: "Start the branch again.",
  });
  assert.equal(relaunch.data?.reason, "plan-cancelled");
  namesCancellation(relaunch.data?.message, child);

  const engagement = await client.refused("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "pcn-root",
    procedureVersion: "1.0.0",
    plan,
    mode: "dry-run",
    environment: "local",
    rootInputs: { repository: `${plan}-repository` },
  });
  assert.equal(engagement.data?.reason, "plan-cancelled");

  const view = await client.read(child);
  assert.equal(view.workState, "CANCELLED");
  assert.equal(view.activeEscalation?.escalationId, escalationId);
  assert.equal(view.parent?.current, true);
});

test("PCN-010 AC4 the cancellation is refused without reason, for a child Plan, for a COMPLETE Plan and for a cancelled Plan", {
  timeout: 30_000,
}, async () => {
  const plan = "pcn-ac4";
  const { child } = await client.composition(plan);

  for (const params of [{ plan }, { plan, reason: "" }, { plan, reason: "   " }]) {
    const refusal = await client.refused("plan.cancel", params);
    assert.equal(refusal.data?.reason, "invalid-plan-cancellation", JSON.stringify(params));
    assert.match(refusal.data?.message ?? "", /requires a non-empty reason/);
  }
  assert.equal((await client.read(plan)).workState, "IN_PROGRESS");

  const childRefusal = await client.refused("plan.cancel", { plan: child, reason });
  assert.equal(childRefusal.data?.reason, "plan-conflict");
  assert.match(childRefusal.data?.message ?? "", new RegExp(`Plan ${child} is a child Plan of ${plan}`));
  assert.equal((await client.read(child)).workState, "IN_PROGRESS");
  assert.equal((await client.read(child)).cancellation, null);

  const complete = "pcn-ac4-complete";
  await client.engage(complete, "pcn-leaf");
  await client.qualify(await client.checkUri(complete, "diagnostic"), "pcn-ac4-complete-clean", true);
  assert.equal((await client.read(complete)).workState, "COMPLETE");
  const completeRefusal = await client.refused("plan.cancel", { plan: complete, reason });
  assert.equal(completeRefusal.data?.reason, "plan-conflict");
  assert.match(completeRefusal.data?.message ?? "", /is COMPLETE and cannot be cancelled/);
  assert.equal((await client.read(complete)).workState, "COMPLETE");
  assert.equal((await client.read(complete)).cancellation, null);

  const first = await client.rpc<PlanCancellationResult>("plan.cancel", { plan, reason });
  const again = await client.refused("plan.cancel", { plan, reason: "A second, different reason." });
  assert.equal(again.data?.reason, "plan-cancelled");
  assert.match(again.data?.message ?? "", new RegExp(`Plan ${plan} is CANCELLED`));
  const view = await client.read(plan);
  assert.deepEqual(view.cancellation, {
    rootPlan: plan,
    cancelledAt: first.cancelledAt,
    cancelledBy: first.cancelledBy,
    reason,
  });
});

test("PCN-010 AC5 the Checks, Attempts, declarations and revisions of a cancelled Plan stay readable", {
  timeout: 30_000,
}, async () => {
  const plan = "pcn-ac5";
  const { child } = await client.composition(plan);
  const survey = await client.checkUri(plan, "survey");
  const validated = await client.qualify(survey, "pcn-ac5-survey-clean", true);
  const inspection = await client.checkUri(child, "inspection");
  const failed = await client.qualify(inspection, "pcn-ac5-child-dirty", false);
  const pending = await client.admit(inspection, "pcn-ac5-child-pending");
  assert.equal(pending.status, "ADMITTED");
  const before = await client.read(plan);
  const childBefore = await client.read(child);

  await client.rpc("plan.cancel", { plan, reason });

  const afterRoot = await client.read(plan);
  assert.equal(afterRoot.workState, "CANCELLED");
  assert.equal(afterRoot.revision, before.revision);
  assert.deepEqual(afterRoot.revisions, before.revisions);
  assert.deepEqual(afterRoot.declarations, before.declarations);
  assert.deepEqual(afterRoot.missionDeclarations, before.missionDeclarations);
  assert.deepEqual(afterRoot.resolvedMissions, before.resolvedMissions);
  assert.deepEqual(
    afterRoot.checks.map(({ checkUri, state, latestVerdict }) => ({ checkUri, state, latestVerdict })),
    before.checks.map(({ checkUri, state, latestVerdict }) => ({ checkUri, state, latestVerdict })),
  );
  assert.equal(afterRoot.checks.find((check) => check.checkUri === survey)?.state, "SATISFIED");
  assert.deepEqual(afterRoot.latestQualification, before.latestQualification);
  assert.deepEqual(afterRoot.invocations, before.invocations);

  const surveyView = await client.rpc<CheckView>("check.read", {
    contract: "trust.check-read-request@1",
    checkUri: survey,
  });
  const surveyAttempt = surveyView.attempts.find((attempt) => attempt.handle === validated.attemptHandle);
  assert.equal(surveyAttempt?.state, "finalized");
  assert.equal(surveyAttempt?.finalization?.verdict, "VALIDATED");
  assert.equal(surveyAttempt?.facts.length, 1);
  assert.equal(surveyView.history.at(-1)?.verdict, "VALIDATED");

  const afterChild = await client.read(child);
  assert.equal(afterChild.workState, "CANCELLED");
  assert.deepEqual(afterChild.revisions, childBefore.revisions);
  const inspectionView = await client.rpc<CheckView>("check.read", {
    contract: "trust.check-read-request@1",
    checkUri: inspection,
  });
  assert.equal(
    inspectionView.attempts.find((attempt) => attempt.handle === failed.attemptHandle)?.finalization?.verdict,
    "NOT_VALIDATED",
  );
  assert.equal(
    inspectionView.attempts.find((attempt) => attempt.handle === pending.attemptHandle)?.state,
    "interrupted",
  );
  assert.equal(inspectionView.history.at(-1)?.verdict, "NOT_VALIDATED");

  const history = await client.rpc<{ snapshots: { plan: string; verdict: string }[] }>("history.list", {
    filter: { plan },
  });
  assert.deepEqual(
    history.snapshots.map((snapshot) => snapshot.verdict),
    ["VALIDATED"],
  );
});
