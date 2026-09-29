import { expect, type Locator, type Page, test } from "@playwright/test";

async function tone(page: Page, token: Locator, name: string) {
  await expect(token).toBeVisible({ timeout: 15_000 });
  const expected = await page.evaluate((variable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(--color-editor-${variable})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
  await expect.poll(() => token.evaluate((element) => getComputedStyle(element).color)).toBe(expected);
}

test("real LSP semantic colors separate table structure, declarations, references and embedded qualification", async ({
  page,
  request,
}) => {
  await page.goto("/operations/git.head-read?tab=source");
  const editor = page.locator(".monaco-editor");
  const lines = editor.locator(".view-line");
  await expect(lines.filter({ hasText: /\|\s+input/ })).toBeVisible({ timeout: 15_000 });
  await tone(page, lines.filter({ hasText: /\|\s+input/ }).getByText("type", { exact: true }), "table-header");
  const input = lines.filter({ hasText: /\|\s+project/ });
  await tone(page, input.getByText("reference", { exact: true }), "type");
  await tone(page, input.getByText("one", { exact: true }), "keyword-control");
  await tone(page, input.getByText("|", { exact: true }).first(), "table-line");
  const source = `@trust-dsl:1 @procedure:semantic-colors @version:1.0.0
Feature: Semantic colors
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read declared repositories. | Modify files. |
    And one reference "repository"
    And many string "labels" declared by agent
  @scenario:observe
  Scenario: Observe
    Then Check "observe" runs Operation "git.head-read@*"
        on "repository" as Input "project"
        and must establish "the tree is dirty"
      """js
      fact.workingTree === "dirty" && true || fail("reason")
      """
`;
  const publication = await (
    await request.post("http://127.0.0.1:4390/rpc", {
      data: { jsonrpc: "2.0", id: "highlight", method: "procedure.publish", params: { source } },
    })
  ).json();
  expect(publication.error).toBeUndefined();
  await page.goto("/procedures/semantic-colors?tab=source");
  const role = lines.filter({ hasText: /many\s+string/ });
  await tone(page, role.getByText("many", { exact: true }), "keyword-control");
  await tone(page, role.getByText("string", { exact: true }), "type");
  await tone(page, role.getByText("declared by agent", { exact: true }), "keyword-control");
  const check = lines.filter({ hasText: /runs\s+Operation/ });
  await tone(
    page,
    check
      .locator("span")
      // A reference is the whole quoted name@selector.
      .filter({ hasText: /^"?git\.head-read@\*"?$/ })
      .last(),
    "reference",
  );
  const continuation = lines.filter({ hasText: /on\s+"repository"\s+as\s+Input/ });
  await tone(
    page,
    continuation
      .locator("span")
      .filter({ hasText: /^"?repository"?$/ })
      .last(),
    "reference",
  );
  const js = lines.filter({ hasText: "fact.workingTree" });
  const tokens: ReadonlyArray<readonly [string, string]> = [
    ["fact", "keyword"],
    ["workingTree", "property"],
    ["===", "verb"],
    ['"dirty"', "string"],
    ["true", "keyword-control"],
    ["fail", "keyword-control"],
  ];
  for (const [text, color] of tokens) await tone(page, js.getByText(text, { exact: true }), color);
  await expect(page.getByText("Language server unavailable")).toBeHidden();
  await page.screenshot({ path: "test-results/semantic-highlighting-light.png" });
  await page.goto("/overview");
  await page.getByRole("button", { name: /dark theme/i }).click();
  await page.goto("/procedures/semantic-colors?tab=source");
  await tone(page, js.getByText("workingTree", { exact: true }), "property");
  await tone(page, role.getByText("string", { exact: true }), "type");
  await page.screenshot({ path: "test-results/semantic-highlighting-dark.png" });
});
