import { expect, type Page, test } from "@playwright/test";

/* Registry interface acceptance on the real runtime, with local Git, HTTP and file registries. The scenarios share
   one runtime and run in file order: sources are added, packages installed, updated, uninstalled and configured. */

test.describe.configure({ mode: "serial" });

const FIXTURES = "http://127.0.0.1:4394";
type Fixture = { gitRepository: string; localIndex: string; httpIndex: string; dataDirectory: string };
let fixture: Fixture;

test.beforeAll(async ({ request }) => {
  fixture = (await (await request.get(`${FIXTURES}/control/fixture`)).json()) as Fixture;
});

async function addSource(page: Page, name: string, kind: "Git repository" | "HTTP index" | "Local file", url: string) {
  await page.goto("/extensions/sources/new");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("tab", { name: kind }).click();
  const address = page.getByRole("textbox", {
    name: kind === "Git repository" ? "Repository" : kind === "HTTP index" ? "Index URL" : "Index file",
  });
  await address.fill(url);
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page).toHaveURL(new RegExp(`/extensions/sources/${name}$`));
}

async function refreshSource(page: Page, name: string) {
  await page.goto(`/extensions/sources/${name}`);
  await page.getByRole("button", { name: "Refresh index" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: `Index of ${name} refreshed` })).toBeVisible();
}

async function install(page: Page, source: string, name: string, version: string, settings?: Record<string, unknown>) {
  await page.goto(`/extensions/sources/${source}/packages/${name}/${version}`);
  if (settings) {
    await page.getByText("Initial settings (JSON)").click();
    await page.getByRole("textbox", { name: "Initial settings (JSON)" }).fill(JSON.stringify(settings));
  }
  await page.getByRole("button", { name: `Install ${name} ${version}` }).click();
  await expect(page.getByText(`${name} ${version} installed`)).toBeVisible({ timeout: 60_000 });
}

/** Confirms an irreversible action in the in-app confirmation dialog, named by its title. */
async function confirm(page: Page, action: string) {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toHaveAccessibleName(/\?$/);
  await dialog.getByRole("button", { name: action, exact: true }).click();
}

async function openRowMenu(page: Page, title: string) {
  await page.goto("/extensions");
  await page.getByRole("button", { name: `Actions for ${title}` }).click();
  return page.getByRole("menu");
}

