import type { JsonValue } from "./json.js";

export type HttpFormat = "text" | "json";

/** One query parameter appended by a GET: its value comes from one string Input or is a literal. */
export type HttpQueryParameter =
  | { readonly name: string; readonly input: string }
  | { readonly name: string; readonly value: string };

export interface Http {
  readonly method: "GET" | "POST";
  readonly url: { readonly environment: string };
  /** GET only: string Inputs appended, in order, as successive URL-encoded path segments. */
  readonly appendInputs?: readonly string[];
  /** GET only: query parameters appended after the path segments, in order. */
  readonly query?: readonly HttpQueryParameter[];
  readonly body?: "input-json";
  readonly format: HttpFormat;
}

/** The request URL of one HTTP step: the base URL, then one encoded path segment per appended
    Input, then the declared query. `resolve` returns the string value of one Input. */
export function renderHttpUrl(http: Http, base: string, resolve: (input: string) => string): string {
  const url = new URL(base);
  const query = http.query ?? [];
  if (query.length > 0 && url.search !== "") {
    throw new TypeError(`HTTP Environment "${http.url.environment}" already carries a query string; the step declares its own query.`);
  }
  for (const name of http.appendInputs ?? []) {
    url.pathname = `${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}${encodeURIComponent(resolve(name))}`;
  }
  for (const parameter of query) {
    url.searchParams.append(parameter.name, "value" in parameter ? parameter.value : resolve(parameter.input));
  }
  return url.toString();
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
