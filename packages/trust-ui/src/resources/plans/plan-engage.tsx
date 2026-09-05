import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlanMode, RuntimeJsonObject } from "@trust/extension-sdk";
import type { CompiledProcedure } from "@trust/procedure";
import { FlaskConical, PanelRightClose, PanelRightOpen, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useCurrentEnvironment } from "../../lib/environment.js";
import { plural } from "../../lib/format.js";
import { mutationError } from "../../lib/mutations.js";
import { updatePreferences, useExpert, usePreference } from "../../lib/preferences.js";
import { useProcedures, useRuntime } from "../../lib/runtime-context.js";
import { Badge } from "../../ui/badge.js";
import { Breadcrumb } from "../../ui/breadcrumb.js";
import { Button, IconButton } from "../../ui/button.js";
import { Field, TextInput } from "../../ui/controls.js";
import { Description } from "../../ui/description.js";
import { Overlay } from "../../ui/overlay.js";
import { type ObjectSchema, SchemaForm } from "../../ui/schema.js";
import { Select } from "../../ui/select.js";
import { ErrorBox } from "../../ui/states.js";
import { OverlayHeader } from "../shared/resource-overlay.js";
import { ModeBadge } from "./parts.js";

/* Engaging a Plan: immutable presentation metadata plus the closed set of compiled root inputs of a
   published Procedure, on a configured environment. Live Plans are then driven by an agent; dry-runs by the operator (Rehearse). */

