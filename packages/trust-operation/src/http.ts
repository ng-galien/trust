import type { JsonValue } from "./json.js";

/** Registered HTTP methods that represent application requests. `PRI` and the reserved `*` token
    are protocol control values, not methods an Operation can send. */
export const HTTP_METHODS = [
  "ACL",
  "BASELINE-CONTROL",
  "BIND",
  "CHECKIN",
  "CHECKOUT",
  "CONNECT",
  "COPY",
  "DELETE",
  "GET",
  "HEAD",
  "LABEL",
  "LINK",
  "LOCK",
  "MERGE",
  "MKACTIVITY",
  "MKCALENDAR",
  "MKCOL",
  "MKREDIRECTREF",
  "MKWORKSPACE",
  "MOVE",
  "OPTIONS",
  "ORDERPATCH",
  "PATCH",
  "POST",
  "PROPFIND",
  "PROPPATCH",
  "PUT",
  "QUERY",
  "REBIND",
  "REPORT",
  "SEARCH",
  "TRACE",
  "UNBIND",
  "UNCHECKOUT",
  "UNLINK",
  "UNLOCK",
  "UPDATE",
  "UPDATEREDIRECTREF",
  "VERSION-CONTROL",
] as const;

export type HttpMethod = typeof HTTP_METHODS[number];
export type HttpFormat = "text" | "json" | "none";

export type HttpValueSource =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "input"; readonly input: string }
  | { readonly kind: "environment"; readonly environment: string };

export type HttpPathSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "input"; readonly input: string };

export interface HttpQueryParameter {
  readonly name: string;
  readonly source: HttpValueSource;
}

export interface HttpHeader {
  readonly name: string;
  readonly source: HttpValueSource;
}

export type HttpBody =
  | { readonly format: "json"; readonly source: "input" }
  | { readonly format: "json"; readonly source: "jsonata"; readonly expression: string }
  | { readonly format: "text"; readonly source: HttpValueSource };

export interface Http {
  readonly method: HttpMethod;
  readonly url: { readonly environment: string };
  readonly path: readonly HttpPathSegment[];
  readonly query: readonly HttpQueryParameter[];
  readonly headers: readonly HttpHeader[];
  readonly body?: HttpBody;
  readonly format: HttpFormat;
  /** Absent means the standard success range 200-299. */
  readonly acceptedStatuses?: readonly number[];
}

/** Render one request URL from its Environment base and structured path/query sources. */
export function renderHttpUrl(
  http: Http,
  base: string,
  resolveInput: (input: string) => string,
  resolveEnvironment: (environment: string) => string = () => {
    throw new TypeError("HTTP Environment value is unavailable.");
  },
): string {
  const url = new URL(base);
  if (http.query.length > 0 && url.search !== "") {
    throw new TypeError(`HTTP Environment "${http.url.environment}" already carries a query string; the step declares its own query.`);
  }
  for (const segment of http.path) {
    const value = segment.kind === "literal" ? segment.value : resolveInput(segment.input);
    if (value === "") throw new TypeError("HTTP path segments must be non-empty.");
    url.pathname = `${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}${encodeURIComponent(value)}`;
  }
  for (const parameter of http.query) {
    url.searchParams.append(parameter.name, renderHttpValue(parameter.source, resolveInput, resolveEnvironment));
  }
  return url.toString();
}

export function renderHttpValue(
  source: HttpValueSource,
  resolveInput: (input: string) => string,
  resolveEnvironment: (environment: string) => string,
): string {
  if (source.kind === "literal") return source.value;
  return source.kind === "input" ? resolveInput(source.input) : resolveEnvironment(source.environment);
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

export interface HttpEmptyResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: "";
}
