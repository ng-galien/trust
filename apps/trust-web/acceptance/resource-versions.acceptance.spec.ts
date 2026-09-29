import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const runtimeRpcUrl = `http://127.0.0.1:${process.env.TRUST_WEB_ACCEPTANCE_RUNTIME_PORT ?? "4390"}/rpc`;

test.beforeEach(async ({ page }) => {
  await page.goto("/overview");
  await expect(page.locator('[data-doc="shell.sidebar"]')).toBeVisible({ timeout: 30_000 });
});

/** The fields of the Operation catalog listing this scenario reads. */
interface ListedOperation {
  readonly operation: string;
  readonly version: string;
  readonly source?: string;
}
type OperationCatalog = readonly ListedOperation[] | { readonly operations: readonly ListedOperation[] };

test("PostgreSQL Operation overview and expanded step render without a page crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/operations/coordination.mission-create");
  await expect(page.locator('[data-doc="operation.summary"]')).toContainText("executes SQL on PostgreSQL");
  await page.getByRole("tab", { name: "Expert", exact: true }).click();
  await page.getByRole("button", { name: "Steps", exact: true }).click();
  await expect(
    page.getByText("SELECT trust_coordination.mission_create($1::jsonb) AS result", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Simulate", exact: true }).click();
  await expect(page.locator("#sim-step-mission-result")).toBeVisible();
  await page.getByRole("tab", { name: "JSON", exact: true }).click();
  const fields = [
    "mission",
    "plan",
    "assignee",
    "owner",
    "state",
    "instructions",
    "project",
    "expected",
    "authorized",
    "forbidden",
    "response",
  ];
  const values = Object.fromEntries(fields.map((field) => [field, `test-${field}`]));
  await page.locator("#simulation-json").fill(
    JSON.stringify({
      input: Object.fromEntries(
        Object.entries(values).filter(([field]) => !["owner", "state", "response"].includes(field)),
      ),
      environment: { databaseUrl: "postgresql://simulation-only" },
      steps: { mission: { result: values } },
    }),
  );
  await page.locator('[data-doc="simulation.run"]').click();
  await expect(page.locator('[data-doc="simulation.result"]')).toContainText("test-mission");
  expect(errors).toEqual([]);
});

test("every canonical Operation step variant opens overview and simulation", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await request.post(runtimeRpcUrl, {
    data: { jsonrpc: "2.0", id: "variants", method: "operation.list", params: {} },
  });
  const catalog = (await response.json()).result.operations;
  for (const kind of ["shell", "http", "file-read", "postgresql"]) {
    const operation = catalog.find((value: { steps: Array<{ type: string }> }) =>
      value.steps.some((step) => step.type === kind),
    );
    expect(operation, `catalog includes ${kind}`).toBeDefined();
    await page.goto(`/operations/${operation.operation}`);
    await expect(page.locator('[data-doc="operation.summary"]')).toBeVisible();
    await page.getByRole("tab", { name: "Simulate", exact: true }).click();
    await expect(page.locator('[data-doc="simulation.steps"]')).toContainText(operation.steps[0].name);
  }
  expect(errors).toEqual([]);
});

