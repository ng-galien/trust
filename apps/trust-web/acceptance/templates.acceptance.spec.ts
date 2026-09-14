import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { PublishedProcedure, SourceTemplate } from "@trust/extension-sdk";
import { runtimeRpc } from "./support/runtime.js";

const modifier = process.platform === "darwin" ? "Meta" : "Control";
const templateEditor = (page: Page) => page.locator('[data-doc="template.editor"] .monaco-editor');
async function replaceSource(page: Page, source: string) {
  const editor = templateEditor(page);
  await expect(editor).toBeVisible();
  await editor.locator(".view-lines").click();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(source);
}
async function capture(page: Page, name: string) {
  const root = process.env.TRUST_UI_CAPTURE_ROOT;
  if (!root) return;
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: join(root, `${name}.png`), fullPage: true, animations: "disabled" });
}

/** Acceptance data is installed explicitly through the public API, never shipped in the product catalog. */
async function createProcedureFixture(request: APIRequestContext, id: string, title: string) {
  const catalog = await runtimeRpc<{ procedures: PublishedProcedure[] }>(request, "procedure.list", {});
  const original = catalog.procedures.find((item) => item.procedure.procedure === "git-status");
  if (!original) throw new Error("The seeded Procedure fixture is missing");
  return runtimeRpc<SourceTemplate>(request, "template.save", {
    id,
    title,
    description: "Acceptance fixture created through RPC for template authoring checks.",
    body: original.procedure.source
      .replace(/@procedure:[^\s]+/, "@procedure:{{procedure}}")
      .replace(/@version:[^\s]+/, "@version:{{version}}"),
    parameters: [
      { name: "procedure", description: "Procedure identifier", defaultValue: "observe-repository" },
      { name: "version", description: "Version", defaultValue: "1.0.0" },
    ],
    expectedRevision: 0,
  });
}

test("Templates belongs to Design and the shared catalog supports both navigation modes, search and list views", async ({
  page,
  request,
}) => {
  expect(await runtimeRpc<SourceTemplate[]>(request, "template.list", {})).toEqual([]);
  await page.goto("/templates");
  await expect(page.locator('[data-doc="home.content"]').getByRole("link")).toHaveCount(0);
  await createProcedureFixture(request, "acceptance-navigation-fixture", "Repository observation fixture");
  await runtimeRpc(request, "template.save", {
    id: "acceptance-text-fixture",
    title: "Review text fixture",
    description: "Explicit acceptance text fixture",
    body: "Review {{project}}",
    parameters: [{ name: "project", description: "Project", defaultValue: "TRUST" }],
    expectedRevision: 0,
  });
  await page.goto("/overview");
  const navigation = page.getByRole("complementary", { name: "Navigation", exact: true });
  const design = navigation.locator("nav > div").filter({ has: page.getByText("Design", { exact: true }) });
  await expect(design.getByRole("link", { name: "Templates", exact: true })).toBeVisible();
  await expect(design.getByRole("link", { name: "Operations", exact: true })).toBeVisible();
  await expect(design.getByRole("link", { name: "Procedures", exact: true })).toBeVisible();
  await design.getByRole("link", { name: "Templates", exact: true }).click();
  const content = page.locator('[data-doc="home.content"]');
  await expect(content.getByRole("link", { name: /Repository observation/ })).toBeVisible();
  await expect(page.locator('[data-doc="home.header"]')).toContainText("Templates");
  await capture(page, "catalog");
  await page.getByPlaceholder("Search templates…", { exact: true }).fill("Repository observation");
  await expect(content.getByRole("link")).toHaveCount(1);
  await page.getByRole("button", { name: /^Display/ }).click();
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: /^Display/ }).click();
  await expect(content.getByRole("table")).toBeVisible();
  await expect(content.getByRole("link", { name: /Repository observation/ })).toBeVisible();
  await page.getByPlaceholder("Search templates…", { exact: true }).fill("");
  await page.getByRole("button", { name: /^Display/ }).click();
  await page.getByRole("tab", { name: "Cards", exact: true }).click();
  await page.getByRole("button", { name: /^Display/ }).click();
  await expect(content.getByRole("table")).toBeHidden();
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  const templates = navigation.locator("nav").getByRole("link", { name: "Templates", exact: true });
  await templates.hover();
  await expect(page.getByRole("region", { name: "Templates explorer", exact: true })).toBeVisible();
  await templates.click();
  await expect(page).toHaveURL(/\/templates/);
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  await navigation.getByRole("link", { name: "Operations", exact: true }).click();
  await expect(content.getByRole("link").first()).toBeVisible();
  await expect(page.locator('[data-doc="home.header"]')).toContainText("Operations");
  await capture(page, "reference-catalog");
});

