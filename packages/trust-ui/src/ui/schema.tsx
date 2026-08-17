import type { TFunction } from "i18next";
import { AlertCircle, Check, ChevronRight, Minus, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../lib/format.js";
import type { JsonObject } from "../types.js";
import { TextInput } from "./controls.js";
import {
  blankValue,
  constraintHints,
  type FieldIssue,
  type ObjectSchema,
  primaryType,
  type PropertySpec,
  schemaProperties,
  typeLabel,
  validateObject,
  validateValue,
} from "./schema-validate.js";
import { Select } from "./select.js";

export type { FieldIssue, ObjectSchema, PropertySpec } from "./schema-validate.js";
export { schemaProperties, typeLabel } from "./schema-validate.js";

/* Shared schema-driven UI: read-only table, editable form with live validation, field controls. */

export function constraintLabel(spec: PropertySpec): string {
  return constraintHints(spec).join(" · ");
}

/** Read-only projection: one row per field. */
export function SchemaTable({ schema, empty, className }: { schema: JsonObject | undefined; empty?: string; className?: string }) {
  const { t } = useTranslation();
  const rows = schemaProperties(schema);
  if (rows.length === 0) return <p className={cx("text-body text-faint", className)}>{empty ?? t("ui.schema.noField")}</p>;
  return (
    <table className={cx("w-full border-collapse text-body", className)}>
      <thead>
        <tr className="text-left text-meta uppercase tracking-[0.06em] text-faint">
          <th className="py-1 pr-3 font-semibold">{t("ui.schema.columns.field")}</th>
          <th className="py-1 pr-3 font-semibold">{t("ui.schema.columns.type")}</th>
          <th className="py-1 pr-3 font-semibold">{t("ui.schema.columns.constraint")}</th>
          <th className="py-1 font-semibold">{t("ui.schema.columns.required")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ name, spec, required }) => (
          <tr key={name} className="border-t border-border">
            <td className="mono py-1.5 pr-3 font-medium">{name}</td>
            <td className="py-1.5 pr-3 text-muted">{typeLabel(spec)}</td>
            <td className="py-1.5 pr-3 text-muted">{constraintLabel(spec) || "—"}</td>
            <td className="py-1.5 text-muted">{required ? t("ui.schema.yes") : t("ui.schema.no")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Blank object with typed defaults for every property. */
export function blankObject(schema: JsonObject | ObjectSchema | undefined): JsonObject {
  return Object.fromEntries(schemaProperties(schema).map(({ name, spec }) => [name, blankValue(spec)]).filter(([, value]) => value !== undefined));
}

/** Editable form generated from the schema with live validation; the value stays a plain JSON object. */
export function SchemaForm({
  schema,
  value,
  onChange,
  onValidity,
  empty,
  idPrefix,
  showSummary = true,
  touchedAll = false,
}: {
  schema: JsonObject | ObjectSchema | undefined;
  value: JsonObject;
  onChange: (value: JsonObject) => void;
  /** Reports whether the value currently satisfies the schema. */
  onValidity?: (valid: boolean, issues: FieldIssue[]) => void;
  empty?: string;
  idPrefix: string;
  showSummary?: boolean;
  /** Show every issue immediately (after a submit attempt) instead of only touched fields. */
  touchedAll?: boolean;
}) {
  const { t } = useTranslation();
  const rows = schemaProperties(schema);
  const issues = useMemo(() => validateObject(schema, value), [schema, value]);
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  // Report by content, not by array identity: callers may pass a fresh schema object on every render.
  const issuesKey = JSON.stringify(issues);
  useEffect(() => onValidity?.(issues.length === 0, issues), [issuesKey, onValidity]); // eslint-disable-line react-hooks/exhaustive-deps
  if (rows.length === 0) return <p className="text-body text-faint">{empty ?? t("ui.schema.noField")}</p>;
  const set = (name: string, next: unknown) => {
    setTouched((current) => (current.has(name) ? current : new Set(current).add(name)));
    onChange({ ...value, [name]: next });
  };
  const missing = issues.filter((issue) => issue.kind === "missing");
  const invalid = issues.filter((issue) => issue.kind === "invalid");
  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-[minmax(120px,max-content)_minmax(0,1fr)] items-start gap-x-4 gap-y-2.5">
        {rows.map(({ name, spec, required }) => {
          const issue = issues.find((entry) => entry.field === name);
          const visibleIssue = issue && (touchedAll || touched.has(name) || issue.kind === "invalid") ? issue : undefined;
          return (
            <FieldRow key={name} id={`${idPrefix}-${name}`} name={name} spec={spec} required={required} value={value[name]} onChange={(next) => set(name, next)} issue={visibleIssue} pending={issue?.kind === "missing" && !visibleIssue} />
          );
        })}
      </div>
      {showSummary ? (
        <FormStatus missing={missing.map((issue) => issue.field)} invalid={invalid.map((issue) => issue.field)} />
      ) : null}
    </div>
  );
}

function FormStatus({ missing, invalid }: { missing: string[]; invalid: string[] }) {
  const { t } = useTranslation();
  if (missing.length === 0 && invalid.length === 0) {
    return <p className="inline-flex items-center gap-1 text-label text-success"><Check size={12} /> {t("ui.schema.completeAndValid")}</p>;
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-label text-muted">
      {missing.length ? <span>{t("ui.schema.missing")} <span className="mono text-warning">{missing.join(", ")}</span></span> : null}
      {invalid.length ? <span>{t("ui.schema.invalid")} <span className="mono text-danger">{invalid.join(", ")}</span></span> : null}
    </p>
  );
}

function FieldRow({ id, name, spec, required, value, onChange, issue, pending }: { id: string; name: string; spec: PropertySpec; required: boolean; value: unknown; onChange: (value: unknown) => void; issue?: FieldIssue | undefined; pending?: boolean }) {
  const { t } = useTranslation();
  const hints = constraintHints(spec);
  return (
    <>
      <label htmlFor={id} className="pt-1.5">
        <span className="mono flex items-center gap-1 text-body font-medium">
          {name}
          {required ? <span className={cx("text-micro", pending ? "text-warning" : "text-faint")} title={t("ui.schema.required")}>*</span> : null}
        </span>
        <span className="block text-meta text-faint">{typeLabel(spec)}{spec.description ? ` — ${spec.description}` : ""}</span>
      </label>
      <div className="min-w-0">
        <FieldInput id={id} spec={spec} value={value} onChange={onChange} invalid={issue?.kind === "invalid"} />
        <div className="mt-1 flex min-h-[14px] flex-wrap items-center gap-x-2 text-meta">
          {issue ? (
            <span className={cx("inline-flex items-center gap-1", issue.kind === "missing" ? "text-warning" : "text-danger")}><AlertCircle size={11} /> {issue.message}</span>
          ) : null}
          {hints.length ? <span className="text-faint">{hints.join(" · ")}</span> : null}
        </div>
      </div>
    </>
  );
}

const inputBase = "h-8 w-full rounded-(--radius-2) border bg-surface px-2.5 text-body-lg focus:border-border-focus";
const areaBase = "mono w-full resize-y rounded-(--radius-2) border bg-surface px-2.5 py-1.5 text-body leading-relaxed focus:border-border-focus";

function FieldInput({ id, spec, value, onChange, invalid }: { id: string; spec: PropertySpec; value: unknown; onChange: (value: unknown) => void; invalid?: boolean | undefined }) {
  const { t } = useTranslation();
  const type = primaryType(spec);
  const target = type === "array" ? (spec.items ?? {}) : spec;
  const border = invalid ? "border-danger" : "border-border";

  if (target.enum && type !== "array") {
    return (
      <Select
        ariaLabel={id}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(next) => onChange(coerce(target, next))}
        options={target.enum.map((option) => ({ value: String(option), label: String(option) }))}
        placeholder={t("ui.schema.choose")}
        className={cx("w-full", invalid && "[&>button]:border-danger")}
      />
    );
  }
  if (type === "boolean") return <Toggle id={id} checked={Boolean(value)} onChange={onChange} />;
  if (type === "number" || type === "integer") return <NumberStepper id={id} spec={spec} value={typeof value === "number" ? value : undefined} onChange={onChange} invalid={invalid} />;
  if (type === "array") return <ListEditor id={id} spec={target} value={Array.isArray(value) ? value : []} onChange={onChange} invalid={invalid} enumOptions={target.enum} />;
  if (type === "object" || (type === undefined && !spec.format)) return <JsonField id={id} value={value} onChange={onChange} />;
  if (spec.format === "date-time") {
    return (
      <div className="flex gap-1">
        <input id={id} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} placeholder={t("ui.schema.instantPlaceholder")} className={cx(inputBase, "mono", border)} />
        <button type="button" onClick={() => onChange(new Date().toISOString())} className="shrink-0 rounded-(--radius-2) border border-border px-2 text-caption text-muted hover:bg-surface-2" title={t("ui.schema.useNow")}>{t("ui.schema.now")}</button>
      </div>
    );
  }
  return (
    <TextInput
      id={id}
      value={typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value)}
      onChange={(event) => onChange(event.target.value)}
      className={cx("w-full", spec.format?.startsWith("trust-") || spec.format === "uri" ? "mono" : "", invalid && "border-danger")}
      placeholder={placeholderFor(spec, t)}
      spellCheck={false}
      aria-invalid={invalid || undefined}
    />
  );
}

