import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Locator, type Page, test } from "@playwright/test";

/* Documentation screenshots — run with `npm run docs:capture` (Playwright project `docs-capture`).
   Each shot opens a real screen of the seeded runtime, in light and dark theme, and writes
   `<id>.<theme>.<language>.png` (1.5× pixel ratio) plus a JSON sidecar with the boxes (in % of the image)
   of the elements marked `data-doc="…"` the documentation annotates. The pages then draw the callouts. */

const captures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/trust-ui/src/docs/captures");
const themes = ["light", "dark"] as const;
const languages = ["en", "fr"] as const;
const runtimeUrl = "http://127.0.0.1:4390";

interface Shot {
  id: string;
  path: string;
  density?: "operator" | "expert";
  /** Marker keys the documentation references (unknown keys are ignored). */
  callouts: string[];
  /** Runs after the page loaded, before the screenshot (fill forms, select a run…). */
  prepare?: (page: Page) => Promise<void>;
  /** Region to capture — the whole viewport by default. */
  clip?: (page: Page) => Locator;
}

const shots: Shot[] = [
  {
    id: "operations-catalog",
    path: "/operations",
    callouts: ["home.header", "home.filters", "home.display", "home.card", "operations.runnable", "shell.environment"],
    prepare: async (page) => { await expect(page.locator("[data-doc='home.card']").first()).toBeVisible(); },
  },
  {
    id: "operation-overview",
    path: "/operations/git.head-read",
    callouts: ["overlay.header", "overlay.actions", "overlay.tabs", "overlay.status", "operation.summary", "overlay.inspector"],
    prepare: async (page) => { await expect(page.locator("[data-doc='operation.summary']")).toBeVisible(); },
  },
  {
    id: "operation-source",
    path: "/operations/git.head-read?tab=source",
    callouts: ["editor", "editor.format", "overlay.status"],
    prepare: async (page) => { await expect(page.locator(".monaco-editor .view-lines")).toBeVisible(); await page.waitForTimeout(600); },
  },
  {
    id: "operation-simulate",
    path: "/operations/git.head-read?tab=simulation",
    callouts: ["simulation.input", "simulation.steps", "simulation.run", "simulation.result"],
    prepare: async (page) => {
      await page.locator("#sim-input-project").fill("trust");
      await page.locator("#sim-env-workspaceRoot").fill("/srv/projects");
      await page.locator("#sim-step-head-exitCode").fill("0");
      await page.locator("#sim-step-head-stdout").fill("9f1c2e7a4b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e\n");
      await page.locator("#sim-step-head-stderr").fill("");
      await page.locator("#sim-step-status-exitCode").fill("0");
      await page.locator("#sim-step-status-stdout").fill("");
      await page.locator("#sim-step-status-stderr").fill("");
      await page.locator("[data-doc='simulation.run']").click();
      await expect(page.locator("[data-doc='simulation.result'] table")).toBeVisible();
      await page.locator("[data-doc='simulation.input']").scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    },
  },
  {
    id: "operation-run",
    path: "/operations/git.head-read?tab=run",
    callouts: ["run.environment", "run.input", "run.start", "run.recent", "run.report"],
    prepare: async (page) => {
      // One real run so the report is not empty (the seeded `local` Environment points at the workspace root).
      const response = await page.request.post(`${runtimeUrl}/rpc`, { data: { jsonrpc: "2.0", id: 1, method: "operation.trial.start", params: { operation: "git.head-read", version: "1.0.0", environment: "local", input: { project: "trust" } } } });
      expect(response.ok()).toBeTruthy();
      await page.waitForTimeout(2500);
      await page.reload();
      await page.locator("#run-input-project").fill("trust");
      await page.locator("[data-doc='run.recent'] button").first().click();
      await expect(page.locator("[data-doc='run.report'] h4").first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(800);
    },
  },
  {
    id: "procedures-catalog",
    path: "/procedures",
    callouts: ["home.header", "home.filters", "home.display", "home.card"],
    prepare: async (page) => { await expect(page.locator("[data-doc='home.card']").first()).toBeVisible(); },
  },
  {
    id: "procedure-overview",
    path: "/procedures/patient-admission",
    callouts: ["overlay.header", "overlay.actions", "overlay.tabs", "overlay.status", "procedure.summary", "overlay.inspector"],
    prepare: async (page) => { await expect(page.locator("[data-doc='procedure.summary']")).toBeVisible(); },
  },
  {
    id: "procedure-graph",
    path: "/procedures/patient-admission?tab=dag&sel=check%3Aadmission",
    callouts: ["graph.canvas", "graph.legend", "graph.scenario", "graph.panel"],
    prepare: async (page) => {
      await expect(page.locator("[data-doc='graph.panel']")).toBeVisible();
      await page.waitForTimeout(1200);
    },
  },
  {
    id: "procedure-source",
    path: "/procedures/patient-admission?tab=source",
    callouts: ["editor", "editor.format", "overlay.status"],
    prepare: async (page) => { await expect(page.locator(".monaco-editor .view-lines")).toBeVisible(); await page.waitForTimeout(600); },
  },
  {
    id: "procedure-walk",
    path: "/procedures/patient-admission?tab=simulation",
    callouts: ["walk.controls", "walk.scenarios"],
    prepare: async (page) => {
      await page.locator("[data-doc='walk.controls'] button").first().click();
      await page.locator("[data-doc='walk.controls'] button").first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    id: "environments-catalog",
    path: "/environments",
    callouts: ["home.header", "home.filters", "home.card", "shell.environment"],
    prepare: async (page) => { await expect(page.locator("[data-doc='home.card']").first()).toBeVisible(); },
  },
  {
    id: "environment-page",
    path: "/environments/local",
    callouts: ["overlay.header", "overlay.actions", "environment.values", "environment.credentials", "environment.coverage", "overlay.inspector"],
    prepare: async (page) => { await expect(page.locator("[data-doc='environment.coverage'] table")).toBeVisible(); },
  },
  {
    id: "shell",
    path: "/overview",
    callouts: ["shell.sidebar", "shell.search", "shell.environment", "shell.density"],
    prepare: async (page) => { await page.waitForTimeout(800); },
  },
  {
    id: "history",
    path: "/history",
    callouts: ["home.filters", "home.display", "home.content"],
    prepare: async (page) => { await page.waitForTimeout(800); },
  },
  {
    id: "plan-engage",
    path: "/dry-runs/new",
    callouts: ["overlay.header", "engage.form"],
    prepare: async (page) => { await expect(page.locator("[data-doc='engage.form']")).toBeVisible(); },
  },
  {
    id: "plan-page",
    path: "/plans/interface-acceptance",
    callouts: ["overlay.header", "overlay.tabs", "plan.summary", "plan.checklist", "plan.checkDetail"],
    prepare: async (page) => {
      await page.locator("[data-doc='plan.checklist'] button").first().click();
      await expect(page.locator("[data-doc='plan.checkDetail']")).toBeVisible();
      await page.waitForTimeout(600);
    },
  },
  {
    id: "dryrun-cockpit",
    path: "/dry-runs/rehearsal-docs",
    callouts: ["cockpit", "cockpit.todo", "cockpit.workbench", "cockpit.submit"],
    prepare: async (page) => {
      const response = await page.request.post(`${runtimeUrl}/rpc`, { data: { jsonrpc: "2.0", id: 1, method: "plan.engage", params: { contract: "trust.plan-engagement-request@1", procedure: "mono-project-change", procedureVersion: "1.0.0", plan: "rehearsal-docs", environment: "local", rootInputs: { "jira issue": "PAY-42", project: "payment-api" }, mode: "dry-run" } } });
      expect(response.ok()).toBeTruthy();
      await page.reload();
      await expect(page.locator("[data-doc='cockpit.workbench']")).toBeVisible({ timeout: 15_000 });
      await page.locator("[data-doc='cockpit.workbench'] button").first().click().catch(() => undefined);
      await page.waitForTimeout(500);
    },
  },
];

// 1.5× keeps text crisp on retina while halving the weight of a 2× capture (two themes × two languages).
test.use({ deviceScaleFactor: 1.5, viewport: { width: 1440, height: 900 } });

for (const shot of shots) {
  for (const theme of themes) {
    for (const language of languages) {
      test(`${shot.id} · ${theme} · ${language}`, async ({ page }) => {
        await page.addInitScript(
          (value) => localStorage.setItem("trust.ui.preferences", JSON.stringify(value)),
          { state: { theme, language, density: shot.density ?? "operator", environment: "local", docsNavOpen: true, inspectorOpen: true }, version: 0 },
        );
        await page.goto(shot.path);
        await page.locator("main").waitFor();
        await shot.prepare?.(page);
        await page.evaluate(() => document.fonts.ready);
        await mkdir(captures, { recursive: true });
        const name = `${shot.id}.${theme}.${language}`;
        const region = shot.clip ? await shot.clip(page).boundingBox() : { x: 0, y: 0, width: 1440, height: 900 };
        if (!region) throw new Error(`No region for ${shot.id}`);
        await page.screenshot({ path: path.join(captures, `${name}.png`), clip: region, animations: "disabled", caret: "hide" });
        const callouts: Array<{ key: string; x: number; y: number; w: number; h: number }> = [];
        for (const key of shot.callouts) {
          const raw = await page.locator(`[data-doc='${key}']`).first().boundingBox().catch(() => null);
          if (!raw) continue;
          // Keep the visible part only (a scrolled panel may push a marker partly out of the picture).
          const left = Math.max(raw.x, region.x);
          const top = Math.max(raw.y, region.y);
          const right = Math.min(raw.x + raw.width, region.x + region.width);
          const bottom = Math.min(raw.y + raw.height, region.y + region.height);
          if (right - left < 4 || bottom - top < 4) continue;
          callouts.push({
            key,
            x: round(((left - region.x) / region.width) * 100),
            y: round(((top - region.y) / region.height) * 100),
            w: round(((right - left) / region.width) * 100),
            h: round(((bottom - top) / region.height) * 100),
          });
        }
        await writeFile(path.join(captures, `${name}.json`), `${JSON.stringify({ width: region.width * 1.5, height: region.height * 1.5, density: shot.density ?? "operator", callouts }, null, 2)}\n`);
      });
    }
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
