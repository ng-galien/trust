import type { ExtensionDescriptor, ExtensionState } from "@trust/extension-sdk";
import { Loader2, Play, RotateCw, Square, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge, type Tone } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { type LifecycleAction, useExtensionTransition } from "./registry-data.js";
import { Notice } from "./registry-parts.js";

/* Explicit extension lifecycle: only the transitions that apply to the current state are offered, each with what
   it does; every run shows its pending state, then the resulting state or the runtime's refusal and its cause. */

const STATE_TONES: Record<ExtensionState, Tone> = {
  STOPPED: "neutral",
  PREPARING: "warning",
  STARTING: "warning",
  RUNNING: "success",
  STOPPING: "warning",
  FAILED: "danger",
};

export function stateTone(state: ExtensionState): Tone {
  return STATE_TONES[state];
}

/** Transitions applicable to each state; none while a transition is in progress. */
const STATE_ACTIONS: Record<ExtensionState, readonly LifecycleAction[]> = {
  STOPPED: ["prepare", "start"],
  PREPARING: [],
  STARTING: [],
  RUNNING: ["restart", "stop"],
  STOPPING: [],
  FAILED: ["prepare", "start"],
};

export function lifecycleActions(state: ExtensionState): readonly LifecycleAction[] {
  return STATE_ACTIONS[state];
}

export const lifecycleIcon: Record<LifecycleAction, ReactNode> = {
  prepare: <Wrench size={14} aria-hidden="true" />,
  start: <Play size={14} aria-hidden="true" />,
  restart: <RotateCw size={14} aria-hidden="true" />,
  stop: <Square size={14} aria-hidden="true" />,
};

export function StateBadge({ state }: { state: ExtensionState }) {
  const { t } = useTranslation();
  return <Badge tone={stateTone(state)}>{t(`extensions.states.${state}`)}</Badge>;
}

/** One lifecycle run and its outcome, shared by the list and the detail pages. */
export function useLifecycle() {
  const transition = useExtensionTransition();
  const run = (extension: Pick<ExtensionDescriptor, "id" | "title">, action: LifecycleAction) =>
    transition.mutate({ extension: extension.id, title: extension.title, action });
  /** Prepares the storage, then starts the extension once the preparation succeeded. */
  const prepareAndStart = (extension: Pick<ExtensionDescriptor, "id" | "title">) =>
    transition.mutate(
      { extension: extension.id, title: extension.title, action: "prepare" },
      { onSuccess: () => run(extension, "start") },
    );
  const pendingFor = (id: string) =>
    transition.isPending && transition.variables?.extension === id ? transition.variables.action : undefined;
  return { transition, run, prepareAndStart, pendingFor };
}

/** Outcome of the last lifecycle run: resulting state, or the refusal with its cause. */
export function LifecycleOutcome({ lifecycle }: { lifecycle: ReturnType<typeof useLifecycle> }) {
  const { t } = useTranslation();
  const { transition } = lifecycle;
  const variables = transition.variables;
  if (!variables) return null;
  if (transition.isPending)
    return (
      <Notice tone="info">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {t(`registry.lifecycle.pending.${variables.action}`, { name: variables.title ?? variables.extension })}
      </Notice>
    );
  if (transition.isSuccess)
    return (
      <Notice tone="success">
        {t(`registry.lifecycle.done.${variables.action}`, { name: variables.title ?? variables.extension })}{" "}
        {t("registry.lifecycle.state", { state: t(`extensions.states.${transition.data.extension.state}`) })}
      </Notice>
    );
  if (transition.isError)
    return (
      <Notice tone="danger">
        {t(`registry.lifecycle.failed.${variables.action}`, { name: variables.title ?? variables.extension })}{" "}
        {transition.error instanceof Error ? transition.error.message : ""}
      </Notice>
    );
  return null;
}

/** Detail-page lifecycle: each applicable transition with its explanation, then the outcome of the last run. */
export function LifecyclePanel({ extension }: { extension: ExtensionDescriptor }) {
  const { t } = useTranslation();
  const lifecycle = useLifecycle();
  const pending = lifecycle.pendingFor(extension.id);
  const actions = lifecycleActions(extension.state);
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-body-lg">
        {t("registry.lifecycle.current")} <StateBadge state={extension.state} />
      </p>
      {extension.error ? (
        <p role="alert" className="text-body text-danger">
          {extension.error.message}
        </p>
      ) : null}
      {actions.length === 0 ? (
        <p className="text-body text-muted">{t("registry.lifecycle.busy")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {actions.map((action) => (
            <li key={action} className="flex flex-wrap items-center gap-3">
              <Button
                variant={action === "stop" ? "danger" : "secondary"}
                icon={
                  pending === action ? (
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  ) : (
                    lifecycleIcon[action]
                  )
                }
                disabled={lifecycle.transition.isPending}
                onClick={() => lifecycle.run(extension, action)}
                className="min-w-28"
              >
                {pending === action
                  ? t(`registry.lifecycle.running.${action}`)
                  : t(`registry.lifecycle.action.${action}`)}
              </Button>
              <span className="min-w-0 flex-1 text-body text-muted">{t(`registry.lifecycle.explain.${action}`)}</span>
            </li>
          ))}
        </ul>
      )}
      <LifecycleOutcome lifecycle={lifecycle} />
    </div>
  );
}

/** Storage left without a schema by an update or a settings change: one action prepares it and starts the
    extension, then reports each step's outcome in place. */
export function PrepareAndStart({
  extension,
  message,
}: {
  extension: Pick<ExtensionDescriptor, "id" | "title">;
  message: string;
}) {
  const { t } = useTranslation();
  const lifecycle = useLifecycle();
  const pending = lifecycle.pendingFor(extension.id);
  const started = lifecycle.transition.isSuccess && lifecycle.transition.variables?.action === "start";
  return (
    <div className="flex flex-col gap-2">
      {started ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-(--radius-2) border border-warning/30 bg-warning-soft px-3 py-2">
          <span>{message}</span>
          <Button
            size="sm"
            icon={pending ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : lifecycleIcon.prepare}
            disabled={lifecycle.transition.isPending}
            onClick={() => lifecycle.prepareAndStart(extension)}
          >
            {pending ? t(`registry.lifecycle.running.${pending}`) : t("registry.update.prepareAndStart")}
          </Button>
        </div>
      )}
      <LifecycleOutcome lifecycle={lifecycle} />
    </div>
  );
}