test("REG-010 AC1 extension management lists sources, their packages and installed extensions, and returning from a detail keeps the context", async ({
  page,
}) => {
  await page.goto("/extensions");
  // Navigation: the Extensions section has its own Installed and Sources entries (REG-015).
  const navigation = page.getByRole("navigation", { name: "Extensions" });
  await expect(navigation.getByRole("link", { name: "Installed" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "Sources" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Installed extensions" })).toBeVisible();
  const row = page.getByRole("row", { name: "Manual kit" });
  await expect(row).toContainText("Local manifest");
  await expect(row).toContainText("0.1.0");
  // The filter lives in the URL and survives opening a detail and coming back.
  await page.getByPlaceholder("Filter by name or source").fill("manual");
  await expect(page).toHaveURL(/q=manual/);
  await row.getByRole("link", { name: /Manual kit/ }).click();
  await expect(page).toHaveURL(/\/extensions\/settings\/manual-kit/);
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Installed", exact: true })
    .click();
  await expect(page.getByPlaceholder("Filter by name or source")).toHaveValue("manual");
  // The row opened before is selected again: highlighted, and its link has the focus.
  await expect(page.getByRole("row", { name: "Manual kit" })).toHaveAttribute("data-selected", "true");
  await expect(page.getByRole("row", { name: "Manual kit" }).getByRole("link", { name: /Manual kit/ })).toBeFocused();
  // The row menu of the last row is fully visible and offers only the applicable, explained transitions.
  const menu = await openRowMenu(page, "Manual kit");
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height).toBeTruthy();
  await expect(menu.getByRole("menuitem", { name: /Prepare storage/ })).toContainText("storage schema");
  await expect(menu.getByRole("menuitem", { name: /^Stop/ })).toHaveCount(0);
  // The menu is named, takes the focus and is operable from the keyboard; Escape returns to its trigger.
  await expect(menu).toHaveAccessibleName("Actions for Manual kit");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Actions for Manual kit" })).toBeFocused();
  // At phone width the page never scrolls sideways; the list keeps its essential columns and row actions.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/extensions");
  await expect(page.getByRole("row", { name: "Manual kit" })).toBeVisible();
  const overflow = await page.getByRole("main").evaluate((main) => main.scrollWidth - main.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Actions for Manual kit" }).click();
  const small = await page.getByRole("menu").boundingBox();
  expect(small && small.x >= 0 && small.x + small.width <= 390).toBeTruthy();
});

test("REG-015 AC1 the Extensions navigation section shows Installed and Sources entries without opening a page or menu", async ({
  page,
}) => {
  await page.goto("/overview");
  const navigation = page.getByRole("navigation", { name: "Extensions" });
  await expect(navigation.getByRole("link", { name: "Installed" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Sources" })).toBeVisible();
});

test("REG-015 AC2 each entry opens its own page with its URL and breadcrumb and the current entry is highlighted", async ({
  page,
}) => {
  await page.goto("/overview");
  const navigation = page.getByRole("navigation", { name: "Extensions" });
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await navigation.getByRole("link", { name: "Sources" }).click();
  await expect(page).toHaveURL(/\/extensions\/sources$/);
  await expect(breadcrumb).toContainText("Sources");
  await expect(navigation.getByRole("link", { name: "Sources" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "Installed" })).not.toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Installed" }).click();
  await expect(page).toHaveURL(/\/extensions$/);
  await expect(breadcrumb).toContainText("Installed");
  await expect(navigation.getByRole("link", { name: "Installed" })).toHaveAttribute("aria-current", "page");
  // On a phone the same entries are one tap away, in the navigation drawer of the header.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(navigation).toBeHidden();
  await page.getByRole("button", { name: "Navigation" }).click();
  await navigation.getByRole("link", { name: "Sources" }).click();
  await expect(page).toHaveURL(/\/extensions\/sources$/);
  await expect(navigation).toBeHidden();
});

test("REG-016 AC1 only the actions applicable to the current state are offered, each explaining its effect", async ({
  page,
}) => {
  const menu = await openRowMenu(page, "Manual kit");
  await expect(menu.getByRole("menuitem", { name: /^Prepare storage/ })).toContainText("storage schema");
  await expect(menu.getByRole("menuitem", { name: /^Start/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Stop/ })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: /^Restart/ })).toHaveCount(0);
  for (const item of await menu.getByRole("menuitem", { name: /^(Prepare storage|Start)/ }).all())
    expect((await item.innerText()).split("\n").length).toBeGreaterThan(1);
  await page.keyboard.press("Escape");
});

test("REG-016 AC2 a running action is reported and its outcome shows the resulting state without a manual reload", async ({
  page,
}) => {
  const menu = await openRowMenu(page, "Manual kit");
  await menu.getByRole("menuitem", { name: /^Start/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Manual kit started" })).toContainText("State: Running");
  await expect(page.getByRole("row", { name: "Manual kit" })).toContainText("Running");
  const next = await openRowMenu(page, "Manual kit");
  await expect(next.getByRole("menuitem", { name: /^Stop/ })).toBeVisible();
  await expect(next.getByRole("menuitem", { name: /^Start/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("REG-015 AC3 extensions with a workspace stay reachable from the same navigation section", async ({ page }) => {
  // A workspace is offered once its extension runs (started by REG-016 AC2).
  await page.goto("/extensions");
  const navigation = page.getByRole("navigation", { name: "Extensions" });
  await expect(navigation).toContainText("Workspaces");
  await navigation.getByRole("link", { name: "Manual kit" }).click();
  await expect(page).toHaveURL(/\/extensions\/manual-kit$/);
  await expect(navigation.getByRole("link", { name: "Manual kit" })).toHaveAttribute("aria-current", "page");
});

test("REG-030 AC1 an operator adds a Git, HTTP or local file source from the interface", async ({ page }) => {
  await addSource(page, "git-fixtures", "Git repository", fixture.gitRepository);
  await expect(page.getByText("Index not refreshed")).toBeVisible();
  await addSource(page, "http-fixtures", "HTTP index", fixture.httpIndex);
  await addSource(page, "file-fixtures", "Local file", fixture.localIndex);
  await page.goto("/extensions/sources");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Sources" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  for (const name of ["git-fixtures", "http-fixtures", "file-fixtures"])
    await expect(page.getByRole("row", { name })).toBeVisible();
  // At phone width the sources table fits its box.
  await page.setViewportSize({ width: 390, height: 800 });
  const fit = await page
    .getByRole("table", { name: "Registry sources" })
    .evaluate(
      (element) =>
        (element.parentElement as HTMLElement).scrollWidth - (element.parentElement as HTMLElement).clientWidth,
    );
  expect(fit).toBeLessThanOrEqual(0);
});

test("REG-030 AC2 each extension offered by a source is shown and installed individually", async ({ page }) => {
  await refreshSource(page, "git-fixtures");
  for (const name of ["notes-kit", "board-kit", "ops-kit"])
    await expect(page.getByRole("row", { name: new RegExp(`^${name} `) })).toBeVisible();
  await install(page, "git-fixtures", "ops-kit", "1.0.0");
  await page.goto("/extensions/sources/git-fixtures");
  await expect(page.getByRole("row", { name: /^ops-kit / })).toContainText("installed 1.0.0");
  await expect(page.getByRole("row", { name: /^board-kit / })).toContainText("Not installed");
  await expect(page.getByRole("row", { name: /^notes-kit / })).toContainText("Not installed");
});

test("REG-060 AC2 refreshing a source index is a distinct action from updating a package", async ({
  page,
  request,
}) => {
  await refreshSource(page, "http-fixtures");
  await install(page, "http-fixtures", "data-kit", "1.0.0", { dataPath: `${fixture.dataDirectory}/data-kit.data` });
  await request.post(`${FIXTURES}/control/publish`);
  await refreshSource(page, "http-fixtures");
  await expect(page.getByRole("status")).toContainText("No installed package was changed");
  await page.goto("/extensions");
  const row = page.getByRole("row", { name: "Data kit" });
  await expect(row).toContainText("1.0.0");
  await expect(row).toContainText("3.0.0 available");
  // At phone width the badge wraps under the version: the table fits its box and the row actions stay reachable.
  await page.setViewportSize({ width: 390, height: 800 });
  const table = page.getByRole("table", { name: "Installed extensions" });
  const fit = await table.evaluate((element) => {
    const box = element.parentElement as HTMLElement;
    return box.scrollWidth - box.clientWidth;
  });
  expect(fit).toBeLessThanOrEqual(0);
  const trigger = await page.getByRole("button", { name: "Actions for Data kit" }).boundingBox();
  const frame = await table.boundingBox();
  expect(trigger && frame && trigger.x + trigger.width <= frame.x + frame.width).toBeTruthy();
  // At a small laptop width too, the secondary columns wait until there is room for them.
  await page.setViewportSize({ width: 960, height: 800 });
  const laptop = await table.evaluate((element) => {
    const box = element.parentElement as HTMLElement;
    return box.scrollWidth - box.clientWidth;
  });
  expect(laptop).toBeLessThanOrEqual(0);
});

test("REG-080 AC1 the update action shows the installed and target versions before it runs", async ({ page }) => {
  await page.goto("/extensions/packages/data-kit/update");
  await expect(page.getByLabel("Installed", { exact: true })).toHaveText("1.0.0");
  await page.getByRole("button", { name: "Target" }).click();
  await page.getByRole("option", { name: "3.0.0" }).click();
  await expect(page.getByText("1.0.0 → 3.0.0")).toBeVisible();
  await expect(page.getByRole("button", { name: "Update to 3.0.0" })).toBeEnabled();
});

test("REG-080 AC3 a failed update is reported and the previous version stays active", async ({ page }) => {
  await page.goto("/extensions/packages/data-kit/update?version=3.0.0");
  await page.getByRole("button", { name: "Update to 3.0.0" }).click();
  await expect(page.getByText("Update failed.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Version 1.0.0 is still active.")).toBeVisible();
  await page.goto("/extensions");
  await expect(page.getByRole("row", { name: "Data kit" })).toContainText("1.0.0");
});

test("REG-090 AC1 uninstalling reports the removed and the kept items", async ({ page }) => {
  await page.goto("/extensions/packages/ops-kit/uninstall");
  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  await confirm(page, "Uninstall");
  await expect(page.getByText("ops-kit 1.0.0 uninstalled")).toBeVisible();
  await expect(page.getByRole("list", { name: "Removed" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Kept" })).toBeVisible();
});

test("REG-090 AC2 removing a source is a distinct action that keeps installed packages", async ({ page }) => {
  await install(page, "git-fixtures", "notes-kit", "1.0.0", { dataPath: `${fixture.dataDirectory}/notes-kit.data` });
  await page.goto("/extensions/sources/git-fixtures");
  await page.getByRole("button", { name: "Remove source" }).click();
  await confirm(page, "Remove source");
  await expect(page.getByText("Source git-fixtures removed")).toBeVisible();
  await page.goto("/extensions");
  const row = page.getByRole("row", { name: "Notes kit" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("source removed");
  // Without a source index there is no other version: no update is offered.
  await page.getByRole("button", { name: "Actions for Notes kit" }).click();
  await expect(page.getByRole("menuitem", { name: /^Update/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("REG-090 AC3 deleting extension data requires an explicit separate choice", async ({ page, request }) => {
  // Preparing the storage writes the extension's data file; the outcome is shown in place (REG-016).
  const menu = await openRowMenu(page, "Data kit");
  await menu.getByRole("menuitem", { name: /Prepare storage/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Storage of Data kit prepared" })).toBeVisible();
  expect(
    ((await (await request.get(`${FIXTURES}/control/data?name=data-kit`)).json()) as { exists: boolean }).exists,
  ).toBe(true);
  await page.goto("/extensions/packages/data-kit/uninstall");
  const deleteData = page.getByRole("checkbox", { name: "Also delete the extension's data" });
  await expect(deleteData).not.toBeChecked();
  await deleteData.check();
  await expect(page.getByRole("button", { name: "Uninstall", exact: true })).toBeDisabled();
  await deleteData.uncheck();
  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  await confirm(page, "Uninstall");
  await expect(page.getByText("data-kit 1.0.0 uninstalled")).toBeVisible();
  expect(
    ((await (await request.get(`${FIXTURES}/control/data?name=data-kit`)).json()) as { exists: boolean }).exists,
  ).toBe(true);
});

test("REG-100 AC2 the settings page edits and validates an installation's settings from its JSON Schema", async ({
  page,
}) => {
  await refreshSource(page, "file-fixtures");
  await install(page, "file-fixtures", "local-kit", "1.0.0", { databasePath: `${fixture.dataDirectory}/local-kit` });
  await page.goto("/extensions/settings/local-kit");
  const form = page.getByRole("form", { name: "Settings" });
  await form.getByLabel(/databaseUrl/).fill("postgresql://127.0.0.1:5432/local");
  await expect(form.getByText("The settings are invalid:")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
  await form.getByLabel(/databaseUrl/).fill("");
  await expect(form.getByText("Settings valid")).toBeVisible();
  // Every generated field, including an enumerated credential reference, is named by its setting.
  await expect(form.getByRole("button", { name: /^passwordVariable/ })).toBeVisible();
  await form.getByRole("spinbutton", { name: /poolSize/ }).fill("8");
  await page.getByRole("button", { name: "Apply" }).click();
  // The outcome stays visible after the applied revision reloads the form.
  await expect(page.getByRole("status").filter({ hasText: /Settings applied \(revision \d+\)\./ })).toBeVisible();
  await expect(form.getByRole("spinbutton", { name: /poolSize/ })).toHaveValue("8");
});

test("REG-016 AC3 details and structuring actions open as pages and only an irreversible confirmation uses a dialog", async ({
  page,
}) => {
  let menu = await openRowMenu(page, "Local kit");
  await menu.getByRole("menuitem", { name: "Details" }).click();
  await expect(page).toHaveURL(/\/extensions\/packages\/local-kit$/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("local-kit");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  menu = await openRowMenu(page, "Local kit");
  await menu.getByRole("menuitem", { name: "Uninstall" }).click();
  await expect(page).toHaveURL(/\/extensions\/packages\/local-kit\/uninstall$/);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveAccessibleName("Uninstall local-kit 1.0.0?");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
