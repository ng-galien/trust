import { expect, type Locator, type Page, test } from "@playwright/test";
import { missionCards, noPageOverflow, openCorpus } from "./support/corpus-browser.js";
import {
  CROWD,
  DECISION_THREAD,
  DIAGRAM_THREAD,
  ENTRY_CORPUS,
  ENTRY_THREADS,
  FRAMEWORK_PLAN,
  MISSIONS,
  READING_THREADS,
} from "./support/corpus-fixture.js";

/* The reading screens of Corpus: a thread or a facet beside its side panel (neighbourhood, links, Plan and
   references), and the single trail of the screens followed. It runs on the disposable Corpus runtime of
   support/corpus-server.mjs. */

const ENTRY = "/extensions/corpus";
const { topology } = ENTRY_THREADS;
const { notation, examples, crowded } = READING_THREADS;
const threadUrl = (id: string) => `${ENTRY}/threads/${id}`;

const app = (page: Page) => page.locator(".corpus-app");
const threadPanel = (page: Page) => page.getByRole("complementary", { name: "Thread summary" });
const facetPanel = (page: Page) => page.getByRole("complementary", { name: "Facet summary" });
const documentOf = (page: Page) => page.getByRole("article", { name: "Thread document" });
const neighbourhood = (panel: Locator) => panel.getByRole("region", { name: "Neighbourhood", exact: true });
const neighbour = (panel: Locator, name: string) => panel.getByRole("link", { name, exact: true });
const group = (panel: Locator, name: string) => neighbourhood(panel).getByRole("region", { name, exact: true });
/** Chooses the neighbour of that accessible name, opening the folded groups of the shown screen until it shows. */
async function choose(panel: Locator, name: string) {
  const link = neighbour(panel, name);
  const more = neighbourhood(panel).getByRole("button", { name: /^Show \d+ more$/ });
  await expect(async () => {
    if (!(await link.isVisible()) && (await more.count()) > 0) await more.first().click({ timeout: 1000 });
    await link.click({ timeout: 1000 });
  }).toPass({ timeout: 30000 });
}
const trail = (page: Page) => app(page).getByRole("navigation", { name: "Trail" });
/** The names of the trail steps as shown, the current one last. */
const steps = (page: Page) => trail(page).locator(":scope > ol > li").locator("a, [aria-current='page']");
/** A thread step of the trail: its number, then its title. */
const numbered = (title: string) => new RegExp(`^#\\d+ ${title}$`);
const edge = (page: Page) => page.getByRole("separator", { name: "Resize the side panel" });
const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1, exact: true });
/** The accessible names of the neighbour links of a panel. */
const labels = (list: Locator) =>
  list.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("aria-label") ?? ""));
const width = async (locator: Locator) => Math.round((await locator.boundingBox())?.width ?? 0);
const row = (page: Page, title: string) =>
  app(page)
    .locator("li[data-thread-id]")
    .filter({ has: page.getByRole("link", { name: title, exact: true }) });

/** Drags the panel edge horizontally by a number of pixels; a negative move goes to the left. */
async function dragEdge(page: Page, by: number) {
  const box = await edge(page).boundingBox();
  if (!box) throw new Error("The panel edge is not visible");
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 60);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by / 2, y);
  await page.mouse.move(x + by, y);
  await page.mouse.up();
}

test("CXP-060 AC1 the document fills the main area and the side panel shows neighbourhood, links to the thread, Plan and references", async ({
  page,
}) => {
  const errors = await openCorpus(page, threadUrl(notation.id), notation.title);
  const document = documentOf(page);
  const panel = threadPanel(page);
  await expect(document.getByRole("heading", { name: notation.title, level: 1 })).toBeVisible();
  await expect(document).toContainText(`Read ${notation.title.toLowerCase()}.`);
  // The document is the main area, the panel stands at its right and is narrower.
  const [documentBox, panelBox] = [await document.boundingBox(), await panel.boundingBox()];
  expect(documentBox && panelBox && documentBox.x + documentBox.width <= panelBox.x).toBe(true);
  expect((documentBox?.width ?? 0) > (panelBox?.width ?? 0)).toBe(true);
  // The neighbourhood, the links to the thread, then the references; the Plan is the card above the document.
  const titles = await panel.getByRole("heading", { level: 2 }).allTextContents();
  expect(titles.slice(0, 3)).toEqual(["Neighbourhood", "Links to this thread", "References"]);
  await expect(neighbourhood(panel).getByRole("link").first()).toBeVisible();
  const links = panel.getByRole("region", { name: "Links to this thread" });
  await expect(links.getByRole("listitem")).toHaveText([
    `${topology.title}Parent thread`,
    `${examples.title}Child thread`,
    `Facet InterfaceIntention: ${notation.intention}`,
  ]);
  const references = panel.getByRole("region", { name: "References" });
  await expect(references).toBeVisible();
  await expect(panel.getByRole("region", { name: "Framework Plan" })).toHaveCount(0);
  await expect(app(page).getByRole("region", { name: "Framework Plan" })).toContainText("No framework Plan yet.");
  expect(errors).toEqual([]);
});

