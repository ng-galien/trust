import { expect, type Locator, type Page, test } from "@playwright/test";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

test("Procedure display wrapping leaves source unchanged and draft changes can be discarded", async ({ page }) => {
  await page.goto("/procedures/git-status?tab=source");
  const editor = page.locator(".monaco-editor");
  await expect(editor.locator(".view-lines")).toContainText("Feature:", { timeout: 15_000 });
  const publish = page.getByRole("button", { name: "Publish version", exact: true });
  const wrap = page.getByRole("button", { name: "Wrap lines", exact: true });
  await expect(publish).toBeDisabled();
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await expect(publish).toBeDisabled();
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toBeHidden();
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  const chaining = page.getByRole("switch", { name: "Intent chaining" });
  await chaining.click();
  await expect(page.getByText("Unpublished changes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(chaining).toHaveAttribute("aria-checked", "false");
  await expect(editor).not.toContainText("@intent-chaining");
  await expect(publish).toBeDisabled();
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toBeHidden();
});

test("minified theme colors preserve the editor and real LSP completion", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // Production CSS minifies six-digit hex values to their equivalent shorthand.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.setProperty("--color-editor-bg", "#fff");
      document.documentElement.style.setProperty("--color-text", "#123");
    });
  });
  await page.goto("/operations/git.head-read?tab=source");
  const editor = page.locator(".monaco-editor");
  await expect(editor.locator(".view-lines")).toContainText("steps.head.stdout", { timeout: 15_000 });
  await expect(page.getByText("Language server unavailable")).toBeHidden();
  await expect(page.getByText("Editor unavailable")).toBeHidden();
  expect(errors).toEqual([]);
  const line = editor.locator(".view-line").filter({ hasText: "$trim(steps.head.stdout)" });
  await placeCursorAfterDot(page, line, "steps");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".suggest-widget")).toContainText("head");
  expect(errors).toEqual([]);
});

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
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Perform only the actions declared by this Procedure. | Alter the environment or accepted observations to make a Check pass. |
    Given one reference "repository"

  @scenario:invalid
  Scenario: Invalid draft
    Then Check "invalid" runs Operation "missing.operation@*" on "repository" as Input "project" and must establish "the draft is invalid"
      """js
      true
      """
`);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/requires one Operation matching "missing.operation@\*"/)).toBeVisible();
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
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Perform only the actions declared by this Procedure. | Alter the environment or accepted observations to make a Check pass. |
    Given one reference "repository"

  @scenario:comment
  Scenario: Ignore the comment marker
    Then Check "comment" runs Operation "missing.operation@*" on "repository" as Input "project" and must establish "the comment is ignored"
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
  const featureLine = editor.locator(".view-line").filter({ hasText: "Feature: Read Git HEAD and working tree" });
  await expectTokenTone(page, featureLine.getByText("Feature", { exact: true }), "--color-editor-keyword-control");

  const jsonataLine = editor.locator(".view-line").filter({ hasText: "$trim(steps.head.stdout)" });
  await expect(jsonataLine).toBeVisible();
  const functionToken = jsonataLine.getByText("$trim", { exact: true });
  await expect(functionToken).toBeVisible();
  await expectTokenTone(page, functionToken, "--color-editor-keyword-control");
  await expectTokenTone(page, jsonataLine.getByText("steps", { exact: true }), "--color-editor-keyword");
  await expectTokenTone(page, jsonataLine.getByText("head", { exact: true }), "--color-editor-property");

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

async function expectTokenTone(page: Page, token: Locator, variable: string): Promise<void> {
  await expect(token).toBeVisible();
  const actual = await token.evaluate((element) => getComputedStyle(element).color);
  const expected = await page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, variable);
  expect(actual).toBe(expected);
}
