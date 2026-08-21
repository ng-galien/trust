import { expect, test, type Locator, type Page } from "@playwright/test";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

test("the Procedure editor is backed by the LSP and understands its JS qualification", async ({ page }) => {
  await page.goto("/procedures/git-status?tab=source");
  const editor = page.locator(".monaco-editor");
  await expect(editor).toBeVisible();

  const jsLine = editor.locator(".view-line").filter({ hasText: "fact.workingTree" });
  await expect(jsLine).toBeVisible();
  await expect(jsLine.getByText("===", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit source" }).click();

  await placeCursorAfterDot(page, jsLine, "fact");
  await page.keyboard.press("Control+Space");
  const suggestions = page.locator(".suggest-widget");
  await expect(suggestions).toBeVisible();
  await expect(suggestions).toContainText("headRevision");
  await expect(suggestions).toContainText("workingTree");
  await page.keyboard.press("Escape");

  await placeCursorAfterDot(page, jsLine, "fact");
  for (let index = 0; index < "workingTree".length; index += 1) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.insertText("missingField");
  await expect(page.getByText(/produces no field "missingField"/)).toBeVisible();
  await expect(editor.locator(".squiggly-error")).toBeVisible();

  await page.keyboard.press(`${modifier}+z`);
  await expect(page.getByText(/produces no field "missingField"/)).toBeHidden();
});

test("the Operation editor embeds JSONata and completes its typed step context", async ({ page }) => {
  await page.goto("/operations/git.head-read?tab=source");
  const editor = page.locator(".monaco-editor");
  await expect(editor).toBeVisible();

  const jsonataLine = editor.locator(".view-line").filter({ hasText: "$trim(steps.head.stdout)" });
  await expect(jsonataLine).toBeVisible();
  await expect(jsonataLine.getByText("$trim", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit source" }).click();

  await placeCursorAfterDot(page, jsonataLine, "steps");
  await page.keyboard.press("Control+Space");
  const suggestions = page.locator(".suggest-widget");
  await expect(suggestions).toBeVisible();
  await expect(suggestions).toContainText("head");
  await expect(suggestions).toContainText("status");
});

test("the editor reconnects its LSP session after a transport interruption", async ({ page }) => {
  let languageServerAvailable = false;
  await page.routeWebSocket("**/lsp", (socket) => {
    if (languageServerAvailable) socket.connectToServer();
    else socket.close();
  });
  await page.goto("/operations/git.head-read?tab=source");
  const editor = page.locator(".monaco-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByText("Language server unavailable")).toBeVisible();
  languageServerAvailable = true;
  await expect(page.getByText("Language server unavailable")).toBeHidden();

  await page.getByRole("button", { name: "Edit source" }).click();
  const jsonataLine = editor.locator(".view-line").filter({ hasText: "$trim(steps.head.stdout)" });
  await placeCursorAfterDot(page, jsonataLine, "steps");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".suggest-widget")).toContainText("head");
});

test("the Operation editor synchronizes the LSP when client-side navigation reuses Monaco", async ({ page }) => {
  await page.goto("/operations/git.head-read?tab=source");
  const editor = page.locator(".monaco-editor");
  await expect(editor).toBeVisible();
  await expect(editor.locator(".view-line").filter({ hasText: "$trim(steps.head.stdout)" })).toBeVisible();

  await page.evaluate(() => {
    history.pushState({}, "", "/operations/aviation.aircraft-read?tab=source");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/operations\/aviation\.aircraft-read/);
  const aircraftLine = editor.locator(".view-line").filter({ hasText: "steps.aircraft.body.maintenanceStatus" });
  await expect(aircraftLine).toBeVisible();
  await page.getByRole("button", { name: "Edit source" }).click();

  await placeCursorAfterDot(page, aircraftLine, "steps");
  await page.keyboard.press("Control+Space");
  const suggestions = page.locator(".suggest-widget");
  await expect(suggestions).toBeVisible();
  await expect(suggestions).toContainText("aircraft");
  await expect(suggestions).not.toContainText("status");
});

async function placeCursorAfterDot(page: Page, line: Locator, identifier: string): Promise<void> {
  const token = line.getByText(identifier, { exact: true });
  const box = await token.boundingBox();
  if (!box) throw new Error(`The ${identifier} token is not visible`);
  const characterWidth = box.width / identifier.length;
  await page.mouse.click(box.x + box.width + characterWidth * 0.7, box.y + box.height / 2);
}
