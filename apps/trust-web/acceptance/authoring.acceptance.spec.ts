import { expect, test, type Locator, type Page } from "@playwright/test";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

test("the Procedure editor toggles intent chaining in the canonical source", async ({ page }) => {
  await page.goto("/procedures/git-status?tab=source");
  const editor = page.locator(".monaco-editor");
  await expect(editor).toBeVisible();

  const toggle = page.getByRole("switch", { name: "Intent chaining" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(editor).toContainText("@intent-chaining");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(editor).not.toContainText("@intent-chaining");

  await editor.locator(".view-lines").click();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(`# language: en
@intent-chaining
@trust-dsl:1 @procedure:toggle-invalid @version:1.0.0
Feature: Toggle an invalid draft

  Background: Plan context
    Given one reference "repository"

  @scenario:invalid
  Scenario: Invalid draft
    Then Check "invalid" runs Operation "missing.operation" on "repository" as Input "project" and must establish "the draft is invalid"
      """js
      true
      """
`);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/references unknown Operation "missing.operation"/)).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(editor).not.toContainText("@intent-chaining");

  await editor.locator(".view-lines").click();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(`# language: en
# documentation about @intent-chaining
@trust-dsl:1 @procedure:toggle-comment @version:1.0.0
Feature: Keep an intent marker in a comment

  Background: Plan context
    Given one reference "repository"

  @scenario:comment
  Scenario: Ignore the comment marker
    Then Check "comment" runs Operation "missing.operation" on "repository" as Input "project" and must establish "the comment is ignored"
      """js
      true
      """
`);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(editor).toContainText("# documentation about @intent-chaining");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(editor).toContainText("# documentation about @intent-chaining");
});

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

test("leaving an editor closes its LSP connection without stopping the runtime", async ({ page, request }) => {
  const sentMethods: string[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/lsp")) return;
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(payload.toString()) as { method?: string };
      if (message.method) sentMethods.push(message.method);
    });
  });
  await page.goto("/operations/git.head-read?tab=source");
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(page.getByText("Language server unavailable")).toBeHidden();

  await page.locator('aside[data-doc="shell.sidebar"]').getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect.poll(() => sentMethods).toContain("textDocument/didClose");
  expect(sentMethods).not.toContain("shutdown");
  expect(sentMethods).not.toContain("exit");
  const health = await request.get("http://127.0.0.1:4390/health");
  expect(health.status()).toBe(200);

  await page.goto("/operations/aviation.aircraft-read?tab=source");
  const editor = page.locator(".monaco-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByText("Language server unavailable")).toBeHidden();
  await page.getByRole("button", { name: "Edit source" }).click();
  const aircraftLine = editor.locator(".view-line").filter({ hasText: "steps.aircraft.body.maintenanceStatus" });
  await placeCursorAfterDot(page, aircraftLine, "steps");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".suggest-widget")).toContainText("aircraft");
});

async function placeCursorAfterDot(page: Page, line: Locator, identifier: string): Promise<void> {
  const token = line.getByText(identifier, { exact: true });
  const box = await token.boundingBox();
  if (!box) throw new Error(`The ${identifier} token is not visible`);
  const characterWidth = box.width / identifier.length;
  await page.mouse.click(box.x + box.width + characterWidth * 0.7, box.y + box.height / 2);
}
