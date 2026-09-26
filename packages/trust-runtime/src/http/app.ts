import type { AccessConfiguration, BrowserAuthenticationConfiguration } from "@trust/extension-sdk";
import express, { type Express, type Router } from "express";
import type { AccessService } from "../access/service.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { Health } from "../health.js";
import { authenticateHttp } from "./access.js";
import { createExtensionAssetsHttpHandler } from "./extension-assets.js";

export interface HttpAppDependencies {
  readonly health: Health;
  readonly accessService: AccessService;
  readonly accessConfiguration: AccessConfiguration;
  readonly browserAuthentication: BrowserAuthenticationConfiguration | undefined;
  readonly accessResourceUrl: string | undefined;
  readonly rpcHttpHandler: Router;
  readonly mcpHttpHandler: Router;
  readonly otlpHttpHandler: Router;
  readonly diagnosticsHttpHandler: Router;
  readonly planEventsHttpHandler: Router;
  readonly extensionsHttpHandler: Router;
  readonly extensionHost: ExtensionHost;
}

export const createHttpApp = ({
  health,
  accessService,
  accessConfiguration,
  browserAuthentication,
  accessResourceUrl,
  rpcHttpHandler,
  mcpHttpHandler,
  otlpHttpHandler,
  diagnosticsHttpHandler,
  planEventsHttpHandler,
  extensionsHttpHandler,
  extensionHost,
}: HttpAppDependencies): Express => {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_request, response) => {
    response.status(200).json(health.read());
  });
  app.get("/auth/config", (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json({ required: accessService.shared, browser: browserAuthentication ?? null });
  });
  app.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    (_request, response) => {
      if (accessConfiguration.mode === "local" || !accessResourceUrl) {
        response.status(404).end();
        return;
      }
      response.json({
        resource: accessResourceUrl,
        authorization_servers: [accessConfiguration.issuer],
        bearer_methods_supported: ["header"],
      });
    },
  );
  app.use("/extensions", createExtensionAssetsHttpHandler(extensionHost));
  app.use(authenticateHttp(accessService));
  app.use("/rpc", rpcHttpHandler);
  app.use(
    "/mcp",
    (request, response, next) => {
      const origin = request.get("origin");
      if (
        accessService.shared &&
        origin !== undefined &&
        (!browserAuthentication || origin !== new URL(browserAuthentication.redirectUri).origin)
      ) {
        response.status(403).json({ error: "untrusted-origin" });
        return;
      }
      next();
    },
    mcpHttpHandler,
  );
  app.use("/v1/traces", otlpHttpHandler);
  app.use("/otlp/diagnostics", diagnosticsHttpHandler);
  app.use("/events/plans", planEventsHttpHandler);
  app.use("/extensions", extensionsHttpHandler);
  return app;
};
