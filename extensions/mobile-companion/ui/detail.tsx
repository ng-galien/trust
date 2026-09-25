import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { DelegationEpisode } from "./delegation-episode";
import { kindLabel } from "./labels";
import { MarkdownBody } from "./markdown-body";
import { useMobileUi } from "./store";
import type { Copy, Field, Item, Layout } from "./types";

type Answers = Record<string, string | boolean | number>;
type Section = { id: string; title: string };

function ResponseForm({
  item,
  locale,
  t,
  sending,
  onSubmit,
}: {
  item: Item;
  locale: string;
  t: Copy;
  sending: boolean;
  onSubmit(answers: Answers): void;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const setDraftDirty = useMobileUi((state) => state.setDraftDirty);
  useEffect(() => () => setDraftDirty(false), [setDraftDirty]);
  if (!item.form) return null;
  const update = (field: string, value: string | boolean | number) => {
    setAnswers((current) => ({ ...current, [field]: value }));
    setDraftDirty(true);
  };

  const fieldControl = (field: Field) => (
    <div className="mobile-field" key={field.id}>
      <label htmlFor={field.id}>
        {field.label} {field.required && <small>{t.required}</small>}
      </label>
      {field.type === "multiline" ? (
        <textarea
          id={field.id}
          required={field.required}
          value={String(answers[field.id] ?? "")}
          maxLength={8000}
          onChange={(event) => update(field.id, event.target.value)}
        />
      ) : field.type === "choice" ? (
        <select
          id={field.id}
          required={field.required}
          value={String(answers[field.id] ?? "")}
          onChange={(event) => update(field.id, event.target.value)}
        >
          <option value="" />
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.type === "boolean" ? (
        <select
          id={field.id}
          required={field.required}
          value={answers[field.id] === undefined ? "" : String(answers[field.id])}
          onChange={(event) => update(field.id, event.target.value === "true")}
        >
          <option value="" />
          <option value="true">{locale.startsWith("fr") ? "Oui" : "Yes"}</option>
          <option value="false">{locale.startsWith("fr") ? "Non" : "No"}</option>
        </select>
      ) : field.type === "number" ? (
        <input
          id={field.id}
          type="number"
          step="any"
          required={field.required}
          min={field.minimum}
          max={field.maximum}
          value={String(answers[field.id] ?? "")}
          onChange={(event) => update(field.id, event.target.value === "" ? "" : Number(event.target.value))}
        />
      ) : (
        <input
          id={field.id}
          required={field.required}
          value={String(answers[field.id] ?? "")}
          maxLength={8000}
          onChange={(event) => update(field.id, event.target.value)}
        />
      )}
    </div>
  );

  const layoutControls = (layout: Layout, fields: Field[]): ReactNode => {
    if (layout.type === "Control") {
      const field = fields.find((entry) => `#/properties/${entry.id}` === layout.scope);
      return field ? fieldControl(field) : null;
    }
    return (
      <div className={layout.type === "HorizontalLayout" ? "mobile-layout-horizontal" : "mobile-layout-vertical"}>
        {layout.label && <h3>{layout.label}</h3>}
        {layout.elements.map((element) => (
          <div key={JSON.stringify(element)}>{layoutControls(element, fields)}</div>
        ))}
      </div>
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(answers);
  };
  return (
    <form onSubmit={submit}>
      {item.form.uiSchema ? layoutControls(item.form.uiSchema, item.form.fields) : item.form.fields.map(fieldControl)}
      <button className="mobile-primary" type="submit" disabled={sending}>
        {sending ? t.loading : t.submit}
      </button>
    </form>
  );
}

export function ItemDetail({
  item,
  projectTitle,
  locale,
  t,
  sending,
  demo,
  onOpenDocument,
  onOpenRevision,
  onOpenVersion,
  onSubmit,
  trustBase,
  eventsUrl,
}: {
  item: Item;
  projectTitle: string;
  locale: string;
  t: Copy;
  sending: boolean;
  demo: boolean;
  onOpenDocument(): void;
  onOpenRevision(): void;
  onOpenVersion(version: number | null): void;
  onSubmit(answers: Answers): void;
  trustBase: string;
  eventsUrl: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDetailsElement>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [activeSection, setActiveSection] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The outline reads rendered headings and must refresh when article content or revision changes.
  useEffect(() => {
    const headings = Array.from(bodyRef.current?.querySelectorAll<HTMLHeadingElement>("h2, h3, h4, h5, h6") ?? []);
    setSections(
      headings
        .filter((heading) => heading.id)
        .map((heading) => ({ id: heading.id, title: heading.textContent?.trim() ?? "" })),
    );
    setActiveSection(0);
    if (headings.length < 2) return;
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const currentHeadings = Array.from(
          bodyRef.current?.querySelectorAll<HTMLHeadingElement>("h2, h3, h4, h5, h6") ?? [],
        );
        const current = currentHeadings.reduce(
          (last, heading, index) => (heading.getBoundingClientRect().top <= 145 ? index : last),
          0,
        );
        setActiveSection(current);
      });
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.cancelAnimationFrame(frame);
    };
  }, [item.id, item.body, item.article?.version]);
  const openSection = (id: string, index: number) => {
    outlineRef.current?.removeAttribute("open");
    setActiveSection(index);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(item.createdAt),
  );
  const contextFirst = Boolean(item.plan && item.kind === "progress");
  const publishedContent = (
    <>
      {sections.length >= 2 && (
        <details className="mobile-reading-outline" ref={outlineRef}>
          <summary>
            <span>{locale.startsWith("fr") ? "Dans cet article" : "In this article"}</span>
            <strong>{sections[activeSection]?.title}</strong>
            <span>
              {activeSection + 1} / {sections.length}
            </span>
          </summary>
          <nav aria-label={locale.startsWith("fr") ? "Sections de l’article" : "Article sections"}>
            {sections.map((section, index) => (
              <button
                key={section.id}
                type="button"
                aria-current={index === activeSection ? "location" : undefined}
                onClick={() => openSection(section.id, index)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                {section.title}
              </button>
            ))}
          </nav>
        </details>
      )}
      {contextFirst && (
        <h2 className="mobile-item-body-heading">
          {locale.startsWith("fr") ? "Contexte et compte rendu publié" : "Published context and work note"}
        </h2>
      )}
      <MarkdownBody source={item.body} locale={locale} title={item.title} sectionPrefix={item.id} bodyRef={bodyRef} />
    </>
  );
  return (
    <article className="mobile-detail" data-kind={item.kind}>
      <p className="mobile-kicker">
        {projectTitle} <span aria-hidden="true">/</span> {kindLabel(item.kind, locale)}
        {demo ? " · Démonstration" : ""}
      </p>
      <h1>{item.title}</h1>
      <time dateTime={item.createdAt}>{date}</time>
      {item.article && item.article.latestVersion > 1 && (
        <section className="mobile-article-history" aria-label={t.articleHistory}>
          <p>
            {item.article.version === item.article.latestVersion ? t.currentVersion : t.historicalVersion}
            {` ${item.article.version}/${item.article.latestVersion}`}
          </p>
          <details>
            <summary>{t.articleHistory}</summary>
            <ol>
              {item.article.history.map((entry) => (
                <li key={entry.version}>
                  <button
                    type="button"
                    aria-current={entry.version === item.article?.version ? "true" : undefined}
                    onClick={() => onOpenVersion(entry.version === item.article?.latestVersion ? null : entry.version)}
                  >
                    {entry.version}. {entry.title}
                  </button>
                  <small>
                    {entry.author} ·{" "}
                    {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(entry.publishedAt))}
                  </small>
                  <small>{entry.reason}</small>
                </li>
              ))}
            </ol>
          </details>
          {item.article.version < item.article.latestVersion && (
            <button type="button" className="mobile-revision-link" onClick={() => onOpenVersion(null)}>
              {t.currentVersion} ↗
            </button>
          )}
        </section>
      )}
      {item.plan && (
        <p className="mobile-summary-caption">{locale.startsWith("fr") ? "Résumé publié" : "Published summary"}</p>
      )}
      <p className="mobile-lead">{item.summary}</p>
      {(item.plan || item.documentUrl) && (
        <nav
          className="mobile-item-links"
          aria-label={locale.startsWith("fr") ? "Contenu lié à cet épisode" : "Linked episode content"}
        >
          <span>{locale.startsWith("fr") ? "Dans cet épisode" : "In this episode"}</span>
          {item.plan && (
            <button
              type="button"
              onClick={() =>
                document.getElementById("mobile-episode-plan")?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              {locale.startsWith("fr") ? "État actuel et étapes" : "Current status and steps"}{" "}
              <span aria-hidden="true">↓</span>
            </button>
          )}
          {item.documentUrl && (
            <button type="button" onClick={onOpenDocument}>
              {t.document} <span aria-hidden="true">↗</span>
            </button>
          )}
        </nav>
      )}
      {contextFirst && publishedContent}
      <DelegationEpisode item={item} trustBase={trustBase} eventsUrl={eventsUrl} locale={locale} />
      {item.supersedes && (
        <button className="mobile-revision-link" type="button" onClick={onOpenRevision}>
          {t.previousVersion} ↗
        </button>
      )}
      {!contextFirst && publishedContent}
      {item.documentUrl && (
        <button className="mobile-primary" type="button" onClick={onOpenDocument}>
          {locale.startsWith("fr") ? "Ouvrir le lecteur" : "Open reader"} <span aria-hidden="true">↗</span>
        </button>
      )}
      {item.form && (
        <section className="mobile-answer">
          <h2>{t.answer}</h2>
          {item.response ? (
            <div className="mobile-sent">
              <strong>{t.sent}</strong>
              <dl>
                {item.form.fields.map((field) => (
                  <div key={field.id}>
                    <dt>{field.label}</dt>
                    <dd>{String(item.response?.answers[field.id] ?? "—")}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <ResponseForm key={item.id} item={item} locale={locale} t={t} sending={sending} onSubmit={onSubmit} />
          )}
        </section>
      )}
    </article>
  );
}
