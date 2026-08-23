import type { CompiledOperation } from "@trust/operation";

import { parseHttpJson, requestHttp } from "../http/request.js";
import { isJsonObject, type JsonObject } from "../lib/json.js";

export type CheckAdmission =
  | {
      readonly status: "ADMITTED";
      readonly attemptKey: string;
      readonly attemptHandle: string;
      readonly executionId: string;
      readonly checkUri: string;
      readonly actionInput: JsonObject;
      readonly operation: CompiledOperation;
      readonly environment: JsonObject;
      readonly expiresAt: string;
    }
  | {
      readonly status: "REFUSED";
      readonly attemptKey: string;
      readonly reasonCode: string;
      readonly reason: string;
    };

export interface CheckFinalization {
  readonly verdict: "VALIDATED" | "NOT_VALIDATED";
  readonly reasonCode: string;
  readonly reason: string;
  readonly checklistDelta: {
    readonly newlySatisfied: readonly string[];
    readonly newlyOpened: readonly string[];
    readonly unchanged: readonly string[];
  };
}

export interface CheckInterruption {
  readonly status: "INTERRUPTED";
}

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
  #sequence = 0;

  constructor(endpoint: string, timeoutMs = 30_000) {
    this.#endpoint = endpoint;
    this.#timeoutMs = timeoutMs;
  }

  async admit(
    attemptKey: string,
    checkUri: string,
    intent: string | undefined,
    nextIntent: string | undefined,
  ): Promise<CheckAdmission> {
    return this.#call("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey,
      checkUri,
      ...(intent === undefined ? {} : { intent }),
      ...(nextIntent === undefined ? {} : { nextIntent }),
    }) as unknown as Promise<CheckAdmission>;
  }

  async finalize(attemptHandle: string): Promise<CheckFinalization> {
    return this.#call("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle,
    }) as unknown as Promise<CheckFinalization>;
  }

  async interrupt(attemptHandle: string): Promise<CheckInterruption> {
    return this.#call("check.attempt.interrupt", {
      contract: "trust.attempt-interruption-request@1",
      attemptHandle,
    }) as unknown as Promise<CheckInterruption>;
  }

  async #call(method: string, params: JsonObject): Promise<JsonObject> {
    const id = `trust-runner-${++this.#sequence}`;
    const response = await requestHttp({
      method: "POST",
      url: this.#endpoint,
      headers: { "content-type": "application/json", accept: "application/json" },
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
      const detail = typeof data?.message === "string"
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