test("CXP-060 AC2 the side panel opens the monitoring of the framework Plan and its missions", async ({ page }) => {
  const errors = await openCorpus(page, threadUrl(DIAGRAM_THREAD), "Document diagrams");
  // The side panel no longer holds the Plan: its follow-up opens from the card of the Plan.
  await expect(threadPanel(page).getByRole("region", { name: "Framework Plan" })).toHaveCount(0);
  const card = app(page).getByRole("region", { name: "Current Plan", exact: true });
  await card.getByRole("link", { name: "Plan details", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${DIAGRAM_THREAD}\\?view=plan$`));
  await expect(page.getByRole("heading", { level: 1 })).toContainText(FRAMEWORK_PLAN);
  await expect(missionCards(page)).toHaveCount(MISSIONS.length, { timeout: 30000 });
  await page.goBack();
  // A mission of the card opens its page.
  const mission = MISSIONS[1]?.id ?? "";
  await card.getByRole("button", { name: /missions complete/ }).click();
  await card.getByRole("link", { name: mission, exact: true }).click();
  await expect(page).toHaveURL(/view=mission&mission=/);
  await expect(heading(page, mission)).toBeVisible();
  await expect(trail(page)).toContainText(mission);
  expect(errors).toEqual([]);
});

test("CXP-070 AC1 the neighbours are grouped in order with the count of each group", async ({ page }) => {
  const errors = await openCorpus(page, threadUrl(notation.id), notation.title);
  const panel = threadPanel(page);
  // Corpus, parent, children, facets, then the threads on the same facets, each group with its count.
  await expect(neighbourhood(panel).getByRole("heading", { level: 3 })).toHaveText([
    /^Corpus\s*1$/,
    /^Parent thread\s*1$/,
    /^Child threads\s*1$/,
    /^Facets\s*1$/,
    /^Threads on the same facets\s*5$/,
  ]);
  await expect(group(panel, "Corpus").getByRole("link")).toHaveText(/^TRUST/);
  await expect(neighbour(group(panel, "Parent thread"), `Parent thread: ${topology.title}`)).toBeVisible();
  await expect(neighbour(group(panel, "Child threads"), `Child thread: ${examples.title}`)).toBeVisible();
  await expect(neighbour(group(panel, "Facets"), "Facet: Interface")).toBeVisible();
  const others = group(panel, "Threads on the same facets");
  await others.getByRole("button", { name: "Show 2 more" }).click();
  expect((await labels(others)).sort()).toEqual(
    [
      "Thread: Document diagrams",
      "Thread: Interface registry",
      "Thread: Theme rule",
      "Thread: Reframed delivery",
      `Thread: ${DECISION_THREAD.title}`,
    ].sort(),
  );
  // A thread of another corpus: its corpus, its child, its three facets and the threads that touch them.
  await neighbour(threadPanel(page), `Parent thread: ${topology.title}`).click();
  await expect(heading(page, topology.title)).toBeVisible();
  await expect(neighbourhood(threadPanel(page)).getByRole("heading", { level: 3 })).toHaveText([
    /^Corpus\s*1$/,
    /^Child threads\s*1$/,
    /^Facets\s*3$/,
    /^Threads on the same facets\s*2$/,
  ]);
  expect((await labels(neighbourhood(threadPanel(page)))).sort()).toEqual(
    [
      "Corpus: Delegation exploration",
      `Child thread: ${notation.title}`,
      "Facet: Concepts",
      "Facet: Sources",
      "Facet: Delegation experiments",
      `Thread: ${ENTRY_THREADS.vocabulary.title}`,
      `Thread: ${ENTRY_THREADS.survey.title}`,
    ].sort(),
  );
  expect(errors).toEqual([]);
});

test("CXP-070 AC2 a neighbour thread shows its number, title and state pill, and a facet or corpus its thread count", async ({
  page,
}) => {
  const errors = await openCorpus(page, threadUrl(topology.id), topology.title);
  const panel = threadPanel(page);
  const thread = (name: string) => neighbour(panel, `Thread: ${name}`);
  // A thread row: its number, its title, then its state pill.
  for (const [name, state] of [
    [ENTRY_THREADS.vocabulary.title, "Completed"],
    [ENTRY_THREADS.survey.title, "Paused"],
  ] as const) {
    await expect(thread(name).locator(".corpus-thread-number")).toHaveText(/^#\d+$/);
    await expect(thread(name).locator(".corpus-state-pill")).toHaveText(state);
    await expect(thread(name)).toHaveText(new RegExp(`^#\\d+\\s*${name}\\s*${state}`));
  }
  const child = neighbour(panel, `Child thread: ${notation.title}`);
  await expect(child).toHaveText(new RegExp(`^#\\d+\\s*${notation.title}\\s*Active`));
  // A facet or a corpus row: its title and its thread count, without number or state.
  const sources = neighbour(panel, "Facet: Sources");
  await expect(sources).toHaveText(/^Sources\s*2 threads/);
  await expect(sources.locator(".corpus-state-pill, .corpus-thread-number")).toHaveCount(0);
  const owner = neighbour(panel, `Corpus: ${ENTRY_CORPUS.title}`);
  await expect(owner).toHaveText(new RegExp(`^${ENTRY_CORPUS.title}\\s*\\d+ threads?`));
  await expect(owner.locator(".corpus-state-pill, .corpus-thread-number")).toHaveCount(0);
  expect(await noPageOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("CXP-070 AC3 beyond three neighbours in a group, Show n more shows the others", async ({ page }) => {
  const errors = await openCorpus(page, threadUrl(crowded.id), crowded.title);
  const children = group(threadPanel(page), "Child threads");
  await expect(children.getByRole("heading", { level: 3 })).toHaveText(/^Child threads\s*13$/);
  await expect(children.getByRole("link")).toHaveCount(3);
  await children.getByRole("button", { name: "Show 10 more", exact: true }).click();
  await expect(children.getByRole("link")).toHaveCount(CROWD.length);
  expect((await labels(children)).sort()).toEqual(CROWD.map((member) => `Child thread: ${member.title}`).sort());
  await expect(children.getByRole("button", { name: /^Show \d+ more$/ })).toHaveCount(0);
  // Three rows or fewer: no Show n more.
  await page.goto(threadUrl(topology.id));
  await expect(heading(page, topology.title)).toBeVisible();
  const facets = group(threadPanel(page), "Facets");
  await expect(facets.getByRole("link")).toHaveCount(3);
  await expect(facets.getByRole("button")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("CXP-070 AC4 choosing a neighbour opens its screen", async ({ page }) => {
  const errors = await openCorpus(page, threadUrl(notation.id), notation.title);
  await choose(threadPanel(page), "Facet: Interface");
  await expect(page).toHaveURL(`${ENTRY}/facets/interface`);
  await expect(heading(page, "Interface")).toBeVisible();
  await choose(facetPanel(page), `Thread: ${notation.title}`);
  await expect(page).toHaveURL(threadUrl(notation.id));
  await choose(threadPanel(page), `Child thread: ${examples.title}`);
  await expect(page).toHaveURL(threadUrl(examples.id));
  await expect(heading(page, examples.title)).toBeVisible();
  await choose(threadPanel(page), `Parent thread: ${notation.title}`);
  await expect(heading(page, notation.title)).toBeVisible();
  await choose(threadPanel(page), "Corpus: TRUST");
  await expect(page).toHaveURL(`${ENTRY}/corpora/trust`);
  await expect(heading(page, "TRUST")).toBeVisible();
  // A row shown by Show n more opens its screen too.
  await page.goto(threadUrl(crowded.id));
  await choose(threadPanel(page), `Child thread: ${CROWD[12]?.title}`);
  await expect(page).toHaveURL(threadUrl(CROWD[12]?.id ?? ""));
  await expect(heading(page, CROWD[12]?.title ?? "")).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-070 AC5 without neighbour the panel says No direct neighbour", async ({ page }) => {
  const errors = await openCorpus(page, threadUrl(ENTRY_THREADS.loose.id), ENTRY_THREADS.loose.title);
  const panel = neighbourhood(threadPanel(page));
  await expect(panel).toContainText("No direct neighbour.");
  await expect(panel.getByRole("link")).toHaveCount(0);
  await expect(panel.getByRole("heading", { level: 3 })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("CXP-080 AC1 the facet screen shows description, touching threads with state and intention, technical requirements and materialization without tabs", async ({
  page,
}) => {
  const errors = await openCorpus(page, `${ENTRY}/facets/interface`, "Interface");
  const facet = page.getByRole("article", { name: "Facet Interface" });
  await expect(facet).toContainText("Web interface");
  await expect(facet.getByRole("heading", { level: 2 })).toHaveText([
    /^Threads\s*\d+$/,
    /^Technical requirements\s*3$/,
    "Materialization",
  ]);
  const touching = facet.getByRole("list", { name: "Threads touching Interface" }).getByRole("listitem");
  const line = touching.filter({ has: page.getByRole("link", { name: notation.title, exact: true }) });
  await expect(line).toContainText("Active");
  await expect(line).toContainText(`Intention: ${notation.intention}`);
  await expect(
    touching.filter({ has: page.getByRole("link", { name: "Interface registry", exact: true }) }),
  ).toContainText("No intention recorded for this facet.");
  await expect(facet.getByRole("list", { name: "Registry entries" }).getByRole("listitem")).toHaveCount(3);
  await expect(facet.getByText("packages/trust-ui", { exact: true })).toBeVisible();
  await expect(app(page).getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Facet sections" })).toHaveCount(0);
  // The registry history stays a routed page of the facet.
  await facet.getByRole("link", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/facets/interface?section=history`);
  await expect(heading(page, "Interface — registry history")).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-080 AC2 a facet that represents another corpus links to that corpus", async ({ page }) => {
  const errors = await openCorpus(page, `${ENTRY}/facets/sources`, "Sources");
  await page.getByRole("link", { name: "Represents the corpus TRUST", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/trust`);
  await expect(heading(page, "TRUST")).toBeVisible();
  // A facet that represents no corpus has no such link.
  await page.goto(`${ENTRY}/facets/concepts`);
  await expect(heading(page, "Concepts")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Represents the corpus/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("CXP-080 AC3 the facet screen shows the same neighbourhood panel as a thread screen", async ({ page }) => {
  const errors = await openCorpus(page, `${ENTRY}/facets/sources`, "Sources");
  const panel = facetPanel(page);
  await expect(panel.getByRole("heading", { level: 2 }).first()).toHaveText("Neighbourhood");
  // The facet's corpus and the corpus it represents, then the threads on this facet, as grouped rows.
  await expect(neighbourhood(panel).getByRole("heading", { level: 3 })).toHaveText([
    /^Corpus\s*2$/,
    /^Threads on this facet\s*2$/,
  ]);
  expect((await labels(neighbourhood(panel))).sort()).toEqual(
    ["Corpus: Delegation exploration", "Corpus: TRUST", `Thread: ${topology.title}`, "Thread: Source survey"].sort(),
  );
  await expect(neighbour(panel, "Thread: Source survey").locator(".corpus-state-pill")).toHaveText("Paused");
  await expect(edge(page)).toBeVisible();
  await expect(app(page).getByRole("button", { name: "Hide the side panel" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Links to this facet" })).toContainText(
    `${topology.title}Intention: Explore sources for ${topology.title}.`,
  );
  // The same panel, rows and controls on a thread screen.
  const rowClass = await neighbour(panel, "Thread: Source survey").getAttribute("class");
  const facetPanelClass = await neighbourhood(panel).getAttribute("class");
  await neighbour(panel, `Thread: ${topology.title}`).click();
  const thread = threadPanel(page);
  await expect(thread.getByRole("heading", { level: 2 }).first()).toHaveText("Neighbourhood");
  await expect(app(page).getByRole("button", { name: "Hide the side panel" })).toBeVisible();
  await expect(neighbour(thread, "Facet: Sources")).toBeVisible();
  expect(await neighbourhood(thread).getAttribute("class")).toBe(facetPanelClass);
  expect(await neighbour(thread, "Thread: Source survey").getAttribute("class")).toBe(rowClass);
  expect(errors).toEqual([]);
});

test("CXP-090 AC1 each screen shows one trail of the screens followed and each step returns to its screen", async ({
  page,
}) => {
  const errors = await openCorpus(page, ENTRY, "Corpus");
  await expect(row(page, topology.title)).toBeVisible();
  await row(page, topology.title).getByRole("link", { name: topology.title, exact: true }).click();
  await expect(heading(page, topology.title)).toBeVisible();
  await expect(steps(page)).toHaveText(["Corpus", numbered(topology.title)]);
  await choose(threadPanel(page), "Facet: Concepts");
  await expect(heading(page, "Concepts")).toBeVisible();
  await expect(steps(page)).toHaveText(["Corpus", numbered(topology.title), "Concepts"]);
  await expect(trail(page).locator("[aria-current='page']")).toHaveText("Concepts");
  // One trail only: no breadcrumb of the host or of Corpus stacks above it.
  await expect(page.getByRole("navigation", { name: "Trail" })).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
  // Each step returns to its screen.
  await trail(page)
    .getByRole("link", { name: numbered(topology.title) })
    .click();
  await expect(page).toHaveURL(threadUrl(topology.id));
  await expect(heading(page, topology.title)).toBeVisible();
  await trail(page).getByRole("link", { name: "Corpus", exact: true }).click();
  await expect(page).toHaveURL(ENTRY);
  await expect(heading(page, "Corpus")).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-100 AC1 the panel edge drags between 280 and 560 pixels and the width survives a reload", async ({
  page,
}) => {
  const errors = await openCorpus(page, threadUrl(notation.id), notation.title);
  const panel = threadPanel(page);
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "340");
  expect(await width(panel)).toBe(340);
  // To the left the panel widens up to 560 pixels, to the right it narrows down to 280.
  await dragEdge(page, -400);
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "560");
  expect(await width(panel)).toBe(560);
  await dragEdge(page, 500);
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "280");
  expect(await width(panel)).toBe(280);
  await dragEdge(page, -140);
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "420");
  await page.reload();
  await expect(heading(page, notation.title)).toBeVisible();
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "420");
  expect(await width(threadPanel(page))).toBe(420);
  expect(errors).toEqual([]);
});

test("CXP-100 AC2 a button collapses the panel and the state survives a screen change and a reload", async ({
  page,
}) => {
  const errors = await openCorpus(page, threadUrl(notation.id), notation.title);
  const panel = threadPanel(page);
  const hide = app(page).getByRole("button", { name: "Hide the side panel" });
  const open = await width(documentOf(page));
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await hide.click();
  const show = app(page).getByRole("button", { name: "Show the side panel" });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByRole("heading", { name: "Neighbourhood" })).toBeHidden();
  await expect(edge(page)).toHaveCount(0);
  // The document takes the freed width.
  expect(await width(documentOf(page))).toBeGreaterThan(open + 280);
  // Another screen, reached through the trail and the list, keeps the panel folded.
  await trail(page).getByRole("link", { name: "Corpus", exact: true }).click();
  await row(page, topology.title).getByRole("link", { name: topology.title, exact: true }).click();
  await expect(heading(page, topology.title)).toBeVisible();
  await expect(app(page).getByRole("button", { name: "Show the side panel" })).toBeVisible();
  await expect(threadPanel(page).getByRole("heading", { name: "Neighbourhood" })).toBeHidden();
  await page.reload();
  await expect(heading(page, topology.title)).toBeVisible();
  await expect(app(page).getByRole("button", { name: "Show the side panel" })).toBeVisible();
  await expect(threadPanel(page).getByRole("heading", { name: "Neighbourhood" })).toBeHidden();
  // Unfolded again, everywhere.
  await app(page).getByRole("button", { name: "Show the side panel" }).click();
  await expect(threadPanel(page).getByRole("heading", { name: "Neighbourhood" })).toBeVisible();
  await page.goto(`${ENTRY}/facets/concepts`);
  await expect(facetPanel(page).getByRole("heading", { name: "Neighbourhood" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-100 AC3 under 900 pixels the panel shows below the document without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 899, height: 900 });
  const errors = await openCorpus(page, threadUrl(notation.id), notation.title);
  for (const viewport of [899, 390]) {
    await page.setViewportSize({ width: viewport, height: 900 });
    const [documentBox, panelBox] = [await documentOf(page).boundingBox(), await threadPanel(page).boundingBox()];
    expect(documentBox && panelBox && panelBox.y >= documentBox.y + documentBox.height, `at ${viewport} px`).toBe(true);
    await expect(edge(page)).toBeHidden();
    await expect(threadPanel(page).getByRole("heading", { name: "Neighbourhood" })).toBeVisible();
    expect(await noPageOverflow(page), `at ${viewport} px`).toBe(true);
  }
  await page.goto(`${ENTRY}/facets/interface`);
  await expect(heading(page, "Interface")).toBeVisible();
  const [facetBox, panelBox] = [
    await page.getByRole("article", { name: "Facet Interface" }).boundingBox(),
    await facetPanel(page).boundingBox(),
  ];
  expect(facetBox && panelBox && panelBox.y >= facetBox.y + facetBox.height).toBe(true);
  expect(await noPageOverflow(page)).toBe(true);
  // At 900 pixels and wider the panel stands beside the document again.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(edge(page)).toBeVisible();
  expect(await noPageOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("CXP-100 AC4 the panel edge is adjustable by keyboard and has an accessible name", async ({ page }) => {
  const errors = await openCorpus(page, threadUrl(notation.id), notation.title);
  const separator = edge(page);
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await expect(separator).toHaveAttribute("aria-valuemin", "280");
  await expect(separator).toHaveAttribute("aria-valuemax", "560");
  await separator.focus();
  await expect(separator).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "356");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "324");
  expect(await width(threadPanel(page))).toBe(324);
  await page.keyboard.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "560");
  await page.keyboard.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "560");
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "280");
  expect(await width(threadPanel(page))).toBe(280);
  // Reached by Tab like any control.
  await page.getByRole("button", { name: "Edit the document" }).focus();
  let reached = false;
  for (let index = 0; index < 60 && !reached; index++) {
    await page.keyboard.press("Tab");
    reached = await separator.evaluate((element) => element === document.activeElement);
  }
  expect(reached).toBe(true);
  expect(errors).toEqual([]);
});

test("CXP-120 AC1 the trail shows six steps at most and folds older steps in a menu", async ({ page }) => {
  const errors = await openCorpus(page, ENTRY, "Corpus");
  await row(page, topology.title).getByRole("link", { name: topology.title, exact: true }).click();
  const path = [
    `Child thread: ${notation.title}`,
    "Facet: Interface",
    "Thread: Document diagrams",
    "Thread: Interface registry",
    "Thread: Theme rule",
  ];
  for (const name of path) await choose(app(page).getByRole("complementary"), name);
  await expect(heading(page, "Theme rule")).toBeVisible();
  const visible = [
    numbered(topology.title),
    numbered(notation.title),
    "Interface",
    numbered("Document diagrams"),
    numbered("Interface registry"),
    numbered("Theme rule"),
  ];
  await expect(steps(page)).toHaveText(visible);
  // The oldest step folds into a menu that lists it.
  const fold = trail(page).getByRole("button", { name: "1 earlier steps" });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  const menu = trail(page).getByRole("list", { name: "Earlier steps" });
  await expect(menu.getByRole("link")).toHaveText(["Corpus"]);
  // The menu is drawn above the screen, not clipped by it.
  const item = menu.getByRole("link", { name: "Corpus" });
  const box = await item.boundingBox();
  const hit = box
    ? await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, {
        x: box.x + 4,
        y: box.y + box.height / 2,
      })
    : null;
  expect(hit).toBe("Corpus");
  await item.click();
  await expect(page).toHaveURL(ENTRY);
  await expect(heading(page, "Corpus")).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-120 AC2 a return to a screen of the trail shortens the trail to that screen", async ({ page }) => {
  const errors = await openCorpus(page, ENTRY, "Corpus");
  await row(page, topology.title).getByRole("link", { name: topology.title, exact: true }).click();
  await choose(threadPanel(page), `Child thread: ${notation.title}`);
  await choose(threadPanel(page), "Facet: Interface");
  await expect(heading(page, "Interface")).toBeVisible();
  await expect(steps(page)).toHaveText(["Corpus", numbered(topology.title), numbered(notation.title), "Interface"]);
  // Back to a thread already followed through the facet's neighbourhood: the trail ends on it, once.
  await choose(facetPanel(page), `Thread: ${notation.title}`);
  await expect(heading(page, notation.title)).toBeVisible();
  await expect(steps(page)).toHaveText(["Corpus", numbered(topology.title), numbered(notation.title)]);
  // And through the trail itself.
  await trail(page)
    .getByRole("link", { name: numbered(topology.title) })
    .click();
  await expect(heading(page, topology.title)).toBeVisible();
  await expect(steps(page)).toHaveText(["Corpus", numbered(topology.title)]);
  expect(errors).toEqual([]);
});