test("the visible template catalog creates, edits, renders and deletes reusable text", async ({ page, request }) => {
  await page.goto("/templates");
  await page.getByRole("link", { name: "New template", exact: true }).click();
  await expect(page).toHaveURL(/\/templates\/new/);
  await page.getByLabel("Template identifier", { exact: true }).fill("acceptance-custom-template");
  await page.getByLabel("Title", { exact: true }).fill("Review checklist");
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("A reusable Markdown fragment");
  await replaceSource(page, "# Review {{project}}\n- Inspect changes\n");
  await page.getByRole("button", { name: "Add parameter", exact: true }).click();
  await page.getByLabel("Parameter name 1", { exact: true }).fill("project");
  await page.getByLabel("Description 1", { exact: true }).fill("Project to review");
  await page.getByLabel("Default value (optional) 1", { exact: true }).fill("TRUST");
  await capture(page, "creation");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page).toHaveURL(/\/templates\/acceptance-custom-template$/);
  await expect(page.getByRole("heading", { name: "Review checklist", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Preview text", exact: true }).click();
  await expect(templateEditor(page).locator(".view-lines")).toContainText("# Review TRUST");
  expect((await runtimeRpc<SourceTemplate>(request, "template.read", { id: "acceptance-custom-template" })).body).toBe(
    "# Review {{project}}\n- Inspect changes\n",
  );
  await page.getByLabel("project", { exact: true }).fill("Another project");
  await expect(templateEditor(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Preview text", exact: true }).click();
  await expect(templateEditor(page).locator(".view-lines")).toContainText("# Review Another project");
  await capture(page, "detail");
  await page.getByRole("button", { name: "Edit template", exact: true }).click();
  await replaceSource(page, "# Review {{project}}\n- Inspect changes\n- Verify acceptance\n");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Preview text", exact: true }).click();
  await expect(templateEditor(page).locator(".view-lines")).toContainText("Verify acceptance");
  await page.getByRole("button", { name: "Delete template", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await expect(page).toHaveURL(/\/templates$/);
  await expect(page.locator('[data-doc="home.content"]').getByRole("link", { name: /Review checklist/ })).toBeHidden();
  await page.reload();
  await expect(page.locator('[data-doc="home.content"]').getByRole("link", { name: /Review checklist/ })).toBeHidden();
  expect(
    (await runtimeRpc<SourceTemplate[]>(request, "template.list", {})).some(
      (item) => item.id === "acceptance-custom-template",
    ),
  ).toBe(false);
});

test("a user-created template is cloned without changing its original", async ({ page, request }) => {
  const original = await createProcedureFixture(request, "acceptance-original-fixture", "Original template fixture");
  await page.goto(`/templates/${original.id}`);
  await expect(page.getByRole("button", { name: "Edit template", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete template", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clone template", exact: true }).click();
  await page.getByLabel("Template identifier", { exact: true }).fill("acceptance-template-clone");
  await page.getByLabel("Title", { exact: true }).fill("My template copy");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My template copy", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit template", exact: true })).toBeVisible();
  expect(await runtimeRpc<SourceTemplate>(request, "template.read", { id: original.id })).toEqual(original);
  const clone = await runtimeRpc<SourceTemplate>(request, "template.read", { id: "acceptance-template-clone" });
  expect(clone.body).toBe(original.body);
  expect(clone.parameters).toEqual(original.parameters);
  expect(clone.builtIn).toBe(false);
});

test("a template previews without changing a Procedure and explicitly replaces only its draft", async ({
  page,
  request,
}) => {
  const catalog = await runtimeRpc<{ procedures: PublishedProcedure[] }>(request, "procedure.list", {});
  const existing = catalog.procedures.find((item) => item.procedure.procedure === "git-status");
  if (!existing) throw new Error("The seeded procedure is missing");
  const templateSource = existing.procedure.source.replace(/^Feature:.*$/m, "Feature: {{title}}");
  await runtimeRpc(request, "template.save", {
    id: "acceptance-procedure-template",
    title: "Acceptance procedure",
    description: "Complete procedure",
    body: templateSource,
    parameters: [{ name: "title", description: "Procedure title" }],
    expectedRevision: 0,
  });
  await page.goto("/procedures/git-status?tab=source");
  const procedureEditor = page.locator('[data-doc="editor"] .monaco-editor').filter({
    hasNot: page.locator('xpath=ancestor::*[@data-doc="template.editor"]'),
  });
  await expect(procedureEditor.locator(".view-lines")).toContainText("Feature:");
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toBeHidden();
  await capture(page, "reference-detail");
  const originalVisibleText = await procedureEditor.locator(".view-lines").innerText();
  await page.getByRole("button", { name: "Use a template", exact: true }).click();
  await page.getByRole("button", { name: "Template", exact: true }).click();
  await page.getByRole("option", { name: "Acceptance procedure", exact: true }).click();
  await page.getByLabel("title", { exact: true }).fill("Template applied deliberately");
  await page.getByRole("button", { name: "Preview text", exact: true }).click();
  await expect(templateEditor(page).locator(".view-lines")).toContainText("Template applied deliberately");
  await expect(procedureEditor.locator(".view-lines")).not.toContainText("Template applied deliberately");
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toBeHidden();
  expect(await runtimeRpc(request, "procedure.list", {})).toEqual(catalog);
  await capture(page, "procedure");
  await page.getByRole("button", { name: "Replace draft with this text", exact: true }).click();
  await expect(templateEditor(page)).toHaveCount(0);
  await expect(procedureEditor.locator(".view-lines")).toContainText("Template applied deliberately");
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(procedureEditor.locator(".view-lines")).toHaveText(originalVisibleText, { useInnerText: true });
  expect(await runtimeRpc(request, "procedure.list", {})).toEqual(catalog);
});

test("template source uses real LSP defaults, typed completion, diagnostics and the ordinary rendered language", async ({
  page,
  request,
}) => {
  await createProcedureFixture(request, "acceptance-language-fixture", "Language template fixture");
  const sent: Array<{ method?: string; params?: { textDocument?: { uri?: string; text?: string }; uri?: string } }> =
    [];
  const received: Array<{ method?: string; params?: { uri?: string; diagnostics?: Array<{ message: string }> } }> = [];
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/lsp")) return;
    socket.on("framesent", ({ payload }) => sent.push(JSON.parse(payload.toString())));
    socket.on("framereceived", ({ payload }) => received.push(JSON.parse(payload.toString())));
  });
  await page.goto("/templates/acceptance-language-fixture");
  await page.getByRole("button", { name: "Clone template", exact: true }).click();
  const editor = templateEditor(page);
  const factLine = editor.locator(".view-line").filter({ hasText: "fact.workingTree" });
  await expect(factLine).toBeVisible();
  const factToken = factLine.getByText("fact", { exact: true });
  const expectedColor = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--color-editor-keyword)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect.poll(() => factToken.evaluate((element) => getComputedStyle(element).color)).toBe(expectedColor);
  await cursorAfterFact(page);
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".suggest-widget")).toContainText("workingTree");
  await expect(page.locator(".suggest-widget")).toContainText("headRevision");
  await page.keyboard.press("Escape");
  await cursorAfterFact(page);
  for (let index = 0; index < "workingTree".length; index++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.insertText("missingField");
  await expect
    .poll(() =>
      received.some((message) =>
        message.params?.diagnostics?.some(({ message }) => message.includes('produces no field "missingField"')),
      ),
    )
    .toBe(true);
  await expect(editor.locator(".squiggly-error")).toBeVisible();
  await page.keyboard.press(`${modifier}+z`);
  await expect(editor.locator(".squiggly-error")).toBeHidden();
  await expect
    .poll(() =>
      sent.some(
        (message) =>
          message.method === "textDocument/completion" && message.params?.textDocument?.uri?.includes("/templates/"),
      ),
    )
    .toBe(true);
  await expect.poll(() => sent.some((message) => message.method === "trust/templateContext")).toBe(true);
  await capture(page, "template-language");
  await page.getByLabel("Template identifier", { exact: true }).fill("acceptance-template-language");
  await page.getByLabel("Title", { exact: true }).fill("Template language acceptance");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Preview text", exact: true }).click();
  await expect(editor.locator(".view-lines")).not.toContainText("{{procedure}}");
  await expect(editor.locator(".view-lines")).toContainText("observe-repository");
  await expect(
    editor.locator(".view-line").filter({ hasText: "fact.workingTree" }).getByText("fact", { exact: true }),
  ).toBeVisible();
  const renderedUri = () =>
    sent.find(
      (message) =>
        message.method === "textDocument/didOpen" &&
        message.params?.textDocument?.text?.includes("@procedure:observe-repository") &&
        !message.params?.textDocument?.text?.includes("{{procedure}}"),
    )?.params?.textDocument?.uri;
  await expect.poll(renderedUri).toBeTruthy();
  await expect
    .poll(() =>
      sent.some(
        (message) =>
          message.method === "textDocument/semanticTokens/full" && message.params?.textDocument?.uri === renderedUri(),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      received.some(
        (message) =>
          message.method === "textDocument/publishDiagnostics" &&
          message.params?.uri === renderedUri() &&
          message.params?.diagnostics?.length === 0,
      ),
    )
    .toBe(true);
  await expect(editor.locator(".squiggly-error")).toBeHidden();
  await page.goto("/templates");
  await expect
    .poll(() =>
      sent.some(
        (message) =>
          message.method === "textDocument/didClose" && message.params?.textDocument?.uri?.includes("/templates/"),
      ),
    )
    .toBe(true);
});

async function cursorAfterFact(page: Page) {
  const token = templateEditor(page)
    .locator(".view-line")
    .filter({ hasText: /fact\./ })
    .getByText("fact", { exact: true });
  const box = await token.boundingBox();
  if (!box) throw new Error("The fact token is not visible");
  await page.mouse.click(box.x + box.width + (box.width / 4) * 0.7, box.y + box.height / 2);
}

test("an explicit empty default survives UI save and omitted-value rendering", async ({ page, request }) => {
  await page.goto("/templates/new");
  await page.getByLabel("Template identifier", { exact: true }).fill("acceptance-empty-default");
  await page.getByLabel("Title", { exact: true }).fill("Optional suffix");
  await replaceSource(page, "Read{{suffix}}.");
  await page.getByRole("button", { name: "Add parameter", exact: true }).click();
  await page.getByLabel("Parameter name 1", { exact: true }).fill("suffix");
  const presence = page.getByRole("button", { name: "Use default 1", exact: true });
  await expect(presence).toHaveAttribute("aria-pressed", "false");
  await presence.click();
  await expect(presence).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Default value (optional) 1", { exact: true }).fill(" optional suffix");
  await page.getByLabel("Default value (optional) 1", { exact: true }).fill("");
  await expect(presence).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page).toHaveURL(/\/templates\/acceptance-empty-default$/);
  const saved = await runtimeRpc<SourceTemplate>(request, "template.read", { id: "acceptance-empty-default" });
  expect(saved.parameters[0]?.defaultValue).toBe("");
  expect(
    await runtimeRpc(request, "template.render", { id: saved.id, expectedRevision: saved.revision, values: {} }),
  ).toEqual({ source: "Read." });
  await page.getByRole("button", { name: "Edit template", exact: true }).click();
  await expect(presence).toHaveAttribute("aria-pressed", "true");
  await presence.click();
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit template", exact: true })).toBeVisible();
  const omitted = await runtimeRpc<SourceTemplate>(request, "template.read", { id: saved.id });
  expect(omitted.parameters).toEqual([{ name: "suffix", description: "" }]);
});

