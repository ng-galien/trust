import type { PlanCancellationView, PlanView } from "@trust/extension-sdk";
import { Ban } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatTime } from "../../lib/format.js";
import { mutationError, mutationErrorDetails, useCancelPlan } from "../../lib/mutations.js";
import { RuntimeError } from "../../runtime.js";
import { ConfirmDialog } from "../../ui/confirm.js";
import { ErrorBox } from "../../ui/states.js";

/* Cancellation of a root Plan: the operator gives a reason and confirms; the runtime records date, author and
   reason, and the Plan page shows them for as long as the Plan exists. */

/** Only a root Plan that is neither complete nor already cancelled can be cancelled; its child Plans follow it. */
export function canCancel(plan: Pick<PlanView, "parent" | "workState">): boolean {
  return plan.parent === null && plan.workState !== "COMPLETE" && plan.workState !== "CANCELLED";
}

export function CancelPlanDialog({ plan, open, onClose }: { plan: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const cancel = useCancelPlan();
  const [reason, setReason] = useState("");
  const close = () => {
    cancel.reset();
    setReason("");
    onClose();
  };
  const refusal = cancel.error
    ? cancel.error instanceof RuntimeError && cancel.error.code === -32001
      ? t("plans.cancellation.denied")
      : t("plans.cancellation.refused", { reason: mutationError(cancel.error) ?? "" })
    : undefined;
  return (
    <ConfirmDialog
      open={open}
      tone="danger"
      title={t("plans.cancellation.confirmTitle", { slug: plan })}
      body={
        <>
          <p>{t("plans.cancellation.confirmBody")}</p>
          <label className="mt-3 block text-text">
            <span className="kicker">{t("plans.cancellation.reason")}</span>
            <textarea
              aria-label={t("plans.cancellation.reason")}
              value={reason}
              maxLength={4_096}
              rows={4}
              placeholder={t("plans.cancellation.reasonPlaceholder")}
              disabled={cancel.isPending}
              className="mt-2 w-full resize-y rounded-(--radius-2) border border-border bg-bg px-3 py-2 text-body-lg leading-relaxed text-text outline-none placeholder:text-faint focus:border-accent"
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="mt-1 block text-caption text-muted">{t("plans.cancellation.reasonHint")}</span>
          </label>
          {cancel.isPending ? (
            <p role="status" className="mt-2 text-body text-muted">
              {t("plans.cancellation.pending")}
            </p>
          ) : null}
          {refusal ? (
            <div role="alert" className="mt-3">
              <ErrorBox message={refusal} details={mutationErrorDetails(cancel.error)} />
            </div>
          ) : null}
        </>
      }
      confirmLabel={t("plans.cancellation.action")}
      cancelLabel={t("plans.cancellation.keep")}
      busy={cancel.isPending}
      confirmDisabled={!reason.trim()}
      onCancel={close}
      onConfirm={() => {
        if (!reason.trim()) return;
        cancel.mutate({ plan, reason: reason.trim() }, { onSuccess: close });
      }}
    />
  );
}

/** The recorded cancellation: date, author and reason, with the root Plan when this Plan was cancelled with it. */
export function PlanCancellationNotice({ plan, cancellation }: { plan: PlanView; cancellation: PlanCancellationView }) {
  const { t } = useTranslation();
  const inherited = cancellation.rootPlan !== plan.plan;
  const author = cancellation.cancelledBy
    ? t("plans.cancellation.principal", {
        subject: cancellation.cancelledBy.subject,
        issuer: cancellation.cancelledBy.issuer,
      })
    : t("plans.cancellation.localAccess");
  return (
    <section
      data-doc="plan.cancellation"
      aria-labelledby={`plan-cancellation-${plan.plan}`}
      className="overflow-hidden rounded-(--radius-3) border border-border-strong bg-surface-2"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-3">
        <Ban size={18} aria-hidden="true" className="shrink-0 text-muted" />
        <h2 id={`plan-cancellation-${plan.plan}`} className="text-ui font-semibold">
          {t("plans.cancellation.title")}
        </h2>
        {inherited ? (
          <Link
            to={`${plan.mode === "dry-run" ? "/dry-runs" : "/plans"}/${encodeURIComponent(cancellation.rootPlan)}`}
            aria-label={t("plans.cancellation.openRoot", { plan: cancellation.rootPlan })}
            className="min-w-0 break-words text-body text-accent hover:underline"
          >
            {t("plans.cancellation.inherited", { plan: cancellation.rootPlan })}
          </Link>
        ) : null}
      </div>
      <dl className="grid min-w-0 gap-x-4 gap-y-2 px-4 py-3 text-body-lg sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="kicker pt-0.5">{t("plans.cancellation.cancelledAt")}</dt>
        <dd className="min-w-0">
          <time dateTime={cancellation.cancelledAt} title={cancellation.cancelledAt}>
            {formatTime(cancellation.cancelledAt)}
          </time>
        </dd>
        <dt className="kicker pt-0.5">{t("plans.cancellation.cancelledBy")}</dt>
        <dd className="min-w-0 break-words">{author}</dd>
        <dt className="kicker pt-0.5">{t("plans.cancellation.reason")}</dt>
        <dd className="min-w-0 whitespace-pre-wrap break-words">{cancellation.reason}</dd>
      </dl>
    </section>
  );
}
