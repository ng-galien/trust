import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CheckAttemptAdmissionResult } from "@trust/extension-sdk";
import { afterAll, beforeAll } from "vitest";
import { test } from "./support/fixtures.js";

// The file runs compiled from dist/acceptance or directly as TypeScript from acceptance; both use the built runtime.
const here = path.dirname(fileURLToPath(import.meta.url));
const runtimePackage = path.resolve(here, here.endsWith(`${path.sep}dist${path.sep}acceptance`) ? "../.." : "..");
const { startPublicRuntime } = (await import(
  pathToFileURL(path.join(runtimePackage, "dist/acceptance/support/runtime-process.js")).href
)) as typeof import("./support/runtime-process.js");
const { cancellationClient } = (await import(
  pathToFileURL(path.join(runtimePackage, "dist/acceptance/support/plan-cancellation.js")).href
)) as typeof import("./support/plan-cancellation.js");

let runtime: Awaited<ReturnType<typeof startPublicRuntime>>;
let client: ReturnType<typeof cancellationClient>;

beforeAll(async () => {
  runtime = await startPublicRuntime("trust-mission-stop-", {
    operationsDirectory: path.join(runtimePackage, "../../assets/operations"),
  });
  client = cancellationClient(runtime.endpoint);
  await client.publish();
});

afterAll(async () => {
  await runtime?.close();
});

const reason = "The owner dropped this requirement; the mission is no longer wanted.";
const mission = (plan: string, id: string) => ({
  id,
  definition: { kind: "published", reference: "pcn-branch@1.0.0" },
  rootInputs: { repository: `${plan}-${id}-repository` },
});
/** The declaration replacement that keeps the given missions in "work", with an optional reason for the others. */
const replacement = async (plan: string, kept: readonly string[], missionRemovalReason?: unknown) => ({
  contract: "trust.plan-declaration-replacement-request@1",
  plan,
  expectedRevision: (await client.read(plan)).revision,
  declarations: {},
  missionDeclarations: { work: kept.map((id) => mission(plan, id)) },
  ...(missionRemovalReason === undefined ? {} : { missionRemovalReason }),
});
/** A root Plan whose "work" collection holds the given missions; each has a child Plan and a leaf below it. */
async function coordinated(plan: string, ids: readonly string[]) {
  await client.engage(plan, "pcn-root");
  await client.rpc("plan.declarations.replace", await replacement(plan, ids));
  const view = await client.read(plan);
  const children = new Map<string, { child: string; leaf: string }>();
  for (const id of ids) {
    const child = view.invocations.find((invocation) => invocation.mission?.id === id)?.childPlan;
    assert.ok(child, `mission ${id} has a child Plan`);
    const leaf = (await client.read(child)).invocations.find((invocation) => invocation.name === "leaf")?.childPlan;
    assert.ok(leaf, `mission ${id} has a leaf Plan`);
    children.set(id, { child, leaf });
  }
  return (id: string) => {
    const plans = children.get(id);
    assert.ok(plans, `mission ${id} was declared`);
    return plans;
  };
}
/** Run the mission to the end: its own Check and the Check of its leaf are VALIDATED. */
async function complete(plans: { child: string; leaf: string }, key: string) {
  await client.qualify(await client.checkUri(plans.child, "inspection"), `${key}-inspection`, true);
  await client.qualify(await client.checkUri(plans.leaf, "diagnostic"), `${key}-diagnostic`, true);
  assert.equal((await client.read(plans.child)).workState, "COMPLETE");
}
const attemptState = async (checkUri: string) =>
  (
    await client.rpc<{ attempts: readonly { state: string }[] }>("check.read", {
      contract: "trust.check-read-request@1",
      checkUri,
    })
  ).attempts[0]?.state;
const workIds = async (plan: string) => (await client.read(plan)).missionDeclarations?.work?.map((value) => value.id);

