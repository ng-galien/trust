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
const overlap = (a: Locator, b: Locator) =>
  Promise.all([a.boundingBox(), b.boundingBox()]).then(
    ([x, y]) =>
      !!x && !!y && x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height,
  );

test("CXP-250 AC1 the thread screen shows at its top a card of the current Plan with its identifier, the revision it carries, its state and the progress of its Checks", async ({
  page,
}) => {
  const { revision } = await command<{ revision: number }>("threads.read", { id: DIAGRAM_THREAD });
  const plan = await readPlan(FRAMEWORK_PLAN);
  const validated = plan.checks.filter((check) => check.state === "SATISFIED").length;
  const errors = await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  const current = card(page);
  await expect(current).toContainText(FRAMEWORK_PLAN);
  await expect(current).toContainText(`Carries revision ${revision}`);
  await expect(current).toContainText("In progress");
  await expect(current).toContainText(`${validated} of ${plan.checks.length} Checks validated`);
  // The card opens the thread screen, above the document.
  const [cardBox, documentBox] = [await current.boundingBox(), await documentOf(page).boundingBox()];
  expect(cardBox && documentBox && cardBox.y + cardBox.height <= documentBox.y).toBe(true);
  expect(errors).toEqual([]);
});

test("CXP-250 AC2 the card of the current Plan stays visible while the document scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  const title = documentOf(page).getByRole("heading", { name: "Document diagrams", level: 1 });
  await expect(card(page)).toBeInViewport();
  await documentOf(page).locator(".corpus-markdown > *").last().scrollIntoViewIfNeeded();
  await expect(title).not.toBeInViewport();
  await expect(card(page)).toBeInViewport();
  const box = await card(page).boundingBox();
  expect(box && box.y >= 0 && box.y < 120).toBe(true);
});

test("CXP-250 AC3 the card shows the missions of the Plan with their state and leads to the detailed follow-up", async ({
  page,
}) => {
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  const missions = card(page).getByRole("list", { name: "Missions of the Plan" }).getByRole("listitem");
  await expect(missions).toHaveCount(MISSIONS.length);
  const complete = missions.filter({ has: page.getByRole("link", { name: "mission-complete", exact: true }) });
  await expect(complete).toContainText("Complete");
  const escalated = missions.filter({ has: page.getByRole("link", { name: "mission-escalated", exact: true }) });
  await expect(escalated).toContainText("Escalated");
  const running = missions.filter({ has: page.getByRole("link", { name: "mission-running", exact: true }) });
  await expect(running).toContainText("In progress");
  // A mission leads to its follow-up page, the card to the detailed follow-up of the Plan.
  await complete.getByRole("link", { name: "mission-complete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "mission-complete", level: 1 })).toBeVisible();
  await page.goBack();
  await card(page).getByRole("link", { name: "Plan details", exact: true }).click();
  await expect(page).toHaveURL(/[?&]view=plan/);
  await expect(app(page).getByRole("heading", { level: 1 })).toContainText(FRAMEWORK_PLAN);
});

test("CXP-250 AC4 a thread with no Plan in progress shows its last Plan and its state in the card", async ({
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
  await expect(last).toContainText(plan);
  await expect(last).toContainText("Cancelled");
});

test("CXP-260 AC1 an action of the card opens the Plan history, newest first, with each Plan, the revision it carries, its requirements and its opening date", async ({
  page,
}) => {
  const errors = await openCorpus(page, threadUrl(REFRAMED_THREAD), "Reframed delivery");
  await card(page).getByRole("link", { name: "Plan history", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${REFRAMED_THREAD}/plans$`));
  await expect(app(page).getByRole("heading", { name: "Plan history", level: 1 })).toBeVisible();
  const entries = historyEntries(page);
  await expect(entries.nth(0)).toContainText(REFRAMED_PLAN);
  await expect(entries.nth(0)).toContainText("Current");
  await expect(entries.nth(1)).toContainText(REFRAMED_OLD_PLAN);
  // An archived Plan carries its revision, its requirements and its opening date.
  const archived = entries.nth(2);
  await expect(archived).toContainText(`${REFRAMED_THREAD}-archive-${ARCHIVED_PLANS}`);
  await expect(archived).toContainText(/Revision\s*1/);
  await expect(archived).toContainText("TRUST-FR-ARC-010");
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

test("CXP-270 AC1 the panel of views and corpora and the thread list each keep their zone at every width", async ({
  page,
}) => {
  await openCorpus(page, ENTRY, "Corpus");
  for (const width of [1280, 1000, 800, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const show = app(page).getByRole("button", { name: "Show views and corpora" });
    if (width < 900 && (await show.isVisible())) await show.click();
    await expect(views(page)).toBeVisible();
    await expect(rows(page).first()).toBeVisible();
    // Side by side or one under the other, also once the list scrolled under the panel's place.
    for (const scroll of [0, 600]) {
      await page.mouse.wheel(0, scroll);
      for (const index of [0, 1, 2, 3])
        expect(await overlap(views(page), rows(page).nth(index)), `${width} px, row ${index}`).toBe(false);
    }
    expect(await noPageOverflow(page)).toBe(true);
  }
});

test("CXP-270 AC2 below 900 pixels the panel of views and corpora folds behind a button that opens and closes it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await openCorpus(page, ENTRY, "Corpus");
  const show = app(page).getByRole("button", { name: "Show views and corpora" });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect(views(page)).toBeHidden();
  await show.click();
  await expect(views(page)).toBeVisible();
  const hide = app(page).getByRole("button", { name: "Hide views and corpora" });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await hide.click();
  await expect(views(page)).toBeHidden();
  await expect(rows(page).first()).toBeVisible();
});

const approval = (revision: number) => `Revision ${revision} waits for your approval.`;
const visual = `The screens of ${VISUAL_MISSION} wait for your visual validation.`;

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
    await expect(current).toContainText(approval(revision));
    await expect(current).toContainText(visual);
    await expect(current.getByRole("button")).toHaveCount(0);
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
    "recorded in the Plan. The Check “approve revision” waits to be run.",
  );
  const framework = await readPlan(DECISION_PLAN);
  expect(framework.declarations).toMatchObject({ "approval choice": "continue", "approved revision": revision });
  // The visual validation is recorded in the Plan of the mission.
  await current.getByRole("button", { name: `Validate the screens of ${VISUAL_MISSION}` }).click();
  await expect(current.getByRole("status").filter({ hasText: "Visual validation" })).toContainText(
    `Visual validation of ${VISUAL_MISSION} recorded in its Plan.`,
  );
  const child = framework.invocations.find((invocation) => invocation.mission?.id === VISUAL_MISSION)?.childPlan ?? "";
  expect((await readPlan(child)).declarations).toMatchObject({ "visual validation": "approved" });
});