function placeholderFor(spec: PropertySpec, t: TFunction): string | undefined {
  if (spec.format === "trust-directory") return t("ui.schema.placeholder.directory");
  if (spec.format === "trust-url" || spec.format === "uri" || spec.format === "url") return t("ui.schema.placeholder.url");
  if (spec.format === "email") return t("ui.schema.placeholder.email");
  return undefined;
}

function coerce(spec: PropertySpec, raw: string): unknown {
  const type = primaryType(spec);
  if (type === "number" || type === "integer") return raw === "" ? undefined : Number(raw);
  if (type === "boolean") return raw === "true";
  return raw;
}

/** Number field with −/+ respecting minimum, maximum and step (multipleOf or 1 for integers). */
export function NumberStepper({ id, spec, value, onChange, invalid }: { id: string; spec: PropertySpec; value: number | undefined; onChange: (value: unknown) => void; invalid?: boolean | undefined }) {
  const { t } = useTranslation();
  const step = spec.multipleOf ?? (primaryType(spec) === "integer" ? 1 : 0.1);
  const min = spec.minimum ?? (spec.exclusiveMinimum !== undefined ? spec.exclusiveMinimum + step : undefined);
  const max = spec.maximum ?? (spec.exclusiveMaximum !== undefined ? spec.exclusiveMaximum - step : undefined);
  const clamp = (next: number) => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, next));
  const round = (next: number) => Number(next.toFixed(6));
  const bump = (direction: 1 | -1) => onChange(round(clamp((value ?? (min ?? 0)) + direction * step)));
  return (
    <div className={cx("flex h-8 w-full items-stretch overflow-hidden rounded-(--radius-2) border bg-surface focus-within:border-border-focus", invalid ? "border-danger" : "border-border")}>
      <button type="button" aria-label={t("ui.schema.decrease")} onClick={() => bump(-1)} disabled={value !== undefined && min !== undefined && value <= min} className="w-8 shrink-0 border-r border-border text-muted hover:bg-surface-2 disabled:opacity-40"><Minus size={13} className="mx-auto" /></button>
      <input
        id={id}
        type="number"
        inputMode={primaryType(spec) === "integer" ? "numeric" : "decimal"}
        value={value === undefined ? "" : String(value)}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
        aria-invalid={invalid || undefined}
        className="mono min-w-0 flex-1 bg-transparent px-2.5 text-center text-body-lg outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button type="button" aria-label={t("ui.schema.increase")} onClick={() => bump(1)} disabled={value !== undefined && max !== undefined && value >= max} className="w-8 shrink-0 border-l border-border text-muted hover:bg-surface-2 disabled:opacity-40"><Plus size={13} className="mx-auto" /></button>
    </div>
  );
}

