import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  corpusApi,
  fault,
  noPageOverflow,
  openCorpus,
  readOnlyCaller,
  rpc,
  runCheck,
} from "./support/corpus-browser.js";
import {
  ARCHIVED_PLANS,
  DECISION_PLAN,
  DECISION_THREAD,
  DIAGRAM_THREAD,
  FRAMEWORK_PLAN,
  INHERITED_MISSIONS,
  MISSION_ASSIGNEE,
  MISSIONS,
  REFRAMED_OLD_PLAN,
  REFRAMED_PLAN,
  REFRAMED_THREAD,
  VISUAL_MISSION,
} from "./support/corpus-fixture.js";

/* The card of the framework Plan at the top of a thread, the Plan history it opens, the owner's decisions it records,
   and the zones of the entry screen at every width. It runs on the disposable Corpus runtime of
   support/corpus-server.mjs. */

const ENTRY = "/extensions/corpus";
const threadUrl = (id: string) => `${ENTRY}/threads/${id}`;
const app = (page: Page) => page.locator(".corpus-app");
const documentOf = (page: Page) => page.getByRole("article", { name: "Thread document" });
const card = (page: Page, name = "Current Plan") => app(page).getByRole("region", { name, exact: true });
const views = (page: Page) => app(page).getByRole("navigation", { name: "Views", exact: true });
const rows = (page: Page) => app(page).locator("li[data-thread-id]");
const historyEntries = (page: Page) => app(page).getByRole("list", { name: "Framework Plans" }).getByRole("listitem");
const historyRead = (thread: string) => (url: string) =>
  new URL(url).pathname === `${ENTRY}/api/threads/${thread}/plans`;