test("R3.AC1 a started mission is stopped with a reason, with a running Attempt or a NOT_VALIDATED verdict, and the parent no longer requires it", {
  timeout: 60_000,
}, async () => {
  const plan = "mission-stop-ac1";
  const of = await coordinated(plan, ["kept", "running", "failed"]);
  await client.qualify(await client.checkUri(plan, "survey"), "ac1-survey", true);
  await complete(of("kept"), "ac1-kept");
  // One mission runs: an Attempt of its child Plan and one of its descendant are pending and not expired.
  const runningInspection = await client.checkUri(of("running").child, "inspection");
  const runningDiagnostic = await client.checkUri(of("running").leaf, "diagnostic");
  for (const [uri, key] of [
    [runningInspection, "ac1-running-inspection"],
    [runningDiagnostic, "ac1-running-diagnostic"],
  ] as const) {
    const admitted = await client.admit(uri, key);
    assert.equal(admitted.status, "ADMITTED", JSON.stringify(admitted));
    assert.equal(await attemptState(uri), "pending");
  }
  // One mission gave a NOT_VALIDATED verdict.
  await client.qualify(await client.checkUri(of("failed").child, "inspection"), "ac1-failed-inspection", false);
  const before = await client.read(plan);
  assert.equal(before.workState, "IN_PROGRESS", "the parent still requires its three missions");

  await client.rpc("plan.declarations.replace", await replacement(plan, ["kept"], reason));

  const after = await client.read(plan);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(await workIds(plan), ["kept"]);
  assert.deepEqual(
    after.invocations.map((invocation) => invocation.mission?.id),
    ["kept"],
    "the parent composition no longer counts the stopped missions",
  );
  assert.equal(after.workState, "COMPLETE", "the parent completes with the mission it still requires");
  // The stopped child Plans and their descendants are CANCELLED with the reason, as for a cancelled root Plan.
  for (const id of ["running", "failed"]) {
    const { child, leaf } = of(id);
    for (const stopped of [child, leaf]) {
      const view = await client.read(stopped);
      assert.equal(view.workState, "CANCELLED", `${id}: ${stopped}`);
      assert.equal(view.cancellation?.reason, reason);
      assert.equal(view.cancellation?.rootPlan, child, "the cancellation names the stopped child Plan as its origin");
      assert.equal(view.sessionState, "UNAVAILABLE");
    }
    assert.equal((await client.read(child)).parent?.current, false);
  }
  // The running Attempts were interrupted by the stop.
  assert.equal(await attemptState(runningInspection), "interrupted");
  assert.equal(await attemptState(runningDiagnostic), "interrupted");
  // A stopped Plan admits no Attempt any more; the refusal names the reason.
  const refused: CheckAttemptAdmissionResult = await client.admit(runningInspection, "ac1-after-stop");
  assert.notEqual(refused.status, "ADMITTED");
  assert.ok(JSON.stringify(refused).includes(reason), JSON.stringify(refused));
  // The mission that was kept is untouched.
  const kept = await client.read(of("kept").child);
  assert.deepEqual([kept.workState, kept.cancellation, kept.parent?.current], ["COMPLETE", null, true]);
});

test("R3.AC2 the stop is refused without a reason and the Plan history keeps the mission and the reason", {
  timeout: 60_000,
}, async () => {
  const plan = "mission-stop-ac2";
  const of = await coordinated(plan, ["kept", "failed", "running"]);
  await client.qualify(await client.checkUri(of("failed").child, "inspection"), "ac2-failed-inspection", false);
  const runningInspection = await client.checkUri(of("running").child, "inspection");
  assert.equal((await client.admit(runningInspection, "ac2-running-inspection")).status, "ADMITTED");
  const accepted = await client.read(plan);

  // Without a reason the removal of a started mission is refused, as before.
  const noReasonVerdict = await client.refused(
    "plan.declarations.replace",
    await replacement(plan, ["kept", "running"]),
  );
  assert.match(
    JSON.stringify(noReasonVerdict),
    /Accepted mission \\"failed\\" cannot be removed: an Attempt of its child Plan gave a verdict/,
  );
  const noReasonRunning = await client.refused(
    "plan.declarations.replace",
    await replacement(plan, ["kept", "failed"]),
  );
  assert.match(
    JSON.stringify(noReasonRunning),
    /Accepted mission \\"running\\" cannot be removed: an Attempt of its child Plan is running and not expired/,
  );
  // A blank reason, a padded one and a reason that is not text are refused too.
  for (const blank of ["", "   ", " padded "]) {
    const refusal = await client.refused("plan.declarations.replace", await replacement(plan, ["kept"], blank));
    assert.match(JSON.stringify(refusal), /Stopping a mission requires a non-empty missionRemovalReason/);
  }
  await client.refused("plan.declarations.replace", await replacement(plan, ["kept"], 42));
  const unchanged = await client.read(plan);
  assert.equal(unchanged.revision, accepted.revision, "no refusal created a revision");
  assert.deepEqual(unchanged.stoppedMissions, []);
  for (const id of ["failed", "running"]) {
    const child = await client.read(of(id).child);
    assert.deepEqual([child.workState === "CANCELLED", child.cancellation], [false, null], id);
  }
  assert.equal(await attemptState(runningInspection), "pending", "a refused stop interrupts nothing");

  // With a reason the mission is stopped, through RPC for one and through the MCP tool for the other.
  await client.rpc("plan.declarations.replace", await replacement(plan, ["kept", "running"], reason));
  const mcpReason = "The owner replaced this mission by another one.";
  const { contract: _contract, ...mcpArguments } = await replacement(plan, ["kept"], mcpReason);
  await client.mcpText("trust_plan_declarations_replace", mcpArguments);

  const current = await client.read(plan);
  // The revision history keeps the stopped missions.
  assert.deepEqual(
    current.revisions
      .find((revision) => revision.revision === accepted.revision)
      ?.missionDeclarations?.work?.map((value) => value.id),
    ["kept", "failed", "running"],
  );
  assert.deepEqual(
    current.revisions
      .find((revision) => revision.revision === current.revision)
      ?.missionDeclarations?.work?.map((value) => value.id),
    ["kept"],
  );
  // The Plan read names each stopped mission with its reason and the child Plan the stop cancelled.
  assert.deepEqual(
    current.stoppedMissions?.map(({ stoppedAt, ...stopped }) => {
      assert.equal(Number.isNaN(Date.parse(stoppedAt)), false);
      return stopped;
    }),
    [
      { collection: "work", mission: "failed", childPlan: of("failed").child, stoppedBy: null, reason },
      { collection: "work", mission: "running", childPlan: of("running").child, stoppedBy: null, reason: mcpReason },
    ],
  );
  // The stopped child Plan stays readable with its reason, its Checks and its Attempts.
  const failed = await client.read(of("failed").child);
  assert.deepEqual(
    [failed.workState, failed.cancellation?.reason, failed.parent?.plan, failed.parent?.current],
    ["CANCELLED", reason, plan, false],
  );
  assert.equal(failed.checks.find((check) => check.name === "inspection")?.state, "OPEN");
  assert.equal(await attemptState(await client.checkUri(of("failed").child, "inspection")), "finalized");
  assert.equal(await attemptState(runningInspection), "interrupted");
  // The MCP Plan read gives the same history.
  const text = await client.mcpText("trust_plan_read", { plan });
  assert.match(text, /STOPPED MISSIONS/);
  assert.ok(text.includes(`- work/failed: stopped at`), text);
  assert.ok(text.includes(`Reason: ${reason}`), text);
  assert.ok(text.includes(`Reason: ${mcpReason}`), text);
  // A later revision of the parent does not lose it.
  await client.rpc("plan.declarations.replace", await replacement(plan, ["kept", "later"]));
  assert.deepEqual(
    (await client.read(plan)).stoppedMissions?.map((stopped) => [stopped.mission, stopped.reason]),
    [
      ["failed", reason],
      ["running", mcpReason],
    ],
  );
});

