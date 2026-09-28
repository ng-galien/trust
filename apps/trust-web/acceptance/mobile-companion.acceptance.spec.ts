import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("project conversation renders a form and persists its typed answer", async ({ page, request }) => {
  const base = "/extensions/mobile-companion";
  expect((await request.post(`${base}/prepare`, { data: {} })).ok()).toBeTruthy();
  expect((await request.post(`${base}/start`, { data: {} })).ok()).toBeTruthy();
  const command = (name: string, args: object) =>
    request.post(`${base}/commands`, {
      data: { command: name, arguments: args },
    });
  expect(
    (
      await command("projects.put", {
        id: "trust",
        title: "TRUST",
        status: "active",
        route: "/mobile/mobile-companion?project=trust",
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await command("feed.publish", {
        id: "mobile-choice-1",
        project: "trust",
        kind: "decision",
        title: "Choose the next step",
        summary: "Review the plan and respond.",
        body: "The proposed work is ready for your decision.",
        form: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              decision: { type: "string", title: "Decision", enum: ["Approve", "Revise"] },
              reason: { type: "string", title: "Reason", format: "textarea", maxLength: 8000 },
            },
            required: ["decision"],
          },
          uiSchema: {
            type: "VerticalLayout",
            elements: [
              { type: "Control", scope: "#/properties/decision" },
              { type: "Control", scope: "#/properties/reason" },
            ],
          },
        },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/mobile/mobile-companion/");
  await expect(page.getByRole("heading", { name: "Sujets" })).toBeVisible();
  await page.evaluate(() => ((window as Window & { __navigationMarker?: number }).__navigationMarker = 1));
  await page.getByRole("button", { name: /TRUST.*Review the plan/ }).click();
  await expect(page.getByRole("heading", { name: "Épisodes" })).toBeVisible();
  await page.getByRole("button", { name: /Choose the next step/ }).click();
  await expect(page.getByRole("heading", { name: "Choose the next step" })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __navigationMarker?: number }).__navigationMarker)).toBe(1);
  await page.getByLabel(/Decision/).selectOption("Approve");
  await page.getByLabel(/Reason/).fill("Proceed after review.");
  await page.getByRole("button", { name: "Envoyer la réponse" }).click();
  await expect(page.getByText("Réponse envoyée")).toBeVisible();
  const response = await (await request.get(`${base}/api/responses/mobile-choice-1`)).json();
  expect(response.answers).toEqual({ decision: "Approve", reason: "Proceed after review." });
  expect(response.responseRevision).toBe(1);
  await page.getByRole("button", { name: "Ouvrir le menu" }).click();
  await expect(page.getByRole("region", { name: "Notifications sur le téléphone" })).toBeVisible();
  await page.getByRole("button", { name: "Sombre" }).click();
  await page.getByRole("button", { name: "Violet" }).click();
  await page.getByRole("dialog", { name: "Ouvrir le menu" }).getByRole("button", { name: "Fermer le menu" }).click();
  await expect(page.locator("main.mobile-companion")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("main.mobile-companion")).toHaveAttribute("data-accent", "violet");
  await page.reload();
  await expect(page.getByText("Réponse envoyée")).toBeVisible();
  await expect(page.locator("main.mobile-companion")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("main.mobile-companion")).toHaveAttribute("data-accent", "violet");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a superseded episode stays reachable through the current episode", async ({ page, request }) => {
  const base = "/extensions/mobile-companion";
  await request.post(`${base}/prepare`, { data: {} });
  await request.post(`${base}/start`, { data: {} });
  const command = (name: string, args: object) =>
    request.post(`${base}/commands`, { data: { command: name, arguments: args } });
  expect((await command("projects.put", { id: "revisions", title: "Revisions", status: "active" })).ok()).toBeTruthy();
  expect(
    (
      await command("feed.publish", {
        id: "episode-old",
        project: "revisions",
        kind: "progress",
        title: "Older wording",
        summary: "Earlier summary",
        body: "Earlier body",
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await command("feed.publish", {
        id: "episode-current",
        project: "revisions",
        kind: "progress",
        title: "Current wording",
        summary: "Current summary",
        body: "Current body",
        supersedes: "episode-old",
      })
    ).status(),
  ).toBe(201);
  await page.goto("/mobile/mobile-companion/?project=revisions");
  await expect(page.locator(".mobile-entry")).toHaveCount(1);
  await page.getByRole("button", { name: /Current wording/ }).click();
  await page.getByRole("button", { name: "Lire la version précédente" }).click();
  await expect(page.getByRole("heading", { name: "Older wording" })).toBeVisible();
});

test("a decision item shows its live parent Plan and declared child mission at phone width", async ({
  page,
  request,
}) => {
  const base = "/extensions/mobile-companion";
  await request.post(`${base}/prepare`, { data: {} });
  await request.post(`${base}/start`, { data: {} });
  const rpc = async (method: string, params: unknown) => {
    const response = await request.post("/rpc", { data: { jsonrpc: "2.0", id: method, method, params } });
    const envelope = await response.json();
    expect(envelope.error).toBeUndefined();
    return envelope.result;
  };
  const command = (name: string, args: object) =>
    request.post(`${base}/commands`, { data: { command: name, arguments: args } });
  const operationSource = await readFile(
    new URL("../../../extensions/mobile-companion/operations/mobile.response-decision-read.feature", import.meta.url),
    "utf8",
  );
  await rpc("environment.save", {
    environment: "local",
    values: { mobileResponseUrl: `http://127.0.0.1:4399${base}/api/responses/` },
  });
  await rpc("operation.save", { source: operationSource, sourceName: "mobile.response-decision-read.feature" });
  await rpc("procedure.publish", {
    source: `@trust-dsl:1 @procedure:mobile-browser-parent @version:1.0.0
Feature: Coordinate a mobile decision and child diagnosis
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read a decision. | Change the decision. |
    And missions "diagnostics" declared by agent
  @scenario:diagnostics
  Scenario: Run declared diagnostics
    Then Invocation "diagnostics" runs each declared Procedure in "diagnostics" and must establish "the declared diagnostic is complete"
`,
  });
  const childSource = `@trust-dsl:1 @procedure:mobile-browser-child @version:1.0.0
Feature: Read a submitted decision
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the submitted decision. | Change the decision. |
    And one reference "form"
  @scenario:read
  Scenario: Read the decision
    Then Check "read decision" runs Operation "mobile.response-decision-read@1.0.0" on "form" as Input "item" and must establish "the decision is approved"
      """js
      fact.decision === "Approve" || fail("approval is absent")
      """
`;
  await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "mobile-browser-parent",
    procedureVersion: "1.0.0",
    plan: "mobile-browser-episode",
    environment: "local",
    rootInputs: {},
    metadata: { title: "Release 1.2 decision", labels: ["release"], annotations: {} },
  });
  const parent = await rpc("plan.read", { plan: "mobile-browser-episode" });
  await rpc("plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan: "mobile-browser-episode",
    expectedRevision: parent.revision,
    declarations: {},
    missionDeclarations: {
      diagnostics: [
        {
          id: "release-diagnosis",
          definition: { kind: "inline", procedureSource: childSource, operationSources: [] },
          rootInputs: { form: "mobile-episode-decision" },
        },
      ],
    },
  });
  expect((await command("projects.put", { id: "episode", title: "Release", status: "active" })).ok()).toBeTruthy();
  expect(
    (
      await command("feed.publish", {
        id: "mobile-episode-decision",
        project: "episode",
        kind: "decision",
        title: "Can I release 1.2?",
        summary: "Review the diagnosis and authorize the release.",
        body: "The release proposal is ready for review.",
        plan: "mobile-browser-episode",
        form: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              decision: { type: "string", title: "Decision", enum: ["Approve", "Revise"] },
            },
            required: ["decision"],
          },
        },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/mobile/mobile-companion/?project=episode&item=mobile-episode-decision");
  await expect(page.getByRole("heading", { name: "Can I release 1.2?" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Épisode de délégation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Étapes du travail" })).toBeVisible();
  await expect(page.locator(".mobile-episode-steps").getByText("diagnostics")).toBeVisible();
  await expect(page.locator(".mobile-episode-steps").getByText("Aucun résultat remis pour cette étape.")).toBeVisible();
  await page.getByText("Détails de la procédure TRUST").click();
  await expect(page.getByRole("heading", { name: "Release 1.2 decision" })).toBeVisible();
  await page.locator(".mobile-episode-branch > summary").first().click();
  await page.locator(".mobile-episode-branch").first().getByText("Validations et preuves").click();
  await expect(page.getByText("Décision observée")).toBeVisible();
  await page.getByText("Identité de la mission").click();
  await expect(page.getByText("diagnostics/release-diagnosis")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByLabel("Decision").selectOption("Approve");
  await page.getByRole("button", { name: "Envoyer la réponse" }).click();
  await expect(page.getByText("Réponse enregistrée")).toBeVisible();
  expect(
    (
      await command("feed.publish", {
        id: "mobile-episode-progress",
        project: "episode",
        kind: "progress",
        title: "Release work context",
        summary: "The release context was published with this update.",
        body: "This note explains the release work before its live status.",
        plan: "mobile-browser-episode",
      })
    ).status(),
  ).toBe(201);
  await page.goto("/mobile/mobile-companion/?project=episode&item=mobile-episode-progress");
  const contextPosition = await page.getByRole("heading", { name: "Contexte et compte rendu publié" }).boundingBox();
  const statusPosition = await page.getByRole("region", { name: "Épisode de délégation" }).boundingBox();
  expect(contextPosition?.y).toBeLessThan(statusPosition?.y ?? 0);
});

test("a project document opens an allowlisted reader and returns to its detail", async ({ page, request }) => {
  const base = "/extensions/mobile-companion";
  await request.post(`${base}/prepare`, { data: {} });
  await request.post(`${base}/start`, { data: {} });
  const command = (name: string, args: object) =>
    request.post(`${base}/commands`, {
      data: { command: name, arguments: args },
    });
  expect(
    (
      await command("projects.put", { id: "maket", title: "Maket", status: "active", route: "/mobile/apps/maket/" })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await command("feed.publish", {
        id: "reader-document-1",
        project: "maket",
        kind: "document",
        title: "Read the example document",
        summary: "A document from Maket",
        body: "Open this document to read it.",
        documentUrl: "/mobile/apps/maket/documents/example/read",
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto("/mobile/mobile-companion/?project=maket");
  await expect(page.getByRole("heading", { name: "Épisodes" })).toBeVisible();
  await page.getByRole("button", { name: /Read the example document/ }).click();
  await page.getByRole("button", { name: /Lire le document/ }).click();
  const reader = page.frameLocator(".mobile-embedded iframe");
  await expect(reader.getByRole("heading", { name: "Example document" })).toBeVisible();
  await expect.poll(() => reader.locator("body").getAttribute("data-connection")).toBe("connected");
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:4179");
  await page.getByRole("button", { name: "Retour à l’élément" }).click();
  await expect(page.getByRole("heading", { name: "Read the example document" })).toBeVisible();
  await page.getByRole("button", { name: "Retour au sujet" }).click();
  await expect(page.getByRole("heading", { name: "Maket" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Ouvrir l’application/ })).toBeVisible();
  await page.setViewportSize({ width: 884, height: 915 });
  await page.getByRole("button", { name: "Afficher le panneau des sujets" }).click();
  await expect(page.getByRole("complementary", { name: "Sujets" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Applications" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an unavailable document reader shows a retryable explanation", async ({ page, request }) => {
  const base = "/extensions/mobile-companion";
  await request.post(`${base}/prepare`, { data: {} });
  await request.post(`${base}/start`, { data: {} });
  const project = await request.post(`${base}/commands`, {
    data: {
      command: "projects.put",
      arguments: { id: "maket", title: "Maket", status: "active", route: "/mobile/apps/maket/" },
    },
  });
  expect(project.ok()).toBeTruthy();
  const published = await request.post(`${base}/commands`, {
    data: {
      command: "feed.publish",
      arguments: {
        id: "reader-unavailable-1",
        project: "maket",
        kind: "document",
        title: "Unavailable document",
        summary: "A reader that has stopped",
        body: "The reader cannot be reached.",
        documentUrl: "/mobile/apps/maket/documents/unavailable/read",
      },
    },
  });
  expect(published.ok()).toBeTruthy();
  await page.goto("/mobile/mobile-companion/?project=maket&item=reader-unavailable-1&reader=1");
  await expect(page.getByRole("alert")).toContainText("Le lecteur Maket est indisponible");
  await expect(page.locator(".mobile-embedded iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Réessayer" }).click();
  await expect(page.getByRole("alert")).toContainText("Le lecteur Maket est indisponible");
  await page.getByRole("button", { name: "Retour à l’élément" }).click();
  await expect(page.getByRole("heading", { name: "Unavailable document" })).toBeVisible();
});

test("silent updates preserve loaded history and the reading position", async ({ page, request }) => {
  const base = "/extensions/mobile-companion";
  await request.post(`${base}/prepare`, { data: {} });
  await request.post(`${base}/start`, { data: {} });
  const command = (name: string, args: object) =>
    request.post(`${base}/commands`, { data: { command: name, arguments: args } });
  expect((await command("projects.put", { id: "history", title: "History", status: "active" })).ok()).toBeTruthy();
  for (let index = 0; index < 55; index++) {
    expect(
      (
        await command("feed.publish", {
          id: `history-${String(index).padStart(2, "0")}`,
          project: "history",
          kind: "progress",
          title: `History item ${String(index).padStart(2, "0")}`,
          summary: "A retained historical update.",
          body: "Read this update in the timeline.",
        })
      ).status(),
    ).toBe(201);
  }
  await page.goto("/mobile/mobile-companion/?project=history");
  await expect(page.locator(".mobile-entry")).toHaveCount(50);
  await page.getByRole("button", { name: "Éléments précédents" }).click();
  await expect(page.locator(".mobile-entry")).toHaveCount(55);
  const older = page.getByRole("button", { name: /History item 10/ });
  await older.scrollIntoViewIfNeeded();
  const before = await older.evaluate((element) => element.getBoundingClientRect().top);

  expect(
    (
      await command("feed.publish", {
        id: "history-new",
        project: "history",
        kind: "progress",
        title: "New update",
        summary: "A new update in this conversation.",
        body: "The older timeline remains available.",
      })
    ).status(),
  ).toBe(201);
  await expect(page.locator(".mobile-entry")).toHaveCount(56);
  await expect(older).toBeVisible();
  const afterEvent = await older.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(afterEvent - before)).toBeLessThan(5);

  const refreshed = page.waitForResponse((response) => response.url().includes("/api/feed?") && response.ok());
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await refreshed).finished();
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(page.locator(".mobile-entry")).toHaveCount(56);
  await expect(older).toBeVisible();
  const afterVisibility = await older.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(afterVisibility - afterEvent)).toBeLessThan(5);
});

test("Markdown post renders headings, lists, tables and safe links on phone and wide screens", async ({
  page,
  request,
}) => {
  const base = "/extensions/mobile-companion";
  await request.post(`${base}/prepare`, { data: {} });
  await request.post(`${base}/start`, { data: {} });
  const command = (name: string, args: object) =>
    request.post(`${base}/commands`, { data: { command: name, arguments: args } });
  expect((await command("projects.put", { id: "benchmark", title: "Benchmark", status: "active" })).ok()).toBeTruthy();
  expect(
    (
      await command("feed.publish", {
        id: "markdown-fixture",
        project: "benchmark",
        kind: "explanation",
        title: "Cinq produits",
        summary: "Five tools in one post.",
        body: `# Cinq produits\n\n- **Slack** — échanges\n- **Linear** — travail\n\n| Produit | Modèle | Notes |\n| --- | --- | --- |\n| Slack | Canaux | Lien avec le travail durable et les documents |\n| | | Autre observation avec [source sûre](https://example.com/reference) |\n\n| Sens | Mécanisme | Données | État |\n| --- | --- | --- | --- |\n| TRUST → extension | Operation | Référence | À concevoir |\n\n[Source sûre](https://example.com/reference) · [Lien dangereux](javascript:alert(1))\n\n> **Revue indépendante — portée du modèle proposé**\n>\n> Hypothèse de design avec [source officielle](https://linear.app/docs/conceptual-model).\n>\n> - Identité\n> - Relations\n\n<img src=x onerror="window.__unsafe=1"><script>window.__unsafe=1</script>\n\n![Pixel](https://example.com/pixel.png)`,
      })
    ).status(),
  ).toBe(201);

  await page.goto("/mobile/mobile-companion/?project=benchmark");
  await page.getByRole("button", { name: /Cinq produits/ }).click();
  await expect(page.getByRole("heading", { name: "Cinq produits" })).toHaveCount(1);
  await expect(page.getByRole("listitem").filter({ hasText: "Slack" })).toBeVisible();
  await expect(page.locator(".mobile-table-compact-row")).toHaveCount(1);
  await page.locator(".mobile-table-full summary").first().click();
  await expect(page.getByRole("table")).toHaveCount(2);
  await expect(page.getByRole("table").first().getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("table").first().getByRole("link", { name: "source sûre" })).toBeVisible();
  const review = page.locator(".mobile-independent-review");
  await expect(review).toContainText("Revue indépendante — portée du modèle proposé");
  await expect(review.getByRole("listitem")).toHaveCount(2);
  await expect(review.getByRole("link", { name: "source officielle" })).toHaveAttribute(
    "href",
    "https://linear.app/docs/conceptual-model",
  );
  expect(await review.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  const mechanism = page.locator('.mobile-table-full td[data-label="Mécanisme"]');
  await expect(mechanism).toContainText("Operation");
  const wideTable = page.locator(".mobile-table-full .mobile-table-viewport").first();
  expect(await wideTable.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await wideTable.evaluate((element) => {
    element.scrollLeft = 180;
  });
  expect(await wideTable.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const safeLink = page.getByRole("link", { name: "Source sûre", exact: true });
  await expect(safeLink).toHaveAttribute("href", "https://example.com/reference");
  await expect(safeLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("link", { name: "Lien dangereux" })).toHaveCount(0);
  await expect(page.locator(".mobile-body img, .mobile-body script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __unsafe?: number }).__unsafe)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 884, height: 915 });
  await expect(page.getByRole("heading", { name: "Cinq produits" })).toHaveCount(1);
  await expect(page.getByRole("table")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Mermaid diagrams render as inert images and malformed source stays readable", async ({ page, request }) => {
  const base = "/extensions/mobile-companion";
  await request.post(`${base}/prepare`, { data: {} });
  await request.post(`${base}/start`, { data: {} });
  const command = (name: string, args: object) =>
    request.post(`${base}/commands`, {
      data: { command: name, arguments: args },
    });
  expect((await command("projects.put", { id: "diagrams", title: "Diagrams", status: "active" })).ok()).toBeTruthy();
  const body = [
    "# Mermaid examples",
    "```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```",
    "```mermaid\nflowchart LR\n  A -->\n```",
    '```mermaid\nflowchart LR\n  A["<img src=x onerror=window.__unsafe=1>"] --> B[Safe]\n  click A "https://evil.example/" "Open"\n```',
  ].join("\n\n");
  expect(
    (
      await command("feed.publish", {
        id: "mermaid-fixture",
        project: "diagrams",
        kind: "explanation",
        title: "Mermaid fixtures",
        summary: "Valid, invalid and hostile diagrams",
        body,
      })
    ).status(),
  ).toBe(201);
  await page.goto("/mobile/mobile-companion/?project=diagrams&item=mermaid-fixture");
  await expect.poll(() => page.locator(".mobile-mermaid img").count()).toBe(1);
  await expect(page.locator(".mobile-mermaid-error")).toHaveCount(2);
  await expect(page.locator(".mobile-mermaid-error").filter({ hasText: "A -->" })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".mobile-mermaid img")
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  expect(await page.evaluate(() => (window as Window & { __unsafe?: number }).__unsafe)).toBeUndefined();
  expect(await page.locator(".mobile-mermaid a, .mobile-mermaid script, .mobile-mermaid iframe")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Agrandir" }).first().click();
  await expect(page.locator(".mobile-mermaid").first()).toHaveAttribute("data-expanded", "true");
  const enlarged = page.getByRole("dialog", { name: "Diagramme agrandi" });
  await expect(enlarged).toBeVisible();
  await expect(enlarged.locator(".mobile-mermaid-dialog-scroll")).toHaveAttribute("data-zoomed", "false");
  await enlarged.getByRole("button", { name: "Taille réelle" }).click();
  await expect(enlarged.locator(".mobile-mermaid-dialog-scroll")).toHaveAttribute("data-zoomed", "true");
  await enlarged.getByRole("button", { name: "Vue d’ensemble" }).click();
  await expect(enlarged.locator(".mobile-mermaid-dialog-scroll")).toHaveAttribute("data-zoomed", "false");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Diagramme agrandi" })).toHaveCount(0);
});

test("touch swipe reveals pin and hold delete with undo without deleting project data", async ({ page, request }) => {
  const base = "/extensions/mobile-companion";
  await request.post(`${base}/prepare`, { data: {} });
  await request.post(`${base}/start`, { data: {} });
  const command = (name: string, args: object) =>
    request.post(`${base}/commands`, {
      data: { command: name, arguments: args },
    });
  for (const [id, title] of [
    ["swipe-alpha", "Alpha"],
    ["swipe-beta", "Beta"],
  ])
    expect((await command("projects.put", { id, title, status: "active" })).ok()).toBeTruthy();
  expect(
    (
      await command("feed.publish", {
        id: "swipe-item",
        project: "swipe-alpha",
        kind: "explanation",
        title: "Retained item",
        summary: "History remains",
        body: "Retained body",
      })
    ).status(),
  ).toBe(201);
  await page.goto("/mobile/mobile-companion/");
  const row = page.locator(".mobile-conversation-item").filter({ hasText: "Alpha" });
  await expect(row).toBeVisible();
  const session = await page.context().newCDPSession(page);
  const swipe = async () => {
    const box = await row.boundingBox();
    if (!box) throw new Error("Conversation row unavailable");
    const y = box.y + box.height / 2;
    const x = box.x + box.width - 45;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 190, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe();
  await expect(row).toHaveAttribute("data-actions-open", "true");
  await row.getByRole("button", { name: "Épingler" }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${base}/api/conversations`)).json()).conversations.find(
          (entry: { project: string }) => entry.project === "swipe-alpha",
        )?.pinned,
    )
    .toBe(true);
  await expect(page.locator(".mobile-conversation-item").first()).toContainText("Alpha");
  await page.waitForTimeout(250);
  await swipe();
  await expect(row).toHaveAttribute("data-actions-open", "true");
  await page.waitForTimeout(250);
  const deleteButton = row.getByRole("button", { name: /Maintenir pour supprimer/ });
  const box = await deleteButton.boundingBox();
  if (!box) throw new Error("Delete action unavailable");
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  });
  await expect(deleteButton).toHaveAttribute("data-holding", "true");
  await page.waitForTimeout(1600);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(row).toHaveCount(0);
  expect((await request.get(`${base}/api/items/swipe-item`)).status()).toBe(200);
  await page.getByRole("button", { name: "Annuler" }).click();
  await expect(row).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${base}/api/conversations`)).json()).conversations.find(
          (entry: { project: string }) => entry.project === "swipe-alpha",
        )?.deletedAt,
    )
    .toBeNull();
});

test("the host manifest stays shared while the mobile push worker retains its scope", async ({ page, request }) => {
  const base = "/extensions/mobile-companion";
  expect([200, 409]).toContain((await request.post(`${base}/prepare`, { data: {} })).status());
  expect((await request.post(`${base}/start`, { data: {} })).ok()).toBeTruthy();
  await page.goto("/extensions/mobile-companion");
  await expect(page.locator(".mobile-companion")).toBeVisible();
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.id).toBe("/");
  expect(manifest.start_url).toBe("/overview");
  expect(manifest.scope).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.name).toBe("TRUST");
  expect(manifest.theme_color).toBe("#f4f3ef");
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["192x192", "512x512"]);
  expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/manifest.webmanifest");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  const cdp = await page.context().newCDPSession(page);
  const parsed = await cdp.send("Page.getAppManifest");
  expect(parsed.errors).toEqual([]);
  expect(parsed.url).toBe(new URL("/manifest.webmanifest", page.url()).href);
  await page.evaluate(async () =>
    navigator.serviceWorker.register("/mobile/mobile-companion/sw.js", { scope: "/mobile/mobile-companion/" }),
  );
  await expect
    .poll(() =>
      page.evaluate(async () =>
        Boolean((await navigator.serviceWorker.getRegistration("/mobile/mobile-companion/"))?.active),
      ),
    )
    .toBe(true);
  for (const size of [192, 512]) {
    const icon = await request.get(`/icons/trust-${size}.png`);
    expect(icon.ok()).toBeTruthy();
    expect(icon.headers()["content-type"]).toContain("image/png");
    const bytes = await icon.body();
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
    expect((await request.get(`/mobile/mobile-companion/icon-${size}.png`)).ok()).toBeTruthy();
  }
  await page.goto("/overview");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
});

test("a long article keeps its rendered section outline usable at phone and wide widths", async ({ page, request }) => {
  const base = "/extensions/mobile-companion";
  await request.post(`${base}/prepare`, { data: {} });
  await request.post(`${base}/start`, { data: {} });
  const command = (name: string, args: object) =>
    request.post(`${base}/commands`, {
      data: { command: name, arguments: args },
    });
  expect((await command("projects.put", { id: "outline", title: "Outline", status: "active" })).ok()).toBeTruthy();
  const body = ["First", "Second", "Third", "Fourth"]
    .map((label) => `## ${label} section\n\n${`${label} content for reading. `.repeat(90)}`)
    .join("\n\n");
  expect(
    (
      await command("feed.publish", {
        id: "outline-article",
        project: "outline",
        kind: "explanation",
        title: "Long article",
        summary: "A long document with four sections.",
        body,
      })
    ).status(),
  ).toBe(201);
  await page.setViewportSize({ width: 412, height: 884 });
  await page.goto("/mobile/mobile-companion/?project=outline&item=outline-article");
  await expect(page.getByRole("heading", { name: "Long article" })).toBeVisible();
  const outline = page.locator(".mobile-reading-outline");
  await expect(outline.locator("summary")).toContainText("1 / 4");
  await outline.locator("summary").click();
  await page
    .getByRole("navigation", { name: "Sections de l’article" })
    .getByRole("button", { name: /Fourth section/ })
    .click();
  await expect
    .poll(() =>
      page.getByRole("heading", { name: "Fourth section" }).evaluate((heading) => heading.getBoundingClientRect().top),
    )
    .toBeLessThan(150);
  await expect(outline.locator("summary")).toContainText("4 / 4");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 884, height: 915 });
  await outline.locator("summary").click();
  await page
    .getByRole("navigation", { name: "Sections de l’article" })
    .getByRole("button", { name: /Second section/ })
    .click();
  await expect
    .poll(() =>
      page.getByRole("heading", { name: "Second section" }).evaluate((heading) => heading.getBoundingClientRect().top),
    )
    .toBeLessThan(150);
  await expect(outline.locator("summary")).toContainText("2 / 4");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const width of [412, 884])
  test(`subject links open their source and return at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const suffix = String(width);
    const base = "/extensions/mobile-companion";
    await request.post(`${base}/prepare`, { data: {} });
    await request.post(`${base}/start`, { data: {} });
    const command = (name: string, args: object) =>
      request.post(`${base}/commands`, { data: { command: name, arguments: args } });
    expect((await command("projects.put", { id: "trust", title: "TRUST", status: "active" })).ok()).toBeTruthy();
    for (const item of [
      {
        id: `subject-article-${suffix}`,
        kind: "explanation",
        title: "Article source",
        summary: "Analysis",
        body: "# Reference",
      },
      {
        id: `subject-document-${suffix}`,
        kind: "document",
        title: "Maket source",
        summary: "Design",
        body: "Design",
        documentUrl: "/mobile/apps/maket/documents/one/read",
      },
      {
        id: `subject-episode-${suffix}`,
        kind: "progress",
        title: "Plan source",
        summary: "Execution",
        body: "Execution",
        plan: `subject-plan-${suffix}`,
      },
    ])
      expect((await command("feed.publish", { ...item, project: "trust" })).status()).toBe(201);
    expect(
      (
        await command("subjects.put", {
          id: `mobile-work-${suffix}`,
          project: "trust",
          title: "Mobile work",
          description: "A durable subject",
          expectedRevision: 0,
          links: [
            {
              id: "article",
              kind: "article",
              relation: "Reference article",
              description: "Analysis",
              item: `subject-article-${suffix}`,
              targetIdentity: `subject-article-${suffix}`,
              provenance: "Editorial choice",
            },
            {
              id: "document",
              kind: "document",
              relation: "Design document",
              description: "Maket",
              item: `subject-document-${suffix}`,
              targetIdentity: "/mobile/apps/maket/documents/one/read",
              provenance: "Maket link",
            },
            {
              id: "plan",
              kind: "plan",
              relation: "Tracked execution",
              description: "TRUST",
              item: `subject-episode-${suffix}`,
              targetIdentity: `subject-plan-${suffix}`,
              provenance: "Plan engagement",
            },
          ],
        })
      ).status(),
    ).toBe(201);
    await page.goto("/mobile/mobile-companion/?project=trust");
    await page.getByRole("button", { name: "Mobile work →" }).first().click();
    await expect(page.getByRole("heading", { name: "Mobile work" })).toBeVisible();
    await expect(page.getByText("Aucune décision enregistrée pour ce sujet.")).toBeVisible();
    await expect(page.getByText("Provenance du lien · Maket link")).toBeVisible();
    await page
      .getByRole("listitem")
      .filter({ hasText: "Reference article" })
      .getByRole("button", { name: /Ouvrir la source/ })
      .click();
    await expect(page.getByRole("heading", { name: "Article source" })).toBeVisible();
    await page.locator(".mobile-back").click();
    await expect(page.getByRole("heading", { name: "Mobile work" })).toBeVisible();
    await page
      .getByRole("listitem")
      .filter({ hasText: "Design document" })
      .getByRole("button", { name: /Ouvrir la source/ })
      .click();
    await expect(page.getByRole("heading", { name: "Maket source" })).toBeVisible();
    await page.locator(".mobile-back").click();
    await expect(page.getByRole("heading", { name: "Mobile work" })).toBeVisible();
    await page
      .getByRole("listitem")
      .filter({ hasText: "Tracked execution" })
      .getByRole("button", { name: /Ouvrir la source/ })
      .click();
    await expect(page).toHaveURL(
      new RegExp(
        `subject=mobile-work-${suffix}.*item=subject-episode-${suffix}|item=subject-episode-${suffix}.*subject=mobile-work-${suffix}`,
      ),
    );
    await expect(page.getByRole("heading", { name: "Plan source" })).toBeVisible();
    await page.locator(".mobile-back").click();
    await expect(page.getByRole("heading", { name: "Mobile work" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`subject=mobile-work-${suffix}`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
