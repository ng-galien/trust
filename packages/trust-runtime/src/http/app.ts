import express, { type Express, type Router } from "express";
import type { Health } from "../health.js";

export interface HttpAppDependencies {
  readonly health: Health;
  readonly rpcHttpHandler: Router;
  readonly mcpHttpHandler: Router;
  readonly otlpHttpHandler: Router;
  readonly diagnosticsHttpHandler: Router;
  readonly planEventsHttpHandler: Router;
}

export const createHttpApp = ({
  health,
  rpcHttpHandler,
  mcpHttpHandler,
  otlpHttpHandler,
  diagnosticsHttpHandler,
  planEventsHttpHandler,
}: HttpAppDependencies): Express => {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_request, response) => {
    response.status(200).json(health.read());
  });
  app.use("/rpc", rpcHttpHandler);
  app.use("/mcp", mcpHttpHandler);
  app.use("/v1/traces", otlpHttpHandler);
  app.use("/otlp/diagnostics", diagnosticsHttpHandler);
  app.use("/events/plans", planEventsHttpHandler);
  return app;
};
