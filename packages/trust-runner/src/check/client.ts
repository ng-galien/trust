import type {
  AttemptInterruptionResult,
  CheckAttemptAdmissionResult,
  CheckFinalizationResult,
} from "@trust/extension-sdk";
import type { RunnerAuthorization } from "../auth/credentials.js";
import { parseHttpJson, requestHttp } from "../http/request.js";
import { isJsonObject, type JsonObject } from "../lib/json.js";

export class CheckClientError extends Error {
  constructor(
    readonly method: string,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CheckClientError";
  }
}

export class CheckClient {
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #authorization: RunnerAuthorization | undefined;
  #sequence = 0;

  constructor(endpoint: string, timeoutMs = 30_000, authorization?: RunnerAuthorization) {
    this.#endpoint = endpoint;
    this.#timeoutMs = timeoutMs;
    this.#authorization = authorization;
  }

  async admit(
    attemptKey: string,
    checkUri: string,
    intent: string | undefined,
    nextIntent: string | undefined,
  ): Promise<CheckAttemptAdmissionResult> {
    return this.#call("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey,
      checkUri,
      ...(intent === undefined ? {} : { intent }),
      ...(nextIntent === undefined ? {} : { nextIntent }),
    }) as unknown as Promise<CheckAttemptAdmissionResult>;
  }

  async finalize(attemptHandle: string): Promise<CheckFinalizationResult> {
    return this.#call("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle,
    }) as unknown as Promise<CheckFinalizationResult>;
  }

  async interrupt(attemptHandle: string): Promise<AttemptInterruptionResult> {
    return this.#call("check.attempt.interrupt", {
      contract: "trust.attempt-interruption-request@1",
      attemptHandle,
    }) as unknown as Promise<AttemptInterruptionResult>;
  }

  async #call(method: string, params: JsonObject): Promise<JsonObject> {
    const id = `trust-runner-${++this.#sequence}`;
    const response = await requestHttp({
      method: "POST",
      url: this.#endpoint,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(await this.#authorization?.headers(this.#endpoint)),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      timeoutMs: this.#timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`TRUST RPC ${method} failed with HTTP ${response.status}.`);
    }
    const envelope = parseHttpJson(response.body);
    if (!isJsonObject(envelope)) {
      throw new Error(`TRUST RPC ${method} returned an invalid envelope.`);
    }
    if (envelope.jsonrpc !== "2.0" || envelope.id !== id) {
      throw new Error(`TRUST RPC ${method} returned an invalid envelope.`);
    }
    if (envelope.error !== undefined) {
      const failure = isJsonObject(envelope.error) ? envelope.error : undefined;
      const data = failure !== undefined && isJsonObject(failure.data) ? failure.data : undefined;
      const reason = typeof data?.reason === "string" ? data.reason : undefined;
      const detail =
        typeof data?.message === "string"
          ? data.message
          : typeof failure?.message === "string"
            ? failure.message
            : `TRUST RPC ${method} failed.`;
      throw new CheckClientError(method, reason, detail);
    }
    if (typeof envelope.result !== "object" || envelope.result === null || Array.isArray(envelope.result)) {
      throw new Error(`TRUST RPC ${method} returned an invalid result.`);
    }
    return envelope.result as JsonObject;
  }
}
