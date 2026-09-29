import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

test("LSP references open the exact resource version and retain their source origin", async ({ page, request }) => {
  test.setTimeout(60_000);
  for (const name of ["01-lock", "02-vault", "03-heist", "04-distraction", "05-game"]) {
    const source = await readFile(
      new URL(`../../../assets/procedures/dragon-heist/${name}.feature`, import.meta.url),
      "utf8",
    );
    const response = await request.post("http://127.0.0.1:4390/rpc", {
      data: { jsonrpc: "2.0", id: name, method: "procedure.publish", params: { source } },
    });
    expect((await response.json()).error).toBeUndefined();
    if (name === "04-distraction") {
      const newer = await request.post("http://127.0.0.1:4390/rpc", {
        data: {
          jsonrpc: "2.0",
          id: "newer",
          method: "procedure.publish",
          params: {
            source: source
              .replace("@version:1.0.0", "@version:2.0.0")
              .replace("Feature: Dragon Heist distraction", "Feature: A newer distraction"),
          },
        },
      });
      expect((await newer.json()).error).toBeUndefined();
    }
  }
  const origin = "/procedures/dragon-heist-game?version=1.0.0&tab=source";
  await page.goto(origin);
  const editor = page.locator(".monaco-editor");
  await expect(editor.locator(".view-lines")).toContainText("dragon-heist.scout", { timeout: 15_000 });
  // A reference token is the whole quoted name@selector.
  const operation = editor.getByText(/^"?dragon-heist\.scout@\*"?$/).first();
  await operation.hover();
  await expect(page.locator(".monaco-hover").filter({ hasText: "Produced" }).first()).toBeVisible();
  await operation.click({ modifiers: [modifier] });
  await expect(page).toHaveURL(/\/operations\/dragon-heist\.scout\?version=1\.0\.0&tab=source/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("scout");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(origin);
  const procedure = editor.getByText(/^"?dragon-heist-distraction@1\.0\.0"?$/).first();
  await procedure.scrollIntoViewIfNeeded();
  await procedure.hover();
  await expect(page.locator(".monaco-hover").filter({ hasText: "1.0.0" }).first()).toBeVisible();
  await procedure.click({ modifiers: [modifier] });
  await expect(page).toHaveURL(/\/procedures\/dragon-heist-distraction\?version=1\.0\.0&tab=source/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dragon Heist distraction");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(origin);
  await page.goto("/procedures/dragon-heist-distraction?version=2.0.0&tab=source");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A newer distraction");
});
