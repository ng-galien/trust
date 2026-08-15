import express, { type Express, type Router } from "express";
import type { HealthService } from "../application/health-service.js";

export interface HttpAppDependencies {
  readonly healthService: HealthService;
  readonly rpcHttpHandler: Router;
  readonly mcpHttpHandler: Router;
  readonly otlpHttpHandler: Router;
}

export const createHttpApp = ({
  healthService,
  rpcHttpHandler,
  mcpHttpHandler,
  otlpHttpHandler,
}: HttpAppDependencies): Express => {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_request, response) => {
    response.status(200).json(healthService.read());
  });
  app.use("/rpc", rpcHttpHandler);
  app.use("/mcp", mcpHttpHandler);
  app.use("/v1/traces", otlpHttpHandler);
  return app;
};
