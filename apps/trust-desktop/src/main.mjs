import { app, BrowserWindow, dialog, Menu } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deployRunner,
  readTrustServerStatus,
  resolveTrustInstallation,
  startTrustServer,
} from "@trust/shell";

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installation = resolveTrustInstallation(
  process.env.TRUST_INSTALL_ROOT ?? path.resolve(applicationRoot, "../.."),
);
const host = process.env.TRUST_HOST ?? "127.0.0.1";
const runtimePort = environmentPort("TRUST_PORT", 4318);
const webPort = environmentPort("TRUST_WEB_PORT", 4173);
let ownedServer;
let mainWindow;

await app.whenReady();
const existing = await readTrustServerStatus(host, webPort);
if (!existing.running) {
  ownedServer = await startTrustServer({
    installation,
    host,
    runtimePort,
    webPort,
    stateDirectory: path.join(app.getPath("userData"), "server"),
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

function environmentPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new TypeError(`Invalid ${name}: ${raw}`);
  return value;
}
