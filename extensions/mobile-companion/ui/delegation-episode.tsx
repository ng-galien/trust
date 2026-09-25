import type { CheckView, DelegationEpisodePlanView, DelegationEpisodeView } from "@trust/extension-sdk";
import { checkLabel, missionLabel, planLabel, reasonLabel } from "./episode-labels";
import type { Item } from "./types";
import { useDelegationEpisode } from "./use-delegation-episode";

function shortUri(value: string) {
  return value.split("/").at(-1) ?? value;
}

function humanState(state: string, fr: boolean) {
  const names: Record<string, string> = fr
    ? {
        COMPLETE: "Terminé",
        IN_PROGRESS: "En cours",
        ESCALATED: "Escaladé",
        WAITING: "En attente",
        RUNNING: "En cours",
        SATISFIED: "Validée",
        OPEN: "Ouvert",
      }
    : {
        COMPLETE: "Complete",
        IN_PROGRESS: "In progress",
        ESCALATED: "Escalated",
        WAITING: "Waiting",
        RUNNING: "Running",
        SATISFIED: "Satisfied",
        OPEN: "Open",
      };
  return names[state] ?? state;
}

function workState(state: string, fr: boolean) {
  const names: Record<string, string> = fr
    ? {
        COMPLETE: "Terminé",
        IN_PROGRESS: "En cours",
        ESCALATED: "Intervention requise",
        WAITING: "À venir",
        RUNNING: "En cours",
        SATISFIED: "Terminé",
      }
    : {
        COMPLETE: "Complete",
        IN_PROGRESS: "In progress",
        ESCALATED: "Needs attention",
        WAITING: "Upcoming",
        RUNNING: "In progress",
        SATISFIED: "Complete",
      };
  return names[state] ?? state;
}

function verifiedSummary(value: DelegationEpisodePlanView | null): { text: string; observedAt: string } | null {
  if (!value) return null;
  for (const check of value.checks) {
    if (check.state !== "SATISFIED" || check.latestVerdict !== "VALIDATED") continue;
    const qualification = [...check.history]
      .reverse()
      .find((entry) => entry.verdict === "VALIDATED" && entry.state === "satisfied");
    if (!qualification) continue;
    const fact = check.attempts
      .flatMap((attempt) => attempt.facts)
      .find((entry) => qualification.factIds.includes(entry.id) && typeof entry.values.summary === "string");
    if (fact && typeof fact.values.summary === "string") {
      return { text: fact.values.summary, observedAt: fact.observedAt };
    }
  }
  return null;
}

function stepTitle(
  value: DelegationEpisodePlanView | null,
  invocation: DelegationEpisodeView["branches"][number]["invocation"],
  fr: boolean,
) {
  const sourceTitle = value?.plan.metadata.title?.trim();
  return sourceTitle && sourceTitle !== "implementation lots" && sourceTitle !== value?.plan.procedure
    ? planLabel(sourceTitle, fr)
    : missionLabel(invocation, fr);
}

function CheckRow({ check, fr }: { check: CheckView; fr: boolean }) {
  const accepted = check.attempts.flatMap((attempt) => attempt.facts);
  const factCount = fr
    ? `${accepted.length} ${accepted.length === 1 ? "fait" : "faits"}`
    : `${accepted.length} ${accepted.length === 1 ? "Fact" : "Facts"}`;
  return (
    <li className="mobile-episode-check" data-state={check.state}>
      <div className="mobile-episode-check-heading">
        <span className="mobile-episode-node" aria-hidden="true" />
        <div>
          <strong>{checkLabel(check.name, fr)}</strong>
          <span>
            {check.latestVerdict === "NOT_VALIDATED"
              ? fr
                ? "Non validé"
                : "Not validated"
              : humanState(check.state, fr)}
          </span>
        </div>
      </div>
      {check.reason && check.latestVerdict === "NOT_VALIDATED" && <p>{reasonLabel(check.reason, fr)}</p>}
      {check.state === "OPEN" && check.blockedBy.length > 0 && (
        <p>
          {fr ? "Attend" : "Waiting for"}:{" "}
          {check.blockedBy
            .map((reason) => (reason.startsWith("trust://") ? shortUri(reason) : reasonLabel(reason, fr)))
            .join(", ")}
        </p>
      )}
      {(check.attempts.length > 0 || check.history.length > 0) && (
        <details>
          <summary>
            {fr ? "Preuves et qualification" : "Facts and qualification"} · {factCount}
          </summary>
          <dl>
            <div>
              <dt>{fr ? "Check" : "Check"}</dt>
              <dd>{check.name}</dd>
            </div>
            <div>
              <dt>{fr ? "Opération" : "Operation"}</dt>
              <dd>{check.operation}</dd>
            </div>
            <div>
              <dt>{fr ? "Tentatives" : "Attempts"}</dt>
              <dd>{check.attempts.length}</dd>
            </div>
            {check.latestReasonCode && (
              <div>
                <dt>{fr ? "Motif" : "Reason code"}</dt>
                <dd>{check.latestReasonCode}</dd>
              </div>
            )}
          </dl>
          {check.reason && <p>{reasonLabel(check.reason, fr)}</p>}
          {accepted.map((fact) => (
            <div className="mobile-episode-fact" key={fact.id}>
              <small>
                {fr ? "Observé" : "Observed"} {new Date(fact.observedAt).toLocaleString(fr ? "fr-FR" : "en-US")}
              </small>
              <pre>{JSON.stringify(fact.values, null, 2)}</pre>
            </div>
          ))}
        </details>
      )}
    </li>
  );
}

