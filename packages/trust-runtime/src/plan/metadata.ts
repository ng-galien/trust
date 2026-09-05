import type { PlanMetadata, RuntimeJsonObject } from "@trust/extension-sdk";

const MAX_TITLE_LENGTH = 256;
const MAX_LABELS = 32;
const MAX_LABEL_LENGTH = 64;
const MAX_ANNOTATIONS = 32;
const MAX_ANNOTATION_KEY_LENGTH = 128;
const MAX_ANNOTATION_VALUE_LENGTH = 1_024;
const LABEL = /^[a-z0-9][a-z0-9._/-]*$/;
const ANNOTATION_KEY = /^[a-z0-9][a-z0-9._/-]*$/;

export function normalizePlanMetadata(value: RuntimeJsonObject | PlanMetadata | undefined): PlanMetadata {
  const source = (value ?? Object.freeze({})) as RuntimeJsonObject;
  const allowed = new Set(["title", "labels", "annotations"]);
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    throw new TypeError("Plan metadata accepts only title, labels and annotations");
  }

  const title = source.title;
  if (title !== undefined && !boundedSingleLine(title, MAX_TITLE_LENGTH)) {
    throw new TypeError(
      `Plan metadata title must be a trimmed single-line string of at most ${MAX_TITLE_LENGTH} characters`,
    );
  }

  const rawLabels = source.labels ?? [];
  if (
    !Array.isArray(rawLabels) ||
    rawLabels.length > MAX_LABELS ||
    rawLabels.some((label) => typeof label !== "string" || label.length > MAX_LABEL_LENGTH || !LABEL.test(label))
  ) {
    throw new TypeError(
      `Plan metadata labels must contain at most ${MAX_LABELS} unique lowercase labels of at most ${MAX_LABEL_LENGTH} characters`,
    );
  }
  const labels = [...rawLabels] as string[];
  if (new Set(labels).size !== labels.length) {
    throw new TypeError(
      `Plan metadata labels must contain at most ${MAX_LABELS} unique lowercase labels of at most ${MAX_LABEL_LENGTH} characters`,
    );
  }

  const rawAnnotations = source.annotations ?? {};
  if (
    !isRecord(rawAnnotations) ||
    Object.keys(rawAnnotations).length > MAX_ANNOTATIONS ||
    Object.entries(rawAnnotations).some(
      ([key, annotation]) =>
        key.length > MAX_ANNOTATION_KEY_LENGTH ||
        !ANNOTATION_KEY.test(key) ||
        !boundedSingleLine(annotation, MAX_ANNOTATION_VALUE_LENGTH),
    )
  ) {
    throw new TypeError(
      `Plan metadata annotations must contain at most ${MAX_ANNOTATIONS} bounded string entries with lowercase keys`,
    );
  }

  return Object.freeze({
    ...(typeof title === "string" ? { title } : {}),
    labels: Object.freeze(labels),
    annotations: Object.freeze({ ...rawAnnotations }) as Readonly<Record<string, string>>,
  });
}

function boundedSingleLine(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
