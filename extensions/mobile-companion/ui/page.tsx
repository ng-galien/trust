import type { ExtensionPageProps } from "@trust/extension-sdk";
import { useCallback, useEffect, useState } from "react";
import { ConversationList, ConversationTimeline } from "./conversations";
import { words } from "./copy";
import { ItemDetail } from "./detail";
import { EmbeddedContent } from "./embedded-content";
import { MobileNavigation } from "./navigation";
import { useMobileUi } from "./store";
import { SubjectView } from "./subject-view";
import { useMobileData } from "./use-mobile-data";
import { useNotifications } from "./use-notifications";
import { usePreviewReload } from "./use-preview-reload";
import "./style.css";

type RouteChange = Partial<Record<"project" | "item" | "version" | "app" | "reader" | "subject", string | null>>;

export default function MobileCompanion({ apiBase, trustBase, eventsUrl, language, navigation }: ExtensionPageProps) {
  const locale = window.location.pathname.startsWith("/mobile/") ? "fr" : language;
  const t = locale.toLowerCase().startsWith("fr") ? words.fr : words.en;
  const demo = import.meta.env.VITE_MOBILE_PREVIEW === "1";
  const route = useMobileUi((state) => state.route);
  const setRoute = useMobileUi((state) => state.setRoute);
  const theme = useMobileUi((state) => state.theme);
  const accent = useMobileUi((state) => state.accent);
  const railOpen = useMobileUi((state) => state.railOpen);
  const search = navigation?.search ?? window.location.search;
  const { project, item: itemId, version, app, reader, subject } = route;
  const requestedVersion = version && /^[1-9]\d*$/.test(version) ? Number(version) : undefined;
  const data = useMobileData(apiBase, eventsUrl, project, itemId, requestedVersion);
  const notifications = useNotifications(apiBase, data.setError);
  const updatePending = usePreviewReload(apiBase, demo);
  const [sending, setSending] = useState(false);
  const [undoProject, setUndoProject] = useState<string | null>(null);

  useEffect(() => {
    if (!undoProject) return;
    const timer = window.setTimeout(() => setUndoProject(null), 10000);
    return () => window.clearTimeout(timer);
  }, [undoProject]);

  useEffect(() => {
    (window as Window & { __trustMobileReport?: (stage: string, code: string) => void }).__trustMobileReport?.(
      "react",
      "mounted",
    );
  }, []);

  useEffect(() => setRoute(search), [search, setRoute]);
  useEffect(() => {
    if (navigation) return;
    const restore = () => setRoute(window.location.search);
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [navigation, setRoute]);

  const move = useCallback(
    (changes: RouteChange) => {
      const next = new URLSearchParams();
      for (const key of ["project", "item", "version", "app", "subject"] as const) {
        if (route[key]) next.set(key, route[key]);
      }
      if (route.reader) next.set("reader", "1");
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const query = next.toString();
      const href = `${window.location.pathname}${query ? `?${query}` : ""}`;
      setRoute(query);
      if (navigation) navigation.navigate(href);
      else window.history.pushState(null, "", href);
      window.scrollTo({ top: 0, behavior: "auto" });
    },
    [navigation, route, setRoute],
  );

  const selectProject = (id: string | null) =>
    move({ project: id, item: null, version: null, app: null, reader: null, subject: null });
  const selectApp = (id: string) =>
    move({ project: id, item: null, version: null, app: id, reader: null, subject: null });
  const back = () => {
    if (reader) move({ reader: null });
    else if (app) move({ app: null });
    else if (version && data.item?.article) move({ item: data.item.id, version: null });
    else if (itemId) move({ project: data.item?.project ?? project, item: null, version: null });
    else if (subject) move({ subject: null });
    else selectProject(null);
  };

  const selectedProject = data.projects.find((entry) => entry.id === (data.item?.project ?? project));
  const selectedApp = data.projects.find((entry) => entry.id === app);
  const embeddedUrl = reader ? data.item?.documentUrl : selectedApp?.route;
  const commandUrl = `${apiBase.replace(/\/api$/, "")}/commands`;
  const conversationCommand = async (command: string, args: Record<string, unknown>) => {
    data.setError("");
    try {
      const response = await fetch(commandUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, arguments: args }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(failure?.error ?? `Request failed (${response.status})`);
      }
      await data.refresh(true);
      return true;
    } catch (cause) {
      data.setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  const deleteConversation = async (id: string) => {
    if (await conversationCommand("conversations.delete", { project: id })) setUndoProject(id);
  };
  const restoreConversation = async () => {
    if (!undoProject) return;
    if (await conversationCommand("conversations.restore", { project: undoProject })) setUndoProject(null);
  };
  const submit = async (answers: Record<string, string | boolean | number>) => {
    if (!data.item || sending) return;
    setSending(true);
    data.setError("");
    try {
      const response = await fetch(commandUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "responses.submit",
          arguments: { item: data.item.id, expectedRevision: 0, answers },
        }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          response.status === 409 ? t.changed : (failure?.error ?? `Request failed (${response.status})`),
        );
      }
      await data.refresh(true);
    } catch (cause) {
      data.setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="mobile-companion" data-theme={theme} data-accent={accent}>
      <div className="mobile-frame" data-rail-open={railOpen}>
        <MobileNavigation
          projects={data.projects}
          project={project}
          item={itemId}
          app={app}
          reader={reader}
          subject={subject}
          t={t}
          pushStatus={notifications.pushStatus}
          notificationState={notifications.notificationState}
          changingNotifications={notifications.changingNotifications}
          onSelectProject={selectProject}
          onSelectApp={selectApp}
          onBack={back}
          onToggleNotifications={() => void notifications.toggleNotifications()}
        />
        <div className="mobile-main">
          {data.error && (
            <div role="alert" className="mobile-error">
              {data.error}{" "}
              <button type="button" onClick={() => void data.refresh()}>
                {t.retry}
              </button>
            </div>
          )}
          {updatePending && (
            <p role="status" className="mobile-update-pending">
              {t.updatePending}
            </p>
          )}
          {undoProject && !project && !itemId && (
            <div role="status" className="mobile-undo">
              <span>{t.conversationDeleted}</span>
              <button type="button" onClick={() => void restoreConversation()}>
                {t.undo}
              </button>
            </div>
          )}
          {data.loading && (
            <p role="status" className="mobile-loading">
              {t.loading}
            </p>
          )}
          {reader || app ? (
            embeddedUrl?.startsWith("/mobile/") ? (
              <EmbeddedContent
                url={embeddedUrl}
                title={reader ? (data.item?.title ?? t.document) : (selectedApp?.title ?? t.apps)}
                reader={reader}
                french={locale.startsWith("fr")}
              />
            ) : (
              !data.loading && <p className="mobile-empty">{t.unavailable}</p>
            )
          ) : itemId ? (
            data.item && (
              <ItemDetail
                key={data.item.id}
                item={data.item}
                projectTitle={selectedProject?.title ?? data.item.project}
                locale={locale}
                t={t}
                sending={sending}
                demo={demo}
                trustBase={trustBase}
                eventsUrl={eventsUrl}
                onOpenDocument={() => move({ reader: "1" })}
                onOpenRevision={() => move({ item: data.item?.supersedes ?? null })}
                onOpenVersion={(next) =>
                  move({ item: data.item?.id ?? itemId, version: next === null ? null : String(next) })
                }
                onSubmit={(answers) => void submit(answers)}
              />
            )
          ) : subject && data.subjects.find((entry) => entry.id === subject) ? (
            <SubjectView
              subject={data.subjects.find((entry) => entry.id === subject)!}
              apiBase={apiBase}
              trustBase={trustBase}
              eventsUrl={eventsUrl}
              onOpenItem={(id) => move({ item: id, version: null })}
            />
          ) : project ? (
            selectedProject && (
              <ConversationTimeline
                project={selectedProject}
                feed={data.feed}
                subjects={data.subjects}
                subjectError={data.subjectError}
                nextCursor={data.nextCursor}
                loading={data.loading}
                locale={locale}
                t={t}
                demo={demo}
                onOpenItem={(id) => move({ item: id, version: null })}
                onOpenApp={() => move({ app: selectedProject.id, item: null, reader: null })}
                onOpenSubject={(id) => move({ subject: id })}
                onLoadOlder={() => void data.loadOlder()}
              />
            )
          ) : (
            <ConversationList
              projects={data.projects}
              conversations={data.conversations}
              latest={data.latest}
              loading={data.loading}
              locale={locale}
              t={t}
              demo={demo}
              onSelect={(id) => selectProject(id)}
              onPin={(id, pinned) => void conversationCommand("conversations.pin", { project: id, pinned })}
              onDelete={(id) => void deleteConversation(id)}
            />
          )}
        </div>
      </div>
    </main>
  );
}
