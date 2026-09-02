import { randomUUID } from "node:crypto";

export type PlanEventType = "plan.engaged" | "plan.revision" | "plan.state" | "plan.removed" | "session.changed" | "runtime.changed";

export interface PlanEvent {
  readonly sequence: number;
  readonly id: string;
  readonly type: PlanEventType;
  readonly at: string;
  readonly plan?: string;
  readonly resync?: true;
  readonly revision?: number;
  readonly cause?: "declarations" | "verdict";
  readonly workState?: "IN_PROGRESS" | "ESCALATED" | "COMPLETE";
  readonly checklistDelta?: {
    readonly newlySatisfied: readonly string[];
    readonly newlyOpened: readonly string[];
    readonly unchanged: readonly string[];
  };
  readonly removedCheckUris?: readonly string[];
  readonly session?: { readonly id: string; readonly state: "open" | "closed" | "expired" };
}

type NewPlanEvent = Omit<PlanEvent, "id" | "sequence">;

const MAX_EVENTS = 1_000;

/** Process-local live projection. Durable state remains in SQL; reconnecting clients always resync through RPC. */
export class PlanEvents {
  readonly #events: PlanEvent[] = [];
  readonly #listeners = new Set<(event: PlanEvent) => void>();
  readonly #generation = randomUUID();
  #sequence = 0;

  publish(event: NewPlanEvent): PlanEvent {
    const sequence = ++this.#sequence;
    const published = Object.freeze({ ...event, sequence, id: `${this.#generation}:${sequence}` });
    this.#events.push(published);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    for (const listener of this.#listeners) listener(published);
    return published;
  }

  replay(lastEventId: string | undefined): { readonly events: readonly PlanEvent[]; readonly resync: boolean } {
    if (lastEventId === undefined) return { events: this.#events, resync: false };
    const separator = lastEventId.lastIndexOf(":");
    const generation = separator < 0 ? "" : lastEventId.slice(0, separator);
    const sequence = separator < 0 ? Number.NaN : Number(lastEventId.slice(separator + 1));
    const firstSequence = this.#events[0]?.sequence ?? this.#sequence + 1;
    if (generation !== this.#generation || !Number.isSafeInteger(sequence) || sequence < firstSequence - 1 || sequence > this.#sequence) {
      return { events: [], resync: true };
    }
    return { events: this.#events.filter((event) => event.sequence > sequence), resync: false };
  }

  resyncEvent(at: string): PlanEvent {
    return Object.freeze({
      id: `${this.#generation}:0`,
      sequence: 0,
      type: "runtime.changed",
      at,
      resync: true,
    });
  }

  subscribe(listener: (event: PlanEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
