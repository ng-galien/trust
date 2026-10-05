import { expect, type Page, test } from "@playwright/test";
import { corpusApi, noPageOverflow, openCorpus, rpc, visit } from "./support/corpus-browser.js";
import { ENTRY_CORPUS, ENTRY_FACETS, ENTRY_THREADS, REGISTRY_THREAD } from "./support/corpus-fixture.js";

/* The Corpus entry screen: one thread list with filters, groups, views and search, on routed addresses. It runs on
   the disposable Corpus runtime of support/corpus-server.mjs. */

const ENTRY = "/extensions/corpus";
const { topology, vocabulary, survey, loose } = ENTRY_THREADS;
const revision = async (thread: string) =>
  ((await (await fetch(`${corpusApi}/api/threads/${thread}`)).json()) as { revision: number }).revision;
const facetTitle = (id: string) => ENTRY_FACETS.find((facet) => facet.id === id)?.title ?? id;

const app = (page: Page) => page.locator(".corpus-app");
const views = (page: Page, name = "Views") => page.getByRole("navigation", { name });
const filters = (page: Page) => page.getByRole("group", { name: "Filters" });
/** The rows of the thread list, across every group. */
const rows = (page: Page) => app(page).locator("li[data-thread-id]");
const row = (page: Page, title: string) =>
  rows(page).filter({ has: page.getByRole("link", { name: title, exact: true }) });
const listed = (page: Page) => rows(page).locator("> div > a").allTextContents();
const chip = (page: Page, text: string) => filters(page).getByRole("button", { name: text, exact: true });
const removeChip = (page: Page, text: string) =>
  filters(page).getByRole("button", { name: `Remove filter ${text}`, exact: true });
const addFilter = (page: Page, dimension: string) =>
  filters(page).getByRole("button", { name: `Add a filter on ${dimension}`, exact: true });
const option = (page: Page, label: string) => filters(page).getByRole("checkbox", { name: label, exact: true });
const groupBy = (page: Page) => filters(page).getByRole("combobox", { name: "Group by" });
const groupTitles = (page: Page) => app(page).locator("section > h2");
/** A view of the supplied or saved views panel. */
const view = (page: Page, name: string) => views(page).getByRole("button", { name, exact: true });

async function openEntry(page: Page, language: "en" | "fr" = "en") {
  const errors = await openCorpus(page, ENTRY, "Corpus", language);
  const facets = language === "en" ? `Facets of ${topology.title}` : `Facettes de ${topology.title}`;
  await expect(row(page, topology.title).getByRole("list", { name: facets })).toBeVisible();
  return errors;
}

