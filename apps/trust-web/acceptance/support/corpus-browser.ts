import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { CORPUS_PROXY_PORT, CORPUS_RUNTIME_PORT } from "./corpus-fixture.js";

/* Public boundaries of the disposable Corpus runtime (support/corpus-server.mjs) shared by the Corpus browser specs. */

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
export const runtime = `http://127.0.0.1:${CORPUS_RUNTIME_PORT}`;
export const corpusApi = `${runtime}/extensions/corpus`;

/** Makes the web host's reads of one path fail at the harness proxy, or heals them. */
export async function fault(path: string, fail: boolean) {
  const response = await fetch(`http://127.0.0.1:${CORPUS_PROXY_PORT}/__faults`, {
    method: "POST",
    body: JSON.stringify({ path, fail }),
  });
  if (!response.ok) throw new Error(`The proxy refused the fault on ${path}`);
}
/** Counts the change streams the page opens to the Corpus extension. */
export function countEventStreams(page: Page) {
  let opened = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/extensions/corpus/events") opened++;
  });
  return () => opened;
}
export async function rpc<Result>(method: string, params: unknown): Promise<Result> {
  const response = await fetch(`${runtime}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  const payload = (await response.json()) as { result?: Result; error?: unknown };
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result as Result;
}
export async function checkOf(plan: string, name: string) {
  const read = await rpc<{ checks: { name: string; checkUri: string }[] }>("plan.read", { plan });
  const check = read.checks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`Check ${name} is absent from ${plan}`);
  return check;
}
/** Facts reach TRUST only through the Runner, exactly as a worker runs a Check. */
export async function runCheck(plan: string, name: string) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TRUST_")));
  const { stdout } = await exec(
    process.execPath,
    [
      path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"),
      (await checkOf(plan, name)).checkUri,
      "--json",
    ],
    {
      env: { ...environment, TRUST_RPC_ENDPOINT: `${runtime}/rpc`, TRUST_OTLP_ENDPOINT: `${runtime}/v1/traces` },
      timeout: 60000,
    },
  );
  return (JSON.parse(stdout) as { result: { qualification: { verdict: string } } }).result.qualification;
}

const preferences = (language: "en" | "fr") => ({ state: { language, theme: "light" }, version: 0 });
/** Opens a Corpus page in a fresh light session; the returned list collects console and page errors. */
export async function openCorpus(page: Page, url: string, heading: string, language: "en" | "fr" = "en") {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    (value) => localStorage.setItem("trust.ui.preferences", JSON.stringify(value)),
    preferences(language),
  );
  await page.goto(url);
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible({ timeout: 30000 });
  return errors;
}
/** Loads another Corpus page in the same session; the host's first reads can delay the extension by seconds. */
export async function visit(page: Page, url: string, heading: string) {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible({ timeout: 30000 });
}
export const noPageOverflow = (page: Page) =>
  page.evaluate(() => {
    const app = document.querySelector(".corpus-app");
    return document.documentElement.scrollWidth <= innerWidth && (!app || app.scrollWidth <= app.clientWidth);
  });
/** The mission cards of one section of the framework Plan monitor ("Missions", "Inherited missions"). */
export const missionCards = (page: Page, section = "Missions") =>
  page
    .getByRole("region", { name: section, exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByRole("list", { name: /^(Progress: |Progression : )/ }) });
export const missionCard = (page: Page, mission: string, section = "Missions") =>
  missionCards(page, section).filter({ has: page.getByRole("link", { name: mission, exact: true }) });
