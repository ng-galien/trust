/** Identical scalar decoding for both PostgreSQL engines. JSON columns use native JSON.parse. */
export function safeDatabaseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError("Database integer exceeds the supported safe integer range");
  return parsed;
}

export function databaseInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new RangeError("Database timestamp is not a finite supported instant");
  return parsed.toISOString();
}

export const DATABASE_PARSERS: Record<number, (value: string) => unknown> = {
  20: safeDatabaseInteger,
  1184: databaseInstant,
  114: JSON.parse,
  3802: JSON.parse,
};
