import { expect, type Locator, type Page, test } from "@playwright/test";
import { openCorpus, rpc } from "./support/corpus-browser.js";
import { DIAGRAM_THREAD, FRAMEWORK_PLAN } from "./support/corpus-fixture.js";

/* The shared components of the visual language (TRUST-FR-CXP-300): the state pill on every screen, the step track of
   the Checks of a Plan on the card of the current Plan, its tooltip, and their colour roles in both themes. It runs on
   the disposable Corpus runtime of support/corpus-server.mjs. */

const ENTRY = "/extensions/corpus";
const threadUrl = (id: string) => `${ENTRY}/threads/${id}`;
const app = (page: Page) => page.locator(".corpus-app");
const card = (page: Page) => app(page).getByRole("region", { name: "Current Plan", exact: true });
const track = (page: Page) => card(page).getByRole("list", { name: "Checks of the Plan", exact: true });
const pills = (page: Page) => app(page).locator(".corpus-state-pill");

type PillReading = { word: string; role: string; background: string; color: string };
/** Every state pill of the screen: its word, its colour role and its computed colours. */
const readPills = (page: Page): Promise<PillReading[]> =>
  pills(page).evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        word: (element.textContent ?? "").trim(),
        role: element.getAttribute("data-state-role") ?? "",
        background: style.backgroundColor,
        color: style.color,
      };
    }),
  );

/** The computed colours of the host tokens of each role, in the current theme. */
const roleColours = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const read = (background: string, color: string) => {
      probe.style.background = `var(${background})`;
      probe.style.color = `var(${color})`;
      const style = getComputedStyle(probe);
      return { background: style.backgroundColor, color: style.color };
    };
    const roles = {
      accent: read("--color-accent-soft", "--color-accent"),
      success: read("--color-success-soft", "--color-success"),
      warning: read("--color-warning-soft", "--color-warning"),
      danger: read("--color-danger-soft", "--color-danger"),
      waiting: read("--color-surface-3", "--color-text-muted"),
    };
    probe.remove();
    return roles as Record<string, { background: string; color: string }>;
  });

const EXPECTED_ROLES: Record<string, string> = {
  Open: "accent",
  "In progress": "warning",
  Complete: "success",
  Completed: "success",
  Validated: "success",
  Escalated: "warning",
  Paused: "waiting",
  "Waits for you": "warning",
  "Not validated": "danger",
  Stopped: "danger",
  Cancelled: "danger",
  Waiting: "waiting",
};

/** The pills of the thread screen, the Plan follow-up and the entry list. */
async function collectPills(page: Page) {
  const readings: PillReading[] = [];
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  await expect(card(page).locator(".corpus-state-pill").first()).toBeVisible();
  readings.push(...(await readPills(page)));
  await page.goto(`${threadUrl(DIAGRAM_THREAD)}?view=plan`);
  await expect(app(page).getByRole("heading", { level: 1 })).toContainText(FRAMEWORK_PLAN);
  await expect(pills(page).first()).toBeVisible();
  readings.push(...(await readPills(page)));
  await page.goto(ENTRY);
  await expect(app(page).locator("li[data-thread-id]").first()).toBeVisible();
  readings.push(...(await readPills(page)));
  return readings;
}

/** Each pill carries the role of its word, and the colours of that role. */
function expectCoherent(readings: PillReading[], colours: Record<string, { background: string; color: string }>) {
  expect(readings.length).toBeGreaterThan(0);
  const roleOfWord = new Map<string, string>();
  for (const pill of readings) {
    expect(pill.role, `"${pill.word}" has a colour role`).toMatch(/^(accent|success|warning|danger|waiting)$/);
    const expected = EXPECTED_ROLES[pill.word];
    if (expected) expect(pill.role, `"${pill.word}" shows the ${expected} role`).toBe(expected);
    const known = roleOfWord.get(pill.word);
    if (known) expect(pill.role, `"${pill.word}" keeps one role on every screen`).toBe(known);
    roleOfWord.set(pill.word, pill.role);
    expect(pill.background, `"${pill.word}" fills with its role`).toBe(colours[pill.role]?.background);
    expect(pill.color, `"${pill.word}" writes with its role`).toBe(colours[pill.role]?.color);
  }
}

