import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../lib/format.js";
import { Expert } from "./expert.js";

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col items-center justify-center gap-2 rounded-(--radius-3) border border-dashed border-border px-6 py-12 text-center", className)}>
      {icon ? <span className="text-faint [&>svg]:h-7 [&>svg]:w-7">{icon}</span> : null}
      <strong className="text-subhead font-semibold">{title}</strong>
      {body ? <p className="max-w-md text-body-lg text-muted">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label, className }: { label?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cx("flex items-center justify-center gap-2 py-12 text-body-lg text-muted", className)}>
      <Loader2 size={16} className="animate-spin" />
      {label ?? t("ui.states.loading")}
    </div>
  );
}

export function ErrorBox({ message, details, className }: { message: string; details?: string | undefined; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cx("flex items-start gap-2 rounded-(--radius-2) border border-danger/30 bg-danger-soft px-3 py-2 text-body-lg text-danger", className)}>
      <AlertCircle size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="break-words">{message}</span>
        {details ? (
          <Expert>
            <details className="mt-1">
              <summary className="cursor-pointer text-caption text-danger/80">{t("common.states.technicalDetails")}</summary>
              <pre className="mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-(--radius-1) bg-surface p-2 text-caption text-text">{details}</pre>
            </details>
          </Expert>
        ) : null}
      </div>
    </div>
  );
}
