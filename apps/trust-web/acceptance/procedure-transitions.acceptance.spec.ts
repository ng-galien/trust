import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { runtimeRpc } from "./support/runtime.js";

test("selected Procedure graph preserves a subsequent manual pan", async ({ page }) => {
  await page.goto("/procedures/git-status?tab=dag");
  const graph = page.locator('[data-doc="graph.canvas"]');
  const selection = graph.getByRole("button", { name: /Select this Check/ }).first();
  await expect(selection).toBeVisible();
  await selection.click();
  await expect(page).toHaveURL(/sel=/);
  const viewport = graph.locator(".react-flow__viewport");
  // Wait for the selection animation to settle before the independent user gesture.
  await page.waitForTimeout(400);
  const before = await viewport.getAttribute("style");
  const pane = await graph.locator(".react-flow__pane").boundingBox();
  if (!pane) throw new Error("Graph pane is unavailable");
  await page.mouse.move(pane.x + pane.width - 30, pane.y + 50);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width - 230, pane.y + 160, { steps: 10 });
  await page.mouse.up();
  const moved = await viewport.getAttribute("style");
  expect(moved).not.toBe(before);
  await page.waitForTimeout(450);
  expect(await viewport.getAttribute("style")).toBe(moved);
});

test("Procedure walkthrough resets when the selected published definition changes", async ({ page, request }) => {
  const source = await readFile(new URL("../../../assets/procedures/00-git-status.feature", import.meta.url), "utf8");
  for (const version of ["1.0.0", "1.1.0"]) {
    await runtimeRpc(request, "procedure.publish", {
      source: source
        .replace("@procedure:git-status", "@procedure:walk-transition")
        .replace(/@version:\S+/, `@version:${version}`),
      sourceName: "walk-transition.feature",
    });
  }
  await page.goto("/procedures/walk-transition?tab=simulation&version=1.0.0");
  const controls = page.locator('[data-doc="walk.controls"]');
  await controls.getByRole("button").first().click();
  await expect(controls.getByRole("button").nth(1)).toBeEnabled();
  await page.getByRole("combobox", { name: "Version", exact: true }).selectOption("1.1.0");
  await expect(page).toHaveURL(/version=1.1.0/);
  await expect(controls.getByRole("button").nth(1)).toBeDisabled();
  await expect(controls.getByRole("button").first()).toBeEnabled();
});

test("Procedure walkthrough progress survives unrelated query navigation and resets explicitly", async ({ page }) => {
  await page.goto("/procedures/git-status?tab=simulation");
  const controls = page.locator('[data-doc="walk.controls"]');
  const advance = controls.getByRole("button").first();
  await expect(advance).toBeEnabled();
  await advance.click();
  const reset = controls.getByRole("button").nth(1);
  await expect(reset).toBeEnabled();
  const progress = await controls.locator("p").textContent();
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("sel", "scenario:unrelated");
    window.history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(controls.locator("p")).toHaveText(progress ?? "");
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(reset).toBeDisabled();
  await expect(advance).toBeEnabled();
});