test("CXP-300 AC2 a thread, Plan, mission or Check state shows one pill with the same colour role for the same meaning", async ({
  page,
}) => {
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  // The thread header, the Plan of the card and its missions each show one pill.
  const header = app(page).getByRole("article", { name: "Thread document" });
  await expect(header.locator(".corpus-state-pill", { hasText: /Open|In progress/ }).first()).toBeVisible();
  await expect(card(page).locator(".corpus-state-pill", { hasText: "In progress" }).first()).toBeVisible();
  await card(page)
    .getByRole("button", { name: /missions complete/ })
    .click();
  const missions = card(page).getByRole("list", { name: "Missions of the Plan" }).getByRole("listitem");
  await expect(missions.first()).toBeVisible();
  for (const item of await missions.all()) await expect(item.locator(".corpus-state-pill")).toHaveCount(1);
  // Each pill is a dot and a word.
  const first = pills(page).first();
  await expect(first.locator("span[aria-hidden='true']")).toHaveCount(1);
  expectCoherent(await collectPills(page), await roleColours(page));
});

test("CXP-300 AC3 a step track shows each Check by its name with an icon for its state", async ({ page }) => {
  const plan = await rpc<{ checks: { name: string; state: string }[] }>("plan.read", { plan: FRAMEWORK_PLAN });
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  // The missions of the Plan are a step of their own beside its Checks.
  const steps = track(page).getByRole("listitem");
  await expect(steps).toHaveCount(plan.checks.length + 1);
  const icons: Record<string, string> = { validated: "✓", owner: "!", refused: "✕", current: "", waiting: "" };
  for (const step of await steps.all()) {
    const state = (await step.getAttribute("data-step-state")) ?? "";
    expect(Object.keys(icons)).toContain(state);
    const name = (await step.locator("[class*='stepName']").textContent()) ?? "";
    await expect(step.locator("[class*='icon']").first()).toHaveText(icons[state] ?? "");
    if (name === "missions") continue;
    const check = plan.checks.find((entry) => entry.name === name);
    expect(check, `the step "${name}" is a Check of the Plan`).toBeTruthy();
    expect(state === "validated").toBe(check?.state === "SATISFIED");
  }
  const names = await track(page).locator("[class*='stepName']").allTextContents();
  expect([...names].sort()).toEqual([...plan.checks.map((check) => check.name), "missions"].sort());
  await expect(track(page).locator("[data-step-state='validated']").first()).toBeVisible();
});

test("CXP-300 AC4 hovering or focusing a step shows its name, verdict, date and reason, and Escape closes it", async ({
  page,
}) => {
  await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  const step = track(page).locator("[data-step-state='validated']").first();
  const name = ((await step.locator("[class*='stepName']").textContent()) ?? "").trim();
  const tooltip = page.getByRole("tooltip");
  await step.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(name);
  await expect(tooltip.locator(".corpus-state-pill")).toHaveText("Validated");
  await expect(tooltip.locator("[class*='tipDate']")).toHaveText(/\d/);
  await expect(tooltip.locator("[class*='tipReason']")).not.toBeEmpty();
  await page.mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);
  // The keyboard focus opens the same tooltip, described by the focused step; Escape closes it.
  const node = step.locator("a, [tabindex='0']").first();
  await node.focus();
  await expect(tooltip).toBeVisible();
  await expect(node).toHaveAttribute("aria-describedby", (await tooltip.getAttribute("id")) ?? "");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
});

test("CXP-300 AC5 the components keep the same colour roles in the light theme and in the dark theme", async ({
  page,
}) => {
  const themes: Record<string, Record<string, { background: string; color: string }>> = {};
  for (const theme of ["light", "dark"] as const) {
    await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
    const toggle = page.getByRole("button", { name: `Use ${theme} theme` });
    if (await toggle.isVisible()) await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const colours = await roleColours(page);
    themes[theme] = colours;
    // The pills, the step icons and the ring are drawn with the role colours of the theme.
    expectCoherent(await readPills(page), colours);
    const icons: [Locator, string][] = [
      [track(page).locator("[data-step-state='validated'] [class*='icon']").first(), "success"],
    ];
    for (const [icon, role] of icons)
      expect(await icon.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(colours[role]?.color);
    const ring = card(page).locator("svg circle").nth(1);
    expect(await ring.evaluate((element) => getComputedStyle(element).stroke)).toBe(colours.success?.color);
  }
  // The roles change colour with the theme, so the same component reads the same role in both.
  expect(themes.dark?.success).not.toEqual(themes.light?.success);
});
