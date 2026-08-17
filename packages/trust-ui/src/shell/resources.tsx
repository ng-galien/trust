import { Activity, FlaskConical, GitBranch, History, LayoutDashboard, Server, TerminalSquare } from "lucide-react";
import type { ParseKeys } from "i18next";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";

import { plural } from "../lib/format.js";
import { useRemoveEnvironment, useRemoveOperation, useRemovePlan } from "../lib/mutations.js";
import { useEnvironments, useOperations, usePlans, useProcedures } from "../lib/runtime-context.js";

export type AnchorId = "operations" | "procedures" | "environments" | "plans" | "dry-runs" | "history";
export type Section = "design" | "run";
type TranslationKey = ParseKeys;

export interface ResourceAnchor {
  id: AnchorId;
  /** Dictionary key of the display name — consumers render `t(anchor.label)`. */
  label: TranslationKey;
  /** Dictionary key of the singular noun used in "New …" / "Delete …" phrases. */
  singular: TranslationKey;
  icon: ComponentType<{ size?: number | string; strokeWidth?: number | string; className?: string }>;
  to: string;
  section: Section;
  /** The anchor lists its items in the sidebar explorer. */
  explorable: boolean;
  /** Creation route, when the UI can author a new item. */
  createTo?: string;
  /** Dictionary key explaining why items of this resource cannot be deleted from the interface (no runtime contract). */
  managementNote?: TranslationKey;
}

export const overviewAnchor = { label: "shell.nav.overview", icon: LayoutDashboard, to: "/overview" } as const;

export const resourceAnchors: ResourceAnchor[] = [
  {
    id: "operations",
    label: "shell.nav.operations",
    singular: "shell.singular.operation",
    icon: TerminalSquare,
    to: "/operations",
    section: "design",
    explorable: true,
    createTo: "/operations/new",
  },
  {
    id: "procedures",
    label: "shell.nav.procedures",
    singular: "shell.singular.procedure",
    icon: GitBranch,
    to: "/procedures",
    section: "design",
    explorable: true,
    createTo: "/procedures/new",
    managementNote: "shell.managementNote.procedures",
  },
  // Environments: where Plans run — named contexts with their values and credential references (never the secrets).
  { id: "environments", label: "shell.nav.environments", singular: "shell.singular.environment", icon: Server, to: "/environments", section: "run", explorable: true, createTo: "/environments/new" },
  // Live Plans are driven by agents; the interface can engage one but never acts on its Checks.
  { id: "plans", label: "shell.nav.plans", singular: "shell.singular.plan", icon: Activity, to: "/plans", section: "run", explorable: true, createTo: "/plans/new", managementNote: "shell.managementNote.plans" },
  // Dry-runs are Plans rehearsed by the operator: same object, same rules, kept apart from live Plans.
  { id: "dry-runs", label: "shell.nav.dryRuns", singular: "shell.singular.dryRun", icon: FlaskConical, to: "/dry-runs", section: "run", explorable: true, createTo: "/dry-runs/new" },
  { id: "history", label: "shell.nav.history", singular: "shell.singular.history", icon: History, to: "/history", section: "run", explorable: false },
];

export const sections: Array<{ id: Section; label: TranslationKey }> = [
  { id: "design", label: "shell.nav.design" },
  { id: "run", label: "shell.nav.run" },
];

export interface AnchorItem {
  id: string;
  label: string;
  to: string;
  meta?: string;
  state?: string;
  /** Source of a client-side duplicate, when authoring is available. */
  duplicateTo?: string;
  /** Deletion, when the runtime offers it for this item; `blocked` explains why it is refused for this one. */
  remove?: { blocked?: string; body: string; run: () => Promise<unknown> };
  /** Items sharing a group are listed under a common heading (e.g. Plans under their Procedure). */
  group?: { id: string; label: string; to: string };
}

export interface AnchorItems {
  items: AnchorItem[];
  loading: boolean;
  error?: string | undefined;
}

/** Items shown under an anchor. Reads the same queries as the resource homes. */
export function useAnchorItems(anchor: AnchorId): AnchorItems {
  const { t } = useTranslation();
  const operations = useOperations();
  const procedures = useProcedures();
  const plans = usePlans();
  const environments = useEnvironments();
  const removeOperation = useRemoveOperation();
  const removePlan = useRemovePlan();
  const removeEnvironment = useRemoveEnvironment();

  switch (anchor) {
    case "operations":
      return {
        loading: operations.isLoading,
        error: operations.error?.message,
        items: (operations.data ?? [])
          .map((operation) => ({
            id: operation.operation,
            label: operation.operation,
            to: `/operations/${encodeURIComponent(operation.operation)}`,
            meta: `v${operation.version}`,
            duplicateTo: `/operations/new?from=${encodeURIComponent(operation.operation)}`,
            remove: {
              ...(procedures.data?.some(({ procedure }) => procedure.operations.some((used) => used.operation === operation.operation)) ? { blocked: t("shell.items.operationUsedByProcedure") } : {}),
              body: t("shell.items.removeOperationBody"),
              run: () => removeOperation.mutateAsync({ operation: operation.operation, version: operation.version }),
            },
          }))
          .sort(byId),
      };
    case "procedures":
      return {
        loading: procedures.isLoading,
        error: procedures.error?.message,
        items: (procedures.data ?? [])
          .map(({ procedure }) => ({
            id: procedure.procedure,
            label: procedure.procedure,
            to: `/procedures/${encodeURIComponent(procedure.procedure)}`,
            meta: `v${procedure.version}`,
            duplicateTo: `/procedures/new?from=${encodeURIComponent(procedure.procedure)}`,
          }))
          .sort(byId),
      };
    case "environments":
      return {
        loading: environments.isLoading,
        error: environments.error?.message,
        items: (environments.data ?? []).map((environment) => ({
          id: environment.name,
          label: environment.name,
          to: `/environments/${encodeURIComponent(environment.name)}`,
          meta: plural(Object.keys(environment.values).length, "value"),
          remove: { body: t("shell.items.removeEnvironmentBody"), run: () => removeEnvironment.mutateAsync(environment.name) },
        })).sort(byId),
      };
    case "plans":
    case "dry-runs":
      return {
        loading: plans.isLoading,
        error: plans.error?.message,
        items: (plans.data ?? [])
          .filter((plan) => (anchor === "dry-runs" ? plan.mode === "dry-run" : plan.mode !== "dry-run"))
          .map((plan) => ({
            id: plan.plan,
            label: plan.plan,
            to: `/${anchor}/${encodeURIComponent(plan.plan)}`,
            meta: `${plan.satisfiedChecks}/${plan.checkCount}`,
            state: plan.workState,
            ...(plan.mode === "dry-run" ? { remove: { body: t("shell.items.removeDryRunBody"), run: () => removePlan.mutateAsync({ plan: plan.plan }) } } : {}),
            group: {
              id: plan.procedure,
              label: procedures.data?.find(({ procedure }) => procedure.procedure === plan.procedure)?.procedure.title ?? plan.procedure,
              to: `/procedures/${encodeURIComponent(plan.procedure)}`,
            },
          }))
          .sort((a, b) => a.group.label.localeCompare(b.group.label) || byId(a, b)),
      };
    default:
      return { items: [], loading: false };
  }
}

function byId(a: { id: string }, b: { id: string }) {
  return a.id.localeCompare(b.id);
}
