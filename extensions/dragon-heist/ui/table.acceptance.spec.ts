import { expect, test } from "@playwright/test";

test("real game table exposes bundled rules and sources without playing the game, on desktop and mobile", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/extensions/dragon-heist/api/games")).json();
  const catalog = await (await request.get("/extensions/dragon-heist/api/catalog")).json();
  expect(catalog.procedures).toHaveLength(5);
  expect(catalog.operations).toHaveLength(10);
  await page.goto("/extensions/dragon-heist");
  const table = page.getByRole("main", { name: "Dragon Heist game table" });
  await expect(table.getByRole("heading", { name: "DragonHeist" })).toBeVisible();
  await expect(table.getByText("Table connected", { exact: true })).toBeVisible();
  await expect(table.getByRole("region", { name: "The heist table" })).toBeVisible();
  await page.screenshot({ path: "extensions/dragon-heist/test-results/table-desktop.png", fullPage: true });
  await table.getByRole("button", { name: /TRUST Plan/ }).click();
  await expect(table.getByRole("dialog", { name: "Game context" })).toContainText("Intentions are declarations");
  await expect(table.getByRole("link", { name: "Open Plan" })).toHaveAttribute("href", /\/plans\//);
  await table.getByRole("button", { name: "Close game context" }).click();
  await table.locator(".heist-learning > summary").click();
  await expect(table.getByRole("tabpanel")).toContainText("A die is an observation, never a qualification.");
  await expect(table.getByRole("tabpanel")).toContainText("explicit operator resume");
  await expect(table.locator(".heist-rule-list > li")).toHaveCount(catalog.rules.length);
  for (const kind of ["Procedures", "Operations"]) {
    await table.getByRole("tab", { name: kind, exact: true }).click();
    const artifacts = kind === "Procedures" ? catalog.procedures : catalog.operations;
    await expect(table.locator(".heist-source-list > details")).toHaveCount(artifacts.length);
    const source = table.locator(".heist-source-list > details").first();
    await source.locator("summary").click();
    await expect(source.locator("pre")).toHaveText(artifacts[0].source);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await table.getByRole("tab", { name: "Rules", exact: true }).click();
  await expect(table.getByRole("tabpanel")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await table.getByRole("heading", { name: "DragonHeist" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "extensions/dragon-heist/test-results/table-mobile.png", fullPage: true });
  const after = await (await request.get("/extensions/dragon-heist/api/games")).json();
  expect(after).toEqual(before);
});
