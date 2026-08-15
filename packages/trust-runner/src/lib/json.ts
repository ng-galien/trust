import type { JsonValue } from "@trust/operation";

export type { JsonValue } from "@trust/operation";

export type JsonObject = { [key: string]: JsonValue };

export const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