test("R3.AC3 a completed mission cannot be stopped", { timeout: 60_000 }, async () => {
  const plan = "mission-stop-ac3";
  const of = await coordinated(plan, ["kept", "done", "failed"]);
  await complete(of("done"), "ac3-done");
  await client.qualify(await client.checkUri(of("failed").child, "inspection"), "ac3-failed-inspection", false);
  const before = await client.read(plan);

  const refusal = await client.refused(
    "plan.declarations.replace",
    await replacement(plan, ["kept", "failed"], reason),
  );
  assert.ok(
    JSON.stringify(refusal).includes(
      `Accepted mission \\"done\\" cannot be stopped: its child Plan ${of("done").child} is COMPLETE. No changes accepted.`,
    ),
    JSON.stringify(refusal),
  );
  // The refusal is atomic: a started mission submitted for a stop with the completed one is not stopped either.
  const batch = await client.refused("plan.declarations.replace", await replacement(plan, ["kept"], reason));
  assert.match(JSON.stringify(batch), /Accepted mission \\"done\\" cannot be stopped/);

  const after = await client.read(plan);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(await workIds(plan), ["kept", "done", "failed"]);
  assert.deepEqual(after.stoppedMissions, []);
  const done = await client.read(of("done").child);
  assert.deepEqual([done.workState, done.cancellation, done.parent?.current], ["COMPLETE", null, true]);
  const leaf = await client.read(of("done").leaf);
  assert.deepEqual([leaf.workState, leaf.cancellation], ["COMPLETE", null]);
  const failed = await client.read(of("failed").child);
  assert.deepEqual([failed.workState === "CANCELLED", failed.cancellation], [false, null]);
});

test("R3 P3 a mission that never ran is removed without a reason as before", { timeout: 60_000 }, async () => {
  const plan = "mission-stop-never-ran";
  const of = await coordinated(plan, ["kept", "idle"]);
  await client.rpc("plan.declarations.replace", await replacement(plan, ["kept"]));
  const after = await client.read(plan);
  assert.deepEqual(await workIds(plan), ["kept"]);
  assert.deepEqual(after.stoppedMissions, [], "a removal without a reason is not a stop");
  // The Plan of the removed mission does not stay in progress: TRUST closes it, without listing it as a stop.
  const idle = await client.read(of("idle").child);
  assert.equal(idle.parent?.current, false);
  assert.equal(idle.workState, "CANCELLED");
  assert.match(idle.cancellation?.reason ?? "", /^No longer the current generation of its mission/u);
});
