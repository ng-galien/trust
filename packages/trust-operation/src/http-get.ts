import type { JsonValue } from "./json.js";

export type HttpFormat = "text" | "json";

export interface HttpGet {
  readonly url: { readonly environment: string };
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
