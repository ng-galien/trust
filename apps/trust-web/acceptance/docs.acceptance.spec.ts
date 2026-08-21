import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/* The integrated documentation: every Gherkin snippet marked `operation` / `procedure` compiles on the real runtime,
   every referenced screenshot exists, and the documentation area behaves (tree, search, glossary, expert blocks). */

const contentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/trust-ui/src/docs/content");
const capturesRoot = path.resolve(contentRoot, "../captures");
const runtimeUrl = "http://127.0.0.1:4390";

async function mdxFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await mdxFiles(full)));
    else if (entry.name.endsWith(".mdx")) out.push(full);
  }
  return out.sort();
}

interface Fence { file: string; line: number; language: string; meta: string; code: string }

async function fences(): Promise<Fence[]> {
  const out: Fence[] = [];
  for (const file of await mdxFiles(contentRoot)) {
    const text = await readFile(file, "utf8");
    const pattern = /^```(\w+)([^\n]*)\n([\s\S]*?)^```/gm;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      out.push({ file: path.relative(contentRoot, file), line, language: match[1]!, meta: match[2]!.trim(), code: match[3]! });
    }
  }
  return out;
}

async function rpc(request: Parameters<Parameters<typeof test>[2]>[0]["request"], method: string, params: unknown) {
  const response = await request.post(`${runtimeUrl}/rpc`, { data: { jsonrpc: "2.0", id: method, method, params } });
  return (await response.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
}

test("every complete Gherkin snippet of the documentation compiles", async ({ request }) => {
  const complete = (await fences()).filter((fence) => fence.language === "gherkin" && /\b(operation|procedure)\b/.test(fence.meta));
  expect(complete.length).toBeGreaterThan(5);
  const failures: string[] = [];
  for (const fence of complete) {
    const method = /\boperation\b/.test(fence.meta) ? "operation.compile" : "procedure.compile";
    const payload = await rpc(request, method, { source: fence.code, sourceName: `${fence.file}:${fence.line}.feature` });
    if (payload.error) failures.push(`${fence.file}:${fence.line} — ${payload.error.message} ${JSON.stringify(payload.error.data ?? "")}`);
  }
  expect(failures, failures.join("\n")).toEqual([]);
});

test("every screenshot the documentation references has been captured, with its legend keys", async () => {
  const missing: string[] = [];
  for (const file of await mdxFiles(contentRoot)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/<Screenshot\s+id="([^"]+)"([\s\S]*?)\/>/g)) {
      const id = match[1]!;
      const png = path.join(capturesRoot, `${id}.light.en.png`);
      const sidecar = path.join(capturesRoot, `${id}.light.en.json`);
      if (!existsSync(png) || !existsSync(sidecar)) { missing.push(`${path.relative(contentRoot, file)}: ${id}`); continue; }
      const capture = JSON.parse(await readFile(sidecar, "utf8")) as { callouts: Array<{ key: string }> };
      for (const key of Array.from(match[2]!.matchAll(/"([\w.]+)":/g)).map((entry) => entry[1]!)) {
        if (!capture.callouts.some((callout) => callout.key === key)) missing.push(`${path.relative(contentRoot, file)}: ${id} has no box for "${key}"`);
      }
    }
  }
  expect(missing, missing.join("\n")).toEqual([]);
});

test("every English page has a French translation with the same structure", async () => {
  const problems: string[] = [];
  const shape = (text: string) => ({
    fences: (text.match(/^```/gm) ?? []).length,
    components: (text.match(/<(Screenshot|Details|Callout|Step|Term|PageCards|Compare|Legend|Figure|Diagram)\b/g) ?? []).length,
    // Fenced sources must be byte-identical (they compile, they are the language) — mermaid labels excepted.
    sources: Array.from(text.matchAll(/^```(?!mermaid)\w*[^\n]*\n([\s\S]*?)^```/gm)).map((match) => match[1]),
  });
  for (const file of await mdxFiles(path.join(contentRoot, "en"))) {
    const relative = path.relative(path.join(contentRoot, "en"), file);
    const french = path.join(contentRoot, "fr", relative);
    if (!existsSync(french)) { problems.push(`${relative}: no French page`); continue; }
    const en = shape(await readFile(file, "utf8"));
    const fr = shape(await readFile(french, "utf8"));
    if (en.fences !== fr.fences) problems.push(`${relative}: ${en.fences} fences in English, ${fr.fences} in French`);
    if (en.components !== fr.components) problems.push(`${relative}: ${en.components} components in English, ${fr.components} in French`);
    en.sources.forEach((source, index) => { if (fr.sources[index] !== source) problems.push(`${relative}: fenced source #${index + 1} differs`); });
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the documentation area: tree, page, search, glossary and expert blocks", async ({ page }) => {
  test.setTimeout(90_000); // several navigations and a reload; the docs chunk is large
  await page.goto("/docs");
  await expect(page.locator("article h1")).toHaveText("Introduction");
  await page.getByRole("navigation", { name: "Documentation contents" }).getByRole("link", { name: "Operations" }).click();
  await expect(page).toHaveURL(/\/docs\/operations$/);
  await expect(page.locator("article h1")).toHaveText("Operations");
  // Glossary term opens its definition in place.
  await page.locator("article .docs-term").first().click();
  await expect(page.getByRole("dialog")).toContainText(/Operation/);
  await page.keyboard.press("Escape");
  // Search finds a page by its text.
  await page.getByRole("textbox", { name: "Search the documentation" }).fill("accepts exits");
  await page.getByRole("button", { name: /Shell step/ }).click();
  await expect(page).toHaveURL(/\/docs\/operations\/steps\/shell$/);
  // Expert blocks are closed in operator mode and open in expert mode.
  const expertBlock = page.locator(".docs-details").filter({ hasText: "Diagnostics specific to Shell steps" });
  await expect(expertBlock.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("tab", { name: "Expert" }).click();
  await page.reload();
  await expect(page.locator(".docs-details").filter({ hasText: "Diagnostics specific to Shell steps" }).getByRole("button")).toHaveAttribute("aria-expanded", "true");
  // The URL does not depend on the language.
  await page.getByRole("tab", { name: "Operator" }).click();
});
