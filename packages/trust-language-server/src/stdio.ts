import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { startTrustLanguageServer } from "./server.js";

startTrustLanguageServer(createConnection(ProposedFeatures.all));
