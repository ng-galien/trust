import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PlanSummaryView } from "@trust/extension-sdk";
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
  runtime = await startPublicRuntime("trust-plan-cancellation-mcp-", {
    operationsDirectory: path.join(runtimePackage, "../../assets/operations"),
  });
  client = cancellationClient(runtime.endpoint);
  await client.publish();
});

afterAll(async () => {
  await runtime?.close();
});

const reason = "The owner abandoned this work; nobody will finish it.";

test("PCN-020 AC1 an MCP tool cancels a Plan with a reason and the MCP Plan read gives its cancellation", {
  timeout: 30_000,
}, async () => {
  const listed = await fetch(`${runtime.endpoint}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} }),
  });
  const tools = (
    (await listed.json()) as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } }
  ).result.tools;
  assert.deepEqual(tools.find((tool) => tool.name === "trust_plan_cancel")?.inputSchema.required, ["plan", "reason"]);

  const plan = "pcn-mcp-ac1";
  const { child } = await client.composition(plan);

  const missing = await client.mcp("trust_plan_cancel", { plan });
  assert.equal(missing.result?.isError, true);
  assert.match(
    missing.result?.content[0]?.text ?? "",
    /TRUST Plan cancellation refused: .*requires a non-empty reason/,
  );
  const childRefusal = await client.mcp("trust_plan_cancel", { plan: child, reason });
  assert.equal(childRefusal.result?.isError, true);
  assert.match(childRefusal.result?.content[0]?.text ?? "", /is a child Plan/);
  assert.match(await client.mcpText("trust_plan_read", { plan }), /State: IN_PROGRESS/);

  const cancelled = await client.mcpText("trust_plan_cancel", { plan, reason });
  assert.match(cancelled, /^PLAN CANCELLATION$/m);
  assert.match(cancelled, /^Result: CANCELLED$/m);
  assert.match(cancelled, new RegExp(`^Plan: ${plan}$`, "m"));
  assert.match(cancelled, new RegExp(`^Reason: ${reason.replace(/[.;]/g, "\\$&")}$`, "m"));
  assert.match(cancelled, new RegExp(`^Cancelled child Plans: .*${child}`, "m"));

  const view = await client.read(plan);
  assert.ok(view.cancellation);
  const text = await client.mcpText("trust_plan_read", { plan });
  assert.match(text, /^State: CANCELLED$/m);
  assert.match(text, /^Session: UNAVAILABLE$/m);
  assert.match(text, /^CANCELLATION$/m);
  assert.match(text, new RegExp(`^Cancelled at: ${view.cancellation.cancelledAt}$`, "m"));
  assert.match(text, /^Cancelled by: unauthenticated local access$/m);
  assert.ok(text.includes(`Reason: ${reason}`), text);
  assert.match(text, /The Plan is CANCELLED\. Do not run a Check/);
  assert.doesNotMatch(text, /ACTIONABLE CHECKS/);

  const childText = await client.mcpText("trust_plan_read", { plan: child });
  assert.match(childText, /^State: CANCELLED$/m);
  assert.match(childText, new RegExp(`^Cancelled with root Plan: ${plan}$`, "m"));

  const again = await client.mcp("trust_plan_cancel", { plan, reason: "Another reason." });
  assert.equal(again.result?.isError, true);
  assert.match(again.result?.content[0]?.text ?? "", new RegExp(`Plan ${plan} is CANCELLED`));
});

test("PCN-020 AC2 the Plan list by MCP and by RPC filters by state, including the cancelled state", {
  timeout: 30_000,
}, async () => {
  const progressing = ["pcn-mcp-ac2-progress-a", "pcn-mcp-ac2-progress-b"];
  for (const plan of progressing) await client.engage(plan, "pcn-leaf");

  const escalated = "pcn-mcp-ac2-escalated";
  await client.engage(escalated, "pcn-leaf");
  const diagnostic = await client.checkUri(escalated, "diagnostic");
  const failed = await client.qualify(diagnostic, "pcn-mcp-ac2-dirty", false);
  await client.escalate(diagnostic, failed.attemptHandle);

  const complete = "pcn-mcp-ac2-complete";
  await client.engage(complete, "pcn-leaf");
  await client.qualify(await client.checkUri(complete, "diagnostic"), "pcn-mcp-ac2-clean", true);

  const cancelled = "pcn-mcp-ac2-cancelled";
  await client.engage(cancelled, "pcn-leaf");
  await client.rpc("plan.cancel", { plan: cancelled, reason });

  const expected = {
    IN_PROGRESS: progressing,
    ESCALATED: [escalated],
    COMPLETE: [complete],
    CANCELLED: [cancelled],
  } as const;
  const ours = (plans: readonly string[]) => plans.filter((plan) => plan.startsWith("pcn-mcp-ac2-")).sort();

  for (const [workState, plans] of Object.entries(expected)) {
    const page = await client.rpc<{ plans: PlanSummaryView[] }>("plan.list", {
      filter: { procedure: "pcn-leaf", workState },
    });
    assert.deepEqual(ours(page.plans.map((plan) => plan.plan)), [...plans].sort(), `RPC ${workState}`);
    assert.ok(page.plans.every((plan) => plan.workState === workState));

    const text = await client.mcpText("trust_plan_list", { procedure: "pcn-leaf", workState });
    assert.match(text, new RegExp(`^Filter: procedure=pcn-leaf, workState=${workState}$`, "m"));
    const listed = [...text.matchAll(/^- (\S+)$/gm)].map((match) => match[1]!);
    assert.deepEqual(ours(listed), [...plans].sort(), `MCP ${workState}`);
    assert.equal([...text.matchAll(new RegExp(`^  State: ${workState};`, "gm"))].length, listed.length);
  }

  const cancelledText = await client.mcpText("trust_plan_list", { workState: "CANCELLED" });
  assert.ok(cancelledText.includes(`Reason: ${reason}`), cancelledText);
  const cancelledPage = await client.rpc<{ plans: PlanSummaryView[] }>("plan.list", {
    filter: { workState: "CANCELLED" },
  });
  assert.equal(cancelledPage.plans.find((plan) => plan.plan === cancelled)?.cancellation?.reason, reason);

  // A derived work state pages through Plans of other states with a cursor bound to the filter.
  const first = await client.rpc<{ plans: PlanSummaryView[]; nextCursor?: string }>("plan.list", {
    filter: { procedure: "pcn-leaf", workState: "IN_PROGRESS" },
    limit: 1,
  });
  assert.equal(first.plans.length, 1);
  assert.ok(first.nextCursor);
  const second = await client.rpc<{ plans: PlanSummaryView[]; nextCursor?: string }>("plan.list", {
    filter: { procedure: "pcn-leaf", workState: "IN_PROGRESS" },
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.plans.length, 1);
  assert.equal(second.nextCursor, undefined);
  assert.deepEqual([first.plans[0]!.plan, second.plans[0]!.plan].sort(), [...progressing].sort());
  const mcpPage = await client.mcpText("trust_plan_list", {
    procedure: "pcn-leaf",
    workState: "IN_PROGRESS",
    limit: 1,
  });
  assert.match(mcpPage, /More Plans exist\. Call trust_plan_list with the same filter and cursor "/);

  const invalid = await client.refused("plan.list", { filter: { workState: "ABANDONED" } });
  assert.equal(invalid.code, -32602);
  const invalidMcp = await client.mcp("trust_plan_list", { workState: "ABANDONED" });
  assert.equal(invalidMcp.error?.code, -32602);
  assert.match(invalidMcp.error?.message ?? "", /IN_PROGRESS, ESCALATED, COMPLETE, CANCELLED/);
});