function Toggle({ id, checked, onChange, labels = ["false", "true"] }: { id: string; checked: boolean; onChange: (value: boolean) => void; labels?: [string, string] }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex h-8 items-center gap-2 text-body-lg"
    >
      <span className={cx("relative inline-flex h-5 w-9 items-center rounded-full border transition-colors", checked ? "border-accent bg-accent" : "border-border-strong bg-surface-3")}>
        <span className={cx("absolute h-3.5 w-3.5 rounded-full bg-surface shadow-(--shadow-1) transition-transform", checked ? "translate-x-[18px]" : "translate-x-[3px]")} />
      </span>
      <span className="mono text-muted">{checked ? labels[1] : labels[0]}</span>
    </button>
  );
}

/** List of scalars as removable chips plus an entry field (or a picker for enum items). */
export function ListEditor({ id, spec, value, onChange, invalid, enumOptions }: { id: string; spec: PropertySpec; value: unknown[]; onChange: (value: unknown[]) => void; invalid?: boolean | undefined; enumOptions?: unknown[] | undefined }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    onChange([...value, coerce(spec, trimmed)]);
    setDraft("");
  };
  return (
    <div className={cx("flex min-h-8 w-full flex-wrap items-center gap-1 rounded-(--radius-2) border bg-surface p-1 focus-within:border-border-focus", invalid ? "border-danger" : "border-border")}>
      {value.map((item, index) => (
        <span key={index} className="mono inline-flex h-6 items-center gap-1 rounded-full border border-border bg-surface-2 pr-1 pl-2 text-label">
          {typeof item === "string" ? item : JSON.stringify(item)}
          <button type="button" aria-label={t("ui.schema.removeItem", { item: String(item) })} onClick={() => onChange(value.filter((_, position) => position !== index))} className="inline-flex h-4 w-4 items-center justify-center rounded-full text-faint hover:bg-surface-3 hover:text-text"><X size={10} /></button>
        </span>
      ))}
      {enumOptions ? (
        <Select
          ariaLabel={`${id} add`}
          value=""
          onChange={(next) => add(next)}
          options={enumOptions.filter((option) => !value.includes(option)).map((option) => ({ value: String(option), label: String(option) }))}
          placeholder={t("ui.schema.add")}
          size="sm"
          className="min-w-28"
        />
      ) : (
        <input
          id={id}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add(draft);
            } else if (event.key === "Backspace" && draft === "" && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => add(draft)}
          placeholder={value.length ? t("ui.schema.add") : t("ui.schema.typeToAdd")}
          className="mono h-6 min-w-24 flex-1 bg-transparent px-1 text-body outline-none placeholder:text-faint"
        />
      )}
    </div>
  );
}

/** Free JSON value (objects, mixed payloads) with inline validity feedback. */
export function JsonField({ id, value, onChange, rows = 4 }: { id: string; value: unknown; onChange: (value: unknown) => void; rows?: number }) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [invalid, setInvalid] = useState(false);
  return (
    <div>
      <textarea
        id={id}
        rows={rows}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          if (event.target.value.trim() === "") {
            setInvalid(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(event.target.value));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        placeholder="{ }"
        className={cx(areaBase, invalid ? "border-danger" : "border-border")}
      />
      {invalid ? <span className="text-caption text-danger">{t("ui.schema.invalidJson")}</span> : null}
    </div>
  );
}

/** Collapsible group used by forms and read views. */
export function Disclosure({ title, meta, defaultOpen = true, children, className }: { title: ReactNode; meta?: ReactNode; defaultOpen?: boolean; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cx("rounded-(--radius-2) border border-border bg-surface", className)}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2">
        <ChevronRight size={13} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <span className="text-body-lg font-semibold">{title}</span>
        {meta ? <span className="ml-auto text-caption text-muted">{meta}</span> : null}
      </button>
      {open ? <div className="border-t border-border px-3 py-3">{children}</div> : null}
    </section>
  );
}

