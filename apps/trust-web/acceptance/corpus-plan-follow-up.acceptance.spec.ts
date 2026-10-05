import { expect, type Locator, type Page, test } from "@playwright/test";
import { corpusApi, noPageOverflow, openCorpus } from "./support/corpus-browser.js";
import { DECISION_PLAN, DECISION_THREAD, VISUAL_INSTRUCTIONS, VISUAL_MISSION } from "./support/corpus-fixture.js";

/* The Plan follow-up page and the mission page of a thread, on the disposable Corpus runtime of
   support/corpus-server.mjs. */

const threadUrl = (id: string) => `/extensions/corpus/threads/${id}`;
const app = (page: Page) => page.locator(".corpus-app");

type CheckRead = {
  checkUri: string;
  scenario: string;
  scenarioDependencies: string[];
  name: string;
  state: string;
  reason: string | null;
  blockedBy: string[];
  history: { calculatedAt: string; reason: string }[];
};
type EpisodeRead = {
  root: { plan: { metadata: { title?: string } }; checks: CheckRead[] };
  branches: { child: { plan: { workState: string } } | null }[];
};
const episode = async (plan: string) =>
  (await (await fetch(`${corpusApi}/trust/episodes/${plan}`)).json()) as EpisodeRead;
const latest = (check: CheckRead) =>
  check.history.reduce<string | undefined>(
    (found, snapshot) => (found === undefined || snapshot.calculatedAt > found ? snapshot.calculatedAt : found),
    undefined,
  );
/** Scenarios the Checks wait for that no Check runs: the scenario of the missions. */
const missionScenarios = (checks: CheckRead[]) => {
  const own = new Set(checks.map((check) => check.scenario));
  return new Set(checks.flatMap((check) => check.scenarioDependencies.filter((scenario) => !own.has(scenario))));
};
/** What a Check waits for, by name: a blocking Check, "missions", or the Checks of a prerequisite scenario. */
const blockerNames = (check: CheckRead, checks: CheckRead[]) => {
  const missions = missionScenarios(checks);
  const names = check.blockedBy.flatMap((blocker) => {
    const designated = checks.find((candidate) => candidate.checkUri === blocker);
    if (designated) return [designated.name];
    const scenario = /scenario "?([^"\s,]+)"?/.exec(blocker)?.[1];
    if (!scenario) return [blocker];
    if (missions.has(scenario)) return ["missions"];
    const own = checks.filter((candidate) => candidate.scenario === scenario).map((candidate) => candidate.name);
    return own.length > 0 ? own : [scenario];
  });
  return [...new Set(names)];
};
/** The reason a Check row shows: its latest qualification, its own reason, or what it waits for by name. */
const reasonOf = (check: CheckRead, checks: CheckRead[]) =>
  check.history.at(-1)?.reason ??
  check.reason ??
  (check.blockedBy.length > 0 ? `Waits for: ${blockerNames(check, checks).join(", ")}.` : null);
/** The names of the trail steps, the current one last. */
const trailSteps = (page: Page) =>
  app(page).getByRole("navigation", { name: "Trail" }).locator(":scope > ol > li").locator("a, [aria-current='page']");
const top = async (locator: Locator) => (await locator.boundingBox())?.y ?? Number.NaN;