test("catalog search finds Operation descriptions and tags and Procedure descriptions", async ({ page, request }) => {
  test.setTimeout(90_000);
  const original = await readFile(new URL("../../../assets/operations/git.head-read.feature", import.meta.url), "utf8");
  const source = original
    .replace("@operation:git.head-read", "@operation:ui.catalog-search @x-team:observability-lab")
    .replace(
      "Feature: Read Git HEAD and working tree",
      "Feature: Catalog search operation\n\n  Finds the saffron observer phrase in this description.",
    );
  const saved = await (
    await request.post(runtimeRpcUrl, {
      data: {
        jsonrpc: "2.0",
        id: "catalog-search-operation",
        method: "operation.save",
        params: { source, sourceName: "ui.catalog-search@1.0.0.feature" },
      },
    })
  ).json();
  expect(saved.error).toBeUndefined();

  await page.goto("/operations?q=saffron%20observer%20phrase");
  await expect(page.locator('main a[href^="/operations/ui.catalog-search"]')).toHaveCount(1);
  await expect(page.locator('[data-doc="home.content"]')).toContainText("in description");

  await page.goto("/operations?q=observability-lab");
  await expect(page.locator('main a[href^="/operations/ui.catalog-search"]')).toHaveCount(1);
  await expect(page.locator('[data-doc="home.content"]')).toContainText("@x-team:observability-lab");

  await page.goto("/procedures?q=Answers%20one%20question");
  await expect(page.locator('main a[href^="/procedures/git-status"]')).toHaveCount(1);
  await expect(page.locator('[data-doc="home.content"]')).toContainText("in description");

  await page.goto("/operations/ui.catalog-search");
  await page.getByRole("tab", { name: "Catalog details" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Catalog search revised");
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Revised cedar discovery phrase.");
  await page.getByRole("textbox", { name: "Classification tags", exact: true }).fill("@x-team:platform-search");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator('[data-doc="catalog.metadata"]')).toContainText("Catalog revision 1");
  await expect(page.getByRole("heading", { name: "Catalog search revised" })).toBeVisible();

  await page.goto("/operations?q=platform-search");
  await expect(page.locator('main a[href^="/operations/ui.catalog-search"]')).toHaveCount(1);
  await page.goto("/operations?q=Catalog%20platform-search");
  await expect(page.locator('main a[href^="/operations/ui.catalog-search"]')).toHaveCount(1);
  await page.goto("/operations?q=observability-lab");
  await expect(page.locator('main a[href^="/operations/ui.catalog-search"]')).toHaveCount(0);
  await page.goto("/operations?q=cedar%20discovery%20phrase");
  await expect(page.locator('main a[href^="/operations/ui.catalog-search"]')).toHaveCount(1);

  await page.goto("/procedures/git-status");
  await page.getByRole("tab", { name: "Catalog details" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Repository status guide");
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Finds the violet repository clue.");
  await page.getByRole("textbox", { name: "Classification tags", exact: true }).fill("@x-team:repository-review");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator('[data-doc="catalog.metadata"]')).toContainText("Catalog revision 1");
  await page.goto("/procedures?q=violet%20repository%20clue");
  await expect(page.locator('main a[href^="/procedures/git-status"]')).toHaveCount(1);
  await page.goto("/procedures?q=repository-review");
  await expect(page.locator('main a[href^="/procedures/git-status"]')).toHaveCount(1);
  await page.goto("/procedures?q=Repository%20repository-review");
  await expect(page.locator('main a[href^="/procedures/git-status"]')).toHaveCount(1);

  const catalogResponse = await (
    await request.post(runtimeRpcUrl, {
      data: { jsonrpc: "2.0", id: "catalog-method-snapshots", method: "operation.list", params: {} },
    })
  ).json();
  const operation = catalogResponse.result.operations.find(
    (entry: { operation: string }) => entry.operation === "ui.catalog-search",
  );
  expect(operation.title).toBe("Catalog search operation");
  expect(operation.source).toContain("@version:1.0.0");
});

test("catalog identities contain semantically ordered exact versions and authoring preserves older Operation sources", async ({
  page,
  request,
}) => {
  const rpc = async <T = unknown>(method: string, params: unknown): Promise<T> => {
    const result = await (
      await request.post(runtimeRpcUrl, { data: { jsonrpc: "2.0", id: method, method, params } })
    ).json();
    expect(result.error).toBeUndefined();
    return result.result as T;
  };
  const original = (
    await readFile(new URL("../../../assets/operations/git.head-read.feature", import.meta.url), "utf8")
  ).replace("@operation:git.head-read", "@operation:ui.versioned");
  const versions = ["1.9.0", "1.10.0", "2.0.0-beta.1"];
  for (const version of versions) {
    await rpc("operation.save", {
      source: original.replace("@version:1.0.0", `@version:${version}`),
      sourceName: `ui.versioned@${version}.feature`,
    });
    await rpc("procedure.publish", {
      source: `@trust-dsl:1 @procedure:versioned-procedure @version:${version}
Feature: Versioned Procedure
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the repository. | Change files. |
    And one reference "repository"
  @scenario:read
  Scenario: Read
    Then Check "read" runs Operation "ui.versioned@^1.0.0" on "repository" as Input "project" and must establish "the tree is dirty"
      """js
      fact.workingTree === "dirty" || fail("Clean tree")
      """
`,
    });
  }
  await page.goto("/operations?q=ui.versioned");
  await page.getByRole("button", { name: "Expand Operations", exact: true }).click();
  await page.getByRole("textbox", { name: "Filter operations…", exact: true }).fill("ui.versioned");
  await expect(page.locator('[data-doc="shell.sidebar"] a[href="/operations/ui.versioned"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Actions for ui.versioned", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator('main a[href^="/operations/ui.versioned"]')).toHaveCount(1);
  await page.locator('main a[href^="/operations/ui.versioned"]').click();
  const selector = page.getByRole("combobox", { name: "Version", exact: true });
  await expect(selector).toHaveValue("1.10.0");
  expect(await selector.locator("option").allTextContents()).toEqual(["2.0.0-beta.1", "1.10.0", "1.9.0"]);
  await page.getByRole("tab", { name: "Source", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Source", exact: true })).toHaveAttribute("aria-selected", "true");
  await selector.selectOption("1.9.0");
  await expect(page).toHaveURL(/version=1.9.0/);
  expect(new URL(page.url()).searchParams.get("q")).toBe("ui.versioned");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("@version:1.9.0", { timeout: 15_000 });
  await page.getByRole("button", { name: "Wrap lines", exact: true }).click();
  await expect(page.getByRole("button", { name: "Publish version", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
  await selector.selectOption("1.10.0");
  await page.goBack();
  await expect(selector).toHaveValue("1.9.0");
  const feature = page.locator(".monaco-editor .view-line").filter({ hasText: "Feature: Read Git HEAD" });
  await feature.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" revised");
  await expect(page.getByRole("status").filter({ hasText: "Published versions are immutable." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish version", exact: true })).toBeDisabled();
  await expect(selector).toBeDisabled();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(selector).toBeEnabled();
  await expect(feature).not.toContainText("revised");
  await feature.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" discard-on-version-change");
  await expect(selector).toBeDisabled();
  await page.goBack();
  await expect(selector).toHaveValue("1.10.0");
  await expect(selector).toBeEnabled();
  await page.goForward();
  await expect(selector).toHaveValue("1.9.0");
  await expect(selector).toBeEnabled();
  await expect(feature).not.toContainText("discard-on-version-change");
  const tags = page.locator(".monaco-editor .view-line").filter({ hasText: "@operation:ui.versioned" });
  await tags.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.insertText("@trust-dsl:1 @operation:ui.versioned @version:1.11.0");
  await expect(selector).toBeDisabled();
  const save = page.getByRole("button", { name: "Publish version", exact: true });
  await expect(save).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "Unpublished draft for a new version." })).toBeVisible();
  const listed = (catalog: OperationCatalog) => ("operations" in catalog ? catalog.operations : catalog);
  const beforePublish = listed(await rpc<OperationCatalog>("operation.list", {}));
  expect(beforePublish.some((value) => value.operation === "ui.versioned" && value.version === "1.11.0")).toBe(false);
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await save.click();
  await expect(page).toHaveURL(/version=1.11.0/);
  await expect(selector).toHaveValue("1.11.0");
  const operations = listed(await rpc<OperationCatalog>("operation.list", {}));
  expect(operations.find((value) => value.operation === "ui.versioned" && value.version === "1.9.0")?.source).toBe(
    original.replace("@version:1.0.0", "@version:1.9.0"),
  );
  await selector.selectOption("1.9.0");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("@version:1.9.0");
  await page.goto("/procedures?q=versioned-procedure");
  await page.getByRole("button", { name: "Expand Procedures", exact: true }).click();
  await page.getByRole("textbox", { name: "Filter procedures…", exact: true }).fill("versioned-procedure");
  await expect(page.locator('[data-doc="shell.sidebar"] a[href="/procedures/versioned-procedure"]')).toHaveCount(1);
  await expect(page.locator('main a[href^="/procedures/versioned-procedure"]')).toHaveCount(1);
  await page.locator('main a[href^="/procedures/versioned-procedure"]').click();
  await expect(selector).toHaveValue("1.10.0");
  await selector.selectOption("1.9.0");
  await page.getByRole("tab", { name: "Source", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("@version:1.9.0");
  await page.screenshot({ path: "test-results/resource-versions.png" });
});
