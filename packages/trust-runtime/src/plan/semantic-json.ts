/** Semantic JSON comparison; object insertion order is not business state. */
export function semanticJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint" || (typeof item === "number" && !Number.isFinite(item))) {
      throw new TypeError("Persisted JSON requires finite JSON numbers");
    }
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }
    return item;
  });
  if (encoded === undefined) throw new TypeError("Persisted JSON requires a value");
  return encoded;
}
