import {
  evaluateOperationProjection,
  type Http,
  type HttpEmptyResult,
  type HttpJsonResult,
  type HttpTextResult,
  type OperationExecutionContext,
  operationProjectionContext,
  renderHttpHeaderValue,
  renderHttpUrl,
  renderHttpValue,
} from "@trust/operation";
import { matchHttpBody, matchHttpFormat, matchHttpHeaderSource } from "@trust/operation/match";

import { clip, nullReporter, type StepReporter } from "../diagnostics/events.js";
import type { JsonObject } from "../lib/json.js";
import { type Clock, instantMilliseconds, SystemClock } from "../time.js";
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
  timeoutMs?: number,
  clock: Clock = new SystemClock(),
  resolveCredential: (credential: string) => string = undelegated,
): Promise<HttpTextResult | HttpJsonResult | HttpEmptyResult> {
  const baseUrl = environment[http.url.environment];
  if (typeof baseUrl !== "string") {
    throw new TypeError(`HTTP Environment "${http.url.environment}" must be a URL string.`);
  }
  const resolveInput = (name: string): string => stringValue(input[name], `HTTP Input "${name}"`);
  const resolveEnvironment = (name: string): string => stringValue(environment[name], `HTTP Environment "${name}"`);
  const url = renderHttpUrl(http, baseUrl, resolveInput, resolveEnvironment);
  const headers = Object.fromEntries(
    http.headers.map((header) => [
      header.name,
      headerValue(
        renderHttpHeaderValue(header.source, resolveInput, resolveEnvironment, resolveCredential),
        `HTTP header "${header.name}"`,
      ),
    ]),
  );
  const credentialHeaders = new Map(
    http.headers.flatMap((header) =>
      matchHttpHeaderSource<[string, string][]>(header.source, {
        literal: () => [],
        input: () => [],
        environment: () => [],
        credential: (source) => [[header.name, `[credential ${source.credential}]`]],
      }),
    ),
  );
  const body = await requestBody(http, input, environment, steps, execution, resolveInput, resolveEnvironment);
  if (http.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
    headers["content-type"] = matchHttpBody(http.body, {
      text: () => "text/plain; charset=utf-8",
      input: () => "application/json",
      jsonata: () => "application/json",
    });
  }
  reporter.log(
    "http.request",
    `${http.method} ${url}${
      Object.keys(headers).length === 0
        ? ""
        : `\n${Object.entries(headers)
            .map(([name, value]) => `${name}: ${credentialHeaders.get(name) ?? value}`)
            .join("\n")}`
    }${body === undefined ? "" : `\n\n${clip(body, 8_192)}`}`,
  );
  const startedAt = instantMilliseconds(clock);
  const response = await requestHttp({
    method: http.method,
    url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  reporter.log(
    "http.response",
    `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} (${instantMilliseconds(clock) - startedAt} ms)\n${Object.entries(
      response.headers,
    )
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n")}\n\n${clip(response.body, 16_384)}`,
  );
  const accepted =
    http.acceptedStatuses === undefined
      ? response.status >= 200 && response.status < 300
      : http.acceptedStatuses.includes(response.status);
  if (!accepted) throw new HttpStatusError(response.status, response.statusText, http.method);
  return matchHttpFormat<HttpTextResult | HttpJsonResult | HttpEmptyResult>(http.format, {
    none: () => ({ status: response.status, headers: response.headers, body: "" }),
    text: () => ({ status: response.status, headers: response.headers, body: response.body }),
    json: () => ({ status: response.status, headers: response.headers, body: parseHttpJson(response.body) }),
  });
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
  return matchHttpBody<string | Promise<string>>(body, {
    text: (value) => renderHttpValue(value.source, resolveInput, resolveEnvironment),
    input: () => JSON.stringify(input),
    jsonata: async (value) =>
      JSON.stringify(
        await evaluateOperationProjection(
          value.expression,
          operationProjectionContext(input, environment, steps, execution),
        ),
      ),
  });
}

function undelegated(credential: string): string {
  throw new TypeError(`Credential "${credential}" was not delegated to this HTTP step.`);
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
