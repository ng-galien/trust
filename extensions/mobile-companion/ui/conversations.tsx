import { ConversationRow } from "./conversation-row";
import { kindLabel, statusLabel } from "./labels";
import type { Conversation, Copy, Project, Subject, Summary } from "./types";

const time = (locale: string, value: string) =>
  new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(value));

export function ConversationList({
  projects,
  conversations,
  latest,
  loading,
  locale,
  t,
  demo,
  onSelect,
  onPin,
  onDelete,
}: {
  projects: Project[];
  conversations: Conversation[];
  latest: Record<string, Summary | null>;
  loading: boolean;
  locale: string;
  t: Copy;
  demo: boolean;
  onSelect(id: string): void;
  onPin(id: string, pinned: boolean): void;
  onDelete(id: string): void;
}) {
  const state = new Map(conversations.map((conversation) => [conversation.project, conversation]));
  const ordered = projects
    .filter((entry) => state.has(entry.id))
    .sort(
      (a, b) =>
        Number(state.get(b.id)?.pinned) - Number(state.get(a.id)?.pinned) ||
        (latest[b.id]?.createdAt ?? "").localeCompare(latest[a.id]?.createdAt ?? ""),
    );
  return (
    <>
      <section className="mobile-home-heading">
        <p className="mobile-kicker">TRUST{demo ? " · Démonstration" : ""}</p>
        <h1>{t.conversations}</h1>
        <p>{t.conversationHint}</p>
      </section>
      <nav className="mobile-conversation-list" aria-label={t.conversations}>
        {ordered.map((entry) => {
          const preview = latest[entry.id] ?? null;
          return (
            <ConversationRow
              key={entry.id}
              entry={entry}
              preview={preview}
              pinned={state.get(entry.id)?.pinned ?? false}
              locale={locale}
              t={t}
              onSelect={() => onSelect(entry.id)}
              onPin={() => onPin(entry.id, !(state.get(entry.id)?.pinned ?? false))}
              onDelete={() => onDelete(entry.id)}
            />
          );
        })}
        {!loading && ordered.length === 0 && <p className="mobile-empty">{t.emptyConversation}</p>}
      </nav>
    </>
  );
}

export function ConversationTimeline({
  project,
  feed,
  subjects,
  subjectError,
  nextCursor,
  loading,
  locale,
  t,
  demo,
  onOpenItem,
  onOpenApp,
  onOpenSubject,
  onLoadOlder,
}: {
  project: Project;
  feed: Summary[];
  subjects: Subject[];
  subjectError: string;
  nextCursor: string | null;
  loading: boolean;
  locale: string;
  t: Copy;
  demo: boolean;
  onOpenItem(id: string): void;
  onOpenApp(): void;
  onOpenSubject(id: string): void;
  onLoadOlder(): void;
}) {
  const superseded = new Set(feed.flatMap((entry) => (entry.supersedes ? [entry.supersedes] : [])));
  const visibleFeed = feed.filter((entry) => !superseded.has(entry.id));
  const days: { key: string; label: string; entries: Summary[] }[] = [];
  for (const entry of visibleFeed) {
    const key = new Date(entry.createdAt).toDateString();
    let day = days.at(-1);
    if (day?.key !== key) {
      day = {
        key,
        label: new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(new Date(entry.createdAt)),
        entries: [],
      };
      days.push(day);
    }
    day.entries.push(entry);
  }
  return (
    <>
      <section className="mobile-conversation-heading">
        <p className="mobile-kicker">
          {t.channel}
          {demo ? " · Démonstration" : ""}
        </p>
        <h1>{project.title}</h1>
        {project.description && <p>{project.description}</p>}
        <div className="mobile-conversation-meta">
          <span>{statusLabel(project.status, locale)}</span>
          {subjects.map((subject) => (
            <button type="button" key={subject.id} onClick={() => onOpenSubject(subject.id)}>
              {subject.title} →
            </button>
          ))}
          {project.route?.startsWith("/mobile/apps/") && (
            <button type="button" onClick={onOpenApp}>
              {t.open} ↗
            </button>
          )}
        </div>
        {subjectError && <p role="status">Sujets indisponibles · {subjectError}</p>}
      </section>
      <section className="mobile-thread" aria-label={t.feed}>
        <h2>{t.feed}</h2>
        {!loading && visibleFeed.length === 0 && <p className="mobile-empty">{t.empty}</p>}
        {days.map((day) => (
          <div className="mobile-day" key={day.key}>
            <h3>{day.label}</h3>
            <div className="mobile-day-entries">
              {day.entries.map((entry) => (
                <button type="button" className="mobile-entry" key={entry.id} onClick={() => onOpenItem(entry.id)}>
                  <span className="mobile-entry-marker" aria-hidden="true" />
                  <span className="mobile-entry-content">
                    <span className="mobile-entry-meta">
                      <span>{kindLabel(entry.kind, locale)}</span>
                      <time dateTime={entry.createdAt}>{time(locale, entry.createdAt)}</time>
                    </span>
                    <strong>{entry.title}</strong>
                    <span className="mobile-summary">{entry.summary}</span>
                    {(entry.plan || entry.documentUrl) && (
                      <span className="mobile-entry-links">
                        {entry.plan && <span>{locale.startsWith("fr") ? "Plan suivi" : "Tracked Plan"}</span>}
                        {entry.documentUrl && (
                          <span>{locale.startsWith("fr") ? "Document lié" : "Linked document"}</span>
                        )}
                      </span>
                    )}
                    <span className="mobile-entry-action">
                      {entry.answered ? t.sent : entry.hasForm ? t.answer : t.read}
                      <span aria-hidden="true">→</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {nextCursor && (
          <button className="mobile-more" type="button" onClick={onLoadOlder}>
            {t.more}
          </button>
        )}
      </section>
    </>
  );
}
