import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { startTrustLanguageServer } from "../../src/server.js";

// Public LSP transport fixture: control catalog availability, never compiler or handler results.
const connection = createConnection(ProposedFeatures.all);
let pending: Promise<void> | undefined;
let release: (() => void) | undefined;
let unavailable = false;
connection.onRequest("acceptance/catalog", async (input: { action: string }) => {
  if (input.action === "pause")
    pending = new Promise((resolve) => {
      release = resolve;
    });
  if (input.action === "fail") unavailable = true;
  if (input.action === "release") {
    release?.();
    pending = undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return null;
});
startTrustLanguageServer(connection, {
  procedures: async () => {
    await pending;
    if (unavailable) throw new Error("Catalog unavailable");
    return [];
  },
});