function PlanLane({
  value,
  title,
  fr,
  root = false,
  id,
}: {
  value: DelegationEpisodePlanView;
  title: string;
  fr: boolean;
  root?: boolean;
  id?: string;
}) {
  const { plan, checks } = value;
  return (
    <section className="mobile-episode-lane" aria-label={title} id={id}>
      <div className="mobile-episode-lane-heading">
        <div>
          <span className="mobile-episode-eyebrow">{title}</span>
          {root && <h3>{planLabel(plan.metadata.title || plan.procedure, fr)}</h3>}
        </div>
        <span className="mobile-episode-state" data-state={plan.workState}>
          {fr && !root && plan.workState === "COMPLETE" ? "Terminée" : humanState(plan.workState, fr)}
        </span>
      </div>
      <details className="mobile-episode-plan-checks">
        <summary>
          {fr ? "Validations et preuves" : "Checks and facts"} · {checks.length}
        </summary>
        <ol className="mobile-episode-checks">
          {checks.map((check) => (
            <CheckRow key={check.checkUri} check={check} fr={fr} />
          ))}
        </ol>
      </details>
      {plan.importedResults.length > 0 && (
        <details className="mobile-episode-results">
          <summary>
            {fr ? "Résultats des missions" : "Mission results"} · {plan.importedResults.length}
          </summary>
          {plan.importedResults.map((result) => (
            <div
              key={`${result.invocationId}-${result.childPlan}-${result.childRevision}-${result.role}-${result.result}`}
            >
              <strong>{result.result}</strong>
              <small>
                {result.childPlan} · r{result.childRevision}
              </small>
              <pre>{JSON.stringify(result.value, null, 2)}</pre>
            </div>
          ))}
        </details>
      )}
      <details className="mobile-episode-provenance">
        <summary>{fr ? "Contrat et provenance" : "Contract and provenance"}</summary>
        <dl>
          <div>
            <dt>Plan</dt>
            <dd>{plan.plan}</dd>
          </div>
          <div>
            <dt>{fr ? "Procédure" : "Procedure"}</dt>
            <dd>
              {plan.procedure}@{plan.procedureVersion}
            </dd>
          </div>
          {plan.metadata.title && (
            <div>
              <dt>{fr ? "Titre source" : "Source title"}</dt>
              <dd>{plan.metadata.title}</dd>
            </div>
          )}
          <div>
            <dt>{fr ? "Révision" : "Revision"}</dt>
            <dd>{plan.revision}</dd>
          </div>
          <div>
            <dt>{fr ? "Environnement" : "Environment"}</dt>
            <dd>{plan.environment}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

function ChildLane({ invocation, child, fr }: DelegationEpisodeView["branches"][number] & { fr: boolean }) {
  const title = missionLabel(invocation, fr);
  const id = `mission-${invocation.id}`;
  return (
    <details className="mobile-episode-branch" id={id}>
      <summary>
        <span>{stepTitle(child, invocation, fr)}</span>
        <small>{workState(child?.plan.workState ?? invocation.state, fr)}</small>
      </summary>
      <div className="mobile-episode-branch-content">
        {child ? (
          <PlanLane value={child} title={title} fr={fr} />
        ) : (
          <div className="mobile-episode-waiting">
            <strong>{title}</strong>
            <span>{humanState(invocation.state, fr)}</span>
          </div>
        )}
        {invocation.history.length > 1 && (
          <details>
            <summary>
              {fr ? "Générations" : "Generations"} · {invocation.history.length}
            </summary>
            <ol>
              {invocation.history.map((entry) => (
                <li key={entry.generation}>
                  #{entry.generation} · {entry.childPlan}
                  {entry.supersededAt ? ` · ${entry.supersededAt}` : ""}
                </li>
              ))}
            </ol>
          </details>
        )}
        <details className="mobile-episode-mission-source">
          <summary>{fr ? "Identité de la mission" : "Mission identity"}</summary>
          <dl>
            <div>
              <dt>{fr ? "Mission" : "Mission"}</dt>
              <dd>
                {invocation.mission ? `${invocation.mission.collection}/${invocation.mission.id}` : invocation.name}
              </dd>
            </div>
            <div>
              <dt>{fr ? "Invocation" : "Invocation"}</dt>
              <dd>{invocation.id}</dd>
            </div>
          </dl>
        </details>
      </div>
    </details>
  );
}

function WorkSteps({ branches, fr }: { branches: DelegationEpisodeView["branches"]; fr: boolean }) {
  return (
    <div className="mobile-episode-work">
      <h3>{fr ? "Étapes du travail" : "Work steps"}</h3>
      <ol className="mobile-episode-steps">
        {branches.map(({ invocation, child }) => {
          const state = child?.plan.workState ?? invocation.state;
          const report = verifiedSummary(child);
          return (
            <li key={invocation.id} data-state={state}>
              <span className="mobile-episode-step-marker" aria-hidden="true" />
              <div className="mobile-episode-step-content">
                <strong className="mobile-episode-step-title">{stepTitle(child, invocation, fr)}</strong>
                {report ? (
                  <>
                    <p className="mobile-episode-report-date">
                      {fr ? "Compte rendu historique du" : "Historical report from"}{" "}
                      <time dateTime={report.observedAt}>
                        {new Intl.DateTimeFormat(fr ? "fr-FR" : "en-US", { dateStyle: "medium" }).format(
                          new Date(report.observedAt),
                        )}
                      </time>
                    </p>
                    <details className="mobile-episode-report-detail">
                      <summary>
                        {fr ? "Voir le compte rendu technique daté" : "Read the dated technical report"}
                      </summary>
                      <p lang="en">{report.text}</p>
                    </details>
                  </>
                ) : (
                  <p>{fr ? "Aucun résultat remis pour cette étape." : "No result has been submitted for this step."}</p>
                )}
              </div>
              <span className="mobile-episode-step-state">{workState(state, fr)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EpisodeTechnicalDetails({ episode, fr }: { episode: DelegationEpisodeView; fr: boolean }) {
  const checks = [episode.root.checks, ...episode.branches.map(({ child }) => child?.checks ?? [])].flat();
  const satisfied = checks.filter((check) => check.state === "SATISFIED").length;
  return (
    <details className="mobile-episode-technical">
      <summary>
        <span>{fr ? "Détails de la procédure TRUST" : "TRUST procedure details"}</span>
        <small>
          {fr
            ? `${satisfied} validations sur ${checks.length} · résultats et provenance`
            : `${satisfied} of ${checks.length} checks · results and provenance`}
        </small>
      </summary>
      <div className="mobile-episode-layout">
        <PlanLane value={episode.root} title={fr ? "Plan principal" : "Parent Plan"} fr={fr} root />
        {episode.branches.length > 0 && (
          <div className="mobile-episode-branches">
            <h3>{fr ? "Missions de la procédure" : "Procedure missions"}</h3>
            {episode.branches.map(({ invocation, child }) => (
              <ChildLane key={invocation.id} invocation={invocation} child={child} fr={fr} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export function DelegationEpisode({
  item,
  trustBase,
  eventsUrl,
  locale,
}: {
  item: Item;
  trustBase: string;
  eventsUrl: string;
  locale: string;
}) {
  const { episode, error, loading, refresh } = useDelegationEpisode(trustBase, eventsUrl, item.plan);
  if (!item.plan) return null;
  const fr = locale.startsWith("fr");
  const completed = episode?.branches.filter(({ child }) => child?.plan.workState === "COMPLETE").length ?? 0;
  const state = episode?.root.plan.workState;
  const title = state ? workState(state, fr) : fr ? "Suivi du travail" : "Work status";
  return (
    <section
      className="mobile-episode"
      id="mobile-episode-plan"
      aria-label={fr ? "Épisode de délégation" : "Delegation episode"}
    >
      <header className="mobile-episode-header">
        <div>
          <span className="mobile-episode-eyebrow">{fr ? "SUIVI DU TRAVAIL" : "WORK STATUS"}</span>
          <h2>{title}</h2>
        </div>
        {episode && episode.branches.length > 0 && (
          <span className="mobile-episode-count">
            {fr
              ? `${completed} ${completed > 1 ? "étapes terminées" : "étape terminée"} sur ${episode.branches.length}`
              : `${completed} of ${episode.branches.length} complete`}
          </span>
        )}
      </header>
      {item.response ? (
        <p className="mobile-episode-decision">
          {fr ? "Réponse enregistrée" : "Response recorded"} ·{" "}
          <time dateTime={item.response.submittedAt}>{new Date(item.response.submittedAt).toLocaleString(locale)}</time>
        </p>
      ) : item.form ? (
        <p className="mobile-episode-decision">{fr ? "Votre réponse est attendue" : "Your response is needed"}</p>
      ) : null}
      {loading && <p role="status">{fr ? "Chargement du parcours…" : "Loading record…"}</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => void refresh()}>
            {fr ? "Réessayer" : "Retry"}
          </button>
        </p>
      )}
      {episode && (
        <>
          {episode.branches.length > 0 && <WorkSteps branches={episode.branches} fr={fr} />}
          {episode.branches.length === 0 && (
            <p className="mobile-episode-overview">
              {state === "COMPLETE"
                ? fr
                  ? "Travail terminé."
                  : "Work complete."
                : fr
                  ? "Le travail est suivi dans la procédure."
                  : "Work is tracked in the procedure."}
            </p>
          )}
          <EpisodeTechnicalDetails episode={episode} fr={fr} />
        </>
      )}
    </section>
  );
}