async function command<Result>(name: string, args: unknown): Promise<Result> {
  const response = await fetch(`${corpusApi}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: name, arguments: args }),
  });
  if (!response.ok) throw new Error(`${name}: ${await response.text()}`);
  return (await response.json()) as Result;
}
type PlanRead = {
  revision: number;
  declarations: Record<string, unknown>;
  checks: { name: string; state: string }[];
  invocations: { mission?: { id: string }; childPlan: string }[];
};
const readPlan = (plan: string) => rpc<PlanRead>("plan.read", { plan });
async function declare(plan: string, values: Record<string, unknown>) {
  const current = await readPlan(plan);
  await rpc("plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan,
    expectedRevision: current.revision,
    declarations: { ...current.declarations, ...values },
  });
}
/** Whether two boxes share any area. */
/** Whether two shown elements overlap, both measured in the same frame so that a scroll in progress cannot shift one. */
const overlap = async (a: Locator, b: Locator) => {
  const other = await b.elementHandle();
  return a.evaluate((first, second) => {
    const [x, y] = [first.getBoundingClientRect(), (second as Element).getBoundingClientRect()];
    const shown = x.width > 0 && x.height > 0 && y.width > 0 && y.height > 0;
    return shown && x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
  }, other);
};
/** Waits until the page scroll position holds still over two animation frames. */
const scrollSettled = (page: Page) =>
  page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const before = window.scrollY;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY === before)));
      }),
  );

test("CXP-250 AC1 the card at the top of the thread screen shows the title of the current Plan, its state and its progress, with the identifier as secondary text", async ({
  page,
}) => {
  // The Plan of the decisions carries a metadata title.
  const plan = await readPlan(DECISION_PLAN);
  const validated = plan.checks.filter((check) => check.state === "SATISFIED").length;
  const errors = await openCorpus(page, threadUrl(DECISION_THREAD.id), DECISION_THREAD.title);
  const current = card(page);
  await expect(current).toHaveAttribute("data-card-form", "full");
  const title = current.getByText(DECISION_THREAD.title, { exact: true });
  await expect(title).toBeVisible();
  await expect(current).toContainText("In progress");
  await expect(current).toContainText(`${validated} of ${plan.checks.length} Checks · next: `);
  // The identifier is secondary: in the footer, under the title.
  const footer = current.locator("footer");
  await expect(footer).toContainText(DECISION_PLAN);
  const [titleBox, footerBox] = [await title.boundingBox(), await footer.boundingBox()];
  expect(titleBox && footerBox && titleBox.y < footerBox.y).toBe(true);
  // The card opens the thread screen, above the document.
  const [cardBox, documentBox] = [await current.boundingBox(), await documentOf(page).boundingBox()];
  expect(cardBox && documentBox && cardBox.y + cardBox.height <= documentBox.y).toBe(true);
  expect(errors).toEqual([]);
});

test("CXP-250 AC2 while the document scrolls the card stays on one line with the state, the title, the progress and the decision count", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await openCorpus(page, threadUrl(DECISION_THREAD.id), DECISION_THREAD.title);
  const title = documentOf(page).getByRole("heading", { name: DECISION_THREAD.title, level: 1 });
  await expect(card(page)).toHaveAttribute("data-card-form", "full");
  await documentOf(page).locator(".corpus-markdown > *").last().scrollIntoViewIfNeeded();
  await expect(title).not.toBeInViewport();
  const current = card(page);
  await expect(current).toHaveAttribute("data-card-form", "compact");
  await expect(current).toBeInViewport();
  await expect(current).toContainText("In progress");
  await expect(current).toContainText(DECISION_THREAD.title);
  await expect(current).toContainText(/\d+ of \d+ Checks/);
  await expect(current).toContainText("2 decisions");
  const box = await current.boundingBox();
  expect(box && box.y >= 0 && box.y < 120 && box.height < 64).toBe(true);
  // Back at the top, the card opens again.
  await app(page).getByRole("navigation", { name: "Trail" }).scrollIntoViewIfNeeded();
  await expect(current).toHaveAttribute("data-card-form", "full");
  await expect(current.getByRole("list", { name: "Your decisions" })).toBeVisible();
});

test("CXP-250 AC3 the card shows the Checks of the Plan in Procedure order as named steps with their state", async ({
  page,
}) => {
  const plan = await readPlan(FRAMEWORK_PLAN);
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  const steps = card(page).getByRole("list", { name: "Checks of the Plan" }).getByRole("listitem");
  await expect(steps).toHaveCount(plan.checks.length + 1);
  const names = await steps.evaluateAll((items) =>
    items.map((item) => item.querySelector("a > span:nth-child(2), span > span:nth-child(2)")?.textContent ?? ""),
  );
  expect([...names].sort()).toEqual([...plan.checks.map((check) => check.name), "missions"].sort());
  // Procedure order: a Check comes after the Checks it waits for.
  expect(names.indexOf("check requirements")).toBeGreaterThan(names.indexOf("attach thread"));
  expect(names.indexOf("approve framing")).toBeGreaterThan(names.indexOf("check requirements"));
  for (const check of plan.checks)
    await expect(steps.nth(names.indexOf(check.name))).toHaveAttribute(
      "data-step-state",
      check.state === "SATISFIED" ? "validated" : /current|waiting|owner|refused/,
    );
  // The missions are a step of their own with their count; the first step not validated is the current one.
  const missions = steps.nth(names.indexOf("missions"));
  await expect(missions).toContainText(`1 of ${MISSIONS.length}`);
  await expect(card(page).locator('[data-step-state="current"]')).toHaveCount(1);
});

test("CXP-250 AC4 the card lists the missions as rows with state, identifier, assignee and validated Checks, and a row opens the mission page", async ({
  page,
}) => {
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  await card(page)
    .getByRole("button", { name: /missions complete/ })
    .click();
  const missions = card(page).getByRole("list", { name: "Missions of the Plan" }).getByRole("listitem");
  const running = missions.filter({ has: page.getByRole("link", { name: "mission-running", exact: true }) });
  await expect(running).toContainText("In progress");
  await expect(running).toContainText(`${MISSION_ASSIGNEE} · at: verify work`);
  await expect(running).toContainText("1 of 3 Checks");
  const escalated = missions.filter({ has: page.getByRole("link", { name: "mission-escalated", exact: true }) });
  await expect(escalated).toContainText("Escalated");
  // The whole row opens the mission page.
  const box = await running.boundingBox();
  if (box) await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
  await expect(page).toHaveURL(/view=mission&mission=/);
  await expect(page.getByRole("heading", { name: "mission-running", level: 1 })).toBeVisible();
});

test("CXP-250 AC5 the missions of the card are folded behind their count and open as one whole list", async ({
  page,
}) => {
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  const missions = card(page).getByRole("list", { name: "Missions of the Plan" }).getByRole("listitem");
  const fold = card(page).getByRole("button", { name: /missions complete/ });
  // Folded, the card gives the count only.
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(fold).toContainText(`1 of ${MISSIONS.length} missions complete`);
  await expect(missions).toHaveCount(0);
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(missions).toHaveCount(MISSIONS.length);
  // The complete mission comes after the missions still at work.
  await expect(missions.last()).toContainText("mission-complete");
  await expect(missions.last()).toContainText("Complete");
  await fold.click();
  await expect(missions).toHaveCount(0);
});

test("CXP-250 AC6 the card footer holds the revision, the Plan identifier and the links Plan details, Plan history and Open in TRUST", async ({
  page,
}) => {
  const { framework } = await command<{ framework: { revision: number | null } | null }>("threads.read", {
    id: DIAGRAM_THREAD,
  });
  const plan = await readPlan(FRAMEWORK_PLAN);
  const carried = framework?.revision ?? plan.declarations["approved revision"];
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  const footer = card(page).locator("footer");
  await expect(footer).toContainText(`Carries revision ${carried}`);
  await expect(footer).toContainText(FRAMEWORK_PLAN);
  await expect(footer.getByRole("link")).toHaveText(["Plan details", "Plan history", "Open in TRUST ↗"]);
  await footer.getByRole("link", { name: "Plan details", exact: true }).click();
  await expect(page).toHaveURL(/[?&]view=plan/);
  await expect(app(page).getByRole("heading", { level: 1 })).toContainText(FRAMEWORK_PLAN);
});

test("CXP-250 AC7 a thread with no Plan in progress shows its last Plan on one line with a control that opens the full card", async ({
  page,
}) => {
  // A thread whose framework Plan was linked, then cancelled.
  const id = `cancelled-framework-${Date.now()}`;
  const plan = `${id}-plan`;
  await command("threads.open", { id, title: "Cancelled framework", body: "## Goal\n\nStop the framework." });
  await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "corpus-thread-framework",
    procedureVersion: "0.4.0",
    plan,
    environment: "local",
    rootInputs: { thread: id },
  });
  const { revision } = await command<{ revision: number }>("threads.read", { id });
  await declare(plan, { "target corpus": "trust", "thread revision": revision });
  for (const name of ["attach thread", "link framework"])
    expect((await runCheck(plan, name)).verdict).toBe("VALIDATED");
  await rpc("plan.cancel", { plan, reason: "The framework stops here." });
  await openCorpus(page, threadUrl(id), "Cancelled framework");
  const last = card(page, "Last Plan");
  await expect(last).toHaveAttribute("data-card-form", "last");
  await expect(last).toContainText(plan);
  await expect(last).toContainText("Cancelled");
  await expect(last).toContainText(/2 of \d+/);
  await expect(last.getByRole("link", { name: "Plan history", exact: true })).toBeVisible();
  const box = await last.boundingBox();
  expect(box && box.height < 64).toBe(true);
  const open = last.getByRole("button", { name: "Open the full Plan card" });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await open.click();
  await expect(last).toHaveAttribute("data-card-form", "full");
  await expect(last.getByRole("list", { name: "Checks of the Plan" })).toBeVisible();
  await expect(last.locator("footer")).toContainText(plan);
});

test("CXP-260 AC1 an action of the card opens the Plan history, newest first, with each Plan's state, title, identifier, revision, requirement count and opening date", async ({
  page,
}) => {
  const errors = await openCorpus(page, threadUrl(REFRAMED_THREAD), "Reframed delivery");
  // The Plans as TRUST lists them, to compare the title of the earlier Plan with its row.
  const listed = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return path.endsWith("/plans") && !path.includes("/threads/") && response.ok();
  });
  await card(page).getByRole("link", { name: "Plan history", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${REFRAMED_THREAD}/plans$`));
  await expect(app(page).getByRole("heading", { name: "Plan history", level: 1 })).toBeVisible();
  const entries = historyEntries(page);
  const pill = (index: number) => entries.nth(index).locator(".corpus-state-pill");
  // Newest first: the current Plan, the Plan it replaced, then the archived ones.
  await expect(entries.nth(0).getByRole("link", { name: REFRAMED_PLAN, exact: true })).toBeVisible();
  await expect(pill(0)).toHaveText("Current");
  await expect(entries.nth(1).getByRole("link", { name: REFRAMED_OLD_PLAN, exact: true })).toBeVisible();
  await expect(pill(1)).toHaveText("In progress");
  const body = (await (await listed).json()) as
    | { plan: string; metadata?: { title?: string } }[]
    | { plans: { plan: string; metadata?: { title?: string } }[] };
  const plans = Array.isArray(body) ? body : body.plans;
  const title = plans.find((plan) => plan.plan === REFRAMED_OLD_PLAN)?.metadata?.title ?? "";
  await expect(entries.nth(1).locator("strong")).toHaveText(title);
  // An archived Plan: its state, its identifier, the revision it carries, its requirement count and its opening date.
  const archived = entries.nth(2);
  await expect(
    archived.getByRole("link", { name: `${REFRAMED_THREAD}-archive-${ARCHIVED_PLANS}`, exact: true }),
  ).toBeVisible();
  // The fixture's archived Plans are not Plans of TRUST: their state is unknown.
  await expect(pill(2)).toHaveText("Unknown");
  await expect(archived).toContainText("revision 1 · 1 requirement");
  const opened = new Date(Date.now() - 86400000).toLocaleDateString("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  await expect(archived).toContainText(opened);
  expect(await noPageOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("CXP-260 AC2 the Plan history loads when it is opened, by pages", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (historyRead(REFRAMED_THREAD)(request.url())) reads.push(request.url());
  });
  await openCorpus(page, threadUrl(REFRAMED_THREAD), "Reframed delivery");
  await expect(card(page)).toContainText(REFRAMED_PLAN);
  expect(reads).toHaveLength(0);
  await card(page).getByRole("link", { name: "Plan history", exact: true }).click();
  // The first page holds the twenty most recent Plans, the next page the older ones.
  await expect(historyEntries(page)).toHaveCount(20);
  expect(reads).toHaveLength(1);
  await app(page).getByRole("button", { name: "Show older Plans" }).click();
  await expect(historyEntries(page)).toHaveCount(ARCHIVED_PLANS + 2);
  expect(reads).toHaveLength(2);
  expect(new URL(reads[1] ?? "").searchParams.get("before")).not.toBeNull();
  await expect(historyEntries(page).last()).toContainText(`${REFRAMED_THREAD}-archive-01`);
});