export function PlanEngage({
  planMode,
  base,
  onClose,
  listSearch,
}: {
  planMode: PlanMode;
  base: string;
  onClose: () => void;
  listSearch: string;
}) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const procedures = useProcedures();
  const expert = useExpert();
  // The procedure aside (description, counts) follows the same user preference as every overlay inspector.
  const inspectorOpen = usePreference("inspectorOpen");
  const environments = useQuery({ queryKey: ["environments"], queryFn: () => runtime.environments() });
  const current = useCurrentEnvironment().name;
  const [procedureId, setProcedureId] = useState("");
  const [environment, setEnvironment] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const [rootInputs, setRootInputs] = useState<RuntimeJsonObject>({});
  const [valid, setValid] = useState(false);
  const [touchedAll, setTouchedAll] = useState(false);

  const published = procedures.data?.find(({ procedure }) => procedure.procedure === procedureId)?.procedure;
  const schema = useMemo(() => (published ? rootInputSchema(published) : undefined), [published]);
  const [inputsProcedure, setInputsProcedure] = useState(procedureId);
  if (inputsProcedure !== procedureId) {
    setInputsProcedure(procedureId);
    setRootInputs({});
    setTouchedAll(false);
    setValid(false);
  }
  useEffect(() => {
    const first = environments.data?.[0];
    if (!environment && first) setEnvironment(current ?? first.name);
  }, [environments.data, environment, current]);

  const labels = labelsText
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  const titleValue = title.trim();
  const titleOk = titleValue.length <= 256 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(titleValue);
  const labelsOk =
    labels.length <= 32 &&
    new Set(labels).size === labels.length &&
    labels.every((label) => /^[a-z0-9][a-z0-9._/-]{0,63}$/.test(label));
  const metadata = {
    ...(titleValue ? { title: titleValue } : {}),
    labels,
    annotations: {},
  };

  const engage = useMutation({
    mutationFn: () => {
      if (!published) throw new Error("Select a published Procedure before engaging a Plan.");
      return runtime.engagePlan({
        procedure: published.procedure,
        procedureVersion: published.version,
        plan: slug.trim(),
        environment,
        metadata,
        rootInputs,
        ...(planMode === "dry-run" ? { mode: "dry-run" as const } : {}),
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["plans"] });
      navigate(`${base}/${encodeURIComponent(result.plan)}${listSearch}`, { replace: true });
    },
  });
  const error = mutationError(engage.error);
  const slugOk = /^[a-z0-9][a-z0-9-]*$/.test(slug.trim());
  const ready = Boolean(published) && environment !== "" && slugOk && titleOk && labelsOk && valid;
  // The aside carries the chosen procedure (description, counts): nothing to show before a choice.
  const asideOpen = Boolean(published) && inspectorOpen;

  return (
    <Overlay
      onClose={onClose}
      labelledBy="plan-engage-title"
      breadcrumb={
        <Breadcrumb
          items={[
            { label: t("plans.brand"), to: "/overview" },
            {
              label: planMode === "dry-run" ? t("plans.anchor.dryRuns") : t("plans.anchor.plans"),
              to: `${base}${listSearch}`,
            },
            { label: planMode === "dry-run" ? t("plans.engage.newDryRun") : t("plans.engage.engagePlan") },
          ]}
        />
      }
    >
      <OverlayHeader
        labelledBy="plan-engage-title"
        kicker={t("plans.engage.kicker")}
        badges={<ModeBadge mode={planMode} />}
        id={expert ? (published ? `${published.procedure}@${published.version}` : t("plans.engage.newId")) : ""}
        title={planMode === "dry-run" ? t("plans.engage.titleDryRun") : t("plans.engage.titleLive")}
        actions={
          <>
            {published ? (
              <IconButton
                size="sm"
                label={inspectorOpen ? t("plans.engage.hideDetails") : t("plans.engage.showDetails")}
                active={inspectorOpen}
                onClick={() => updatePreferences({ inspectorOpen: !inspectorOpen })}
              >
                {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
              </IconButton>
            ) : null}
            <Button
              variant="primary"
              icon={planMode === "dry-run" ? <FlaskConical size={13} /> : <Play size={13} />}
              disabled={!ready || engage.isPending}
              onClick={() => {
                setTouchedAll(true);
                if (ready) engage.mutate();
              }}
            >
              {engage.isPending
                ? t("plans.engage.engaging")
                : planMode === "dry-run"
                  ? t("plans.engage.startDryRun")
                  : t("plans.engage.engage")}
            </Button>
          </>
        }
      />
      <div
        className={
          asideOpen
            ? "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_var(--inspector-w)]"
            : "flex min-h-0 flex-1 flex-col"
        }
      >
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0" data-doc="engage.form">
          <Field label={t("plans.engage.procedure")}>
            <Select
              ariaLabel={t("plans.engage.procedure")}
              value={procedureId}
              onChange={setProcedureId}
              placeholder={t("plans.engage.chooseProcedure")}
              options={(procedures.data ?? []).map(({ procedure }) => ({
                value: procedure.procedure,
                label: procedure.title,
                meta: expert ? `${procedure.procedure} · v${procedure.version}` : procedure.procedure,
              }))}
            />
            {procedures.error ? <ErrorBox message={procedures.error.message} /> : null}
          </Field>
          <Field label={t("plans.engage.environment")}>
            <Select
              ariaLabel={t("plans.engage.environment")}
              value={environment}
              onChange={setEnvironment}
              placeholder={t("plans.engage.chooseEnvironment")}
              options={(environments.data ?? []).map((entry) => ({ value: entry.name, label: entry.name }))}
            />
          </Field>
          <Field label={t("plans.engage.identifier")} hint={t("plans.engage.identifierHint")}>
            <TextInput
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder={planMode === "dry-run" ? "simulation-pay-42" : "pay-42"}
              className="w-72"
              aria-invalid={touchedAll && !slugOk}
            />
            {touchedAll && !slugOk ? (
              <span className="text-caption text-danger">{t("plans.engage.identifierInvalid")}</span>
            ) : null}
          </Field>
          <Field label={t("plans.engage.metadataTitle")} hint={t("plans.engage.metadataTitleHint")}>
            <TextInput
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={published?.title ?? t("plans.engage.metadataTitlePlaceholder")}
              className="w-full max-w-2xl"
              aria-invalid={touchedAll && !titleOk}
            />
            {touchedAll && !titleOk ? (
              <span className="text-caption text-danger">{t("plans.engage.metadataTitleInvalid")}</span>
            ) : null}
          </Field>
          <Field label={t("plans.engage.labels")} hint={t("plans.engage.labelsHint")}>
            <TextInput
              value={labelsText}
              onChange={(event) => setLabelsText(event.target.value)}
              placeholder="release, payments"
              className="w-full max-w-2xl mono"
              aria-invalid={touchedAll && !labelsOk}
            />
            {touchedAll && !labelsOk ? (
              <span className="text-caption text-danger">{t("plans.engage.labelsInvalid")}</span>
            ) : null}
          </Field>
          <Field label={t("plans.engage.rootInputs")}>
            {published ? (
              <SchemaForm
                idPrefix="engage"
                schema={schema}
                value={rootInputs}
                onChange={setRootInputs}
                onValidity={setValid}
                touchedAll={touchedAll}
                empty={t("plans.engage.noRootInput")}
              />
            ) : (
              <p className="text-body text-faint">{t("plans.engage.chooseProcedureFirst")}</p>
            )}
          </Field>
          {error ? <ErrorBox message={error} /> : null}
        </div>
        {asideOpen && published ? (
          <aside className="min-h-0 overflow-y-auto border-l border-border p-3 text-body" data-doc="engage.aside">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="kicker">{t("plans.engage.procedureKicker")}</span>
              <Badge>{t("plans.engage.scenarios", { count: published.scenarios.length })}</Badge>
              <Badge>{plural(published.checks.length, "check")}</Badge>
            </div>
            {published.description ? <Description text={published.description} className="mt-2 text-muted" /> : null}
          </aside>
        ) : null}
      </div>
    </Overlay>
  );
}

/** JSON schema of the root inputs (roles sourced as plan inputs), so the shared SchemaForm can drive them. */
function rootInputSchema(procedure: CompiledProcedure): ObjectSchema {
  const roles = procedure.roles.filter((role) => role.source.kind === "plan-input");
  return {
    properties: Object.fromEntries(
      roles.map((role) => {
        const scalar = role.type === "number" ? { type: "number" } : { type: "string", minLength: 1 };
        return [role.name, role.cardinality === "many" ? { type: "array", items: scalar, minItems: 1 } : scalar];
      }),
    ),
    required: roles.map((role) => role.name),
    additionalProperties: false,
  };
}
