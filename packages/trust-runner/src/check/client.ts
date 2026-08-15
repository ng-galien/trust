import type { CompiledOperation } from "@trust/operation";

import { parseHttpJson, requestHttp } from "../http/request.js";
import { isJsonObject, type JsonObject } from "../lib/json.js";

export interface MaterializationParent {
  readonly kind: "input" | "output";
  readonly port: string;
  readonly valueType: "string" | "number" | "instant" | "reference";
}

export interface MaterializationOutput {
  readonly output: string;
  readonly observation: string;
  readonly valueType: "string" | "number" | "instant" | "reference";
  readonly sourceCardinality: "one" | "many";
  readonly parents: readonly MaterializationParent[];
}

export type CheckAdmission =
  | {
      readonly status: "ADMITTED";
      readonly attemptKey: string;
      readonly executionHandle: string;
      readonly checkUri: string;
      readonly capability: string;
      readonly actionInput: JsonObject;
      readonly materializationContract: readonly MaterializationOutput[];
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

export class CheckClient {
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  #sequence = 0;

  constructor(endpoint: string, timeoutMs = 30_000) {
    this.#endpoint = endpoint;
    this.#timeoutMs = timeoutMs;
  }

  async admit(attemptKey: string, checkUri: string): Promise<CheckAdmission> {
    return this.#call("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey,
      checkUri,
    }) as unknown as Promise<CheckAdmission>;
  }

  async finalize(executionHandle: string): Promise<CheckFinalization> {
    return this.#call("check.attempt.finalize", {
      contract: "trust.check-finalization-request@1",
      executionHandle,
    }) as unknown as Promise<CheckFinalization>;
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
    if (envelope.jsonrpc !== "2.0" || envelope.id !== id || envelope.error !== undefined) {
      throw new Error(`TRUST RPC ${method} failed.`);
    }
    if (typeof envelope.result !== "object" || envelope.result === null || Array.isArray(envelope.result)) {
      throw new Error(`TRUST RPC ${method} returned an invalid result.`);
    }
    return envelope.result as JsonObject;
  }
}
