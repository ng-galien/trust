import { useEffect, useRef } from "react";
import { useMobileUi } from "./store";
import type { Copy, Project, PushStatus } from "./types";

export function MobileNavigation({
  projects,
  project,
  item,
  app,
  reader,
  subject,
  t,
  pushStatus,
  notificationState,
  changingNotifications,
  onSelectProject,
  onSelectApp,
  onBack,
  onToggleNotifications,
}: {
  projects: Project[];
  project: string | null;
  item: string | null;
  app: string | null;
  reader: boolean;
  subject: string | null;
  t: Copy;
  pushStatus: PushStatus | null;
  notificationState: "off" | "on" | "blocked" | "unsupported";
  changingNotifications: boolean;
  onSelectProject(id: string | null): void;
  onSelectApp(id: string): void;
  onBack(): void;
  onToggleNotifications(): void;
}) {
  const open = useMobileUi((state) => state.menuOpen);
  const openMenu = useMobileUi((state) => state.openMenu);
  const closeMenu = useMobileUi((state) => state.closeMenu);
  const railOpen = useMobileUi((state) => state.railOpen);
  const toggleRail = useMobileUi((state) => state.toggleRail);
  const theme = useMobileUi((state) => state.theme);
  const accent = useMobileUi((state) => state.accent);
  const setTheme = useMobileUi((state) => state.setTheme);
  const setAccent = useMobileUi((state) => state.setAccent);
  const drawer = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const projectTitle = projects.find((entry) => entry.id === project)?.title;
  const appTitle = projects.find((entry) => entry.id === app)?.title;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
      if (event.key !== "Tab" || !drawer.current) return;
      const focusable = [...drawer.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first && last) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last && first) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = priorOverflow;
      previous?.focus();
    };
  }, [open, closeMenu]);

  const backLabel = reader ? t.backToItem : app ? (project ? t.back : t.backToList) : item ? t.back : t.backToList;
  const title = reader
    ? t.document
    : app
      ? appTitle
      : item && subject
        ? "Sujet"
        : item
          ? projectTitle
          : subject
            ? projectTitle
            : t.conversations;
  return (
    <>
      <header className="mobile-header">
        {reader || app || item || project || subject ? (
          <button type="button" className="mobile-back" onClick={onBack} aria-label={backLabel}>
            <span aria-hidden="true">←</span>
            <span>{title}</span>
          </button>
        ) : (
          <div className="mobile-brand">
            <span className="mobile-mark">T</span>
            <span>TRUST</span>
          </div>
        )}
        <div className="mobile-header-actions">
          <button
            type="button"
            className="mobile-rail-toggle"
            onClick={toggleRail}
            aria-label={railOpen ? t.hideRail : t.showRail}
            aria-expanded={railOpen}
            aria-controls="mobile-conversations-panel"
          >
            <span className="mobile-rail-icon" aria-hidden="true" />
          </button>
          <button type="button" className="mobile-menu-button" onClick={openMenu} aria-label={t.menu}>
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
        </div>
      </header>
      <aside
        id="mobile-conversations-panel"
        className="mobile-wide-rail"
        aria-label={t.conversations}
        hidden={!railOpen}
      >
        <div className="mobile-wide-rail-title">{t.conversations}</div>
        <nav aria-label={t.conversations}>
          <button type="button" className={!project && !app ? "selected" : ""} onClick={() => onSelectProject(null)}>
            {t.all}
          </button>
          {projects.map((entry) => (
            <div className="mobile-nav-project" key={entry.id}>
              <button
                type="button"
                className={project === entry.id && !app ? "selected" : ""}
                onClick={() => onSelectProject(entry.id)}
              >
                {entry.title}
              </button>
              {project === entry.id && entry.route?.startsWith("/mobile/apps/") && (
                <button
                  type="button"
                  className={`mobile-nav-app ${app === entry.id ? "selected" : ""}`}
                  onClick={() => onSelectApp(entry.id)}
                >
                  {t.open} ↗
                </button>
              )}
            </div>
          ))}
        </nav>
      </aside>
      {open && (
        <div className="mobile-menu-layer">
          <button className="mobile-menu-scrim" type="button" aria-label={t.closeMenu} onClick={closeMenu} />
          <aside ref={drawer} className="mobile-drawer" role="dialog" aria-modal="true" aria-label={t.menu}>
            <div className="mobile-drawer-heading">
              <div>
                <span>TRUST</span>
                <strong>{t.conversations}</strong>
              </div>
              <button ref={closeButton} type="button" onClick={closeMenu} aria-label={t.closeMenu}>
                ×
              </button>
            </div>
            <nav aria-label={t.conversations} className="mobile-drawer-nav">
              <button
                type="button"
                className={!project && !app ? "selected" : ""}
                onClick={() => onSelectProject(null)}
              >
                <span className="mobile-drawer-symbol" aria-hidden="true">
                  ≡
                </span>
                {t.all}
              </button>
              {projects.map((entry) => (
                <div className="mobile-nav-project" key={entry.id}>
                  <button
                    type="button"
                    className={project === entry.id && !app ? "selected" : ""}
                    onClick={() => onSelectProject(entry.id)}
                  >
                    <span className="mobile-drawer-symbol" aria-hidden="true">
                      {entry.title.slice(0, 1).toUpperCase()}
                    </span>
                    {entry.title}
                  </button>
                  {project === entry.id && entry.route?.startsWith("/mobile/apps/") && (
                    <button
                      type="button"
                      className={`mobile-nav-app ${app === entry.id ? "selected" : ""}`}
                      onClick={() => onSelectApp(entry.id)}
                    >
                      <span className="mobile-drawer-symbol" aria-hidden="true">
                        ↗
                      </span>
                      {t.open}
                    </button>
                  )}
                </div>
              ))}
            </nav>
            <section className="mobile-appearance" aria-label={t.appearance}>
              <h2>{t.appearance}</h2>
              <fieldset className="mobile-appearance-choices" aria-label={t.appearance}>
                <button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
                  {t.light}
                </button>
                <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
                  {t.dark}
                </button>
              </fieldset>
              <h3>{t.accent}</h3>
              <fieldset className="mobile-appearance-choices" aria-label={t.accent}>
                <button type="button" aria-pressed={accent === "blue"} onClick={() => setAccent("blue")}>
                  {t.blue}
                </button>
                <button type="button" aria-pressed={accent === "violet"} onClick={() => setAccent("violet")}>
                  {t.violet}
                </button>
              </fieldset>
            </section>
            {pushStatus?.enabled && (
              <section className="mobile-notifications" aria-label={t.notifications}>
                <div>
                  <strong>{t.notifications}</strong>
                  <p>{t.notificationHelp}</p>
                </div>
                {notificationState === "off" || notificationState === "on" ? (
                  <button type="button" disabled={changingNotifications} onClick={onToggleNotifications}>
                    {notificationState === "on" ? t.notificationOn : t.notificationOff}
                  </button>
                ) : (
                  <small>{notificationState === "blocked" ? t.notificationBlocked : t.notificationUnsupported}</small>
                )}
              </section>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
