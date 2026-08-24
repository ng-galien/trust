import {
  createConnection,
  createProtocolConnection,
  ProposedFeatures,
  type Connection,
  type WatchDog,
} from "vscode-languageserver";
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
  let connection: Connection | undefined;
  const watchDog: WatchDog = {
    shutdownReceived: false,
    initialize: () => undefined,
    // This connection is embedded in the runtime. LSP lifecycle notifications own the WebSocket,
    // never the host process. The standalone stdio entry point keeps the Node watchdog.
    exit: () => {
      connection?.dispose();
      socket.dispose();
    },
  };
  connection = createConnection(
    (logger) => createProtocolConnection(reader, writer, logger),
    watchDog,
    ProposedFeatures.all,
  );
  startTrustLanguageServer(connection, options);
}
