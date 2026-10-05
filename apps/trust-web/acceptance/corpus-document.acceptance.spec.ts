import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  checkOf,
  corpusApi,
  missionCard,
  missionCards,
  noPageOverflow,
  openCorpus,
  rpc,
  runCheck,
} from "./support/corpus-browser.js";
import { DIAGRAM_THREAD, FRAMEWORK_PLAN, MISSIONS } from "./support/corpus-fixture.js";

/* The Corpus extension, built from its sources, on a disposable runtime seeded by support/corpus-server.mjs. */

const TIME_ZONE = "Europe/Paris";

type Episode = {
  root: { plan: { invocations: { mission?: { id: string }; childPlan: string | null }[] } };
  branches: {
    invocation: { id: string; mission?: { id: string }; generation: number | null };
    child: {
      plan: { createdAt: string; escalations: { escalatedAt: string }[] };
      checks: {
        name: string;
        history: { calculatedAt: string }[];
        attempts: { handle: string; admittedAt: string; finalizedAt?: string }[];
      }[];
    } | null;
  }[];
};

const episode = async () => (await (await fetch(`${corpusApi}/trust/episodes/${FRAMEWORK_PLAN}`)).json()) as Episode;
async function childPlan(mission: string) {
  const plan = await rpc<Episode["root"]["plan"]>("plan.read", { plan: FRAMEWORK_PLAN });
  const child = plan.invocations.find((invocation) => invocation.mission?.id === mission)?.childPlan;
  if (!child) throw new Error(`Mission ${mission} has no child Plan`);
  return child;
}
const openThread = (page: Page, language: "en" | "fr" = "en") =>
  openCorpus(page, `/extensions/corpus?thread=${DIAGRAM_THREAD}`, "Document diagrams", language);
/** The Plan details page of the thread, where the mission cards of its framework Plan are. */
const openPlan = (page: Page, language: "en" | "fr" = "en") =>
  openCorpus(page, `/extensions/corpus/threads/${DIAGRAM_THREAD}?view=plan`, FRAMEWORK_PLAN, language);
const svgOf = async (image: Locator) => {
  const source = (await image.getAttribute("src")) ?? "";
  return decodeURIComponent(source.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
};
/** The Corpus tokens the host resolves for this figure, as serialized colours (rgb). */
const tokensOf = (figure: Locator) =>
  figure.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("span");
    element.append(probe);
    const color = (name: string) => {
      probe.style.color = style.getPropertyValue(name).trim();
      return getComputedStyle(probe).color;
    };
    const tokens = {
      text: color("--corpus-text"),
      accent: color("--corpus-accent"),
      accentSoft: color("--corpus-accent-soft"),
    };
    probe.remove();
    return tokens;
  });
