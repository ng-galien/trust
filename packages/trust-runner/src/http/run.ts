import { renderHttpUrl, type Http, type HttpJsonResult, type HttpTextResult } from "@trust/operation";

import { clip, nullReporter, type StepReporter } from "../diagnostics/events.js";
import type { JsonObject } from "../lib/json.js";
import { parseHttpJson, requestHttp } from "./request.js";

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly method: "GET" | "POST" = "GET",
  ) {
    super(`HTTP ${method} failed with ${status}${statusText === "" ? "" : ` ${statusText}`}.`);
    this.name = "HttpStatusError";
  }
}

function buildHttpUrl(http: Http, input: JsonObject, baseUrl: string): string {
  return renderHttpUrl(http, baseUrl, (name) => {
    const value = input[name];
    if (typeof value !== "string") throw new TypeError(`HTTP Input "${name}" must be one string.`);
    return value;
  });
}

export async function runHttp(
  http: Http,
  input: JsonObject,
  environment: JsonObject,
  reporter: StepReporter = nullReporter,
): Promise<HttpTextResult | HttpJsonResult> {
  const baseUrl = environment[http.url.environment];
  if (typeof baseUrl !== "string") {
    throw new TypeError(`HTTP Environment "${http.url.environment}" must be a URL string.`);
  }
  const url = buildHttpUrl(http, input, baseUrl);
  const requestBody = http.body === "input-json" ? JSON.stringify(input) : undefined;
  reporter.log("http.request", `${http.method} ${url}${requestBody === undefined ? "" : `\ncontent-type: application/json\n\n${clip(requestBody, 8_192)}`}`);
  const startedAt = Date.now();
  const response = await requestHttp({
    method: http.method,
    url,
    ...(requestBody === undefined ? {} : { headers: { "content-type": "application/json" }, body: requestBody }),
  });
  reporter.log(
    "http.response",
    `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} (${Date.now() - startedAt} ms)\n${Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join("\n")}\n\n${clip(response.body, 16_384)}`,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new HttpStatusError(response.status, response.statusText, http.method);
  }
  if (http.format === "text") {
    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
    };
  }
  return {
    status: response.status,
    headers: response.headers,
    body: parseHttpJson(response.body),
  };
}
