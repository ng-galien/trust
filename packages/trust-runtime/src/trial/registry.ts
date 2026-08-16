import { randomUUID } from "node:crypto";

import type { RuntimeJsonObject } from "../model.js";

/* Trials are diagnostic runs of one Operation, kept in memory only:
   never Facts, never Plans, gone on restart. The last N are kept so operators can compare and copy reports. */

export type TrialStatus = "starting" | "running" | "succeeded" | "failed" | "aborted";

export interface TrialEvent {
  readonly sequence: number;
  readonly type: string;
  readonly at: string;
  readonly [key: string]: unknown;
}

export interface TrialRecord {
  readonly id: string;
  readonly operation: string;
  readonly version: string;
  readonly environment: string;
  readonly input: RuntimeJsonObject;
  readonly startedAt: string;
  readonly startedBy: string;
  status: TrialStatus;
  endedAt?: string;
  outcome?: RuntimeJsonObject;
  error?: string;
  events: TrialEvent[];
}

export interface TrialSummary {
  readonly id: string;
  readonly operation: string;
  readonly version: string;
  readonly environment: string;
  readonly startedAt: string;
  readonly startedBy: string;
  readonly status: TrialStatus;
  readonly endedAt?: string;
  readonly error?: string;
  readonly eventCount: number;
}

export type TrialListener = (event: TrialEvent) => void;

export class TrialRegistry {
  readonly #trials = new Map<string, TrialRecord>();
  readonly #listeners = new Map<string, Set<TrialListener>>();
  readonly #lastSequence = new Map<string, number>();
  readonly #capacity: number;
  readonly #eventCapacity: number;

  constructor(capacity = 50, eventCapacity = 5_000) {
    this.#capacity = capacity;
    this.#eventCapacity = eventCapacity;
  }

  create(input: { operation: string; version: string; environment: string; input: RuntimeJsonObject; startedBy: string; startedAt: string }): TrialRecord {
    const record: TrialRecord = { id: randomUUID(), ...input, status: "starting", events: [] };
    this.#trials.set(record.id, record);
    this.#lastSequence.set(record.id, 0);
    while (this.#trials.size > this.#capacity) {
      const oldest = this.#trials.keys().next().value;
      if (oldest === undefined) break;
      this.#trials.delete(oldest);
      this.#listeners.delete(oldest);
      this.#lastSequence.delete(oldest);
    }
    return record;
  }

  get(id: string): TrialRecord | undefined {
    return this.#trials.get(id);
  }

  list(operation?: string): TrialSummary[] {
    return Array.from(this.#trials.values())
      .filter((trial) => !operation || trial.operation === operation)
      .map(summarize)
      .reverse();
  }

  append(id: string, event: { type: string; at: string; [key: string]: unknown }): TrialEvent | undefined {
    const trial = this.#trials.get(id);
    if (!trial) return undefined;
    if (trial.events.length >= this.#eventCapacity) {
      if (event.type !== "trial.completed") return undefined;
      trial.events.shift();
    }
    const { type, at, ...rest } = event;
    const sequence = (this.#lastSequence.get(id) ?? 0) + 1;
    this.#lastSequence.set(id, sequence);
    const sequenced: TrialEvent = { ...rest, type, at, sequence };
    trial.events.push(sequenced);
    if (trial.status === "starting" && sequenced.type !== "trial.started") trial.status = "running";
    this.#listeners.get(id)?.forEach((listener) => listener(sequenced));
    return sequenced;
  }

  complete(id: string, outcome: { status: Exclude<TrialStatus, "starting" | "running">; endedAt: string; outcome?: RuntimeJsonObject; error?: string }): void {
    const trial = this.#trials.get(id);
    if (!trial) return;
    if (trial.status !== "starting" && trial.status !== "running") return;
    trial.status = outcome.status;
    trial.endedAt = outcome.endedAt;
    if (outcome.outcome) trial.outcome = outcome.outcome;
    if (outcome.error) trial.error = outcome.error;
    this.append(id, { type: "trial.completed", at: outcome.endedAt, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) });
  }

  subscribe(id: string, listener: TrialListener): () => void {
    const listeners = this.#listeners.get(id) ?? new Set<TrialListener>();
    listeners.add(listener);
    this.#listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(id);
    };
  }
}

export function summarize(trial: TrialRecord): TrialSummary {
  return {
    id: trial.id,
    operation: trial.operation,
    version: trial.version,
    environment: trial.environment,
    startedAt: trial.startedAt,
    startedBy: trial.startedBy,
    status: trial.status,
    ...(trial.endedAt ? { endedAt: trial.endedAt } : {}),
    ...(trial.error ? { error: trial.error } : {}),
    eventCount: trial.events.length,
  };
}
