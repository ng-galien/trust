import { expect, type Page, test } from "@playwright/test";
import {
  corpusApi,
  countEventStreams,
  fault,
  missionCard,
  missionCards,
  noPageOverflow,
  openCorpus,
  rpc,
  visit,
} from "./support/corpus-browser.js";
import {
  ADDED_MISSION,
  ADDITION,
  CONFLICT_THREAD,
  CURRENT_MISSION,
  INHERITED_MISSIONS,
  REFRAMED_OLD_PLAN,
  REFRAMED_PLAN,
  REFRAMED_THREAD,
  REGISTRY_THREAD,
} from "./support/corpus-fixture.js";

/* The facet registry page and the reframed thread, on the disposable Corpus runtime of support/corpus-server.mjs. */

type Origin = { thread: string; revision: number; author: string; reason: string };
type Registry = {
  entries: {
    procedure: string;
    name: string;
    nature: string | null;
    statement: string | null;
    facets: string[];
    conflicting: boolean;
    origin: Origin;
  }[];
  conflicts: { procedure: string; origin: Origin; declared: { nature: string } }[];
};
const registry = async (facet: string) =>
  (await (await fetch(`${corpusApi}/api/facets/${facet}/registry`)).json()) as Registry;
const facetUrl = (facet: string, section?: string) =>
  `/extensions/corpus?corpus=trust&facet=${facet}${section ? `&section=${section}` : ""}`;
const natures: Record<string, string> = { declarative: "Declarative", measurable: "Measurable" };
const threadTitles: Record<string, string> = {
  [REGISTRY_THREAD]: "Interface registry",
  [CONFLICT_THREAD]: "Theme rule",
};
/** The extension's trail of the screens followed. */
/** The Plan details page of the reframed thread, where the mission cards of its framework Plan are. */
const reframedPlanUrl = `/extensions/corpus/threads/${REFRAMED_THREAD}?view=plan`;
const corpusTrail = (page: Page) => page.locator(".corpus-app").getByRole("navigation", { name: "Trail" });
const entries = (page: Page) => page.getByRole("list", { name: "Registry entries" }).getByRole("listitem");
/** The registry entry of one Procedure reference; its values are named by their terms. */
const row = (page: Page, procedure: string) =>
  entries(page).filter({ has: page.getByRole("link", { name: procedure, exact: true }) });
const value = (entry: ReturnType<typeof row>, term: "Nature" | "Statement" | "Origin") =>
  entry.getByRole("definition").nth(["Nature", "Statement", "Origin"].indexOf(term));

