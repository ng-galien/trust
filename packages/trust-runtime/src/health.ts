import type { Clock } from "./time.js";

export interface HealthStatus {
  readonly status: "ok";
  readonly service: "trust-runtime";
  readonly currentTime: string;
}

export interface HealthDependencies {
  readonly clock: Clock;
}

export class Health {
  readonly #clock: Clock;

  constructor({ clock }: HealthDependencies) {
    this.#clock = clock;
  }

  read(): HealthStatus {
    return {
      status: "ok",
      service: "trust-runtime",
      currentTime: this.#clock.now().toISOString(),
    };
  }
}