test("CXP-320 AC1 the Plan follow-up lists every Check in order with its icon, name, state, reason and date", async ({
  page,
}) => {
  const read = await episode(DECISION_PLAN);
  const checks = read.root.checks;
  expect(checks.length).toBeGreaterThan(2);
  const errors = await openCorpus(page, `${threadUrl(DECISION_THREAD.id)}?view=plan`, DECISION_THREAD.title);

  const list = app(page).getByRole("region", { name: "Checks, in Procedure order", exact: true });
  const rows = list.locator(":scope ol").first().locator(":scope > li");
  // Every Check, and the missions as their own step.
  await expect(rows).toHaveCount(checks.length + 1);

  // The order: the validated Checks by the time of their qualification, then the others after their prerequisites.
  const names = await rows
    .locator(":scope > details > summary")
    .evaluateAll((summaries) =>
      summaries.map((summary) => summary.querySelector("span + span span")?.textContent ?? ""),
    );
  expect([...names].sort()).toEqual(checks.map((check) => check.name).sort());
  const satisfied = checks
    .filter((check) => check.state === "SATISFIED")
    .sort((a, b) => (latest(a) ?? "").localeCompare(latest(b) ?? "") || a.name.localeCompare(b.name));
  expect(satisfied.length).toBeGreaterThan(0);
  expect(names.slice(0, satisfied.length)).toEqual(satisfied.map((check) => check.name));
  const position = new Map(names.map((name, index) => [name, index]));
  for (const check of checks.filter((candidate) => candidate.state !== "SATISFIED"))
    for (const blocker of check.blockedBy)
      if (position.has(blocker))
        expect(position.get(blocker), `${blocker} before ${check.name}`).toBeLessThan(position.get(check.name) ?? 0);

  // Each row: its icon, its name, its state pill, its reason and the date of its latest qualification.
  for (const check of checks) {
    const summary = rows
      .locator(":scope > details > summary")
      .filter({ has: page.getByText(check.name, { exact: true }) });
    const icon = summary.locator("[data-step-icon]");
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    if (check.state === "SATISFIED") {
      await expect(icon).toHaveAttribute("data-step-icon", "validated");
      await expect(icon).toHaveText("✓");
      await expect(summary.locator(".corpus-state-pill")).toHaveText("Validated");
      await expect(summary.locator(".corpus-state-pill")).toHaveAttribute("data-state-role", "success");
      const time = summary.locator("time");
      await expect(time).toHaveAttribute("datetime", latest(check) ?? "");
      await expect(time).not.toHaveText("");
    } else {
      await expect(icon).not.toHaveAttribute("data-step-icon", "validated");
      await expect(summary.locator(".corpus-state-pill")).not.toHaveText("Validated");
    }
    await expect(summary.locator(".corpus-state-pill")).toHaveCount(1);
    const reason = reasonOf(check, checks);
    if (reason) await expect(summary).toContainText(reason);
    // A waiting Check names what it waits for: never an address or a scenario sentence.
    await expect(summary).not.toContainText("trust://");
    await expect(summary).not.toContainText("has no satisfied");
  }

  // The missions step, before the first Check that waits for the missions scenario, with the missions complete.
  const scenarios = missionScenarios(checks);
  const shown = await rows.evaluateAll((items) =>
    items.map((item) => item.querySelector(":scope > details > summary, :scope > div")?.textContent ?? ""),
  );
  const missionsAt = shown.findIndex((text) => text.startsWith("missions"));
  const firstWaiting = names.findIndex((name) =>
    checks.find((check) => check.name === name)?.scenarioDependencies.some((scenario) => scenarios.has(scenario)),
  );
  expect(firstWaiting).toBeGreaterThanOrEqual(0);
  expect(missionsAt).toBe(firstWaiting);
  const complete = read.branches.filter((branch) => branch.child?.plan.workState === "COMPLETE").length;
  const missionsRow = rows.nth(missionsAt);
  await expect(missionsRow).toContainText(`${complete} of ${read.branches.length} missions complete.`);
  await expect(missionsRow.locator("[data-step-icon]")).toHaveCount(1);
  await expect(missionsRow.locator(".corpus-state-pill")).toHaveCount(1);

  // One list of Checks only: each name is the summary of one row, and the missions sit in their own card.
  for (const check of checks)
    await expect(
      app(page)
        .locator("summary")
        .filter({ has: page.getByText(check.name, { exact: true }) }),
    ).toHaveCount(1);
  const missions = app(page).getByRole("region", { name: "Missions", exact: true });
  await expect(missions.getByRole("link", { name: VISUAL_MISSION, exact: true })).toBeVisible();
  await expect(missions.locator("summary")).toHaveCount(0);

  // The trail: Corpus, the thread with its number, then the Plan follow-up.
  await expect(trailSteps(page)).toHaveText([
    "Corpus",
    new RegExp(`^#\\d+\\s*${DECISION_THREAD.title}$`),
    "Framework Plan",
  ]);

  for (const width of [1280, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await noPageOverflow(page), `at ${width} px`).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("CXP-320 AC2 the mission page shows the mission identifier as title, its scope sentence, its pending decision, then its Checks as a named step track", async ({
  page,
}) => {
  const errors = await openCorpus(page, `${threadUrl(DECISION_THREAD.id)}?view=plan`, DECISION_THREAD.title);
  await app(page)
    .getByRole("region", { name: "Missions", exact: true })
    .getByRole("link", { name: VISUAL_MISSION, exact: true })
    .click();
  await expect(page).toHaveURL(/[?&]view=mission/);

  const title = app(page).getByRole("heading", { name: VISUAL_MISSION, level: 1 });
  await expect(title).toBeVisible({ timeout: 30000 });
  const scope = app(page)
    .getByText(VISUAL_INSTRUCTIONS.split(". ")[0] ?? "", { exact: false })
    .first();
  await expect(scope).toBeVisible();
  await expect(scope).not.toContainText("Read the thread before drawing.");

  const decision = app(page).locator("[data-decision-state]");
  await expect(decision).toHaveCount(1);
  await expect(decision).toHaveAttribute("data-decision-state", "waiting");
  await expect(decision).toContainText(`Validate the screens of ${VISUAL_MISSION}`);
  await expect(decision.getByRole("button", { name: `Validate the screens of ${VISUAL_MISSION}` })).toBeVisible();

  const track = app(page).getByRole("list", { name: "Progress: 1 of 2 Checks validated", exact: true });
  await expect(track).toBeVisible();
  const steps = track.getByRole("listitem");
  await expect(steps).toHaveText([/review checklist\s*Validated/, /observe visual validation/]);
  await expect(steps.nth(0)).toHaveAttribute("data-step-state", "validated");
  // While the decision is pending, the mission and its current step wait for the owner.
  await expect(steps.nth(1)).toHaveAttribute("data-step-state", "owner");
  await expect(steps.nth(1)).toContainText("Waits for your validation");
  const head = app(page)
    .locator("header")
    .filter({ has: page.getByRole("heading", { name: VISUAL_MISSION, level: 1 }) });
  await expect(head.locator(".corpus-state-pill").first()).toHaveText("Waits for you");
  await expect(head.locator(".corpus-state-pill").first()).toHaveAttribute("data-state-role", "warning");
  // Each step opens its Check on the mission page.
  await expect(steps.nth(0).getByRole("link")).toHaveAttribute("href", /check=review\+checklist/);

  // In this order: the title, the scope sentence, the decision, then the step track.
  const order = [await top(title), await top(scope), await top(decision), await top(track)];
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(new Set(order).size).toBe(order.length);

  // The trail: the thread, the Plan follow-up, then the mission; each step returns to its screen.
  await expect(trailSteps(page)).toHaveText([
    "Corpus",
    new RegExp(`^#\\d+\\s*${DECISION_THREAD.title}$`),
    "Framework Plan",
    VISUAL_MISSION,
  ]);
  await trailSteps(page).nth(2).click();
  await expect(page).toHaveURL(/[?&]view=plan$/);
  await expect(app(page).getByRole("region", { name: "Checks, in Procedure order", exact: true })).toBeVisible();
  await trailSteps(page).nth(1).click();
  await expect(app(page).getByRole("article", { name: "Thread document" })).toBeVisible();
  await page.goBack();
  await page.goBack();
  await expect(title).toBeVisible();

  for (const width of [1280, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await noPageOverflow(page), `at ${width} px`).toBe(true);
  }
  expect(errors).toEqual([]);
});
