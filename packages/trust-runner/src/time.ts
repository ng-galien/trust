export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export function instantMilliseconds(clock: Clock): number {
  const instant = clock.now();
  const milliseconds = instant.getTime();
  if (Number.isNaN(milliseconds)) throw new Error("Clock returned an invalid instant.");
  return milliseconds;
}

export function instantIso(clock: Clock): string {
  return millisecondsToIso(instantMilliseconds(clock));
}

export function isoToMilliseconds(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid ISO instant: ${value}.`);
  return milliseconds;
}

export function millisecondsToIso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
