import { expect, test } from "@playwright/test";

test("catalog descriptions and tags can be edited and used to find Operations and Procedures", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await request.post("http://127.0.0.1:4390/rpc", {
      data: { jsonrpc: "2.0", id: method, method, params },
    });
    const envelope = await response.json();
    expect(envelope.error).toBeUndefined();
    return envelope.result;
  };

  const beforeOperation = (await rpc("operation.list")).operations.find(
    (entry: { operation: string }) => entry.operation === "git.head-read",
  );
  const beforeProcedure = (await rpc("procedure.list")).procedures.find(
    (entry: { procedure: { procedure: string } }) => entry.procedure.procedure === "git-status",
  );
  expect(beforeOperation).toBeDefined();
  expect(beforeProcedure).toBeDefined();

  await page.goto("/operations/git.head-read");
  await page.getByRole("button", { name: "Edit catalog details" }).click();
  await page.getByRole("textbox", { name: "Description" }).fill("Find the repository revision before reviewing it.");
  await page.getByRole("textbox", { name: "Tags" }).fill("repository\nreview-ready\nreview,ready");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("review-ready", { exact: true })).toBeVisible();

  await page.goto("/operations?q=review-ready");
  await expect(page.locator('main a[href^="/operations/git.head-read"]')).toHaveCount(1);
  await page.goto("/operations?tag=review-ready");
  await expect(page.locator('main a[href^="/operations/git.head-read"]')).toHaveCount(1);
  await page.goto("/operations?tag=review%2Cready");
  await expect(page.locator('main a[href^="/operations/git.head-read"]')).toHaveCount(1);

  await page.goto("/procedures/git-status");
  await page.getByRole("button", { name: "Edit catalog details" }).click();
  await page
    .getByRole("textbox", { name: "Description" })
    .fill("Use this procedure to check a repository before a review.");
  await page.getByRole("textbox", { name: "Tags" }).fill("repository\npreparation\nprep,ready");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("preparation", { exact: true })).toBeVisible();

  await page.goto("/procedures?q=preparation");
  await expect(page.locator('main a[href^="/procedures/git-status"]')).toHaveCount(1);
  await page.goto("/procedures?tag=preparation");
  await expect(page.locator('main a[href^="/procedures/git-status"]')).toHaveCount(1);
  await page.goto("/procedures?tag=prep%2Cready");
  await expect(page.locator('main a[href^="/procedures/git-status"]')).toHaveCount(1);

  const actingOperation = (await rpc("catalog.metadata.list")).find(
    (entry: { kind: string; name: string }) => entry.kind === "operation" && entry.name === "food.batch-release",
  );
  expect(actingOperation).toBeDefined();
  await rpc("catalog.metadata.save", {
    kind: "operation",
    name: actingOperation.name,
    expectedRevision: actingOperation.revision,
    title: actingOperation.title,
    description: actingOperation.description,
    tags: ["nature:observe"],
  });
  await page.goto("/operations?nature=act&q=food.batch-release");
  await expect(page.locator('main a[href^="/operations/food.batch-release"]')).toHaveCount(1);

  const afterOperation = (await rpc("operation.list")).operations.find(
    (entry: { operation: string }) => entry.operation === "git.head-read",
  );
  const afterProcedure = (await rpc("procedure.list")).procedures.find(
    (entry: { procedure: { procedure: string } }) => entry.procedure.procedure === "git-status",
  );
  expect(afterOperation).toEqual(beforeOperation);
  expect(afterProcedure).toEqual(beforeProcedure);
});