test("a rendered preview keeps inserted placeholder-shaped text literal on the shared LSP", async ({
  page,
  request,
}) => {
  await runtimeRpc(request, "template.save", {
    id: "acceptance-literal-preview",
    title: "Literal preview",
    description: "",
    expectedRevision: 0,
    body: "Given Procedure scope\n  | check | authorized | forbidden |\n  | all | Read {{target}}. | Change state. |\n",
    parameters: [{ name: "target", description: "Target", defaultValue: "{{literal}}" }],
  });
  const received: Array<{ method?: string; params?: { uri?: string; diagnostics?: unknown[] } }> = [];
  const sent: Array<{
    method?: string;
    params?: { uri?: string; materialized?: boolean; textDocument?: { uri?: string; text?: string } };
  }> = [];
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/lsp")) return;
    socket.on("framesent", ({ payload }) => sent.push(JSON.parse(payload.toString())));
    socket.on("framereceived", ({ payload }) => received.push(JSON.parse(payload.toString())));
  });
  await page.goto("/templates/acceptance-literal-preview?tab=use");
  await page.getByRole("button", { name: "Preview text", exact: true }).click();
  await expect(templateEditor(page).locator(".view-lines")).toContainText("Read {{literal}}.");
  const renderedUri = () =>
    sent.find((message) => message.method === "trust/templateContext" && message.params?.materialized === true)?.params
      ?.uri;
  await expect.poll(renderedUri).toBeTruthy();
  await expect
    .poll(() =>
      received.some(
        (message) =>
          message.method === "textDocument/publishDiagnostics" &&
          message.params?.uri === renderedUri() &&
          message.params?.diagnostics?.length === 0,
      ),
    )
    .toBe(true);
  await expect(templateEditor(page).locator(".squiggly-error")).toBeHidden();
});
