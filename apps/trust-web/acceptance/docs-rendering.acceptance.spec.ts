import { expect, test } from "@playwright/test";

test("documentation navigation retains hash scrolling and keyboard visual controls", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/docs/screens");
  const expand = page.locator(".docs-screenshot").first().getByRole("button", { name: "View full screen" }).last();
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto("/docs/operations/anatomy#the-shape-of-the-document");
  await expect(page.locator("#the-shape-of-the-document")).toBeInViewport();
  await expect(page.locator(".docs-legend li")).toHaveCount(8);
  await expect(page.locator(".docs-line [data-token]").first()).toBeVisible();
  await page.goto("/docs/procedures/anatomy");
  await expect(page.locator(".docs-legend li")).toHaveCount(13);
  await page.goBack();
  await expect(page.locator("#the-shape-of-the-document")).toBeInViewport();
  expect(errors).toEqual([]);
});

test("mobile documentation contents close after keyboard navigation", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto("/docs/screens");
  await page.getByRole("button", { name: "Show the contents", exact: true }).click();
  const tree = page
    .locator("nav")
    .filter({ has: page.getByRole("link", { name: "Introduction", exact: true }) })
    .filter({ visible: true });
  const home = tree.getByRole("link", { name: "Introduction", exact: true });
  await home.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/docs$/);
  await expect(home).not.toBeVisible();
});
