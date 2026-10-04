import { expect, type Page, test } from "@playwright/test";
import { corpusApi, fault, noPageOverflow, openCorpus, readOnlyCaller, visit } from "./support/corpus-browser.js";
import { ENTRY_CORPUS, ENTRY_THREADS } from "./support/corpus-fixture.js";

/* The behaviour of the Corpus entry list, the thread number, and the organisation pages: create and rename a corpus,
   move a thread. It runs on the disposable Corpus runtime of support/corpus-server.mjs. */

const ENTRY = "/extensions/corpus";
const WORKSPACE = "/extensions/corpus/api/workspace";
const { topology } = ENTRY_THREADS;
/** Identities created by one run, so that a run on a reused harness never meets those of a former run. */
const stamp = Date.now().toString(36);

async function command<Result>(name: string, args: unknown): Promise<Result> {
  const response = await fetch(`${corpusApi}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: name, arguments: args }),
  });
  const body = (await response.json()) as Result & { message?: string };
  if (!response.ok) throw new Error(`${name} refused: ${body.message}`);
  return body;
}
const numberOf = async (thread: string) => (await command<{ number: number }>("threads.read", { id: thread })).number;

const app = (page: Page) => page.locator(".corpus-app");
const filters = (page: Page) => page.getByRole("group", { name: "Filters" });
const rows = (page: Page) => app(page).locator("li[data-thread-id]");
const titleLink = (page: Page, index: number) => rows(page).nth(index).locator("> div > a").first();
const row = (page: Page, title: string) =>
  rows(page).filter({ has: page.getByRole("link", { name: title, exact: true }) });
/** The page errors, without the console lines of the refusals a test causes on purpose. */
const unexpected = (errors: string[], status: number) =>
  errors.filter((error) => !error.includes(`status of ${status}`));
const heading = (page: Page, name: string | RegExp) => page.getByRole("heading", { name, level: 1 });

async function openEntry(page: Page) {
  const errors = await openCorpus(page, ENTRY, "Corpus");
  await expect(row(page, topology.title)).toBeVisible();
  return errors;
}

test("CXP-110 AC1 the filter bar stays visible while the list scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  const errors = await openEntry(page);
  await app(page).getByRole("navigation", { name: "Views" }).getByRole("button", { name: "All threads" }).click();
  const bar = filters(page);
  const first = titleLink(page, 0);
  const last = rows(page).last();
  // The list is longer than the screen: its last row starts below it.
  expect((await last.boundingBox())?.y ?? 0).toBeGreaterThan(640);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  // The first rows went above the screen, while the filter bar and the search stay in view, above the list.
  expect((await first.boundingBox())?.y ?? 0).toBeLessThan(0);
  await expect(bar).toBeInViewport({ ratio: 1 });
  await expect(app(page).getByRole("combobox", { name: "Search Corpus" })).toBeInViewport({ ratio: 1 });
  const box = await bar.boundingBox();
  const covered = await page.evaluate(
    ({ x, y }) => !!document.elementFromPoint(x, y)?.closest("fieldset"),
    box ? { x: box.x + 4, y: box.y + box.height / 2 } : { x: 0, y: 0 },
  );
  expect(covered).toBe(true);
  // A filter of the bar still opens while the list is scrolled.
  await bar.getByRole("button", { name: "Add a filter on Corpus", exact: true }).click();
  await expect(bar.getByRole("checkbox", { name: ENTRY_CORPUS.title, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // The same on a phone.
  await page.setViewportSize({ width: 390, height: 700 });
  await last.scrollIntoViewIfNeeded();
  await expect(bar).toBeInViewport();
  expect(await noPageOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("CXP-110 AC2 the list shows its loading and a failed read shows the cause with a retry", async ({ page }) => {
  // The workspace read is held until the loading state has been seen.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${WORKSPACE}`, async (route) => {
    await held;
    await route.continue();
  });
  const errors = await openCorpus(page, ENTRY, "Corpus");
  const loading = app(page).getByRole("status").filter({ hasText: "Loading the threads…" });
  await expect(loading).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  release();
  await expect(row(page, topology.title)).toBeVisible();
  await expect(loading).toHaveCount(0);
  await page.unroute(`**${WORKSPACE}`);
  // A failed read names its cause and offers a retry that lists the threads once the read succeeds.
  await fault(WORKSPACE, true);
  try {
    await page.reload();
    const failure = app(page).getByRole("alert").filter({ hasText: "The threads could not be read." });
    await expect(failure).toBeVisible({ timeout: 30000 });
    await expect(failure).toContainText("Read refused by the acceptance proxy.");
    await expect(rows(page)).toHaveCount(0);
    await expect(app(page).getByText("No thread yet.")).toHaveCount(0);
    await fault(WORKSPACE, false);
    await failure.getByRole("button", { name: "Retry" }).click();
    await expect(row(page, topology.title)).toBeVisible();
    await expect(failure).toHaveCount(0);
  } finally {
    await fault(WORKSPACE, false);
  }
  // The refused read is the only error of the page.
  expect(unexpected(errors, 503)).toEqual([]);
});