test("CXP-260 AC3 choosing a Plan of the history shows its state and its missions", async ({ page }) => {
  await openCorpus(page, threadUrl(REFRAMED_THREAD), "Reframed delivery");
  await card(page).getByRole("link", { name: "Plan history", exact: true }).click();
  await historyEntries(page).getByRole("link", { name: REFRAMED_OLD_PLAN, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${REFRAMED_THREAD}/plans/${REFRAMED_OLD_PLAN}$`));
  await expect(app(page).getByRole("heading", { name: REFRAMED_OLD_PLAN, level: 1 })).toBeVisible();
  const chosen = card(page, "Plan of the history");
  await expect(chosen).toContainText("In progress");
  const missions = chosen.getByRole("list", { name: "Missions of the Plan" }).getByRole("listitem");
  await expect(missions.filter({ hasText: INHERITED_MISSIONS.complete })).toContainText("Complete");
  await expect(missions.filter({ hasText: INHERITED_MISSIONS.running })).toContainText("In progress");
});

test("CXP-270 AC1 above 1180 pixels the panel of views and corpora is beside the list, and below it is folded and the list keeps the whole width", async ({
  page,
}) => {
  await openCorpus(page, ENTRY, "Corpus");
  const show = app(page).getByRole("button", { name: "Show views and corpora" });
  // With room beside the list, the panel and the rows are side by side, also once the list scrolled.
  for (const width of [1280, 1181]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(views(page)).toBeVisible();
    await expect(show).toBeHidden();
    for (const scroll of [0, 600]) {
      await page.mouse.wheel(0, scroll);
      await scrollSettled(page);
      for (const index of [0, 1, 2, 3])
        expect(await overlap(views(page), rows(page).nth(index)), `${width} px, row ${index}`).toBe(false);
    }
    expect(await noPageOverflow(page)).toBe(true);
  }
  // Without that room the panel is folded behind its button and the rows take the whole width of the list.
  for (const width of [1180, 1000, 800, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(views(page)).toBeHidden();
    await expect(show).toBeVisible();
    await expect(show).toHaveAttribute("aria-expanded", "false");
    // No column is kept for the panel: the rows stand at the same distance from both edges of the screen.
    const workspace = await app(page).boundingBox();
    const first = await rows(page).first().boundingBox();
    if (!workspace || !first) throw new Error(`No row at ${width} px`);
    const left = first.x - workspace.x;
    const right = workspace.x + workspace.width - (first.x + first.width);
    expect(Math.abs(left - right), `${width} px`).toBeLessThanOrEqual(2);
    expect(await noPageOverflow(page)).toBe(true);
  }
});

test("CXP-270 AC2 folded, the panel opens over the list from its button, and the button, a chosen view or corpus, or Escape closes it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openCorpus(page, ENTRY, "Corpus");
  const toggle = app(page).getByRole("button", { name: /^(Show|Hide) views and corpora$/ });
  const open = async () => {
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(views(page)).toBeHidden();
    await toggle.click();
    await expect(views(page)).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveText("Hide views and corpora");
  };
  const closed = async () => {
    await expect(views(page)).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveText("Show views and corpora");
  };
  // Opened, the panel lies over the list: the rows keep their position.
  for (const width of [1000, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const before = await rows(page).first().boundingBox();
    await open();
    expect(await rows(page).first().boundingBox(), `${width} px`).toEqual(before);
    expect(await noPageOverflow(page)).toBe(true);
    // The button closes it.
    await toggle.click();
    await closed();
  }
  await page.setViewportSize({ width: 1000, height: 800 });
  // A chosen view closes it.
  await open();
  await views(page).getByRole("button", { name: "Open threads", exact: true }).click();
  await closed();
  // A chosen corpus closes it.
  await open();
  await views(page).getByRole("link", { name: "TRUST", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/trust`);
  await closed();
  // Escape closes it.
  await open();
  await page.keyboard.press("Escape");
  await closed();
  await expect(rows(page).first()).toBeVisible();
});

const STEP_TRACK = "Checks of the Plan";
const ICON = "a > :first-child, li > span > :first-child";
const CURRENT_STEP = '[data-step-state="current"]';
const STEP_NAME = "a > span:nth-child(2), li > span > span:nth-child(2)";

test("CXP-250 AC8 in a narrow card the step track fits its width and the current step keeps its name", async ({
  page,
}) => {
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  const track = card(page).getByRole("list", { name: STEP_TRACK }).first();
  for (const width of [600, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(track).toBeVisible();
    // The track has no horizontal scroll.
    expect(await track.evaluate((list) => list.scrollWidth <= list.clientWidth), `${width} px`).toBe(true);
    // Every step shows its icon inside the track.
    const box = await track.boundingBox();
    const steps = track.getByRole("listitem");
    expect(await steps.count()).toBeGreaterThan(1);
    for (const step of await steps.all()) {
      const icon = step.locator(ICON).first();
      await expect(icon).toBeVisible();
      const place = await icon.boundingBox();
      expect(box && place && place.x >= box.x - 1 && place.x + place.width <= box.x + box.width + 1).toBe(true);
    }
    // The current step keeps its name.
    const current = track.locator(CURRENT_STEP);
    await expect(current).toHaveCount(1);
    const name = current.locator(STEP_NAME);
    await expect(name).toBeVisible();
    await expect(name).not.toHaveText("");
    // The name is laid out in full, not reduced to the hidden text of a folded step.
    expect(await name.evaluate((text) => text.getBoundingClientRect().width)).toBeGreaterThan(20);
    expect(await noPageOverflow(page)).toBe(true);
  }
});

const approval = (revision: number) => `Approve revision ${revision}`;
const visual = `Validate the screens of ${VISUAL_MISSION}`;

test("CXP-280 AC1 a Plan that waits for the approval of a revision shows the revision and an action that records the approval in the Plan", async ({
  page,
}) => {
  const { revision } = await command<{ revision: number }>("threads.read", { id: DECISION_THREAD.id });
  await openCorpus(page, threadUrl(DECISION_THREAD.id), DECISION_THREAD.title);
  const current = card(page);
  await expect(current).toContainText(DECISION_PLAN);
  await expect(current).toContainText(approval(revision));
  await expect(current.getByRole("button", { name: `Approve revision ${revision}` })).toBeVisible();
});

test("CXP-280 AC2 a mission that waits for the visual validation shows an action that records the validation in the Plan of the mission", async ({
  page,
}) => {
  await openCorpus(page, threadUrl(DECISION_THREAD.id), DECISION_THREAD.title);
  const current = card(page);
  await expect(current).toContainText(visual);
  await expect(current.getByRole("button", { name: `Validate the screens of ${VISUAL_MISSION}` })).toBeVisible();
});

test("CXP-280 AC4 a caller with the read right only sees the expected decisions without their actions", async ({
  page,
}) => {
  const { revision } = await command<{ revision: number }>("threads.read", { id: DECISION_THREAD.id });
  await readOnlyCaller(true);
  try {
    await openCorpus(page, threadUrl(DECISION_THREAD.id), DECISION_THREAD.title);
    const current = card(page);
    await expect(current).toContainText(`Revision ${revision} waits for the owner's approval`);
    await expect(current).toContainText(`The screens of ${VISUAL_MISSION} wait for the owner's visual validation`);
    await expect(current).toContainText("Read-only access: no action.");
    await expect(current.getByRole("list", { name: "Your decisions" }).getByRole("button")).toHaveCount(0);
  } finally {
    await readOnlyCaller(false);
  }
});

test("CXP-280 AC3 the card shows the recorded decision and a refusal of the server", async ({ page }) => {
  const { revision } = await command<{ revision: number }>("threads.read", { id: DECISION_THREAD.id });
  const declarations = `${ENTRY}/trust/plans/${DECISION_PLAN}/declarations`;
  await openCorpus(page, threadUrl(DECISION_THREAD.id), DECISION_THREAD.title);
  const current = card(page);
  const approve = current.getByRole("button", { name: `Approve revision ${revision}` });
  // A refusal of the server is shown and the decision stays to take.
  await fault(declarations, true);
  try {
    await approve.click();
    await expect(current.getByRole("alert")).toContainText("The decision was not recorded");
  } finally {
    await fault(declarations, false);
  }
  // The refusal offers to try the decision again.
  await current.getByRole("button", { name: "Try again" }).click();
  await expect(current.getByRole("status").filter({ hasText: `Approval of revision ${revision}` })).toContainText(
    `Approval of revision ${revision} recordedThe Check “approve revision” waits to be run.`,
  );
  const framework = await readPlan(DECISION_PLAN);
  expect(framework.declarations).toMatchObject({ "approval choice": "continue", "approved revision": revision });
  // The visual validation is recorded in the Plan of the mission.
  await current.getByRole("button", { name: `Validate the screens of ${VISUAL_MISSION}` }).click();
  await expect(current.getByRole("status").filter({ hasText: "Visual validation" })).toContainText(
    `Visual validation of ${VISUAL_MISSION} recorded`,
  );
  await expect(current.getByRole("status").filter({ hasText: "Visual validation" })).toContainText(
    "The Check “observe visual validation” waits to be run.",
  );
  const child = framework.invocations.find((invocation) => invocation.mission?.id === VISUAL_MISSION)?.childPlan ?? "";
  expect((await readPlan(child)).declarations).toMatchObject({ "visual validation": "approved" });
});

test("CXP-280 AC5 a pending decision is the first element of the card under its title line", async ({ page }) => {
  await openCorpus(page, threadUrl(DECISION_THREAD.id), DECISION_THREAD.title);
  const current = card(page);
  const decisions = current.getByRole("list", { name: "Your decisions" });
  await expect(decisions).toBeVisible();
  await current.getByRole("button", { name: /missions? complete/ }).click();
  // Under the title line, before the steps and the missions.
  const order = await current.evaluate((section) =>
    [...section.children].map((child) =>
      child.matches('[aria-label="Your decisions"]')
        ? "decisions"
        : child.matches('[aria-label="Checks of the Plan"]')
          ? "steps"
          : child.querySelector('[aria-label="Missions of the Plan"]')
            ? "missions"
            : child.tagName === "FOOTER"
              ? "footer"
              : "head",
    ),
  );
  expect(order.slice(order.indexOf("decisions"))).toEqual(["decisions", "steps", "missions", "footer"]);
  expect(order.slice(0, order.indexOf("decisions")).every((part) => part === "head")).toBe(true);
  const [title, first] = [
    await current.getByText(DECISION_THREAD.title, { exact: true }).boundingBox(),
    await decisions.locator("li").first().boundingBox(),
  ];
  expect(title && first && title.y + title.height <= first.y).toBe(true);
  // The approval of the revision leads, waiting or already recorded by an earlier decision.
  await expect(decisions.locator("li").first()).toContainText(/Approve revision|Approval of revision/);
});
