import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { createExtensionAccessFixture } from "./access-extension-access-support.mjs";
import { root } from "./access-ownership-support.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("EXTENSION-UI real federated coordination and mobile journeys authenticate", { timeout: 120000 }, async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const fixture = await createExtensionAccessFixture("pglite", { browserOrigin: origin });
  let vite, browser;
  try {
    vite = spawn(
      process.execPath,
      [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: path.join(root, "apps/trust-web"),
        env: { ...process.env, TRUST_RUNTIME_URL: fixture.endpoint, TRUST_WEB_PORT: String(port) },
        stdio: "ignore",
      },
    );
    let started = false;
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(origin + "/health")).ok) {
          started = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(started, "Disposable browser host starts");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    const requests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname.startsWith("/extensions/"))
        requests.push({ path: url.pathname, query: url.search, bearer: Boolean(request.headers().authorization) });
    });
    await page.goto(origin);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator('input[name="login"]').fill("alice");
    await page.locator('input[name="password"]').fill("development-only-ignored");
    await page.locator("form").getByRole("button").click();
    await page.locator('form:has(input[value="consent"]) button').click();
    await page.waitForURL(origin + "/overview");
    async function navigate(route) {
      await page.evaluate((route) => {
        history.pushState(null, "", route);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, route);
    }
    await navigate("/extensions/coordination");
    await page.locator('[data-mission="alice-mission"]').click();
    await page.getByRole("button", { name: "Edit tags", exact: true }).click();
    await page.getByRole("textbox", { name: "New tag", exact: true }).fill("browser-written");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Save tags", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit tags", exact: true })).toBeVisible();
    const listed = fixture.okay(await fixture.command("coordination", fixture.alice.token, "missions.list", {}));
    const mission = listed.missions.find((row) => row.mission === "alice-mission");
    assert.deepEqual(mission.tags, ["browser-written"]);
    fixture.okay(
      await fixture.command("coordination", fixture.admin.token, "tags.replace", {
        mission: "alice-mission",
        expectedRevision: mission.tagRevision,
        tags: ["event-arrived"],
      }),
    );
    await expect(page.getByRole("dialog").getByText("event-arrived", { exact: true })).toBeVisible();
    await navigate("/extensions/mobile-companion?project=extension-project&item=alice-item");
    await page.getByLabel("Decision", { exact: false }).selectOption({ label: "Approve" });
    await page.getByRole("button", { name: "Send response", exact: true }).click();
    await expect(page.getByText("Response sent", { exact: true })).toBeVisible();
    const item = fixture.okay(await fixture.read("mobile-companion", fixture.alice.token, "/items/alice-item"));
    assert.equal(item.response.answers.decision, "Approve");
    await navigate("/extensions/mobile-companion?project=extension-project&item=bob-item");
    await page.getByLabel("Decision", { exact: false }).waitFor();
    fixture.okay(
      await fixture.command("mobile-companion", fixture.admin.token, "responses.submit", {
        item: "bob-item",
        expectedRevision: 0,
        answers: { decision: "Revise" },
      }),
    );
    await expect(page.getByText("Response sent", { exact: true })).toBeVisible();
    for (const id of ["coordination", "mobile-companion"]) {
      assert.ok(
        requests.some((row) => row.path === `/extensions/${id}/assets/remoteEntry.js` && !row.bearer),
        `${id} native federation entry loads without credentials`,
      );
      assert.ok(
        requests.some((row) => row.path === `/extensions/${id}/commands` && row.bearer),
        `${id} command has private bearer`,
      );
      assert.ok(
        requests.some((row) => row.path === `/extensions/${id}/events` && row.bearer),
        `${id} live event stream has private bearer`,
      );
    }
    assert.ok(requests.filter((row) => row.path.includes("/assets/")).every((row) => !row.bearer));
    assert.ok(requests.every((row) => !/(access_token|refresh_token|authorization)=/i.test(row.query)));
    const stored = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    assert.doesNotMatch(JSON.stringify(stored), /access_token|refresh_token|id_token|eyJ[a-zA-Z0-9_-]+\./);
    await page.getByRole("button", { name: "Sign out of TRUST", exact: true }).click();
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    assert.equal(await page.locator(".mobile-companion").count(), 0, "Protected extension page unmounts at logout");
    const deniedPage = await browser.newPage();
    deniedPage.setDefaultTimeout(20000);
    // The actual authorization server grants a narrower browser session without either extension permission.
    await deniedPage.route(fixture.provider.issuer + "/auth?*", (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set(
        "scope",
        url.searchParams
          .get("scope")
          .split(" ")
          .filter((scope) => !scope.endsWith(".use"))
          .join(" "),
      );
      return route.continue({ url: url.href });
    });
    await deniedPage.goto(origin);
    await deniedPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await deniedPage.locator('input[name="login"]').fill("bob");
    await deniedPage.locator('input[name="password"]').fill("development-only-ignored");
    await deniedPage.locator("form").getByRole("button").click();
    await deniedPage.locator('form:has(input[value="consent"]) button').click();
    await deniedPage.waitForURL(origin + "/overview");
    const deniedRead = deniedPage.waitForResponse(
      (response) => response.url() === origin + "/extensions/coordination/commands" && response.status() === 403,
    );
    await deniedPage.evaluate(() => {
      history.pushState(null, "", "/extensions/coordination");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await deniedRead;
    assert.equal(await deniedPage.locator("[data-mission]").count(), 0);
    const refused = await deniedPage.evaluate(async (root) => {
      const { createExtensionTransport } = await import(
        "/@fs" + root + "/packages/trust-ui/src/extensions/transport.ts"
      );
      const { authenticationFor } = await import("/@fs" + root + "/packages/trust-ui/src/lib/authentication.ts");
      const connection = createExtensionTransport("", "coordination", authenticationFor(""));
      try {
        return (
          await connection.transport.fetch("/extensions/coordination/commands", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              command: "tags.replace",
              arguments: { mission: "alice-mission", expectedRevision: 2, tags: ["browser-forbidden"] },
            }),
          })
        ).status;
      } finally {
        connection.dispose();
      }
    }, root);
    assert.equal(refused, 403);
    assert.deepEqual(
      fixture
        .okay(await fixture.command("coordination", fixture.admin.token, "missions.list", {}))
        .missions.find((row) => row.mission === "alice-mission").tags,
      ["event-arrived"],
    );
    await deniedPage.close();
  } finally {
    await browser?.close();
    if (vite) {
      vite.kill("SIGTERM");
      await new Promise((resolve) => {
        if (vite.exitCode !== null) resolve();
        else vite.once("exit", resolve);
      });
    }
    await fixture.close();
  }
});
