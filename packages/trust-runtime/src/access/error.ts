export type AccessErrorCode = "unauthenticated" | "forbidden" | "authority-unavailable";

export class AccessError extends Error {
  readonly status: 401 | 403 | 503;
  constructor(
    readonly code: AccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
    this.status = code === "unauthenticated" ? 401 : code === "forbidden" ? 403 : 503;
  }
}
