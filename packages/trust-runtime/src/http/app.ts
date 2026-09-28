import type {
  AccessConfiguration,
  BrowserAuthenticationConfiguration,
  DevelopmentAuthenticationConfiguration,
} from "@trust/extension-sdk";
import { matchAccessConfiguration } from "@trust/extension-sdk/match";
import express, { type Express, type Router } from "express";
import { allowedBrowserOrigin } from "../access/browser-origin.js";
import type { DevelopmentAuthority } from "../access/development-authority.js";
import type { AccessService } from "../access/service.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { Health } from "../health.js";
import { authenticateHttp } from "./access.js";
import { createDevelopmentAuthenticationHttpHandler } from "./development-authentication.js";
import { createExtensionAssetsHttpHandler } from "./extension-assets.js";

export interface HttpAppDependencies {
  readonly health: Health;
  readonly accessService: AccessService;
  readonly accessConfiguration: AccessConfiguration;
  readonly browserAuthentication: BrowserAuthenticationConfiguration | undefined;
  readonly developmentAuthentication: DevelopmentAuthenticationConfiguration | undefined;
  readonly developmentAuthority: DevelopmentAuthority | undefined;
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
  developmentAuthentication,
  developmentAuthority,
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
  const fixed = matchAccessConfiguration(accessConfiguration, {
    local: () => false,
    fixed: () => true,
    "local-jwt": () => false,
    introspection: () => false,
  });
  const issuer = matchAccessConfiguration(accessConfiguration, {
    local: () => undefined,
    fixed: () => undefined,
    "local-jwt": (value) => value.issuer,
    introspection: (value) => value.issuer,
  });
  app.get("/auth/config", (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json({
      required: accessService.shared && !fixed,
      browser: browserAuthentication ?? null,
      ...(developmentAuthority ? { development: { mode: "embedded" } } : {}),
    });
  });
  if (developmentAuthority) app.use("/auth/dev", createDevelopmentAuthenticationHttpHandler(developmentAuthority));
  app.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    (_request, response) => {
      if (!issuer || developmentAuthority || !accessResourceUrl) {
        response.status(404).end();
        return;
      }
      response.json({
        resource: accessResourceUrl,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
      });
    },
  );
  app.use("/extensions", createExtensionAssetsHttpHandler(extensionHost));
  // Fixed access has no bearer credential to protect browser requests from other origins.
  app.use((request, response, next) => {
    if (
      fixed &&
      !allowedBrowserOrigin(
        request.get("origin"),
        browserAuthentication,
        developmentAuthentication,
        accessConfiguration,
      )
    ) {
      response.status(403).json({ error: "untrusted-origin" });
      return;
    }
    next();
  });
  app.use(authenticateHttp(accessService));
  app.use("/rpc", rpcHttpHandler);
  app.use(
    "/mcp",
    (request, response, next) => {
      const origin = request.get("origin");
      if (
        accessService.shared &&
        !allowedBrowserOrigin(origin, browserAuthentication, developmentAuthentication, accessConfiguration)
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
