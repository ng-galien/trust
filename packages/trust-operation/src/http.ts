import type { JsonValue } from "./json.js";

export type HttpFormat = "text" | "json";

export interface Http {
  readonly method: "GET" | "POST";
  readonly url: { readonly environment: string };
  readonly appendInput?: string;
  readonly body?: "input-json";
  readonly format: HttpFormat;
}

export interface HttpTextResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpJsonResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonValue;
}
