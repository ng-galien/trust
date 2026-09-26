import { authenticatedWebSocket } from "./lib/authentication.js";
import "@codingame/monaco-vscode-standalone-json-language-features";
import EditorWorker from "@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js?worker";
import JsonWorker from "@codingame/monaco-vscode-standalone-json-language-features/worker?worker";
import { type TemplateDocumentContext, templateDocumentContextMethod } from "@trust/extension-sdk";

import { LanguageClientManager } from "monaco-languageclient/lcwrapper";
import {
  getEnhancedMonacoEnvironment,
  type MonacoVscodeApiConfig,
  MonacoVscodeApiWrapper,
} from "monaco-languageclient/vscodeApiWrapper";

export type TrustLanguageServerStatus = "connecting" | "ready" | "unavailable";

const vscodeApiConfig: MonacoVscodeApiConfig = {
  $type: "classic",
  viewsConfig: { $type: "EditorService" },
  monacoWorkerFactory: () => {
    getEnhancedMonacoEnvironment().getWorker = (_workerId, label) =>
      label === "json" ? new JsonWorker() : new EditorWorker();
  },
  advanced: { enforceSemanticHighlighting: true, loadExtensionServices: false },
};

let vscodeApiPromise: Promise<void> | undefined;
const languageClients = new LanguageClientManager();
const templateContexts = new Map<string, TemplateDocumentContext>();
const statusListeners = new Set<(status: TrustLanguageServerStatus) => void>();
let languageServerUrl: string | undefined;
let languageServerStatus: TrustLanguageServerStatus = "connecting";
let languageClientStart: Promise<void> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/** Initialize the process-wide Monaco/VS Code service layer exactly once, including in React Strict Mode. */
export function initializeTrustMonaco(): Promise<void> {
  vscodeApiPromise ??= new MonacoVscodeApiWrapper(vscodeApiConfig).start();
  return vscodeApiPromise;
}

/** Keep the browser language client alive while individual Monaco documents open and close. */
export async function ensureTrustLanguageClient(url: string): Promise<void> {
  await initializeTrustMonaco();
  if (languageServerUrl !== undefined && languageServerUrl !== url) {
    throw new Error(`The TRUST language client is already connected to ${languageServerUrl}`);
  }
  if (languageClients.isStarted()) {
    updateLanguageServerStatus("ready");
    return;
  }
  if (languageClientStart !== undefined) {
    await languageClientStart;
    return;
  }
  languageServerUrl = url;
  languageClientStart = (async () => {
    const webSocket = await authenticatedWebSocket(url);
    languageClients.setConfig({
      languageId: "trust",
      connection: {
        options: { $type: "WebSocketDirect", webSocket, stopOptions: { onCall: languageClientDisconnected } },
      },
      clientOptions: { documentSelector: ["trust-operation", "trust-procedure"] },
    });
    await startLanguageClient();
  })().finally(() => {
    languageClientStart = undefined;
  });
  await languageClientStart;
}

export function subscribeTrustLanguageServerStatus(listener: (status: TrustLanguageServerStatus) => void): () => void {
  statusListeners.add(listener);
  listener(languageServerStatus);
  return () => statusListeners.delete(listener);
}

async function startLanguageClient(): Promise<void> {
  if (languageServerStatus !== "unavailable") updateLanguageServerStatus("connecting");
  try {
    await startLanguageClientsWithin(1_000);
    updateLanguageServerStatus("ready");
    for (const context of templateContexts.values()) void sendTemplateContext(context);
  } catch {
    updateLanguageServerStatus("unavailable");
    scheduleReconnect();
  } finally {
    languageClientStart = undefined;
  }
}

async function startLanguageClientsWithin(timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      languageClients.start(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("TRUST language server connection timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function languageClientDisconnected(): void {
  updateLanguageServerStatus("unavailable");
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (languageServerUrl !== undefined) void ensureTrustLanguageClient(languageServerUrl);
  }, 500);
}

function updateLanguageServerStatus(status: TrustLanguageServerStatus): void {
  languageServerStatus = status;
  for (const listener of statusListeners) listener(status);
}

/** Template authoring context travels over the existing LSP connection, never another analyzer. */
export function setTrustTemplateContext(context: TemplateDocumentContext): void {
  if (context.parameters === null) templateContexts.delete(context.uri);
  else templateContexts.set(context.uri, context);
  if (languageClients.isStarted()) void sendTemplateContext(context);
}

async function sendTemplateContext(context: TemplateDocumentContext): Promise<void> {
  try {
    await languageClients.getLanguageClient("trust")?.sendNotification(templateDocumentContextMethod, context);
  } catch {
    // The complete current context map is replayed by the shared client's reconnect path.
    languageClientDisconnected();
  }
}
