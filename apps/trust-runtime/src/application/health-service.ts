import type { HealthStatus } from "../domain/health.js";
import type { Clock } from "../ports/clock.js";

export interface HealthServiceDependencies {
  readonly clock: Clock;
}

export class HealthService {
  readonly #clock: Clock;

  constructor({ clock }: HealthServiceDependencies) {
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
