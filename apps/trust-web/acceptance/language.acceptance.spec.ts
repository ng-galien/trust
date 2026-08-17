import { expect, test } from "@playwright/test";

/* URLs are the same in every language: the language is a display preference, never part of the address. */

const preferences = (language: "en" | "fr") => ({ state: { language, theme: "light" }, version: 0 });

for (const language of ["en", "fr"] as const) {
  test(`the same operation URL opens the same tab in ${language}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("trust.ui.preferences", JSON.stringify(value)), preferences(language));
    await page.goto("/operations/git.head-read?tab=run");
    await expect(page.locator("#operation-title")).toHaveText("Read Git HEAD and working tree");
    await expect(page).toHaveURL(/tab=run/);
    // The tab labels are translated, the URL is not.
    await expect(page.getByRole("tab", { name: language === "fr" ? "Exécuter" : "Run" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Source" }).click();
    await expect(page).toHaveURL(/tab=source/);
  });
}

test("switching the language keeps the address untouched", async ({ page }) => {
  await page.goto("/operations/git.head-read?tab=simulation");
  await page.goto("/settings");
  await page.getByRole("tab", { name: /Français/ }).click();
  await expect(page.getByRole("heading", { name: "Paramètres" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/operations\/git\.head-read\?tab=simulation/);
  await expect(page.getByRole("tab", { name: "Simuler" })).toHaveAttribute("aria-selected", "true");
});

test("the header actions switch tabs in French too", async ({ page }) => {
  await page.addInitScript((value) => localStorage.setItem("trust.ui.preferences", JSON.stringify(value)), preferences("fr"));
  await page.goto("/operations/aviation.aircraft-read");
  await expect(page.locator("#operation-title")).toHaveText("Read simulated aircraft release data");
  const header = page.locator("#operation-title").locator("xpath=ancestor::header");
  await header.getByRole("button", { name: "Exécuter", exact: true }).click();
  await expect(page).toHaveURL(/tab=run/);
  await expect(page.getByRole("tab", { name: "Exécuter" })).toHaveAttribute("aria-selected", "true");
  await header.getByRole("button", { name: "Simuler", exact: true }).click();
  await expect(page).toHaveURL(/tab=simulation/);
});
