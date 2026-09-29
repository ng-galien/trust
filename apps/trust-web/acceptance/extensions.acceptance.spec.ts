import { expect, type Page, test } from "@playwright/test";

/** A value the scenario requires: absence fails the test with its reason. */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

async function chooseFacet(page: Page, name: string, value: string) {
  const trigger = page.getByRole("button", { name: "Filters", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const picker = page.getByRole("dialog", { name: "Choose filters", exact: true });
  await picker.getByRole("button", { name, exact: true }).click();
  await picker.getByRole("combobox", { name, exact: true }).fill(value);
  await picker.getByRole("option", { name: value, exact: true }).click();
  await picker.getByRole("button", { name: "Done", exact: true }).click();
}

test("compact and stacked boards preserve keyboard autocomplete, projection and URL state", async ({
  page,
  request,
}) => {
  await request.post("/extensions/coordination/prepare", { data: {} });
  await request.post("/extensions/coordination/start", { data: {} });
  const suggestions: Record<string, unknown>[] = [];
  let failSuggestion = true;
  await page.route("**/extensions/coordination/commands", (route) => {
    if (route.request().postDataJSON()?.command === "missions.suggest" && failSuggestion) {
      failSuggestion = false;
      return route.fulfill({ status: 503, body: "temporarily unavailable" });
    }
    return route.continue();
  });
  page.on("request", (event) => {
    if (event.url().endsWith("/commands") && event.method() === "POST") {
      const data = event.postDataJSON();
      if (data.command === "missions.suggest") suggestions.push(data.arguments);
    }
  });
  await page.goto("/extensions/coordination?coord.project=Later&external=keep");
  const trigger = page.getByRole("button", { name: "Filters", exact: true });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Choose filters", exact: true });
  const input = picker.getByRole("combobox", { name: "Project", exact: true });
  await picker.getByRole("button", { name: "Retry suggestions", exact: true }).click();
  await expect(picker.getByRole("option", { name: "Other", exact: true })).toBeVisible();
  await input.focus();
  await page.keyboard.press("ArrowUp");
  await expect(input).toHaveAttribute("aria-activedescendant", /option-2$/);
  await input.fill("Oth");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", /option-0$/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Remove Project: Other", exact: true })).toBeVisible();
  expect(suggestions.filter((value) => value.field === "project").every((value) => value.project === undefined)).toBe(
    true,
  );
  await input.fill("not-a-real-project");
  await expect(picker.getByText("No values match these filters.")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Remove Project: Other", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(picker).not.toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByRole("button", { name: "Stacked", exact: true }).click();
  await page.getByRole("button", { name: "Collapse Plan unavailable", exact: true }).click();
  await expect(page.locator("#coordination-column-unavailable")).not.toBeVisible();
  await page.getByRole("combobox", { name: "Sort by", exact: true }).selectOption("oldest");
  await page.reload();
  await expect(page.getByRole("button", { name: "Stacked", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Expand Plan unavailable", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(new URL(page.url()).searchParams.get("external")).toBe("keep");
  await page.screenshot({ path: "test-results/coordination-stacked.png", fullPage: true });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.screenshot({ path: "test-results/coordination-compact.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(picker.getByRole("option", { name: "Later", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/coordination-autocomplete-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await request.post("/extensions/coordination/stop", { data: {} });
});

test("built federated workspace preserves mission versus Plan state and safely renders Markdown and Mermaid", async ({
  page,
}) => {
  const loaded: string[] = [];
  page.on("response", (response) => {
    if (response.ok()) loaded.push(response.url());
  });
  await page.goto("/extensions");
  await expect(page.getByRole("heading", { name: "Installed extensions", exact: true })).toBeVisible();
  // Lifecycle transitions are offered in the row menu, each with its visible outcome.
  const actions = page.getByRole("button", { name: "Actions for Agent coordination" });
  await actions.click();
  await page.getByRole("menuitem", { name: /^Prepare storage/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Storage of Agent coordination prepared" })).toBeVisible();
  await actions.click();
  await page.getByRole("menuitem", { name: /^Start/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Agent coordination started" })).toBeVisible();
  await actions.click();
  await page.getByRole("menuitem", { name: "Open workspace" }).click();
  await expect(page.getByRole("heading", { name: "Agent coordination" })).toBeVisible();
  const missionRow = page.locator('[data-mission="federation-acceptance"]');
  await expect(missionRow).not.toContainText("federation-acceptance");
  await missionRow.click();
  const inspector = page.getByRole("article", { name: "federation-acceptance" });
  await expect(inspector.getByText("IN_PROGRESS", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Response submitted", { exact: true })).toBeVisible();
  await expect(
    inspector.locator(".coordination-markdown").getByRole("heading", { name: "Review the change" }),
  ).toBeVisible();
  await inspector.getByText("Technical identifiers", { exact: true }).click();
  await expect(inspector.locator("code", { hasText: "federation-acceptance" })).toBeVisible();
  await expect(inspector.locator("strong", { hasText: "public result" })).toBeVisible();
  const instructions = inspector
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Instructions" }) });
  await expect(instructions).toHaveAttribute("open", "");
  await expect(inspector.locator(".coordination-markdown p").first()).toHaveCSS("white-space", "pre-line");
  await instructions.locator("summary").click();
  await expect(instructions.locator(".coordination-markdown")).not.toBeVisible();
  await instructions.locator("summary").click();
  await expect(inspector.getByRole("link", { name: "Reference" })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(inspector.locator(".coordination-diagram svg")).toBeVisible();
  await expect(inspector.getByText("Diagram unavailable — source", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => "extensionUnsafe" in window)).toBe(false);
  expect(loaded.some((url) => url.includes("/extensions/coordination/assets/remoteEntry.js"))).toBe(true);
  expect(loaded.some((url) => url.includes("/extensions/coordination/trust/plans/interface-acceptance"))).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspector.getByRole("button", { name: "← Missions" })).toBeVisible();
  expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/coordination-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const panel = page.getByRole("dialog");
  const workspaceBounds = present(await page.locator("section.coordination").boundingBox(), "workspace bounds");
  const panelBounds = present(await panel.boundingBox(), "panel bounds");
  expect(panelBounds.y).toBeGreaterThan(0);
  expect(Math.abs(panelBounds.y - workspaceBounds.y)).toBeLessThan(2);
  expect(panelBounds.y + panelBounds.height).toBeLessThanOrEqual(1001);
  const resize = page.getByRole("separator", { name: "Panel width" });
  await resize.focus();
  const widthBefore = present(await panel.boundingBox(), "panel bounds").width;
  await page.keyboard.press("ArrowLeft");
  expect(present(await panel.boundingBox(), "panel bounds").width).toBeGreaterThan(widthBefore);
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(panel).toHaveClass(/is-pinned/);
  const originalPanel = present(await panel.elementHandle(), "panel element");
  const refreshed = page.waitForResponse((response) => {
    const request = response.request();
    return request.url().endsWith("/commands") && request.postDataJSON()?.command === "missions.list";
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await refreshed;
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeFocused();
  await expect(panel).toHaveClass(/is-pinned/);
  expect(await originalPanel.evaluate((element) => element.isConnected)).toBe(true);
  await page.waitForResponse((response) => new URL(response.url()).pathname === "/extensions");
  await expect(panel).toHaveClass(/is-pinned/);
  expect(await originalPanel.evaluate((element) => element.isConnected)).toBe(true);
  await page.getByRole("button", { name: "Unpin", exact: true }).click();
  await page.screenshot({ path: "test-results/coordination-desktop.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(missionRow).toBeFocused();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Extensions", exact: true })
    .click();
  await page.getByRole("button", { name: "Actions for Agent coordination" }).click();
  await page.getByRole("menuitem", { name: /^Stop/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Agent coordination stopped" })).toBeVisible();
  // A stopped extension offers no workspace any more.
  await page.getByRole("button", { name: "Actions for Agent coordination" }).click();
  await expect(page.getByRole("menuitem", { name: "Open workspace" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("compact navigation cancels delayed closure on re-entry and survives mode replacement", async ({ page }) => {
  await page.goto("/overview");
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Expand navigation", exact: true })).toBeVisible();
  const rail = page.getByRole("complementary");
  const procedures = rail.getByRole("navigation").getByRole("link", { name: "Procedures", exact: true });
  const explorer = page.getByRole("region", { name: "Procedures explorer", exact: true });
  await procedures.hover();
  await expect(explorer).toBeVisible();
  await page.mouse.move(1000, 800);
  await procedures.hover();
  // Longer than the 220 ms delayed close: re-entry must cancel it.
  await page.waitForTimeout(300);
  await expect(explorer).toBeVisible();
  await page.mouse.move(1000, 800);
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  await expect(explorer).not.toBeVisible();
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await procedures.hover();
  await page.waitForTimeout(300);
  await expect(explorer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(explorer).not.toBeVisible();
});

test("an unavailable remote has a retry action and recovers from a transient load failure", async ({
  page,
  request,
}) => {
  await request.post("/extensions/coordination/start", { data: {} });
  // The host retries a failed remote twice on its own; a third failure shows the explicit retry action.
  await page.route("**/extensions/coordination/assets/remoteEntry.js*", (route) => route.abort(), { times: 3 });
  await page.goto("/extensions/coordination");
  await expect(page.getByRole("alert")).toContainText("The extension could not be loaded.");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent coordination" })).toBeVisible();
  await request.post("/extensions/coordination/stop", { data: {} });
  await expect(page.getByText("This extension is unavailable. Start it from Extensions.")).toBeVisible({
    timeout: 10000,
  });
});

test("the remote follows the host French language preference", async ({ page, request }) => {
  await request.post("/extensions/coordination/start", { data: {} });
  await page.addInitScript(() =>
    localStorage.setItem("trust.ui.preferences", JSON.stringify({ state: { language: "fr" }, version: 0 })),
  );
  await page.goto("/extensions/coordination");
  await expect(page.getByRole("heading", { name: "Coordination des agents" })).toBeVisible();
  await page.locator('[data-mission="federation-acceptance"]').click();
  await expect(page.getByText("État du Plan TRUST", { exact: true })).toBeVisible();
  await expect(page.getByText("Diagramme indisponible — source", { exact: true })).toBeVisible();
  await request.post("/extensions/coordination/stop", { data: {} });
});

test("built coordination filters all pages and edits tags with revision conflicts", async ({ page, request }) => {
  await request.post("/extensions/coordination/prepare", { data: {} });
  await request.post("/extensions/coordination/start", { data: {} });
  await page.goto("/extensions/coordination");
  await expect(page.getByText("107 missions shown", { exact: false })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Procedure", exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await chooseFacet(page, "Procedure", "git-status");
  await expect(page.getByRole("button", { name: "Remove Procedure: git-status", exact: true })).toBeVisible();
  await expect(page.locator("[data-mission]")).toHaveCount(2);
  await expect(page.locator('[data-mission="later-page"]')).toBeVisible();
  await chooseFacet(page, "Plan label", "interface");
  await expect(page.locator("[data-mission]")).toHaveCount(2);
  await chooseFacet(page, "Project", "Later");
  await expect(page.locator("[data-mission]")).toHaveCount(1);
  await chooseFacet(page, "Assigned to", "later-agent");
  await page.getByLabel("Search", { exact: true }).fill("Later page mission");
  await chooseFacet(page, "Coordination tag", "later");
  await expect(page.locator('[data-mission="later-page"]')).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.locator('[data-mission="later-page"]').click();
  const inspector = page.getByRole("article", { name: "later-page" });
  await expect(inspector.getByText("Plan labels · immutable")).toBeVisible();
  await inspector.getByRole("button", { name: "Edit tags" }).click();
  await inspector.getByRole("button", { name: "Remove later", exact: true }).click();
  await inspector.getByLabel("New tag", { exact: true }).fill("updated");
  await inspector.getByRole("button", { name: "Add", exact: true }).click();
  await inspector.getByRole("button", { name: "Save tags", exact: true }).click();
  await expect(inspector.getByRole("button", { name: "Edit tags" })).toBeVisible();
  await expect(inspector.locator(".coordination-chips span", { hasText: "updated" })).toBeVisible();
  await inspector.getByRole("button", { name: "Edit tags" }).click();
  const concurrent = await request.post("/extensions/coordination/commands", {
    data: { command: "tags.replace", arguments: { mission: "later-page", expectedRevision: 1, tags: ["concurrent"] } },
  });
  expect(concurrent.status()).toBe(200);
  await inspector.getByRole("button", { name: "Save tags", exact: true }).click();
  await expect(inspector.getByRole("alert")).toContainText("Tags changed elsewhere");
  await inspector.getByRole("button", { name: "Reload tags" }).click();
  await expect(inspector.locator(".coordination-chips span", { hasText: "concurrent" })).toBeVisible();
  await inspector.getByRole("button", { name: "Edit tags" }).click();
  await inspector.getByRole("button", { name: "Remove concurrent" }).click();
  await inspector.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(inspector.locator(".coordination-chips span", { hasText: "concurrent" })).toBeVisible();
  await page.keyboard.press("Escape");
  await chooseFacet(page, "Coordination tag", "concurrent");
  await expect(page.locator("[data-mission]")).toHaveCount(1);
  await request.post("/extensions/coordination/stop", { data: {} });
});

test("cards follow real four-Check qualification and never treat a submitted response as Plan completion", async ({
  page,
  request,
}) => {
  const rpc = async (method: string, params: object) => {
    const response = await request.post("http://127.0.0.1:4397/rpc", {
      data: { jsonrpc: "2.0", id: method, method, params },
    });
    const payload = await response.json();
    expect(payload.error).toBeUndefined();
    return payload.result;
  };
  await request.post("/extensions/coordination/prepare", { data: {} });
  await request.post("/extensions/coordination/start", { data: {} });
  await page.goto("/extensions/coordination");
  const card = page.locator('[data-mission="other-0"]');
  await expect(card).toContainText("Plan: Unavailable");
  await expect(
    page.getByRole("navigation", { name: "Plan unavailable", exact: true }).locator('[data-mission="other-0"]'),
  ).toBeVisible();
  const engaged = await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "coordination-checklist",
    procedureVersion: "1.0.0",
    plan: "other-plan",
    environment: "local",
    mode: "dry-run",
    rootInputs: { repository: "trust" },
  });
  const checklist = await rpc("plan.read", { plan: "other-plan" });
  engaged.checkUris = [
    ...checklist.checks.filter((check: { name: string }) => check.name !== "observe completion"),
    checklist.checks.find((check: { name: string }) => check.name === "observe completion"),
  ].map((check) => check.checkUri);
  await request.post("http://127.0.0.1:4397/mcp", {
    data: {
      jsonrpc: "2.0",
      id: "read",
      method: "tools/call",
      params: { name: "trust_plan_read", arguments: { checkUri: engaged.checkUris[0] } },
    },
  });
  const initial = await rpc("plan.read", { plan: "other-plan" });
  expect(initial.currentIntent).toBeTruthy();
  await expect(card).toContainText(`Current intent: ${initial.currentIntent}`);
  await expect(card).toContainText("0/4 Checks satisfied");
  await expect(card).toContainText("Announced next intent: Not yet declared");
  const admission = await rpc("check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey: "coordination-card-first",
    checkUri: engaged.checkUris[0],
    intent: initial.currentIntent,
    nextIntent: "Observe the remaining revision",
  });
  expect(admission.status).toBe("ADMITTED");
  await expect(card).toContainText(`Current intent: ${initial.currentIntent}`);
  await expect(card).toContainText("Announced next intent: Observe the remaining revision");
  await card.screenshot({ path: "test-results/coordination-intent-card.png" });
  const qualify = async (attempt: typeof admission) => {
    const now = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptKey: attempt.attemptKey,
      attemptHandle: attempt.attemptHandle,
      executionId: attempt.executionId,
      checkUri: attempt.checkUri,
      recordedAt: now,
      facts: [
        {
          kind: attempt.operation.operation,
          observedAt: now,
          values: { headRevision: "acceptance-revision", workingTree: "clean" },
        },
      ],
    });
    const result = await rpc("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: attempt.attemptHandle,
    });
    expect(result.verdict).toBe("VALIDATED");
  };
  await qualify(admission);
  await expect(card).toContainText("Current intent: Observe the remaining revision");
  await expect(card).toContainText("Announced next intent: Not yet declared");
  await expect(card).toContainText("1/4 Checks satisfied");
  let continuingIntent = "Observe the remaining revision";
  for (const index of [1, 2]) {
    const nextIntent = index === 1 ? "Qualify the third observation" : "Observe completion";
    const attempt = await rpc("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey: `coordination-card-${index}`,
      checkUri: engaged.checkUris[index],
      intent: continuingIntent,
      nextIntent,
    });
    expect(attempt.status).toBe("ADMITTED");
    await qualify(attempt);
    continuingIntent = nextIntent;
  }
  await expect(card).toContainText("Plan: IN_PROGRESS · 3/4 Checks satisfied");
  const awaitingCoordinator = await rpc("plan.read", { plan: "other-plan" });
  expect(
    awaitingCoordinator.checks
      .filter((check: { state: string }) => check.state === "OPEN")
      .map((check: { name: string }) => check.name),
  ).toEqual(["observe completion"]);
  await expect(card).toContainText("Response submitted");
  await expect(
    page.getByRole("navigation", { name: "In progress", exact: true }).locator('[data-mission="other-0"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Completed", exact: true }).locator('[data-mission="other-0"]'),
  ).toHaveCount(0);
  const final = await rpc("check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey: "coordination-card-final",
    checkUri: engaged.checkUris[3],
    intent: continuingIntent,
  });
  expect(final.status).toBe("ADMITTED");
  await qualify(final);
  await expect(card).toContainText("Plan: COMPLETE · 4/4 Checks satisfied");
  await expect(card.locator("..").getByRole("link", { name: "Open Plan", exact: true })).toHaveAttribute(
    "href",
    "/dry-runs/other-plan",
  );
  await expect(card).toContainText("Current intent: No current intent");
  await expect(card).toContainText("Announced next intent: Plan complete");
  await expect(
    page.getByRole("navigation", { name: "Completed", exact: true }).locator('[data-mission="other-0"]'),
  ).toBeVisible();
  const escalated = await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "intent-chaining",
    procedureVersion: "1.0.0",
    plan: "escalated-plan",
    environment: "local",
    mode: "dry-run",
    rootInputs: { repository: "trust" },
  });
  await request.post("http://127.0.0.1:4397/mcp", {
    data: {
      jsonrpc: "2.0",
      id: "read-escalated",
      method: "tools/call",
      params: { name: "trust_plan_read", arguments: { checkUri: escalated.checkUris[0] } },
    },
  });
  const beforeEscalation = await rpc("plan.read", { plan: "escalated-plan" });
  const blockedAttempt = await rpc("check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey: "coordination-card-blocked",
    checkUri: escalated.checkUris[0],
    intent: beforeEscalation.currentIntent,
    nextIntent: "Observe next Check",
  });
  const now = new Date().toISOString();
  await rpc("check.attempt.facts", {
    contract: "trust.fact-batch-request@1",
    attemptKey: blockedAttempt.attemptKey,
    attemptHandle: blockedAttempt.attemptHandle,
    executionId: blockedAttempt.executionId,
    checkUri: blockedAttempt.checkUri,
    recordedAt: now,
    facts: [
      {
        kind: blockedAttempt.operation.operation,
        observedAt: now,
        values: { headRevision: "acceptance-revision", workingTree: "dirty" },
      },
    ],
  });
  expect(
    (
      await rpc("check.attempt.finalize", {
        contract: "trust.attempt-finalization-request@1",
        attemptHandle: blockedAttempt.attemptHandle,
      })
    ).verdict,
  ).toBe("NOT_VALIDATED");
  await rpc("check.escalate", {
    contract: "trust.check-escalation-request@1",
    checkUri: blockedAttempt.checkUri,
    attemptHandle: blockedAttempt.attemptHandle,
    blockingReason: "The dry-run observation is not clean.",
    forbiddenFurtherAction: "Change external repository state to force acceptance.",
  });
  await expect(
    page.getByRole("navigation", { name: "Blocked", exact: true }).locator('[data-mission="other-1"]'),
  ).toBeVisible();
  await expect(page.locator('[data-mission="other-1"]')).toContainText("Plan: ESCALATED");
  await request.post("/extensions/coordination/stop", { data: {} });
});

test("resource links use host navigation and Back restores filters and the open panel", async ({ page, request }) => {
  await request.post("/extensions/coordination/prepare", { data: {} });
  await request.post("/extensions/coordination/start", { data: {} });
  await page.goto("/extensions/coordination?external=keep");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await chooseFacet(page, "Project", "TRUST");
  await expect(page.locator("[data-mission]")).toHaveCount(1);
  await page.locator('[data-mission="federation-acceptance"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await page.getByRole("separator", { name: "Panel width" }).focus();
  await page.keyboard.press("ArrowLeft");
  const origin = page.url();
  expect(new URL(origin).searchParams.get("external")).toBe("keep");
  expect(new URL(origin).searchParams.get("coord.mission")).toBe("federation-acceptance");
  expect(new URL(origin).searchParams.get("coord.project")).toBe("TRUST");
  expect(new URL(origin).searchParams.get("coord.pinned")).toBe("1");
  expect(new URL(origin).searchParams.get("coord.width")).toBe("672");
  await page.evaluate(() => {
    Object.assign(window, { coordinationNavigationMarker: "same-document" });
  });
  await dialog.getByRole("link", { name: "Open Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plans\/interface-acceptance$/);
  await expect(page.locator("#plan-title")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).coordinationNavigationMarker)).toBe(
    "same-document",
  );
  await page.goBack();
  await expect(page).toHaveURL(origin);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/is-pinned/);
  await expect(page.getByRole("button", { name: "Remove Project: TRUST", exact: true })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Panel width" })).toHaveAttribute("aria-valuenow", "672");
  await dialog.getByRole("link", { name: "Open Procedure", exact: true }).click();
  await expect(page).toHaveURL(/\/procedures\/git-status$/);
  await expect(page.locator("#procedure-title")).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeVisible();
  const href = present(
    await dialog.getByRole("link", { name: "Open Plan", exact: true }).getAttribute("href"),
    "Plan link",
  );
  const tab = await page.context().newPage();
  await tab.goto(new URL(href, page.url()).href);
  await expect(tab.locator("#plan-title")).toBeVisible();
  await tab.close();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  const card = page
    .locator(".coordination-card")
    .filter({ has: page.locator('[data-mission="federation-acceptance"]') });
  await expect(card.getByRole("link", { name: "Open Plan", exact: true })).toHaveAttribute(
    "href",
    "/plans/interface-acceptance",
  );
  await request.post("/extensions/coordination/stop", { data: {} });
});
