import type { HttpGet, HttpJsonResult, HttpTextResult } from "@trust/operation";

import type { JsonObject } from "../lib/json.js";
import { parseHttpJson, requestHttp } from "./request.js";

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`HTTP GET failed with ${status}${statusText === "" ? "" : ` ${statusText}`}.`);
    this.name = "HttpStatusError";
  }
}

export async function runHttpGet(
  http: HttpGet,
  environment: JsonObject,
): Promise<HttpTextResult | HttpJsonResult> {
  const url = environment[http.url.environment];
  if (typeof url !== "string") {
    throw new TypeError(`HTTP Environment "${http.url.environment}" must be a URL string.`);
  }
  const response = await requestHttp({ method: "GET", url });
  if (response.status < 200 || response.status >= 300) {
    throw new HttpStatusError(response.status, response.statusText);
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
