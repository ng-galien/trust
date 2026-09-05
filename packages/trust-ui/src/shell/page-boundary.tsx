import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { Button } from "../ui/button.js";

/** Keep a broken resource renderer from unmounting the navigation shell. */
class RenderBoundary extends Component<
  { children: ReactNode; resetKey: string; fallback: (retry: () => void) => ReactNode },
  { failed: boolean; resetKey: string }
> {
  override state = { failed: false, resetKey: "" };
  static getDerivedStateFromProps(props: { resetKey: string }, state: { resetKey: string }) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

export function PageBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  return (
    <RenderBoundary
      resetKey={`${location.pathname}${location.search}`}
      fallback={(retry) => (
        <section role="alert" className="m-6 rounded-(--radius-3) border border-border bg-surface p-6">
          <h1 className="text-subheading font-semibold">{t("common.states.pageFailed")}</h1>
          <p className="mt-2 text-body text-muted">{t("common.states.pageFailedBody")}</p>
          <div className="mt-4 flex items-center gap-4">
            <Button onClick={retry}>{t("common.actions.retry")}</Button>
            <Link to="/overview" className="text-accent underline">
              {t("common.actions.backToOverview")}
            </Link>
          </div>
        </section>
      )}
    >
      {children}
    </RenderBoundary>
  );
}
