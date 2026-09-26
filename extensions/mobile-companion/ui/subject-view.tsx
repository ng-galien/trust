import { useEffect, useState } from "react";
import { useMobileApi } from "./transport";
import type { Item, Subject, SubjectLink } from "./types";
import { useDelegationEpisode } from "./use-delegation-episode";

function matches(item: Item, subject: Subject, link: SubjectLink) {
  if (item.project !== subject.project) return false;
  switch (link.kind) {
    case "article":
      return item.article?.id === link.targetIdentity;
    case "document":
      return item.documentUrl === link.targetIdentity;
    case "plan":
      return item.plan === link.targetIdentity;
    case "decision":
      return item.kind === "decision" && item.response !== null && item.id === link.targetIdentity;
  }
}

export function SubjectView({
  subject,
  apiBase,
  trustBase,
  eventsUrl,
  onOpenItem,
}: {
  subject: Subject;
  apiBase: string;
  trustBase: string;
  eventsUrl: string;
  onOpenItem(id: string): void;
}) {
  const { readItem } = useMobileApi();
  const [sources, setSources] = useState<Record<string, Item | null>>({});
  const [loading, setLoading] = useState(true);
  const planIdentity = subject.links.find((link) => link.kind === "plan")?.targetIdentity ?? null;
  const { episode, error: episodeError } = useDelegationEpisode(trustBase, eventsUrl, planIdentity);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Subject identity and revision are the immutable contract for changes to its links; polling recreates arrays.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.all(
      subject.links.map(async (link) => {
        try {
          return [link.id, await readItem(apiBase, link.item, undefined, controller.signal)] as const;
        } catch {
          return [link.id, null] as const;
        }
      }),
    ).then((entries) => {
      if (!controller.signal.aborted) {
        setSources(Object.fromEntries(entries));
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [apiBase, subject.id, subject.revision, readItem]);

  const plan = episode?.root.plan;
  const children = episode?.branches.filter((branch) => branch.child) ?? [];
  const results = plan?.importedResults ?? [];
  const decisionLinks = subject.links.filter(
    (link) => link.kind === "decision" && sources[link.id] && matches(sources[link.id]!, subject, link),
  );
  return (
    <div className="mobile-subject" data-subject={subject.id}>
      <header className="mobile-subject-header">
        <p className="mobile-kicker">SUJET DURABLE · TRUST</p>
        <h1>{subject.title}</h1>
        <p>{subject.description}</p>
        <small>
          Identité · {subject.id} · révision {subject.revision}
        </small>
      </header>
      <section className="mobile-subject-links" aria-label="Sources liées">
        <div className="mobile-subject-section-heading">
          <h2>Sources liées</h2>
          <span>{subject.links.length} liens explicites</span>
        </div>
        <ol>
          {subject.links.map((link, index) => {
            const source = sources[link.id];
            const valid = source && matches(source, subject, link);
            return (
              <li key={link.id}>
                <span className="mobile-subject-number">{String(index + 1).padStart(2, "0")}</span>
                <div className="mobile-subject-link-copy">
                  <span className="mobile-subject-relation">{link.relation}</span>
                  <h3>{valid ? source.title : link.description}</h3>
                  <p>{link.description}</p>
                  <small>
                    {loading
                      ? "Vérification de la source…"
                      : valid
                        ? `Source vérifiée · ${link.kind === "plan" ? "Plan TRUST" : link.kind === "document" ? "Maket" : link.kind === "decision" ? "Réponse enregistrée" : `article v${source.article?.version}`}`
                        : "Source indisponible ou identité non concordante"}
                  </small>
                  <small>Identité source · {link.targetIdentity}</small>
                  <small>Provenance du lien · {link.provenance}</small>
                  {valid && (
                    <button type="button" onClick={() => onOpenItem(link.item)}>
                      Ouvrir la source <span aria-hidden="true">→</span>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
      {planIdentity && (
        <section className="mobile-subject-execution" aria-label="Exécution TRUST">
          <div className="mobile-subject-section-heading">
            <h2>Exécution TRUST</h2>
            <span>Données du Plan</span>
          </div>
          {plan ? (
            <>
              <p>
                <strong>{plan.metadata.title || plan.plan}</strong> ·{" "}
                {plan.workState === "COMPLETE" ? "Terminé" : "En cours"}
              </p>
              <p>
                {children.length}/{episode?.branches.length ?? 0} missions engagées · {results.length} résultats
                importés
              </p>
              <ol>
                {episode?.branches.map(({ invocation, child }) => (
                  <li key={invocation.id}>
                    <strong>{invocation.mission?.id ?? invocation.name}</strong>
                    <span>
                      {child?.plan.workState ?? invocation.state} ·{" "}
                      {child?.checks.filter((check) => check.state === "SATISFIED").length ?? 0}/
                      {child?.checks.length ?? 0} Checks validés
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mobile-subject-note">
                Les résultats et qualifications viennent du Plan. Les liens ci-dessus sont des choix éditoriaux.
              </p>
            </>
          ) : (
            <p>{episodeError || "Lecture du Plan…"}</p>
          )}
        </section>
      )}
      <section className="mobile-subject-decisions" aria-label="Décisions enregistrées">
        <div className="mobile-subject-section-heading">
          <h2>Décisions</h2>
          <span>
            {decisionLinks.length} enregistrée{decisionLinks.length > 1 ? "s" : ""}
          </span>
        </div>
        {decisionLinks.length ? (
          <ol>
            {decisionLinks.map((link) => (
              <li key={link.id}>
                <button type="button" onClick={() => onOpenItem(link.item)}>
                  {sources[link.id]?.title}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p>Aucune décision enregistrée pour ce sujet. Un Plan terminé ne crée pas une décision humaine.</p>
        )}
      </section>
    </div>
  );
}