test("CXP-110 AC3 the arrow keys move through the rows and Enter opens the selected thread", async ({ page }) => {
  const errors = await openEntry(page);
  await titleLink(page, 0).focus();
  await page.keyboard.press("ArrowDown");
  await expect(titleLink(page, 1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(titleLink(page, 2)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(titleLink(page, 1)).toBeFocused();
  // The arrows also cross from one group to the next.
  await app(page).getByRole("navigation", { name: "Views" }).getByRole("button", { name: "All threads" }).click();
  await filters(page).getByRole("combobox", { name: "Group by" }).selectOption("state");
  const groups = app(page).locator("section[aria-label]");
  const firstGroupSize = await groups.first().locator("li[data-thread-id]").count();
  await titleLink(page, firstGroupSize - 1).focus();
  await page.keyboard.press("ArrowDown");
  await expect(titleLink(page, firstGroupSize)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  const selected = rows(page).nth(firstGroupSize - 2);
  await expect(selected.locator("> div > a").first()).toBeFocused();
  const id = await selected.getAttribute("data-thread-id");
  const title = (await selected.locator("> div > a").first().textContent()) ?? "";
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${ENTRY}/threads/${id}`);
  await expect(heading(page, title)).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-150 AC1 the thread number shows before the title in the list, on the thread screen, in the trail and in the search results", async ({
  page,
}) => {
  const number = await numberOf(topology.id);
  const errors = await openEntry(page);
  const before = new RegExp(`^#${number}\\s*${topology.title}`);
  // In the list.
  const line = row(page, topology.title).locator("> div").first();
  await expect(line.locator(".corpus-thread-number")).toHaveText(`#${number}`);
  await expect(line).toHaveText(before);
  // In the search results.
  const search = app(page).getByRole("combobox", { name: "Search Corpus" });
  await search.fill("topology");
  const result = app(page).getByRole("listbox", { name: "Search results" }).getByRole("option");
  await expect(result.filter({ hasText: topology.title })).toContainText(`Thread#${number} ${topology.title}`);
  await search.fill("");
  // On the thread screen and in the trail.
  await row(page, topology.title).getByRole("link", { name: topology.title, exact: true }).click();
  await expect(heading(page, topology.title)).toBeVisible();
  const document = app(page).getByRole("article", { name: "Thread document" });
  await expect(document.locator("header").first()).toContainText(new RegExp(`#${number}\\s*${topology.title}`));
  const head = await document
    .locator("header")
    .first()
    .evaluate((header) => {
      const label = header.querySelector(".corpus-thread-number");
      const title = header.querySelector("h1");
      return !!label && !!title && !!(label.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  expect(head).toBe(true);
  const trail = app(page).getByRole("navigation", { name: "Trail" });
  await expect(trail.locator("[aria-current='page']")).toHaveText(`#${number} ${topology.title}`);
  // In French the number reads "n°".
  const french = await page.context().newPage();
  const frenchErrors = await openCorpus(french, `${ENTRY}/threads/${topology.id}`, topology.title, "fr");
  await expect(french.locator(".corpus-app article .corpus-thread-number").first()).toHaveText(`n° ${number}`);
  expect([...errors, ...frenchErrors]).toEqual([]);
});

test("CXP-150 AC2 the Corpus search finds a thread by its number", async ({ page }) => {
  const number = await numberOf(topology.id);
  const errors = await openEntry(page);
  const search = app(page).getByRole("combobox", { name: "Search Corpus" });
  const results = app(page).getByRole("listbox", { name: "Search results" }).getByRole("option");
  for (const query of [`#${number}`, String(number), `n° ${number}`]) {
    await search.fill(query);
    await expect(results.first()).toContainText(`Thread#${number} ${topology.title}`);
  }
  await search.fill(`#${number}`);
  await search.press("Enter");
  await expect(page).toHaveURL(`${ENTRY}/threads/${topology.id}`);
  await expect(heading(page, topology.title)).toBeVisible();
  expect(errors).toEqual([]);
});

test("CXP-200 AC1 corpus creation and corpus rename open in a page and show the result or the refusal", async ({
  page,
}) => {
  const id = `archive-${stamp}`;
  const errors = await openEntry(page);
  // Creation: a routed page with its breadcrumb.
  await app(page).getByRole("link", { name: "New corpus", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/new`);
  await expect(heading(page, "Create a corpus")).toBeVisible();
  await expect(app(page).getByRole("navigation", { name: "Trail" })).toContainText("New corpus");
  const form = app(page).locator("form");
  // An identity that exists is refused, and the refusal of the server is shown.
  await form.getByLabel("Identifier").fill("trust");
  await form.getByLabel("Title").fill("Archive");
  await form.getByLabel("Description").fill("Threads kept for reference");
  await form.getByRole("button", { name: "Create the corpus" }).click();
  const refused = app(page).getByRole("alert").filter({ hasText: "The corpus was not created." });
  await expect(refused).toContainText("This identity already exists.");
  await expect(page).toHaveURL(`${ENTRY}/corpora/new`);
  await form.getByLabel("Identifier").fill(id);
  await form.getByRole("button", { name: "Create the corpus" }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/${id}`);
  await expect(heading(page, "Archive")).toBeVisible();
  await expect(app(page).getByRole("status").filter({ hasText: "Corpus “Archive” created." })).toBeVisible();
  // Rename: a routed page; a change made meanwhile is refused with the reason of the server.
  await app(page).getByRole("link", { name: "Rename the corpus Archive", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/${id}/edit`);
  await expect(heading(page, "Rename the corpus Archive")).toBeVisible();
  await expect(app(page).getByRole("navigation", { name: "Trail" })).toContainText("Rename Archive");
  await expect(form.getByLabel("Title")).toHaveValue("Archive");
  await command("corpora.update", { id, expectedRevision: 1, title: "Archive kept", description: "Changed elsewhere" });
  await form.getByLabel("Title").fill("Reference archive");
  await form.getByRole("button", { name: "Rename the corpus" }).click();
  const stale = app(page).getByRole("alert").filter({ hasText: "The corpus was not renamed." });
  await expect(stale).toContainText("Corpus changed; reread before editing.");
  await page.reload();
  await expect(form.getByLabel("Title")).toHaveValue("Archive kept", { timeout: 30000 });
  await form.getByLabel("Title").fill("Reference archive");
  await form.getByRole("button", { name: "Rename the corpus" }).click();
  await expect(page).toHaveURL(`${ENTRY}/corpora/${id}`);
  await expect(heading(page, "Reference archive")).toBeVisible();
  await expect(app(page).getByRole("status").filter({ hasText: "Corpus renamed “Reference archive”." })).toBeVisible();
  expect((await command<{ id: string; title: string }>("corpora.read", { id })).title).toBe("Reference archive");
  expect(await noPageOverflow(page)).toBe(true);
  expect(unexpected(errors, 409)).toEqual([]);
});

test("CXP-200 AC2 the move of a thread opens in a page and shows the refusal of the server", async ({ page }) => {
  const [source, target, facet, thread] = ["origin", "destination", "ledger", "ledger-notes"].map(
    (name) => `${name}-${stamp}`,
  ) as [string, string, string, string];
  await command("corpora.create", { id: source, title: "Origin archive", description: "Where the thread starts" });
  await command("corpora.create", { id: target, title: "Destination archive", description: "Where it moves" });
  await command("facets.create", {
    id: facet,
    corpus: source,
    title: "Ledger",
    description: "Ledger of the origin",
    materialization: "archive/ledger",
  });
  await command("threads.open", { id: thread, title: "Ledger notes", body: "## Goal\n\nKeep the ledger notes." });
  await command("threads.attach", {
    id: thread,
    expectedRevision: 1,
    corpus: source,
    intentions: [{ facet, intention: "Note the ledger." }],
  });
  const errors = await openCorpus(page, `${ENTRY}/threads/${thread}`, "Ledger notes");
  await app(page).getByRole("link", { name: "Move to another corpus", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/threads/${thread}/move`);
  await expect(heading(page, /Move the thread Ledger notes/)).toBeVisible();
  await expect(app(page).getByRole("navigation", { name: "Trail" })).toContainText("Move");
  const form = app(page).locator("form");
  // The page asks the target corpus and a reason, and no facet mapping.
  await expect(form.getByRole("combobox")).toHaveCount(1);
  await form.getByLabel("Target corpus").selectOption(target);
  await form.getByLabel("Reason").fill("The ledger belongs to the destination.");
  // The thread is revised meanwhile: the server refuses the move and the page shows its reason.
  await command("threads.revise", {
    id: thread,
    expectedRevision: 2,
    title: "Ledger notes",
    body: "## Goal\n\nKeep the ledger notes, revised.",
    author: "owner",
    reason: "Clarify",
  });
  await form.getByRole("button", { name: "Move the thread" }).click();
  const refused = app(page).getByRole("alert").filter({ hasText: "The thread was not moved." });
  await expect(refused).toContainText("Thread changed; reread before editing.");
  expect((await command<{ corpus: string }>("threads.read", { id: thread })).corpus).toBe(source);
  // Read again, the move succeeds and shows the facets left outside the new corpus.
  await page.reload();
  await form.getByLabel("Target corpus").selectOption(target, { timeout: 30000 });
  await form.getByLabel("Reason").fill("The ledger belongs to the destination.");
  await form.getByRole("button", { name: "Move the thread" }).click();
  await expect(
    app(page).getByRole("status").filter({ hasText: "Thread moved from Origin archive to Destination archive." }),
  ).toBeVisible();
  const warnings = app(page).getByRole("region", { name: "Facet warnings" });
  await expect(warnings).toContainText("The facet Ledger belongs to the corpus Origin archive.");
  await app(page).getByRole("link", { name: "Open the thread", exact: true }).click();
  await expect(page).toHaveURL(`${ENTRY}/threads/${thread}`);
  await expect(app(page).getByRole("region", { name: "Facet warnings" })).toContainText("Ledger");
  await expect(app(page).getByText(/Moved from the corpus Origin archive to Destination archive/)).toBeVisible();
  expect((await command<{ corpus: string }>("threads.read", { id: thread })).corpus).toBe(target);
  expect(unexpected(errors, 409)).toEqual([]);
});

test("CXP-200 AC3 a caller without the write right does not see these actions", async ({ page }) => {
  await readOnlyCaller(true);
  try {
    const errors = await openEntry(page);
    await expect(app(page).getByRole("link", { name: "New corpus", exact: true })).toHaveCount(0);
    await visit(page, `${ENTRY}/corpora/${ENTRY_CORPUS.id}`, ENTRY_CORPUS.title);
    await expect(app(page).getByRole("link", { name: /^Rename/ })).toHaveCount(0);
    await visit(page, `${ENTRY}/threads/${topology.id}`, topology.title);
    await expect(app(page).getByRole("link", { name: "Move to another corpus", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await readOnlyCaller(false);
  }
});