test("CXP-010 AC1 the Corpus page shows no Extensions header", async ({ page }) => {
  // Each address is loaded afresh, and the host reads its Plans before it loads the extension.
  test.setTimeout(240000);
  const errors = await openEntry(page);
  const main = page.getByRole("main").first();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
  await expect(main.getByRole("link", { name: "Extensions", exact: true })).toHaveCount(0);
  await expect(main.getByText(/Extensions\s*›?\s*Corpus/)).toHaveCount(0);
  // A thread and a facet show the Corpus trail only, never the host breadcrumb above it.
  await visit(page, `${ENTRY}/threads/${topology.id}`, topology.title);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
  await expect(app(page).getByRole("navigation", { name: "Trail" })).toHaveCount(1);
  await visit(page, `${ENTRY}/facets/concepts`, "Concepts");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
  await expect(app(page).getByRole("navigation", { name: "Trail" })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("CXP-010 AC2 the menu keeps Corpus under Workspaces and the extension management under Extensions", async ({
  page,
}) => {
  const errors = await openEntry(page);
  const menu = page.getByRole("navigation", { name: "Extensions", exact: true });
  await expect(menu.getByRole("link", { name: "Installed", exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Sources", exact: true })).toBeVisible();
  await expect(menu.getByText("Workspaces", { exact: true })).toBeVisible();
  const corpus = menu.getByRole("link", { name: "Corpus", exact: true });
  await expect(corpus).toHaveAttribute("aria-current", "page");
  // A nested workspace address still belongs to the Corpus entry.
  await row(page, topology.title).getByRole("link", { name: topology.title, exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/threads/${topology.id}`);
  await expect(corpus).toHaveAttribute("aria-current", "page");
  // The management of the extension stays under Extensions, with its own header.
  await menu.getByRole("link", { name: "Installed", exact: true }).click();
  await expect(page).toHaveURL("/extensions");
  await expect(page.getByRole("heading", { name: "Installed extensions" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Installed", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(corpus).not.toHaveAttribute("aria-current", "page");
  expect(errors).toEqual([]);
});

test("CXP-020 AC1 each row shows the thread title, its corpus, its facet labels, its state and its revision", async ({
  page,
}) => {
  const errors = await openEntry(page);
  await view(page, "All threads").click();
  // One list holds the threads of every corpus, and threads attached to none.
  const titles = await listed(page);
  for (const title of [topology.title, vocabulary.title, survey.title, loose.title, "Document diagrams"])
    expect(titles).toContain(title);
  const active = row(page, topology.title);
  await expect(active).toContainText(ENTRY_CORPUS.title);
  await expect(active.getByRole("list", { name: `Facets of ${topology.title}` }).getByRole("link")).toHaveText(
    ["concepts", "experiments", "sources"].map(facetTitle).sort(),
  );
  await expect(active).toContainText("Open");
  await expect(active).toContainText(`rev. ${await revision(topology.id)}`);
  await expect(row(page, vocabulary.title)).toContainText("Completed");
  await expect(row(page, survey.title)).toContainText("Paused");
  await expect(row(page, loose.title)).toContainText("No corpus");
  const registry = row(page, "Interface registry");
  await expect(registry).toContainText("TRUST");
  await expect(registry.getByRole("link", { name: /^Facet / })).toHaveText(["Documentation", "Interface"]);
  await expect(registry).toContainText(`rev. ${await revision(REGISTRY_THREAD)}`);
  expect(await noPageOverflow(page)).toBe(true);
  // The list stays usable on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(active.getByRole("link", { name: topology.title, exact: true })).toBeVisible();
  expect(await noPageOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("CXP-020 AC2 a row opens its thread and a facet label opens its facet", async ({ page }) => {
  const errors = await openEntry(page);
  await row(page, topology.title).getByRole("link", { name: topology.title, exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/threads/${topology.id}`);
  await expect(page.getByRole("heading", { name: topology.title, level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(ENTRY);
  await row(page, topology.title).getByRole("link", { name: "Facet Concepts", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/facets/concepts`);
  await expect(page.getByRole("heading", { name: "Concepts", level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-030 AC1 each active filter shows as a chip and removing a chip restores the hidden threads", async ({
  page,
}) => {
  const errors = await openEntry(page);
  // The view of the open threads filters on the open state.
  await view(page, "Open threads").click();
  await expect(chip(page, "State: Open")).toBeVisible();
  expect(await listed(page)).not.toContain(vocabulary.title);
  expect(await listed(page)).not.toContain(survey.title);
  await removeChip(page, "State: Open").click();
  await expect(chip(page, "State: Open")).toHaveCount(0);
  await expect(addFilter(page, "State")).toBeVisible();
  await expect(row(page, vocabulary.title)).toBeVisible();
  await expect(row(page, survey.title)).toBeVisible();
  // A corpus filter combines with the others and is a chip of its own.
  await addFilter(page, "Corpus").click();
  await option(page, ENTRY_CORPUS.title).check();
  await page.keyboard.press("Escape");
  await expect(chip(page, `Corpus: ${ENTRY_CORPUS.title}`)).toBeVisible();
  await expect(row(page, "Document diagrams")).toHaveCount(0);
  await expect(row(page, loose.title)).toHaveCount(0);
  await addFilter(page, "State").click();
  await option(page, "Paused").check();
  await page.keyboard.press("Escape");
  await expect(chip(page, "State: Paused")).toBeVisible();
  expect(await listed(page)).toEqual([survey.title]);
  await removeChip(page, `Corpus: ${ENTRY_CORPUS.title}`).click();
  await expect(chip(page, `Corpus: ${ENTRY_CORPUS.title}`)).toHaveCount(0);
  expect(await listed(page)).toEqual([survey.title]);
  await removeChip(page, "State: Paused").click();
  await expect(row(page, "Document diagrams")).toBeVisible();
  await expect(row(page, loose.title)).toBeVisible();
  await expect(row(page, vocabulary.title)).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-330 AC2 the state filter offers In progress, Open, Paused and Completed and the grouping by state follows that order", async ({
  page,
}) => {
  const errors = await openEntry(page);
  await addFilter(page, "State").click();
  await expect(app(page).getByRole("checkbox")).toHaveCount(4);
  // The four states are offered in this order.
  const stateChoices = await filters(page)
    .getByRole("group", { name: "Filter on State" })
    .getByRole("checkbox")
    .evaluateAll((boxes) => boxes.map((box) => box.closest("label")?.textContent?.trim()));
  expect(stateChoices).toEqual(["In progress", "Open", "Paused", "Completed"]);
  await option(page, "In progress").check();
  await page.keyboard.press("Escape");
  await expect(chip(page, "State: In progress")).toBeVisible();
  // Every listed thread shows the In progress pill, and at least one thread is listed.
  await expect(rows(page).first()).toBeVisible();
  for (const item of await rows(page).all())
    await expect(item.locator(".corpus-thread-status")).toHaveText("In progress");
  // The open threads with no Plan at work are under Open.
  await chip(page, "State: In progress").click();
  await option(page, "In progress").uncheck();
  await option(page, "Open").check();
  await page.keyboard.press("Escape");
  await expect(rows(page).first()).toBeVisible();
  for (const item of await rows(page).all()) await expect(item.locator(".corpus-thread-status")).toHaveText("Open");
  // Without a state filter, the grouping by state follows the same order.
  await chip(page, "State: Open").click();
  await option(page, "Open").uncheck();
  await page.keyboard.press("Escape");
  await expect(filters(page).getByRole("button", { name: /^Remove filter / })).toHaveCount(0);
  await groupBy(page).selectOption("state");
  await expect(groupTitles(page)).toHaveText([
    /^In progress\s*\d+$/,
    /^Open\s*\d+$/,
    /^Paused\s*\d+$/,
    /^Completed\s*\d+$/,
  ]);
  expect(errors).toEqual([]);
});

test("CXP-030 AC2 the facet filter offers the facets of the selected corpora", async ({ page }) => {
  const errors = await openEntry(page);
  await view(page, "All threads").click();
  const facetChoices = filters(page).getByRole("group", { name: "Filter on Facet" }).getByRole("checkbox");
  await addFilter(page, "Facet").click();
  const every = await facetChoices.evaluateAll((boxes) => boxes.map((box) => box.closest("label")?.textContent));
  expect(every).toEqual(expect.arrayContaining(["Interface", "Documentation", ...ENTRY_FACETS.map((f) => f.title)]));
  await page.keyboard.press("Escape");
  await addFilter(page, "Corpus").click();
  await option(page, "TRUST").check();
  await page.keyboard.press("Escape");
  await addFilter(page, "Facet").click();
  const trust = await facetChoices.evaluateAll((boxes) => boxes.map((box) => box.closest("label")?.textContent));
  expect(trust.sort()).toEqual(["Documentation", "Interface"]);
  await option(page, "Documentation").check();
  await page.keyboard.press("Escape");
  await expect(chip(page, "Facet: Documentation")).toBeVisible();
  // Only the thread whose technical requirement touches Documentation remains.
  expect(await listed(page)).toEqual(["Interface registry"]);
  // A facet of a corpus that is no longer selected leaves the filter.
  await chip(page, "Corpus: TRUST").click();
  await option(page, "TRUST").uncheck();
  await option(page, ENTRY_CORPUS.title).check();
  await page.keyboard.press("Escape");
  await expect(chip(page, "Facet: Documentation")).toHaveCount(0);
  await addFilter(page, "Facet").click();
  const exploration = await facetChoices.evaluateAll((boxes) => boxes.map((box) => box.closest("label")?.textContent));
  expect(exploration.sort()).toEqual(ENTRY_FACETS.map((facet) => facet.title).sort());
  expect(errors).toEqual([]);
});

test("CXP-030 AC3 a combination without result says so and offers to remove the filters", async ({ page }) => {
  const errors = await openEntry(page);
  await addFilter(page, "Corpus").click();
  await option(page, "TRUST").check();
  await page.keyboard.press("Escape");
  await addFilter(page, "State").click();
  await option(page, "Paused").check();
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(0);
  const empty = app(page).getByRole("status").filter({ hasText: "No thread matches these filters." });
  await expect(empty).toBeVisible();
  await expect(app(page).getByText("0 threads", { exact: true })).toBeVisible();
  await empty.getByRole("button", { name: "Remove all filters" }).click();
  await expect(filters(page).getByRole("button", { name: /^Remove filter / })).toHaveCount(0);
  await expect(row(page, vocabulary.title)).toBeVisible();
  await expect(row(page, survey.title)).toBeVisible();
  await expect(row(page, "Document diagrams")).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-040 AC1 the list groups by corpus, facet or state and a thread appears under each of its facets", async ({
  page,
}) => {
  const errors = await openEntry(page);
  await view(page, "All threads").click();
  await expect(groupBy(page)).toHaveValue("corpus");
  await expect(groupTitles(page)).toHaveText([/^Delegation exploration\s*3$/, /^TRUST\s*\d+$/, /^No corpus\s*1$/]);
  await groupBy(page).selectOption("facet");
  const underFacet = (title: string) =>
    app(page)
      .getByRole("region", { name: title, exact: true })
      .getByRole("link", { name: topology.title, exact: true });
  for (const facet of ENTRY_FACETS) await expect(underFacet(facet.title)).toBeVisible();
  await expect(row(page, topology.title)).toHaveCount(3);
  await expect(app(page).getByRole("region", { name: "No facet", exact: true })).toContainText(loose.title);
  await groupBy(page).selectOption("state");
  await expect(groupTitles(page)).toHaveText([
    /^In progress\s*\d+$/,
    /^Open\s*\d+$/,
    /^Paused\s*1$/,
    /^Completed\s*1$/,
  ]);
  await expect(app(page).getByRole("region", { name: "Paused", exact: true })).toContainText(survey.title);
  await expect(app(page).getByRole("region", { name: "Completed", exact: true })).toContainText(vocabulary.title);
  expect(errors).toEqual([]);
});

test("CXP-040 AC2 the supplied views exist: all threads, open threads, recently completed and one view per corpus, and the list opens on all threads", async ({
  page,
}) => {
  const errors = await openEntry(page);
  // The list opens on every thread, with no state filter.
  await expect(view(page, "All threads")).toHaveAttribute("aria-current", "true");
  await expect(filters(page).getByRole("button", { name: /^Remove filter / })).toHaveCount(0);
  await expect(views(page).getByRole("button")).toContainText(["All threads", "Open threads", "Recently completed"]);
  const corpusViews = views(page).getByRole("list", { name: "Corpus views" }).getByRole("link");
  await expect(corpusViews).toHaveText([ENTRY_CORPUS.title, "TRUST"]);
  await view(page, "Recently completed").click();
  await expect(chip(page, "State: Completed")).toBeVisible();
  await expect(filters(page).getByText("Completed in the last 30 days")).toBeVisible();
  expect(await listed(page)).toEqual([vocabulary.title]);
  await view(page, "All threads").click();
  await expect(filters(page).getByRole("button", { name: /^Remove filter / })).toHaveCount(0);
  await corpusViews.filter({ hasText: ENTRY_CORPUS.title }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/${ENTRY_CORPUS.id}`);
  await expect(page.getByRole("heading", { name: ENTRY_CORPUS.title, level: 1 })).toBeVisible();
  await expect(chip(page, `Corpus: ${ENTRY_CORPUS.title}`)).toBeVisible();
  await expect(corpusViews.filter({ hasText: ENTRY_CORPUS.title })).toHaveAttribute("aria-current", "page");
  expect((await listed(page)).sort()).toEqual([topology.title, vocabulary.title, survey.title].sort());
  // Leaving the corpus filter leaves the corpus address for the thread list.
  await removeChip(page, `Corpus: ${ENTRY_CORPUS.title}`).click();
  await expect(page).toHaveURL(ENTRY);
  expect(errors).toEqual([]);
  // The French catalogue names the same views.
  const french = await page.context().newPage();
  await openEntry(french, "fr");
  await expect(views(french, "Vues").getByRole("button")).toContainText([
    "Tous les threads",
    "Threads ouverts",
    "Terminés récemment",
  ]);
  await french.close();
});

test("CXP-040 AC3 a saved view keeps its filters and grouping after a reload in the same browser", async ({ page }) => {
  const errors = await openEntry(page);
  await addFilter(page, "Corpus").click();
  await option(page, ENTRY_CORPUS.title).check();
  await page.keyboard.press("Escape");
  await groupBy(page).selectOption("facet");
  await filters(page).getByRole("link", { name: "Save view" }).click();
  await expect(page).toHaveURL(`${ENTRY}/views/new`);
  await expect(page.getByRole("heading", { name: "Save the current view", level: 1 })).toBeVisible();
  const summary = page.getByRole("definition");
  await expect(summary).toHaveText(["All", ENTRY_CORPUS.title, "All", "Facet"]);
  await page.getByRole("textbox", { name: "Name" }).fill("Exploration by facet");
  await page.getByRole("button", { name: "Save view" }).click();
  await expect(page).toHaveURL(ENTRY);
  await expect(app(page).getByRole("status").filter({ hasText: "View “Exploration by facet” saved." })).toBeVisible();
  await expect(view(page, "Exploration by facet")).toHaveAttribute("aria-current", "true");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Corpus", level: 1 })).toBeVisible({ timeout: 30000 });
  await expect(view(page, "All threads")).toHaveAttribute("aria-current", "true");
  await view(page, "Exploration by facet").click();
  await expect(chip(page, `Corpus: ${ENTRY_CORPUS.title}`)).toBeVisible();
  await expect(filters(page).getByRole("button", { name: /^Remove filter / })).toHaveCount(1);
  await expect(groupBy(page)).toHaveValue("facet");
  await expect(row(page, topology.title)).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("CXP-050 AC1 the search finds corpora, facets and threads by title and shows the kind of each result", async ({
  page,
}) => {
  const errors = await openEntry(page);
  const search = app(page).getByRole("combobox", { name: "Search Corpus" });
  await search.fill("delegation");
  const results = app(page).getByRole("listbox", { name: "Search results" }).getByRole("option");
  await expect(results).toHaveCount(3);
  await expect(results.nth(0)).toContainText(`Corpus${ENTRY_CORPUS.title}`);
  await expect(results.nth(1)).toContainText(`Facet${facetTitle("experiments")}${ENTRY_CORPUS.title}`);
  // A thread result shows its number before its title.
  await expect(results.nth(2)).toContainText(new RegExp(`Thread#\\d+ ${topology.title}${ENTRY_CORPUS.title}`));
  await search.fill("interface");
  await expect(results).toHaveText([/^FacetInterfaceTRUST/, /^Thread#\d+ Interface registryTRUST/]);
  await search.fill("no such title");
  await expect(app(page).getByRole("status").filter({ hasText: "Nothing in Corpus matches" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-050 AC2 a chosen result opens its screen and the host search shortcut still opens the host search", async ({
  page,
}) => {
  const errors = await openEntry(page);
  const search = app(page).getByRole("combobox", { name: "Search Corpus" });
  const host = page.getByRole("textbox", { name: "Search resources" });
  // "/" opens the Corpus search; ⌘K / Ctrl+K remains the host search.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(host).toBeFocused();
  await expect(search).not.toBeFocused();
  await search.fill("experiments");
  await app(page)
    .getByRole("option", { name: /Delegation experiments/ })
    .click();
  await expect(page).toHaveURL(`${ENTRY}/facets/experiments`);
  await expect(page.getByRole("heading", { name: "Delegation experiments", level: 1 })).toBeVisible();
  await page.goBack();
  await search.fill("registry");
  await search.press("Enter");
  await expect(page).toHaveURL(`${ENTRY}/threads/${REGISTRY_THREAD}`);
  await expect(page.getByRole("heading", { name: "Interface registry", level: 1 })).toBeVisible();
  await page.goBack();
  await search.fill(ENTRY_CORPUS.title);
  await search.press("ArrowDown");
  await search.press("ArrowUp");
  await search.press("Enter");
  await expect(page).toHaveURL(`${ENTRY}/corpora/${ENTRY_CORPUS.id}`);
  expect(errors).toEqual([]);
});

test("CXP-090 AC2 the thread list, a corpus, a facet and a thread each have an address without state parameters", async ({
  page,
}) => {
  // Each address is loaded afresh, and the host reads its Plans before it loads the extension.
  test.setTimeout(240000);
  const errors = await openEntry(page);
  const addresses: [string, string][] = [
    [ENTRY, "Corpus"],
    [`${ENTRY}/corpora/${ENTRY_CORPUS.id}`, ENTRY_CORPUS.title],
    [`${ENTRY}/facets/concepts`, "Concepts"],
    [`${ENTRY}/threads/${topology.id}`, topology.title],
  ];
  for (const [address, heading] of addresses) {
    await visit(page, address, heading);
    expect(new URL(page.url()).pathname).toBe(address);
    expect(new URL(page.url()).search).toBe("");
  }
  // The links of each screen lead to these addresses.
  await visit(page, ENTRY, "Corpus");
  await views(page).getByRole("link", { name: "TRUST", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/trust`);
  await app(page)
    .getByRole("navigation", { name: "Facets of TRUST" })
    .getByRole("button", { name: "Interface" })
    .click();
  await expect(page).toHaveURL(`${ENTRY}/facets/interface`);
  await page.goBack();
  await row(page, "Document diagrams").getByRole("link", { name: "Document diagrams", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/threads/document-diagrams`);
  await app(page).getByRole("navigation", { name: "Trail" }).getByRole("link", { name: "TRUST" }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/trust`);
  expect(errors).toEqual([]);
});

test("CXP-090 AC3 an old address with corpus, thread, section or facet parameters leads to the new address", async ({
  page,
}) => {
  // Each address is loaded afresh, and the host reads its Plans before it loads the extension.
  test.setTimeout(240000);
  const errors = await openEntry(page);
  const redirects: [string, string, string][] = [
    [`?thread=${topology.id}`, `/threads/${topology.id}`, topology.title],
    [`?corpus=${ENTRY_CORPUS.id}`, `/corpora/${ENTRY_CORPUS.id}`, ENTRY_CORPUS.title],
    [`?corpus=trust&section=facets`, "/corpora/trust", "TRUST"],
    [`?corpus=trust&facet=interface`, "/facets/interface", "Interface"],
    [
      `?corpus=trust&facet=interface&section=history`,
      "/facets/interface?section=history",
      "Interface — registry history",
    ],
  ];
  for (const [old, address, heading] of redirects) {
    await visit(page, `${ENTRY}${old}`, heading);
    await expect(page).toHaveURL(`${ENTRY}${address}`);
  }
  // The former address does not stay behind its redirect in the history.
  await visit(page, ENTRY, "Corpus");
  await visit(page, `${ENTRY}?thread=${survey.id}`, survey.title);
  await expect(page).toHaveURL(`${ENTRY}/threads/${survey.id}`);
  await page.goBack();
  await expect(page).toHaveURL(ENTRY);
  expect(errors).toEqual([]);
});

type WorkspaceRead = {
  corpora: { id: string; title: string }[];
  threads: { id: string; title: string; state: string; corpus: string | null; framework_plan: string | null }[];
};
const workspace = async () => (await (await fetch(`${corpusApi}/api/workspace`)).json()) as WorkspaceRead;
const openDialog = (page: Page) => page.getByRole("dialog", { name: "Open a thread", exact: true });
const corpusChoice = (page: Page) => openDialog(page).getByRole("combobox", { name: "Corpus", exact: true });

test("CXP-330 AC1 an open thread whose framework Plan is at work shows In progress and an open thread with no Plan at work shows Open", async ({
  page,
}) => {
  const errors = await openEntry(page);
  await view(page, "All threads").click();
  // The facts come from Corpus and TRUST: the thread state and the work state of its framework Plan.
  const { threads } = await workspace();
  const atWork = new Set<string>();
  for (const plan of new Set(threads.flatMap((thread) => (thread.framework_plan ? [thread.framework_plan] : [])))) {
    const read = await rpc<{ procedure: string; workState: string }>("plan.read", { plan });
    if (read.procedure === "corpus-thread-framework" && ["IN_PROGRESS", "ESCALATED"].includes(read.workState))
      atWork.add(plan);
  }
  const open = threads.filter((thread) => thread.state === "ACTIVE");
  const inProgress = open.filter((thread) => thread.framework_plan && atWork.has(thread.framework_plan));
  // The fixture holds both kinds of open thread.
  expect(inProgress.length).toBeGreaterThan(0);
  expect(open.length).toBeGreaterThan(inProgress.length);
  await expect(rows(page)).toHaveCount(threads.length);
  for (const thread of open) {
    const pill = app(page).locator(`li[data-thread-id="${thread.id}"]`).locator(".corpus-thread-status");
    await expect(pill).toHaveText(inProgress.includes(thread) ? "In progress" : "Open");
  }
  expect(errors).toEqual([]);
});

test("CXP-340 AC1 the Open a thread dialog offers each corpus and No corpus", async ({ page }) => {
  const errors = await openEntry(page);
  const { corpora } = await workspace();
  await app(page).getByRole("button", { name: "Open a thread", exact: true }).click();
  await expect(openDialog(page)).toBeVisible();
  // From the thread list the dialog opens without corpus, and offers every corpus.
  await expect(corpusChoice(page)).toHaveValue("");
  await expect(corpusChoice(page).getByRole("option")).toHaveText(["No corpus", ...corpora.map((c) => c.title)]);
  await openDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(openDialog(page)).not.toBeVisible();
  // From a corpus screen the dialog proposes that corpus.
  await views(page).getByRole("link", { name: "TRUST", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/trust`);
  await app(page).getByRole("button", { name: "Open a thread", exact: true }).click();
  await expect(corpusChoice(page)).toHaveValue("trust");
  await expect(corpusChoice(page).getByRole("option")).toHaveText(["No corpus", ...corpora.map((c) => c.title)]);
  expect(await noPageOverflow(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(openDialog(page)).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-340 AC2 a thread opened with a chosen corpus is attached to it and listed under it", async ({ page }) => {
  const errors = await openEntry(page);
  const commands: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/extensions/corpus/commands")) commands.push(request.postDataJSON().command);
  });
  const title = "Thread opened in the TRUST corpus";
  await app(page).getByRole("button", { name: "Open a thread", exact: true }).click();
  await openDialog(page).getByLabel("Title", { exact: true }).fill(title);
  await openDialog(page).getByLabel("Intention", { exact: true }).fill("Open a thread with its corpus.");
  await corpusChoice(page).selectOption({ label: "TRUST" });
  await openDialog(page).getByRole("button", { name: "Open thread", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  // The thread is opened, then attached to the chosen corpus.
  expect(commands).toEqual(["threads.open", "threads.resolve"]);
  const created = (await workspace()).threads.find((thread) => thread.title === title);
  expect(created?.corpus).toBe("trust");
  await visit(page, ENTRY, "Corpus");
  await view(page, "All threads").click();
  await expect(row(page, title)).toContainText("TRUST");
  await expect(
    app(page).getByRole("region", { name: "TRUST", exact: true }).getByRole("link", { name: title }),
  ).toBeVisible();
  await views(page).getByRole("link", { name: "TRUST", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/trust`);
  expect(await listed(page)).toContain(title);
  expect(errors).toEqual([]);
  // A refused attachment leaves the thread opened without corpus, and the dialog gives the cause.
  await page.route("**/extensions/corpus/commands", async (route) => {
    if (route.request().postDataJSON().command !== "threads.resolve") return route.continue();
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ message: "Thread changed; reread before editing." }),
    });
  });
  const loose = "Thread whose attachment is refused";
  await app(page).getByRole("button", { name: "Open a thread", exact: true }).click();
  await openDialog(page).getByLabel("Title", { exact: true }).fill(loose);
  await openDialog(page).getByLabel("Intention", { exact: true }).fill("Open a thread whose attachment fails.");
  await expect(corpusChoice(page)).toHaveValue("trust");
  await openDialog(page).getByRole("button", { name: "Open thread", exact: true }).click();
  await expect(openDialog(page).getByRole("alert")).toHaveText(
    "The thread is opened without corpus: Thread changed; reread before editing.",
  );
  expect((await workspace()).threads.find((thread) => thread.title === loose)?.corpus).toBeNull();
  await openDialog(page).getByRole("button", { name: "Go to the thread", exact: true }).click();
  await expect(page.getByRole("heading", { name: loose, level: 1 })).toBeVisible();
  // The only console error is the refusal answered by the route above.
  expect(errors).toEqual(["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
});
