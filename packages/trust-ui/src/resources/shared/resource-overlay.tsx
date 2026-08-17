import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { updatePreferences, usePreference } from "../../lib/preferences.js";
import { Breadcrumb, type Crumb } from "../../ui/breadcrumb.js";
import { IconButton } from "../../ui/button.js";
import { SegmentedControl } from "../../ui/controls.js";
import { Overlay } from "../../ui/overlay.js";

/* Item overlay shared by resources: compact header (kicker · status · badges · id / title / actions),
   tab bar with a right-hand meta line, body split between the tab content and the inspector.
   The inspector can be folded away (a diagram wants the whole width); the choice is the user's,
   remembered as a preference across items and sessions. */

/** Compact item header shared by every overlay: kicker · badges · id / title / actions. */
export function OverlayHeader({ labelledBy, kicker, badges, id, title, actions }: { labelledBy: string; kicker: string; badges?: ReactNode; id: string; title: string; actions?: ReactNode }) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-6 border-b border-border px-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-label">
          <span className="kicker">{kicker}</span>
          {badges}
          <span className="mono truncate-1 text-muted">{id}</span>
        </div>
        <h1 id={labelledBy} className="mt-0.5 truncate-1 text-title leading-tight font-semibold tracking-tight">{title}</h1>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function ResourceOverlay<T extends string>({
  onClose,
  crumbs,
  labelledBy,
  kicker,
  badges,
  id,
  title,
  actions,
  tabs,
  tab,
  onTab,
  tabMeta,
  tabActions,
  inspector,
  children,
  loading,
}: {
  onClose: () => void;
  crumbs: Crumb[];
  labelledBy: string;
  kicker: string;
  badges?: ReactNode;
  id: string;
  title: string;
  actions?: ReactNode;
  tabs: Array<{ value: T; label: ReactNode }>;
  tab: T;
  onTab: (tab: T) => void;
  tabMeta?: ReactNode;
  /** Controls placed in the tab bar, next to the meta line (e.g. a cockpit toggle). */
  tabActions?: ReactNode;
  inspector?: ReactNode;
  children: ReactNode;
  loading?: ReactNode;
}) {
  const { t } = useTranslation();
  const inspectorPreferred = usePreference("inspectorOpen");
  const inspectorOpen = Boolean(inspector) && inspectorPreferred;
  const toggleInspector = () => updatePreferences({ inspectorOpen: !inspectorPreferred });

  return (
    <Overlay onClose={onClose} labelledBy={labelledBy} breadcrumb={<Breadcrumb items={crumbs} />}>
      {loading ?? (
        <>
          <OverlayHeader labelledBy={labelledBy} kicker={kicker} badges={badges} id={id} title={title} actions={actions} />
          <div className={inspectorOpen ? "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_var(--inspector-w)]" : "flex min-h-0 flex-1 flex-col"}>
            <section className={inspectorOpen ? "flex min-h-0 min-w-0 flex-col border-r border-border" : "flex min-h-0 min-w-0 flex-1 flex-col"}>
              <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-3 py-1.5">
                <SegmentedControl ariaLabel={t("shared.resourceOverlay.views")} size="sm" value={tab} onChange={onTab} options={tabs} />
                <div className="flex min-w-0 items-center gap-2">
                  {tabMeta ? <span className="truncate-1 text-label text-muted">{tabMeta}</span> : null}
                  {tabActions}
                  {inspector ? (
                    <IconButton size="sm" label={inspectorOpen ? t("shared.resourceOverlay.hideDetails") : t("shared.resourceOverlay.showDetails")} active={inspectorOpen} onClick={toggleInspector}>
                      {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
                    </IconButton>
                  ) : null}
                </div>
              </div>
              <div className="min-h-0 flex-1">{children}</div>
            </section>
            {inspectorOpen ? <aside className="min-h-0 overflow-y-auto">{inspector}</aside> : null}
          </div>
        </>
      )}
    </Overlay>
  );
}
