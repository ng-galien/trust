import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CORPUS_RUNTIME_PORT, DIAGRAM_THREAD, FRAMEWORK_PLAN, MISSIONS } from "./support/corpus-fixture.js";

/* The Corpus extension, built from its sources, on a disposable runtime seeded by support/corpus-server.mjs. */

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const runtime = `http://127.0.0.1:${CORPUS_RUNTIME_PORT}`;
const threadUrl = `/extensions/corpus?thread=${DIAGRAM_THREAD}`;
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

async function rpc<Result>(method: string, params: unknown): Promise<Result> {
  const response = await fetch(`${runtime}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  const payload = (await response.json()) as { result?: Result; error?: unknown };
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result as Result;
}
const episode = async () =>
  (await (await fetch(`${runtime}/extensions/corpus/trust/episodes/${FRAMEWORK_PLAN}`)).json()) as Episode;
async function childPlan(mission: string) {
  const plan = await rpc<Episode["root"]["plan"]>("plan.read", { plan: FRAMEWORK_PLAN });
  const child = plan.invocations.find((invocation) => invocation.mission?.id === mission)?.childPlan;
  if (!child) throw new Error(`Mission ${mission} has no child Plan`);
  return child;
}
async function checkOf(plan: string, name: string) {
  const read = await rpc<{ checks: { name: string; checkUri: string }[] }>("plan.read", { plan });
  const check = read.checks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`Check ${name} is absent from ${plan}`);
  return check;
}
/** Facts reach TRUST only through the Runner, exactly as a worker runs a Check. */
async function runCheck(plan: string, name: string) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TRUST_")));
  const { stdout } = await exec(
    process.execPath,
    [
      path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"),
      (await checkOf(plan, name)).checkUri,
      "--json",
    ],
    {
      env: { ...environment, TRUST_RPC_ENDPOINT: `${runtime}/rpc`, TRUST_OTLP_ENDPOINT: `${runtime}/v1/traces` },
      timeout: 60000,
    },
  );
  return (JSON.parse(stdout) as { result: { qualification: { verdict: string } } }).result.qualification;
}

const preferences = (language: "en" | "fr") => ({ state: { language, theme: "light" }, version: 0 });
/** Opens the thread in a fresh light session and fails the test on any console error or page error. */
async function openThread(page: Page, language: "en" | "fr" = "en") {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    (value) => localStorage.setItem("trust.ui.preferences", JSON.stringify(value)),
    preferences(language),
  );
  await page.goto(threadUrl);
  await expect(page.getByRole("heading", { name: "Document diagrams", level: 1 })).toBeVisible({ timeout: 30000 });
  return errors;
}
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
const noPageOverflow = (page: Page) =>
  page.evaluate(() => {
    const app = document.querySelector(".corpus-app");
    return document.documentElement.scrollWidth <= innerWidth && (!app || app.scrollWidth <= app.clientWidth);
  });
const missionCards = (page: Page) =>
  page
    .getByRole("region", { name: "Missions", exact: true })
    .getByRole("listitem")
    .filter({
      has: page.getByRole("list", { name: /^(Progress: |Progression : )/ }),
    });
const missionCard = (page: Page, mission: string) =>
  missionCards(page).filter({ has: page.getByRole("link", { name: mission, exact: true }) });
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
  const errors = await openThread(page);
  const segments = (mission: string) => missionCard(page, mission).getByRole("list", { name: /^Progress: / });
  await expect(missionCards(page)).toHaveCount(MISSIONS.length, { timeout: 30000 });

  // One segment per Check of the pinned Procedure, in source order (claim, verify, review), not alphabetical.
  const expected: Record<string, [string, string, string]> = {
    "mission-complete": ["Validated", "Validated", "Validated"],
    "mission-running": ["Validated", "In progress", "To come"],
    "mission-refused": ["Validated", "Not validated", "To come"],
    "mission-relaunched": ["Validated", "In progress", "To come"],
    "mission-escalated": ["Validated", "Escalated", "To come"],
  };
  for (const [mission, states] of Object.entries(expected)) {
    const done = states.filter((state) => state === "Validated").length;
    await expect(segments(mission)).toHaveAccessibleName(`Progress: ${done} of 3 Checks validated`);
    await expect(segments(mission).getByRole("link")).toHaveText([
      `claim work · ${states[0]}`,
      `verify work · ${states[1]}`,
      `review work · ${states[2]}`,
    ]);
    // The name and state are also the pointer tooltip.
    await expect(segments(mission).getByRole("link").nth(1)).toHaveAttribute("title", `verify work · ${states[1]}`);
  }
  // A refused Check reads apart from an escalated one and from a Check still to come.
  const fill = (mission: string, index: number) =>
    segments(mission)
      .getByRole("link")
      .nth(index)
      .evaluate(
        (element) =>
          getComputedStyle(element, "::before").backgroundImage + getComputedStyle(element, "::before").backgroundColor,
      );
  const refused = await fill("mission-refused", 1);
  expect(refused).not.toBe(await fill("mission-escalated", 1));
  expect(refused).not.toBe(await fill("mission-refused", 2));

  // Keyboard: a segment is a link to its Check on the mission page.
  const verify = segments("mission-escalated").getByRole("link", { name: "verify work · Escalated" });
  await verify.focus();
  await expect(verify).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/view=mission/);
  await expect(page).toHaveURL(/check=verify\+work/);
  await expect(page.getByRole("heading", { name: "mission-escalated", level: 1 })).toBeVisible();
  await expect(page.locator("details[open] summary").filter({ hasText: "verify work" })).toBeVisible();
  // The mission page shows the same progress.
  await expect(page.getByRole("list", { name: "Progress: 1 of 3 Checks validated" }).getByRole("link")).toHaveText([
    "claim work · Validated",
    "verify work · Escalated",
    "review work · To come",
  ]);
  expect(errors).toEqual([]);
});

test("REQ-090 AC2 a mission card shows its generation, start time and end time with duration or latest activity", async ({
  page,
}) => {
  const errors = await openThread(page);
  await expect(missionCards(page)).toHaveCount(MISSIONS.length, { timeout: 30000 });
  const branches = (await episode()).branches;
  const branch = (mission: string) => {
    const found = branches.find((candidate) => candidate.invocation.mission?.id === mission);
    if (!found?.child) throw new Error(`Mission ${mission} is absent`);
    return found;
  };

  await expect(missionCard(page, "mission-relaunched")).toContainText("Generation 2");
  for (const mission of ["mission-complete", "mission-running", "mission-refused", "mission-escalated"])
    await expect(missionCard(page, mission)).toContainText("Generation 1");

  // Complete: start, end and duration.
  const complete = branch("mission-complete");
  const start = complete.child?.plan.createdAt ?? "";
  const end = latestActivity(complete);
  const minutes = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60000));
  await expect(missionCard(page, "mission-complete")).toContainText(
    `${shown(start)} → ${shown(end, start)} · ${minutes} min`,
  );
  // In progress or escalated: start and latest activity, the escalation included; the current generation's start.
  for (const mission of ["mission-running", "mission-refused", "mission-relaunched", "mission-escalated"]) {
    const current = branch(mission);
    const started = current.child?.plan.createdAt ?? "";
    await expect(missionCard(page, mission)).toContainText(
      `Started ${shown(started)} · last activity ${shown(latestActivity(current), started)}`,
    );
  }
  expect(await noPageOverflow(page)).toBe(true);
  // Nothing on a card overflows it at desktop and phone widths.
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

  // The same card in French.
  const french = await page.context().newPage();
  const frenchErrors = await openThread(french, "fr");
  await expect(missionCard(french, "mission-relaunched")).toContainText("Génération 2");
  await expect(missionCard(french, "mission-running")).toContainText("Démarrée");
  await expect(
    missionCard(french, "mission-running").getByRole("list", { name: "Progression : 1 Checks validés sur 3" }),
  ).toBeVisible();
  await expect(french.getByText("Terminées : 1 sur 5")).toBeVisible();
  expect(frenchErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test("REQ-090 AC3 missions are sorted by latest activity, most recent first", async ({ page }) => {
  const errors = await openThread(page);
  await expect(missionCards(page)).toHaveCount(MISSIONS.length, { timeout: 30000 });
  await expect.poll(() => missionOrder(page)).toEqual(MISSIONS.map((mission) => mission.id));
  // Live updates keep the document in place: the drawn diagram is the same element afterwards.
  const diagram = page.getByRole("figure", { name: "Thread framework" }).getByRole("img");
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
  await expect(
    missionCard(page, "mission-refused").getByRole("link", { name: "verify work · Escalated" }),
  ).toBeVisible();
  await expect(diagram).toHaveAttribute("data-probe", "kept");
  expect(errors).toEqual([]);
});