test("TRQ-010 AC1 a facet page lists its registry entries with Procedure reference, nature, statement and origin", async ({
  page,
}) => {
  const errors = await openCorpus(page, facetUrl("interface"), "Interface");
  // The trail of the screens followed, and the registry counted on the one-page facet screen.
  const trail = corpusTrail(page);
  await expect(trail.getByRole("link")).toHaveText(["Corpus"]);
  await expect(trail.locator('[aria-current="page"]')).toHaveText("Interface");
  await expect(page.getByRole("heading", { name: /^Technical requirements\s*3$/, level: 2 })).toBeVisible();

  // Every entry of the facet's registry, as the read API returns it.
  const { entries: listed, conflicts } = await registry("interface");
  expect(listed.map((entry) => entry.procedure).sort()).toEqual([
    "ui-theme-tokens@1.0.0",
    "ui-translations@1.0.0",
    "ui-wireframe-first@1.0.0",
  ]);
  await expect(entries(page)).toHaveCount(listed.length);
  for (const entry of listed) {
    const line = row(page, entry.procedure);
    await expect(line.getByRole("link", { name: entry.procedure })).toHaveAttribute(
      "href",
      `/procedures/${entry.name}`,
    );
    await expect(line.getByRole("term")).toHaveText(["Nature", "Statement", "Origin"]);
    await expect(value(line, "Nature")).toHaveText(natures[entry.nature ?? ""] ?? "");
    await expect(value(line, "Statement")).toHaveText(entry.statement ?? "");
    const origin = value(line, "Origin");
    await expect(
      origin.getByRole("link", { name: threadTitles[entry.origin.thread] ?? entry.origin.thread }),
    ).toBeVisible();
    await expect(origin).toContainText(`Revision ${entry.origin.revision} · ${entry.origin.author}`);
    await expect(origin).toContainText(entry.origin.reason);
  }
  // The conflicting entry and its conflict, naming the thread and revision that declared the other nature.
  const [conflict] = conflicts;
  expect(conflict?.procedure).toBe("ui-theme-tokens@1.0.0");
  await expect(row(page, "ui-theme-tokens@1.0.0").locator("> div").first()).toContainText("Conflict");
  await expect(row(page, "ui-wireframe-first@1.0.0").locator("> div").first()).not.toContainText("Conflict");
  await expect(page.getByRole("region", { name: "Conflicts" })).toHaveText(
    `Conflictsui-theme-tokens@1.0.0 is declared measurable by Theme rule (revision ${conflict?.origin.revision}); the published Procedure is declarative.`,
  );
  // Written only through approved thread revisions: no way to add an entry here.
  await expect(page.getByText("The registry changes only through an approved revision of a thread")).toBeVisible();
  await expect(page.getByRole("button", { name: /add/i })).toHaveCount(0);

  // The registry history is a routed page.
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/section=history/);
  await expect(page.getByRole("heading", { name: "Interface — registry history", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Registry history" }).getByRole("listitem")).toHaveCount(3);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Interface", level: 1 })).toBeVisible();

  // Each entry leads to its origin thread, where the technical blocks render as cards with their registry status.
  await row(page, "ui-wireframe-first@1.0.0").getByRole("link", { name: "Interface registry" }).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${REGISTRY_THREAD}$`));
  const document = page.getByRole("article", { name: "Thread document" });
  await expect(document.getByRole("heading", { name: "Interface registry", level: 1 })).toBeVisible();
  await expect(document).not.toContainText("::::");
  const card = (procedure: string) =>
    document.getByRole("region", { name: `Technical requirement ${procedure}`, exact: true });
  const wireframe = card("ui-wireframe-first@1.0.0");
  await expect(wireframe.getByRole("link", { name: "ui-wireframe-first@1.0.0" })).toHaveAttribute(
    "href",
    "/procedures/ui-wireframe-first",
  );
  await expect(wireframe).toContainText("Declarative");
  await expect(wireframe).toContainText("Interface");
  await expect(wireframe).toContainText("Every interface change starts from a Maket wireframe.");
  await expect(wireframe).toContainText("In the registry");
  await expect(card("ui-translations@1.0.0")).toContainText("InterfaceDocumentation");
  await expect(card("ui-translations@1.0.0")).toContainText("In the registry");
  await expect(card("ui-routed-pages@1.0.0")).toContainText("Pending approval");
  await visit(page, `/extensions/corpus?thread=${CONFLICT_THREAD}`, "Theme rule");
  await expect(
    page
      .getByRole("article", { name: "Thread document" })
      .getByRole("region", { name: "Technical requirement ui-theme-tokens@1.0.0" }),
  ).toContainText("Conflicting");

  // Phone width: the registry reads as cards, without page overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, facetUrl("interface"), "Interface");
  await expect(row(page, "ui-wireframe-first@1.0.0")).toBeVisible();
  expect(await noPageOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("TRQ-010 AC2 a requirement attached to several facets appears on each facet page as one entry", async ({
  page,
}) => {
  const errors = await openCorpus(page, facetUrl("interface"), "Interface");
  const [interfaceRegistry, documentationRegistry] = await Promise.all([
    registry("interface"),
    registry("documentation"),
  ]);
  for (const listed of [interfaceRegistry, documentationRegistry])
    expect(listed.entries.filter((entry) => entry.procedure === "ui-translations@1.0.0")).toHaveLength(1);
  expect(interfaceRegistry.entries.find((entry) => entry.procedure === "ui-translations@1.0.0")?.facets).toEqual([
    "documentation",
    "interface",
  ]);

  await expect(row(page, "ui-translations@1.0.0")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Shared requirements" })).toHaveText(
    "Shared with Documentation for ui-translations@1.0.0",
  );
  // The facet's neighbourhood leads to its corpus, whose facets include Documentation.
  await page.getByRole("complementary", { name: "Facet summary" }).getByRole("link", { name: "Corpus: TRUST" }).click();
  await page
    .getByRole("navigation", { name: "Facets of TRUST" })
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Documentation", level: 1 })).toBeVisible();
  await expect(entries(page)).toHaveCount(1);
  await expect(row(page, "ui-translations@1.0.0")).toHaveCount(1);
  await expect(value(row(page, "ui-translations@1.0.0"), "Statement")).toHaveText(
    "Every visible text of the interface goes through the en and fr catalogues, with identical keys.",
  );
  await expect(page.getByRole("region", { name: "Shared requirements" })).toHaveText(
    "Shared with Interface for ui-translations@1.0.0",
  );
  expect(errors).toEqual([]);
});

test("TRQ-070 AC2 a reframed thread shows the missions completed under its replaced framework", async ({ page }) => {
  const errors = await openCorpus(page, `/extensions/corpus?thread=${REFRAMED_THREAD}`, "Reframed delivery");
  // The reframing reads in the lifecycle notes, the versions in its recorded reason.
  await expect(page.getByRole("complementary", { name: "Thread summary" })).toContainText(
    `Reframed under a new framework Plan · `,
  );
  await expect(page.getByRole("complementary", { name: "Thread summary" })).toContainText(
    `Reframed from ${REFRAMED_OLD_PLAN} (corpus-thread-framework 0.1.0) to ${REFRAMED_PLAN} (corpus-thread-framework 0.4.0).`,
  );
  // The missions are on the Plan details page.
  await visit(page, reframedPlanUrl, REFRAMED_PLAN);
  const replaced = (await (await fetch(`${corpusApi}/trust/episodes/${REFRAMED_OLD_PLAN}`)).json()) as {
    branches: { invocation: { mission?: { id: string } }; child: { plan: { workState: string } } | null }[];
  };
  const completed = replaced.branches
    .filter((branch) => branch.child?.plan.workState === "COMPLETE")
    .map((branch) => branch.invocation.mission?.id);
  expect(completed).toEqual([INHERITED_MISSIONS.complete]);
  expect(replaced.branches).toHaveLength(2);

  // Only the completed missions of the replaced framework, marked inherited.
  await expect(missionCards(page, "Inherited missions")).toHaveCount(1, { timeout: 30000 });
  const inherited = missionCard(page, INHERITED_MISSIONS.complete, "Inherited missions");
  await expect(inherited).toContainText("Inherited");
  await expect(inherited.locator(".corpus-state-pill")).toHaveText("Complete");
  await expect(inherited).toContainText("3 of 3 Checks");
  await expect(page.getByRole("link", { name: INHERITED_MISSIONS.running, exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Inherited missions" })).toContainText(REFRAMED_OLD_PLAN);

  // Besides the current framework's missions; the mission founded by an addition is nested under it.
  await expect(missionCards(page)).toHaveCount(3);
  await expect(missionCard(page, CURRENT_MISSION)).not.toContainText("Inherited");
  const addition = missionCard(page, ADDITION);
  await expect(
    addition.getByRole("list", { name: `Missions of ${ADDITION}` }).getByRole("link", { name: ADDED_MISSION }),
  ).toBeVisible();

  // An inherited mission opens its own page.
  await inherited.getByRole("link", { name: INHERITED_MISSIONS.complete, exact: true }).click();
  await expect(page).toHaveURL(/view=mission/);
  await expect(page.getByRole("heading", { name: INHERITED_MISSIONS.complete, level: 1 })).toBeVisible();
  await expect(corpusTrail(page)).toContainText(INHERITED_MISSIONS.complete);
  await page.goBack();
  await expect(missionCards(page, "Inherited missions")).toHaveCount(1);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await noPageOverflow(page), `at ${width} px`).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("TRQ-010 AC1 a facet page reports a registry read failure instead of hiding the registry", async ({ page }) => {
  // Two full page loads, each delayed by the host's first reads.
  test.setTimeout(180000);
  const registryPath = "/extensions/corpus/api/facets/interface/registry";
  const streams = countEventStreams(page);
  await fault(registryPath, true);
  try {
    const errors = await openCorpus(page, facetUrl("interface"), "Interface");
    // The failure is reported with its reason and a retry; the registry is not shown as empty.
    const failure = page.getByRole("alert").filter({ hasText: "The registry of Interface cannot be read." });
    await expect(failure).toContainText("Read refused by the acceptance proxy.");
    await expect(page.getByRole("list", { name: "Registry entries" })).toHaveCount(0);
    await expect(page.getByText("No technical requirement is registered for this facet yet.")).toHaveCount(0);
    // The retry reads again: still failing, it keeps the report; healed, the registry appears.
    await failure.getByRole("button", { name: "Retry" }).click();
    await expect(failure).toContainText("Read refused by the acceptance proxy.");
    await fault(registryPath, false);
    await failure.getByRole("button", { name: "Retry" }).click();
    await expect(entries(page)).toHaveCount(3);
    await expect(page.getByRole("alert")).toHaveCount(0);
    // One change stream for the whole page.
    expect(streams()).toBe(1);
    expect(errors.filter((error) => !error.includes("503"))).toEqual([]);
  } finally {
    await fault(registryPath, false);
  }

  // French: the failure and the sentences built from parts follow French typography.
  const french = await page.context().newPage();
  await fault(registryPath, true);
  try {
    await openCorpus(french, facetUrl("interface"), "Interface", "fr");
    const failure = french.getByRole("alert").filter({ hasText: "Le registre de la facette Interface est illisible." });
    await expect(failure.getByRole("button", { name: "Réessayer" })).toBeVisible();
    await fault(registryPath, false);
    await failure.getByRole("button", { name: "Réessayer" }).click();
    await expect(french.getByRole("region", { name: "Conflits" }).getByRole("listitem")).toHaveText(
      /^ui-theme-tokens@1\.0\.0 est déclarée mesurable par Theme rule \(révision \d+\) ; la Procédure publiée est déclarative\.$/,
    );
    await expect(french.getByRole("region", { name: "Exigences partagées" })).toHaveText(
      "Partagée avec Documentation pour ui-translations@1.0.0",
    );
  } finally {
    await fault(registryPath, false);
  }
});

test("TRQ-070 AC2 a thread reports an inherited or addition episode it cannot read instead of hiding its missions", async ({
  page,
}) => {
  test.setTimeout(180000);
  const framework = await rpc<{ invocations: { mission?: { id: string }; childPlan: string | null }[] }>("plan.read", {
    plan: REFRAMED_PLAN,
  });
  const additionPlan = framework.invocations.find((invocation) => invocation.mission?.id === ADDITION)?.childPlan;
  if (!additionPlan) throw new Error("The addition has no child Plan");
  const inheritedPath = `/extensions/corpus/trust/episodes/${REFRAMED_OLD_PLAN}`;
  const additionPath = `/extensions/corpus/trust/episodes/${additionPlan}`;
  const streams = countEventStreams(page);
  await fault(inheritedPath, true);
  await fault(additionPath, true);
  try {
    const errors = await openCorpus(page, reframedPlanUrl, REFRAMED_PLAN);
    // The replaced framework's missions: reported, not hidden.
    const inherited = page.getByRole("region", { name: "Inherited missions" });
    const inheritedFailure = inherited.getByRole("alert");
    await expect(inheritedFailure).toContainText(
      "The missions completed under the replaced framework Plan cannot be read.",
    );
    await expect(inheritedFailure).toContainText("Episode unavailable (503).");
    await expect(missionCards(page, "Inherited missions")).toHaveCount(0);
    // The addition's missions: reported under the addition, which itself stays listed.
    const addition = missionCard(page, ADDITION);
    const additionFailure = addition.getByRole("alert");
    await expect(additionFailure).toContainText(`The missions of ${ADDITION} cannot be read.`);
    await expect(additionFailure).toContainText("Episode unavailable (503).");
    await expect(addition.getByRole("link", { name: ADDED_MISSION })).toHaveCount(0);
    await expect(missionCard(page, CURRENT_MISSION)).toBeVisible();

    // Each retry reads its episode again once the read is healed.
    await fault(inheritedPath, false);
    await inheritedFailure.getByRole("button", { name: "Retry" }).click();
    await expect(missionCards(page, "Inherited missions")).toHaveCount(1);
    await expect(missionCard(page, INHERITED_MISSIONS.complete, "Inherited missions")).toContainText("Inherited");
    await expect(inherited.getByRole("alert")).toHaveCount(0);
    await fault(additionPath, false);
    await additionFailure.getByRole("button", { name: "Retry" }).click();
    await expect(
      addition.getByRole("list", { name: `Missions of ${ADDITION}` }).getByRole("link", { name: ADDED_MISSION }),
    ).toBeVisible();
    await expect(addition.getByRole("alert")).toHaveCount(0);
    // The thread page and all its views share one change stream.
    expect(streams()).toBe(1);
    expect(errors.filter((error) => !error.includes("503"))).toEqual([]);
  } finally {
    await fault(inheritedPath, false);
    await fault(additionPath, false);
  }
});
