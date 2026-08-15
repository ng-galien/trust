export interface HealthStatus {
  readonly status: "ok";
  readonly service: "trust-runtime";
  readonly currentTime: string;
}
