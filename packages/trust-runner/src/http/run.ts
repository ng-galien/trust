import {
  evaluateOperationProjection,
  operationProjectionContext,
  renderHttpUrl,
  renderHttpValue,
  type Http,
  type HttpEmptyResult,
  type HttpJsonResult,
  type HttpTextResult,
  type OperationExecutionContext,
} from "@trust/operation";

import { clip, nullReporter, type StepReporter } from "../diagnostics/events.js";
import type { JsonObject } from "../lib/json.js";
import { parseHttpJson, requestHttp } from "./request.js";

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly method: Http["method"] = "GET",
  ) {
    super(`HTTP ${method} failed with ${status}${statusText === "" ? "" : ` ${statusText}`}.`);
    this.name = "HttpStatusError";
  }
}

export async function runHttp(
  http: Http,
  input: JsonObject,
  environment: JsonObject,
  steps: JsonObject,
  execution: OperationExecutionContext,
  reporter: StepReporter = nullReporter,
): Promise<HttpTextResult | HttpJsonResult | HttpEmptyResult> {
  const baseUrl = environment[http.url.environment];
  if (typeof baseUrl !== "string") {
    throw new TypeError(`HTTP Environment "${http.url.environment}" must be a URL string.`);
  }
  const resolveInput = (name: string): string => stringValue(input[name], `HTTP Input "${name}"`);
  const resolveEnvironment = (name: string): string => stringValue(environment[name], `HTTP Environment "${name}"`);
  const url = renderHttpUrl(http, baseUrl, resolveInput, resolveEnvironment);
  const headers = Object.fromEntries(http.headers.map((header) => [
    header.name,
    headerValue(renderHttpValue(header.source, resolveInput, resolveEnvironment), `HTTP header "${header.name}"`),
  ]));
  const body = await requestBody(http, input, environment, steps, execution, resolveInput, resolveEnvironment);
  if (body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
    headers["content-type"] = http.body?.format === "json" ? "application/json" : "text/plain; charset=utf-8";
  }
  reporter.log("http.request", `${http.method} ${url}${Object.keys(headers).length === 0 ? "" : `\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\n")}`}${body === undefined ? "" : `\n\n${clip(body, 8_192)}`}`);
  const startedAt = Date.now();
  const response = await requestHttp({
    method: http.method,
    url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  });
  reporter.log(
    "http.response",
    `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} (${Date.now() - startedAt} ms)\n${Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join("\n")}\n\n${clip(response.body, 16_384)}`,
  );
  const accepted = http.acceptedStatuses === undefined
    ? response.status >= 200 && response.status < 300
    : http.acceptedStatuses.includes(response.status);
  if (!accepted) throw new HttpStatusError(response.status, response.statusText, http.method);
  if (http.format === "none") return { status: response.status, headers: response.headers, body: "" };
  if (http.format === "text") return { status: response.status, headers: response.headers, body: response.body };
  return { status: response.status, headers: response.headers, body: parseHttpJson(response.body) };
}

async function requestBody(
  http: Http,
  input: JsonObject,
  environment: JsonObject,
  steps: JsonObject,
  execution: OperationExecutionContext,
  resolveInput: (name: string) => string,
  resolveEnvironment: (name: string) => string,
): Promise<string | undefined> {
  const body = http.body;
  if (body === undefined) return undefined;
  if (body.format === "text") return renderHttpValue(body.source, resolveInput, resolveEnvironment);
  if (body.source === "input") return JSON.stringify(input);
  const value = await evaluateOperationProjection(
    body.expression,
    operationProjectionContext(input, environment, steps, execution),
  );
  return JSON.stringify(value);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be one string.`);
  return value;
}

function headerValue(value: string, label: string): string {
  if (value.includes("\r") || value.includes("\n") || value.includes("\0")) {
    throw new TypeError(`${label} contains characters that are unsafe in an HTTP header.`);
  }
  return value;
}
