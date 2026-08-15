export function otlpFactAttributes(
  fact: Readonly<Record<string, unknown>>,
  index: number,
): readonly Readonly<Record<string, unknown>>[] {
  if (
    typeof fact.kind !== "string"
    || typeof fact.observedAt !== "string"
    || !isRecord(fact.values)
  ) {
    throw new TypeError("Fact must contain kind, observedAt and values.");
  }
  return [
    { key: "trust.fact.index", value: { intValue: String(index) } },
    ...Object.entries(fact).map(([name, value]) => ({
      key: `trust.fact.${name === "observedAt" ? "observed_at" : name}`,
      value: otlpValue(value),
    })),
  ];
}

function otlpValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isSafeInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(otlpValue) } };
  }
  if (isRecord(value)) {
    return {
      kvlistValue: {
        values: Object.entries(value).map(([key, item]) => ({ key, value: otlpValue(item) })),
      },
    };
  }
  throw new TypeError("Fact values cannot contain null or non-JSON values.");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
