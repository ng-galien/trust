#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { publicMcp } from "./lib/public-mcp.mjs";
import { publicRpc } from "./lib/public-rpc.mjs";

const endpoint = process.env.TRUST_URL ?? "http://127.0.0.1:4318";
const databaseUrl = process.env.TRUST_COORDINATION_DATABASE_URL;
if (!databaseUrl) throw new Error("Set TRUST_COORDINATION_DATABASE_URL to a password-free PostgreSQL URL");
const url = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(url.protocol) || url.password)
  throw new Error("Use a password-free PostgreSQL URL; credentials belong to the runner");
await publicRpc(endpoint, "environment.save", { environment: "coordination", values: { databaseUrl } });
for (const action of ["create", "claim", "submit", "read"]) {
  const sourceName = `coordination.mission-${action}.feature`;
  const source = await readFile(new URL(`../../../assets/operations/${sourceName}`, import.meta.url), "utf8");
  console.log(await publicMcp(endpoint, "trust_operation_compile", { source, sourceName }));
}
// The runtime uses the repository Operation catalog. Publication embeds its exact Operations.
const sourceName = "agent-delegation.feature";
const source = await readFile(new URL(`../../../assets/procedures/${sourceName}`, import.meta.url), "utf8");
console.log(await publicMcp(endpoint, "trust_procedure_publish", { source, sourceName }));
