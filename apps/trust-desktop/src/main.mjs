import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deployRunner,
  readServerConfiguration,
  readTrustServerStatus,
  resolveTrustInstallation,
  startTrustServer,
} from "@trust/shell";
import { app, BrowserWindow, dialog, Menu } from "electron";

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolved = await readServerConfiguration(process.env, path.join(app.getPath("userData"), "server"));
const { configuration } = resolved;
const installation = resolveTrustInstallation(
  configuration.shell.installRoot ?? path.resolve(applicationRoot, "../.."),
);
const { host, port: runtimePort, webPort } = configuration.server;
let ownedServer;
let mainWindow;

await app.whenReady();
const existing = await readTrustServerStatus(host, webPort, configuration.shell.webAccessPassword);
if (!existing.running) {
  ownedServer = await startTrustServer({
    installation,
    configuration: resolved,
    host,
    runtimePort,
    webPort,
    stateDirectory: configuration.server.stateDirectory,
  });
}
await createWindow();

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    title: "TRUST",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installMenu(mainWindow);
  await mainWindow.loadURL(existing.running ? existing.url : ownedServer.url);
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  if (ownedServer === undefined) return;
  event.preventDefault();
  const server = ownedServer;
  ownedServer = undefined;
  void server.close().finally(() => app.quit());
});

function installMenu(browserWindow) {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Deploy Runner…",
          accelerator: "CmdOrCtrl+Shift+D",
          click: () => void chooseAndDeployRunner(browserWindow),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function chooseAndDeployRunner(browserWindow) {
  const selection = await dialog.showOpenDialog(browserWindow, {
    title: "Deploy TRUST Runner",
    buttonLabel: "Select destination",
    properties: ["openDirectory", "createDirectory"],
  });
  const destination = selection.filePaths[0];
  if (selection.canceled || destination === undefined) return;
  const confirmation = await dialog.showMessageBox(browserWindow, {
    type: "warning",
    title: "Deploy TRUST Runner",
    message: "Replace this directory with the TRUST Runner package?",
    detail: destination,
    buttons: ["Deploy", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (confirmation.response !== 0) return;
  try {
    const deployed = await deployRunner(installation, destination);
    await dialog.showMessageBox(browserWindow, {
      type: "info",
      title: "TRUST Runner deployed",
      message: "The Runner package is ready.",
      detail: deployed,
    });
  } catch (error) {
    await dialog.showMessageBox(browserWindow, {
      type: "error",
      title: "TRUST Runner deployment failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
