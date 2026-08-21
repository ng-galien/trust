import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
  type IWebSocket,
} from "vscode-ws-jsonrpc";

import type { TrustLanguageServerOptions } from "./server.js";
import { startTrustLanguageServer } from "./server.js";

export type TrustLanguageServerSocket = IWebSocket;

export function startTrustWebSocketLanguageServer(
  socket: TrustLanguageServerSocket,
  options: TrustLanguageServerOptions = {},
): void {
  const reader = new WebSocketMessageReader(socket);
  const writer = new WebSocketMessageWriter(socket);
  startTrustLanguageServer(createConnection(ProposedFeatures.all, reader, writer), options);
}
