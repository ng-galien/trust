import { useCallback, useEffect, useRef, useState } from "react";
import { readConversations, readFeed, readItem, readProjects, readSubjects } from "./api";
import { useMobileUi } from "./store";
import type { Conversation, Item, Project, Subject, Summary } from "./types";

export function useMobileData(
  apiBase: string,
  eventsUrl: string,
  project: string | null,
  itemId: string | null,
  version: number | undefined,
) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subjectError, setSubjectError] = useState("");
  const [latest, setLatest] = useState<Record<string, Summary | null>>({});
  const [feed, setFeed] = useState<Summary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const feedRef = useRef<Summary[]>([]);

  const refresh = useCallback(
    async (silent = false) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      if (!silent) setLoading(true);
      try {
        const [catalog, visibleConversations] = await Promise.all([
          readProjects(apiBase, controller.signal),
          readConversations(apiBase, controller.signal),
        ]);
        const [stream, detail, previews, subjectList] = await Promise.all([
          project ? readFeed(apiBase, { project }, controller.signal) : Promise.resolve(null),
          itemId ? readItem(apiBase, itemId, version, controller.signal) : Promise.resolve(null),
          !project && !itemId
            ? Promise.all(
                catalog.map(async (entry) => {
                  if (!visibleConversations.some((conversation) => conversation.project === entry.id))
                    return [entry.id, null] as const;
                  const result = await readFeed(apiBase, { project: entry.id, limit: 1 }, controller.signal);
                  return [entry.id, result.items[0] ?? null] as const;
                }),
              )
            : Promise.resolve(null),
          project
            ? readSubjects(apiBase, project, controller.signal)
                .then((subjects) => ({ subjects, error: "" }))
                .catch((cause: unknown) => ({
                  subjects: [] as Subject[],
                  error: cause instanceof Error ? cause.message : String(cause),
                }))
            : Promise.resolve(null),
        ]);
        if (stream && silent && project) {
          const oldestLoaded = feedRef.current.at(-1)?.id;
          while (oldestLoaded && !stream.items.some((entry) => entry.id === oldestLoaded) && stream.nextCursor) {
            const older = await readFeed(apiBase, { project, before: stream.nextCursor }, controller.signal);
            stream.items.push(...older.items);
            stream.nextCursor = older.nextCursor;
          }
        }
        if (controller.signal.aborted) return;
        setProjects(catalog);
        setConversations(visibleConversations);
        setSubjects(subjectList?.subjects ?? []);
        setSubjectError(subjectList?.error ?? "");
        if (stream) {
          feedRef.current = stream.items;
          setFeed(stream.items);
          setNextCursor(stream.nextCursor);
        } else {
          feedRef.current = [];
          setFeed([]);
          setNextCursor(null);
        }
        setItem(detail);
        if (previews) setLatest(Object.fromEntries(previews));
        setError("");
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (request.current === controller) setLoading(false);
      }
    },
    [apiBase, project, itemId, version],
  );

  useEffect(() => {
    setItem(null);
    feedRef.current = [];
    setFeed([]);
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);

  useEffect(() => {
    const events = new EventSource(eventsUrl);
    events.addEventListener("change", () => void refresh(true));
    const visible = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      events.close();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [eventsUrl, refresh]);

  const loadOlder = useCallback(async () => {
    if (!project || !nextCursor) return;
    const current = request.current;
    try {
      const older = await readFeed(apiBase, { project, before: nextCursor });
      if (current !== request.current || useMobileUi.getState().route.project !== project) return;
      const seen = new Set(feedRef.current.map((entry) => entry.id));
      const merged = [...feedRef.current, ...older.items.filter((entry) => !seen.has(entry.id))];
      feedRef.current = merged;
      setFeed(merged);
      setNextCursor(older.nextCursor);
    } catch (cause) {
      if (current === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [apiBase, project, nextCursor]);

  return {
    projects,
    conversations,
    subjects,
    subjectError,
    latest,
    feed,
    nextCursor,
    item,
    loading,
    error,
    setError,
    refresh,
    loadOlder,
  };
}
