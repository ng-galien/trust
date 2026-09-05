import { expect, test } from "@playwright/test";

test("federated Mermaid renders a diagram without executing embedded HTML or JavaScript links", async ({
  page,
  request,
}) => {
  await request.post("/extensions/coordination/prepare", { data: {} });
  await request.post("/extensions/coordination/start", { data: {} });
  await page.route("**/extensions/coordination/commands", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // Supply adversarial public mission data, not an internal component stub.
    const replaceInstructions = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (key === "instructions" && typeof entry === "string") {
          Reflect.set(
            value,
            key,
            [
              "# Diagram safety",
              '<img src="x" onerror="window.mermaidUnsafe=true">',
              "```mermaid",
              '%%{init: {"securityLevel":"loose"}}%%',
              "flowchart LR",
              'A["<img src=x onerror=window.mermaidUnsafe=true>Safe"] --> B[Result]',
              'click B "javascript:window.mermaidUnsafe=true"',
              "```",
            ].join("\n\n"),
          );
        } else replaceInstructions(entry);
      }
    };
    replaceInstructions(body);
    await route.fulfill({ response, json: body });
  });
  await page.goto("/extensions/coordination");
  await page.locator('[data-mission="federation-acceptance"]').click();
  const inspector = page.getByRole("article", { name: "federation-acceptance" });
  await expect(inspector.getByRole("heading", { name: "Diagram safety", level: 1 })).toBeVisible();
  const diagram = inspector.locator(".coordination-diagram svg").first();
  await expect(diagram).toBeVisible();
  await expect(diagram).toContainText("Result");
  await expect(inspector.locator("script, [onerror], [onload], a[href^='javascript:']")).toHaveCount(0);
  await diagram.click();
  expect(await page.evaluate(() => "mermaidUnsafe" in window)).toBe(false);
});