async function missionOrder(page: Page) {
  const names = await missionCards(page).evaluateAll((cards) =>
    cards.map((card) => card.querySelector("a")?.textContent?.trim() ?? ""),
  );
  return names;
}
/** The instant as the mission card shows it: the hour, with its date unless it falls on the reference day. */
function shown(iso: string, reference?: string) {
  const day = (value: string) => new Date(value).toLocaleDateString("en", { timeZone: TIME_ZONE });
  const withDate = !reference || day(iso) !== day(reference);
  return new Date(iso).toLocaleString("en", {
    ...(withDate ? { day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TIME_ZONE,
  });
}
/** A Check attempt, a qualification or an escalation: the latest thing the mission's current generation did. */
function latestActivity(branch: Episode["branches"][number]) {
  const child = branch.child;
  if (!child) throw new Error("The mission has no child Plan");
  const moments = [
    child.plan.createdAt,
    ...child.checks.flatMap((check) => [
      ...check.history.map((snapshot) => snapshot.calculatedAt),
      ...check.attempts.flatMap((attempt) => [attempt.admittedAt, attempt.finalizedAt ?? attempt.admittedAt]),
    ]),
    ...child.plan.escalations.map((escalation) => escalation.escalatedAt),
  ];
  return moments.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? child.plan.createdAt;
}

test("REQ-080 AC1 a mermaid block renders as a diagram drawn with the host theme and redrawn when the theme changes", async ({
  page,
}) => {
  const errors = await openThread(page);
  const figure = page.getByRole("figure", { name: "Thread framework", exact: true });
  const image = figure.getByRole("img", { name: "Thread framework", exact: true });
  await expect(image).toBeVisible({ timeout: 30000 });

  // Drawn with the host's light tokens, including the semantic node classes of the document.
  const light = await tokensOf(figure);
  const lightSvg = await svgOf(image);
  expect(lightSvg).toMatch(/class="node[^"]*\bcorpus\b/);
  expect(lightSvg).toContain(`fill:${light.accentSoft}!important`);
  expect(lightSvg).toContain(`stroke:${light.accent}!important`);
  expect(lightSvg).toContain(`fill:${light.text}!important`);
  const box = await figure.boundingBox();

  // The host switches to dark: the same diagram is redrawn with the dark tokens, in place, at the same size.
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await tokensOf(figure);
  expect(dark.accentSoft).not.toBe(light.accentSoft);
  expect(dark.text).not.toBe(light.text);
  await expect.poll(async () => (await svgOf(image)).includes(`fill:${dark.accentSoft}!important`)).toBe(true);
  const darkSvg = await svgOf(image);
  expect(darkSvg).toContain(`stroke:${dark.accent}!important`);
  expect(darkSvg).toContain(`fill:${dark.text}!important`);
  expect(darkSvg).not.toContain(`fill:${light.accentSoft}!important`);
  expect((await figure.boundingBox())?.height).toBe(box?.height);
  await expect(figure.getByRole("status")).toHaveCount(0);

  // And back to light.
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect.poll(async () => (await svgOf(image)).includes(`fill:${light.accentSoft}!important`)).toBe(true);
  // Every diagram of the document has its own name.
  await expect(page.getByRole("figure", { name: "Delivery stages", exact: true })).toBeVisible();
  await expect(page.getByRole("figure", { name: "Goal · diagram 3", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("REQ-080 AC2 a diagram fits the column and opens full size with zoom and pan, and invalid syntax shows the error and the source", async ({
  page,
}) => {
  const errors = await openThread(page);
  const small = page.getByRole("figure", { name: "Thread framework", exact: true });
  const wide = page.getByRole("figure", { name: "Delivery stages", exact: true });
  await expect(wide.getByRole("img", { name: "Delivery stages" })).toBeVisible({ timeout: 30000 });

  // A diagram that stays readable fits the column; a wider one keeps a readable scale and scrolls horizontally.
  await expect(small.getByRole("img", { name: "Thread framework" })).toBeVisible();
  await expect(small.getByRole("region")).toHaveCount(0);
  const scroller = wide.getByRole("region", { name: "Delivery stages, scrolls horizontally", exact: true });
  await expect(scroller).toBeVisible();
  const wideImage = scroller.getByRole("img", { name: "Delivery stages" });
  const natural = Number(await wideImage.getAttribute("width"));
  const drawnWidth = (await wideImage.boundingBox())?.width ?? 0;
  expect(drawnWidth).toBeGreaterThanOrEqual(Math.round(natural * 0.6) - 1);
  expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await scroller.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await noPageOverflow(page)).toBe(true);

  // Full screen with zoom and pan; Escape leaves it and returns focus to the button that opened it.
  const open = wide.getByRole("button", { name: "Show Delivery stages full screen", exact: true });
  await open.click();
  await expect.poll(() => wide.getAttribute("data-mode")).toMatch(/^(fullscreen|enlarged)$/);
  if ((await wide.getAttribute("data-mode")) === "fullscreen")
    expect(await wide.evaluate((element) => document.fullscreenElement === element)).toBe(true);
  const canvas = wide.getByRole("application", { name: "Delivery stages", exact: true });
  await expect(canvas).toBeFocused();
  const level = wide.getByRole("status", { name: "Zoom level" });
  const zoom = async () => Number((await level.textContent())?.replace(/\D/g, ""));
  const fitted = await zoom();
  const picture = canvas.getByRole("img", { name: "Delivery stages" });
  const area = await canvas.boundingBox();
  if (!area) throw new Error("The canvas has no box");
  // Fitted: the whole diagram spans the canvas.
  expect((await picture.boundingBox())?.width ?? 0).toBeGreaterThan(area.width * 0.9);
  await page.keyboard.press("+");
  await expect.poll(zoom).toBeGreaterThan(fitted);
  await wide.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect.poll(zoom).toBe(fitted);
  await wide.getByRole("button", { name: "Actual size", exact: true }).click();
  await expect(level).toHaveText("100%");
  const before = await picture.evaluate((element) => (element as HTMLElement).style.transform);
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => picture.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(before);
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect.poll(zoom).toBeGreaterThan(100);
  await page.keyboard.press("Escape");
  await expect(wide).toHaveAttribute("data-mode", "inline");
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(open).toBeFocused();

  // Invalid syntax: Mermaid's error and the source, and the rest of the document still renders.
  const invalid = page.getByRole("figure", { name: "Goal · diagram 3", exact: true });
  await expect(invalid.getByText("Invalid Mermaid syntax")).toBeVisible();
  await expect(invalid.getByText(/Parse error on line/)).toBeVisible();
  await expect(invalid.locator("code")).toHaveText("flowchart LR\n  A[Start] --> ((");
  const threadDocument = page.getByRole("article", { name: "Thread document" });
  await expect(threadDocument.getByText("The document continues after the diagrams.")).toBeVisible();
  await expect(
    threadDocument.getByRole("region", { name: "Requirement: Document diagrams", exact: true }),
  ).toBeVisible();

  // At phone width the small diagram still fits, the wide one still scrolls, and nothing overflows the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(scroller).toBeVisible();
  await expect(small.getByRole("region")).toHaveCount(0);
  const column = await small.evaluate((element) => element.clientWidth);
  expect((await small.getByRole("img").boundingBox())?.width ?? 0).toBeLessThanOrEqual(column);
  expect(await noPageOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("REQ-090 AC1 a mission shows one segment per Check in Procedure order with its state and name", async ({
  page,
}) => {
  const errors = await openPlan(page);
  await expect(missionCards(page)).toHaveCount(MISSIONS.length, { timeout: 30000 });

  // One step per Check of the pinned Procedure, in source order (claim, verify, review), not alphabetical.
  const expected: Record<string, { pill: string; steps: [string, string, string] }> = {
    "mission-complete": { pill: "Complete", steps: ["Validated", "Validated", "Validated"] },
    "mission-running": { pill: "In progress", steps: ["Validated", "In progress", "To come"] },
    "mission-refused": { pill: "In progress", steps: ["Validated", "Not validated", "To come"] },
    "mission-relaunched": { pill: "In progress", steps: ["Validated", "In progress", "To come"] },
    "mission-escalated": { pill: "Escalated", steps: ["Validated", "Escalated", "To come"] },
  };
  const iconFill: Record<string, string[]> = {};
  for (const [mission, { pill, steps }] of Object.entries(expected)) {
    const done = steps.filter((state) => state === "Validated").length;
    // The row: its state, its identifier, its validated Checks; the whole row opens the mission page.
    const row = missionCard(page, mission);
    await expect(row.locator(".corpus-state-pill")).toHaveText(pill);
    await expect(row).toContainText(`${done} of 3 Checks`);
    await row.getByRole("link", { name: mission, exact: true }).click();
    await expect(page).toHaveURL(/view=mission/);
    await expect(page.getByRole("heading", { name: mission, level: 1 })).toBeVisible();
    const track = page.getByRole("list", { name: `Progress: ${done} of 3 Checks validated` });
    await expect(track.getByRole("listitem")).toHaveText([
      new RegExp(`claim work\\s*${steps[0]}`),
      new RegExp(`verify work\\s*${steps[1]}`),
      new RegExp(`review work\\s*${steps[2]}`),
    ]);
    iconFill[mission] = await track
      .locator("[data-step-icon]")
      .evaluateAll((icons) =>
        icons.map((icon) => getComputedStyle(icon).backgroundColor + getComputedStyle(icon).borderColor),
      );
    await page.goBack();
    await expect(missionCards(page)).toHaveCount(MISSIONS.length, { timeout: 30000 });
  }
  // A refused Check reads apart from an escalated one and from a Check still to come.
  const refused = iconFill["mission-refused"]?.[1];
  expect(refused).toBeDefined();
  expect(refused).not.toBe(iconFill["mission-escalated"]?.[1]);
  expect(refused).not.toBe(iconFill["mission-refused"]?.[2]);

  // Keyboard: a step is a link to its Check on the mission page.
  await missionCard(page, "mission-escalated").getByRole("link", { name: "mission-escalated", exact: true }).click();
  const track = page.getByRole("list", { name: "Progress: 1 of 3 Checks validated" });
  const verify = track.getByRole("link").filter({ hasText: "verify work" });
  await verify.focus();
  await expect(verify).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/view=mission/);
  await expect(page).toHaveURL(/check=verify\+work/);
  await expect(page.getByRole("heading", { name: "mission-escalated", level: 1 })).toBeVisible();
  await expect(page.locator("details[open] summary").filter({ hasText: "verify work" })).toBeVisible();
  await expect(track.getByRole("listitem").nth(0)).toHaveAttribute("data-step-state", "validated");
  await expect(track.getByRole("listitem").nth(1)).toHaveAttribute("data-step-state", "owner");
  await expect(track.getByRole("listitem").nth(2)).toHaveAttribute("data-step-state", "waiting");
  expect(errors).toEqual([]);
});

test("REQ-090 AC2 a mission card shows its generation, start time and end time with duration or latest activity", async ({
  page,
}) => {
  const errors = await openPlan(page);
  await expect(missionCards(page)).toHaveCount(MISSIONS.length, { timeout: 30000 });
  const branches = (await episode()).branches;
  const branch = (mission: string) => {
    const found = branches.find((candidate) => candidate.invocation.mission?.id === mission);
    if (!found?.child) throw new Error(`Mission ${mission} is absent`);
    return found;
  };
  /** The head of the mission page, opened from its row. */
  const head = async (target: Page, mission: string) => {
    await missionCard(target, mission).getByRole("link", { name: mission, exact: true }).click();
    await expect(target.getByRole("heading", { name: mission, level: 1 })).toBeVisible();
    return target.locator("header").filter({ has: target.getByRole("heading", { name: mission, level: 1 }) });
  };
  const back = async (target: Page) => {
    await target.goBack();
    await expect(missionCards(target)).toHaveCount(MISSIONS.length, { timeout: 30000 });
  };

  // Complete: generation, start, end and duration.
  const complete = branch("mission-complete");
  const start = complete.child?.plan.createdAt ?? "";
  const end = latestActivity(complete);
  const minutes = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60000));
  let card = await head(page, "mission-complete");
  await expect(card).toContainText("Generation 1");
  await expect(card).toContainText(`${shown(start)} → ${shown(end, start)} · ${minutes} min`);
  await back(page);
  // In progress or escalated: start and latest activity, the escalation included; the current generation's start.
  for (const mission of ["mission-running", "mission-refused", "mission-relaunched", "mission-escalated"]) {
    const current = branch(mission);
    const started = current.child?.plan.createdAt ?? "";
    card = await head(page, mission);
    await expect(card).toContainText(mission === "mission-relaunched" ? "Generation 2" : "Generation 1");
    await expect(card).toContainText(
      `Started ${shown(started)} · last activity ${shown(latestActivity(current), started)}`,
    );
    expect(await noPageOverflow(page)).toBe(true);
    await back(page);
  }
  expect(await noPageOverflow(page)).toBe(true);
  // Nothing on a row overflows it at desktop and phone widths.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflowing = await missionCards(page).evaluateAll((cards) =>
      cards.flatMap((card) => {
        const box = card.getBoundingClientRect();
        return [...card.querySelectorAll("*")]
          .filter((element) => {
            const inner = element.getBoundingClientRect();
            return inner.width > 0 && (inner.right > box.right + 0.5 || inner.left < box.left - 0.5);
          })
          .map((element) => element.textContent);
      }),
    );
    expect(overflowing, `at ${width} px`).toEqual([]);
    expect(await noPageOverflow(page), `at ${width} px`).toBe(true);
  }

  // The same in French.
  const french = await page.context().newPage();
  const frenchErrors = await openPlan(french, "fr");
  await expect(missionCard(french, "mission-running")).toContainText("1 sur 3 Checks");
  await expect(french.getByText("Terminées : 1 sur 5")).toBeVisible();
  const relaunched = await head(french, "mission-relaunched");
  await expect(relaunched).toContainText("Génération 2");
  await expect(relaunched).toContainText("Démarrée");
  await expect(french.getByRole("list", { name: "Progression : 1 sur 3 Checks validés" })).toBeVisible();
  expect(frenchErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test("REQ-090 AC3 missions are sorted by latest activity, most recent first", async ({ page }) => {
  const errors = await openPlan(page);
  await expect(missionCards(page)).toHaveCount(MISSIONS.length, { timeout: 30000 });
  await expect.poll(() => missionOrder(page)).toEqual(MISSIONS.map((mission) => mission.id));
  // Live updates keep the page in place: its title is the same element afterwards.
  const diagram = page.getByRole("heading", { name: FRAMEWORK_PLAN, level: 1 });
  await diagram.evaluate((element) => {
    (element as HTMLElement).dataset.probe = "kept";
  });

  // A qualification moves its mission first, without reloading the page.
  expect((await runCheck(await childPlan("mission-running"), "verify work")).verdict).toBe("VALIDATED");
  await expect
    .poll(() => missionOrder(page), { timeout: 20000 })
    .toEqual(["mission-running", "mission-complete", "mission-refused", "mission-relaunched", "mission-escalated"]);

  // An escalation alone is activity too: the refused mission is escalated and moves first.
  const refused = await childPlan("mission-refused");
  const verify = await checkOf(refused, "verify work");
  const attempts = (await episode()).branches
    .find((branch) => branch.invocation.mission?.id === "mission-refused")
    ?.child?.checks.find((check) => check.name === "verify work")?.attempts;
  await rpc("check.escalate", {
    contract: "trust.check-escalation-request@1",
    checkUri: verify.checkUri,
    attemptHandle: attempts?.at(-1)?.handle,
    blockingReason: "The verification refuses the delivered work.",
    forbiddenFurtherAction: "Do not rerun the verification before the operator decides.",
  });
  await expect
    .poll(() => missionOrder(page), { timeout: 20000 })
    .toEqual(["mission-refused", "mission-running", "mission-complete", "mission-relaunched", "mission-escalated"]);
  // Its row reads escalated at its verification.
  await expect(missionCard(page, "mission-refused").locator(".corpus-state-pill")).toHaveText("Escalated");
  await expect(missionCard(page, "mission-refused")).toContainText("at: verify work");
  await expect(diagram).toHaveAttribute("data-probe", "kept");
  expect(errors).toEqual([]);
});
