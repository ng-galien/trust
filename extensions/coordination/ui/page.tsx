import type { ExtensionPageProps, PlanSummaryView, PlanView } from "@trust/extension-sdk";
import {
  type CSSProperties,
  type MouseEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { command } from "./commands";
import { FilterBar, type Filters } from "./filter-bar";
import { Markdown } from "./markdown";
import { SectionIcon } from "./section-icon";
import "./style.css";

interface Mission {
  mission: string;
  plan: string;
  project: string;
  assignee: string;
  owner: string | null;
  state: string;
  tags: string[];
  tagRevision: number;
  request: Record<string, unknown>;
  response: string;
  createdAt: string;
  updatedAt: string;
}
interface MissionPage {
  missions: Mission[];
  total: number;
  offset: number;
  limit: number;
}
const labels = {
  en: {
    title: "Agent coordination",
    subtitle: "Missions and their current TRUST Plan.",
    refresh: "Refresh",
    loading: "Loading missions…",
    error: "Missions could not be refreshed.",
    empty: "No missions.",
    select: "Select a mission to read its instructions and result.",
    mission: "Mission",
    external: "Mission state",
    plan: "TRUST Plan state",
    unavailable: "Unavailable",
    intent: "Current intent",
    noIntent: "No current intent",
    assignee: "Assigned to",
    owner: "Claimed by",
    project: "Project",
    instructions: "Instructions",
    expected: "Expected result",
    authorized: "Authorized actions",
    forbidden: "Forbidden actions",
    response: "Submitted response",
    noResponse: "No response submitted.",
    updated: "Updated",
    created: "Created",
    checks: "Checks satisfied",
    disconnected: "Live updates interrupted. Reconnecting…",
    back: "Missions",
    pending: "Pending",
    claimed: "Claimed",
    completed: "Completed",
    blocked: "Blocked",
  },
  fr: {
    title: "Coordination des agents",
    subtitle: "Missions et leur Plan TRUST courant.",
    refresh: "Actualiser",
    loading: "Chargement des missions…",
    error: "Impossible d’actualiser les missions.",
    empty: "Aucune mission.",
    select: "Sélectionnez une mission pour lire ses instructions et son résultat.",
    mission: "Mission",
    external: "État de la mission",
    plan: "État du Plan TRUST",
    unavailable: "Indisponible",
    intent: "Intention courante",
    noIntent: "Aucune intention courante",
    assignee: "Attribuée à",
    owner: "Prise en charge par",
    project: "Projet",
    instructions: "Instructions",
    expected: "Résultat attendu",
    authorized: "Actions autorisées",
    forbidden: "Actions interdites",
    response: "Réponse soumise",
    noResponse: "Aucune réponse soumise.",
    updated: "Mise à jour",
    created: "Création",
    checks: "Checks satisfaits",
    disconnected: "Mises à jour interrompues. Reconnexion…",
    back: "Missions",
    pending: "En attente",
    claimed: "Prise en charge",
    completed: "Terminée",
    blocked: "Bloquée",
  },
};
async function read<T>(transport: ExtensionPageProps["transport"], url: string, signal?: AbortSignal): Promise<T> {
  const result = await transport.fetch(url, signal ? { signal } : undefined);
  if (!result.ok) throw new Error("Read unavailable");
  return result.json();
}
export default function Page({ apiBase, trustBase, eventsUrl, language, navigation, transport }: ExtensionPageProps) {
  const t = language.startsWith("fr") ? labels.fr : labels.en;
  const fr = language.startsWith("fr");
  const query = new URLSearchParams(navigation?.search);
  const [localFilters, setLocalFilters] = useState<Filters>({
    search: "",
    project: "",
    assignee: "",
    procedure: "",
    label: "",
    tag: "",
  });
  const filters = navigation
    ? (Object.fromEntries(Object.keys(localFilters).map((key) => [key, query.get(`coord.${key}`) ?? ""])) as Filters)
    : localFilters;
  const replaceQuery = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(navigation?.search);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(`coord.${key}`, value);
      else next.delete(`coord.${key}`);
    }
    navigation?.replaceSearch(next.toString());
  };
  const setFilters = (update: SetStateAction<Filters>) => {
    const value = typeof update === "function" ? update(filters) : update;
    if (navigation) replaceQuery(value);
    else setLocalFilters(value);
  };
  const [total, setTotal] = useState(0);
  const workspace = useRef<HTMLElement>(null);
  const [panelBounds, setPanelBounds] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const container = element.closest("main")?.getBoundingClientRect();
      const top = Math.max(0, rect.top, container?.top ?? 0);
      const bottom = Math.min(window.innerHeight, container?.bottom ?? window.innerHeight);
      setPanelBounds({ top, height: Math.max(0, bottom - top) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, []);
  const [localSort, setLocalSort] = useState("activity");
  const requestedSort = navigation ? query.get("coord.sort") : localSort;
  const sort = requestedSort === "newest" || requestedSort === "oldest" ? requestedSort : "activity";
  const setSort = (value: string) => {
    if (navigation) replaceQuery({ sort: value === "activity" ? null : value });
    else setLocalSort(value);
  };
  const [localLayout, setLocalLayout] = useState("board");
  const layout = (navigation ? query.get("coord.layout") : localLayout) === "stacked" ? "stacked" : "board";
  const setLayout = (value: string) => {
    if (navigation) replaceQuery({ layout: value === "board" ? null : value });
    else setLocalLayout(value);
  };
  const [localCollapsed, setLocalCollapsed] = useState("");
  const collapsed = (navigation ? (query.get("coord.collapsed") ?? "") : localCollapsed).split(",");
  const toggleColumn = (status: string) => {
    const value = collapsed.includes(status) ? collapsed.filter((item) => item !== status) : [...collapsed, status];
    const next = value.filter(Boolean).join(",");
    if (navigation) replaceQuery({ collapsed: next || null });
    else setLocalCollapsed(next);
  };
  const [plansAvailable, setPlansAvailable] = useState(true);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [plans, setPlans] = useState<PlanSummaryView[]>([]);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const selected = navigation ? query.get("coord.mission") : localSelected;
  const setSelected = (value: string | null) => {
    if (navigation) replaceQuery({ mission: value });
    else setLocalSelected(value);
  };
  const [localPinned, setLocalPinned] = useState(false);
  const pinned = navigation ? query.get("coord.pinned") === "1" : localPinned;
  const setPinned = (update: SetStateAction<boolean>) => {
    const value = typeof update === "function" ? update(pinned) : update;
    if (navigation) replaceQuery({ pinned: value ? "1" : null });
    else setLocalPinned(value);
  };
  const [localPanelWidth, setLocalPanelWidth] = useState(640);
  const panelWidth = navigation
    ? Math.max(360, Math.min(Number(query.get("coord.width")) || 640, window.innerWidth))
    : localPanelWidth;
  const setPanelWidth = (value: number) => {
    if (navigation) replaceQuery({ width: String(value) });
    else setLocalPanelWidth(value);
  };
  const [detailResponse, setDetail] = useState<{ request: string; plan: PlanView } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [connected, setConnected] = useState(true);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const source = {
        ...(filters.search ? { search: filters.search } : {}),
        ...(filters.project ? { project: filters.project } : {}),
        ...(filters.assignee ? { assignee: filters.assignee } : {}),
        ...(filters.tag ? { tags: [filters.tag] } : {}),
      };
      const [missionData, planData] = await Promise.all([
        (async () => {
          const collected: Mission[] = [];
          let count = 0;
          for (let offset = 0; offset < 2000; offset += 100) {
            if (current !== sequence.current) break;
            const page = await command<MissionPage>(transport, apiBase, "missions.list", {
              ...source,
              offset,
              limit: 100,
            });
            collected.push(...page.missions);
            count = page.total;
            if (collected.length >= count || page.missions.length < 100) break;
          }
          return { missions: collected, total: count };
        })(),
        read<{ plans: PlanSummaryView[] }>(transport, `${trustBase}/plans`).catch(() => null),
      ]);
      if (current !== sequence.current) return;
      setMissions(missionData.missions);
      setTotal(missionData.total);
      setPlans(planData?.plans ?? []);
      setPlansAvailable(planData !== null);
      setError(false);
      setRevision((value) => value + 1);
    } catch (cause) {
      if (current === sequence.current) {
        if (cause instanceof Error && (cause.cause === 401 || cause.cause === 403)) {
          setMissions([]);
          setPlans([]);
          setTotal(0);
        }
        setError(true);
      }
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [transport, apiBase, trustBase, filters.search, filters.project, filters.assignee, filters.tag]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed public stream URL must reopen the subscription even if the transport object is reused.
  useEffect(() => {
    const events = transport.openEvents();
    events.addEventListener("change", () => {
      setConnected(true);
      void refresh();
    });
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, [transport, eventsUrl, refresh]);
  const mission = missions.find((item) => item.mission === selected);
  const visible = missions
    .filter((item) => {
      const plan = plans.find((value) => value.plan === item.plan);
      return (
        (!filters.procedure || plan?.procedure === filters.procedure) &&
        (!filters.label || plan?.metadata?.labels?.includes(filters.label))
      );
    })
    .sort((a, b) => {
      const field = sort === "activity" ? "updatedAt" : "createdAt";
      const difference = Date.parse(a[field]) - Date.parse(b[field]);
      return (sort === "oldest" ? difference : -difference) || a.mission.localeCompare(b.mission);
    });
  const column = (item: Mission) => {
    const plan = plans.find((value) => value.plan === item.plan);
    if (!plan) return "unavailable";
    if (plan.workState === "COMPLETE") return "completed";
    if (plan.workState === "ESCALATED") return "blocked";
    return item.state === "pending" && !item.owner ? "pending" : "claimed";
  };
  const [editingTags, setEditingTags] = useState(false);
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagRevision, setTagRevision] = useState(0);
  const [tagError, setTagError] = useState("");
  const [savingTags, setSavingTags] = useState(false);
  const [tagOwner, setTagOwner] = useState(selected);
  if (tagOwner !== selected) {
    setTagOwner(selected);
    setEditingTags(false);
    setTagError("");
    setTagInput("");
  }
  const editTags = () => {
    if (!mission) return;
    setDraftTags(mission.tags);
    setTagRevision(mission.tagRevision);
    setTagError("");
    setTagInput("");
    setEditingTags(true);
  };
  const saveTags = async () => {
    if (!mission) return;
    setSavingTags(true);
    setTagError("");
    try {
      await command(transport, apiBase, "tags.replace", {
        mission: mission.mission,
        expectedRevision: tagRevision,
        tags: draftTags,
      });
      setEditingTags(false);
      await refresh();
    } catch (error) {
      setTagError(error instanceof Error && error.message === "conflict" ? "conflict" : "unavailable");
    } finally {
      setSavingTags(false);
    }
  };
  const panel = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const missionId = mission?.mission;
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    if (element.open) element.close();
    if (missionId !== undefined) {
      if (!opener.current) opener.current = document.activeElement as HTMLElement;
      if (pinned) element.show();
      else element.showModal();
    } else {
      opener.current?.focus();
      opener.current = null;
    }
  }, [missionId, pinned]);
  const resizePanel = (width: number) => setPanelWidth(Math.max(360, Math.min(width, window.innerWidth - 100)));
  const availablePlan = plans.find((item) => item.plan === mission?.plan);
  const availablePlanId = availablePlan?.plan;
  const detailRequest = JSON.stringify([availablePlanId, trustBase, revision]);
  const detail = detailResponse?.request === detailRequest ? detailResponse.plan : null;
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    if (availablePlanId)
      void read<PlanView>(transport, `${trustBase}/plans/${encodeURIComponent(availablePlanId)}`, controller.signal)
        .then((plan) => {
          if (!controller.signal.aborted) setDetail({ request: detailRequest, plan });
        })
        .catch(() => {});
    return () => controller.abort();
  }, [transport, availablePlanId, trustBase, detailRequest]);
  const date = (value: string) => new Date(value).toLocaleString(language);
  const shortDate = (value: string) =>
    new Date(value).toLocaleString(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const state = (value: string) => t[value as "pending" | "claimed" | "completed" | "blocked"] ?? value;
  const columnName = (value: string) =>
    value === "claimed"
      ? fr
        ? "En cours"
        : "In progress"
      : value === "unavailable"
        ? fr
          ? "Plan indisponible"
          : "Plan unavailable"
        : state(value);
  const externalState = (value: string) =>
    value === "completed"
      ? fr
        ? "Réponse déposée"
        : "Response submitted"
      : value === "blocked"
        ? fr
          ? "Blocage signalé"
          : "Blocker reported"
        : state(value);
  const title = (item: Mission) => {
    const named = plans.find((plan) => plan.plan === item.plan)?.metadata?.title?.trim();
    if (named) return named;
    const instruction =
      typeof item.request.instructions === "string"
        ? item.request.instructions
            .split("\n")
            .find((line) => line.trim())
            ?.replace(/^#{1,6}\s+/, "")
            .trim()
        : undefined;
    return instruction ? instruction.slice(0, 110) + (instruction.length > 110 ? "…" : "") : item.mission;
  };
  const followLink = (event: MouseEvent<HTMLAnchorElement>) => {
    if (navigation && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const href = event.currentTarget.getAttribute("href");
      if (href !== null) navigation.navigate(href);
    }
  };
  const descendantCount = (count: number) =>
    fr
      ? `${count} escalade${count > 1 ? "s" : ""} descendante${count > 1 ? "s" : ""}`
      : `${count} descendant escalation${count > 1 ? "s" : ""}`;
  const resourceLinks = (plan: PlanSummaryView | undefined) =>
    plan && navigation ? (
      <nav className="coordination-resource-links" aria-label={fr ? "Ressources TRUST" : "TRUST resources"}>
        <a href={navigation.planHref(plan.plan, plan.mode)} onClick={followLink}>
          {fr ? "Ouvrir le Plan" : "Open Plan"}
        </a>
        <a
          href={navigation.procedureHref(plan.procedure, plan.procedureVersion)}
          onClick={followLink}
          title={
            fr
              ? `Procédure courante du catalogue ; ce Plan utilise la version ${plan.procedureVersion}.`
              : `Current catalog Procedure; this Plan uses version ${plan.procedureVersion}.`
          }
        >
          {fr ? "Ouvrir la Procédure" : "Open Procedure"}
        </a>
      </nav>
    ) : null;
  return (
    <section
      ref={workspace}
      className={`coordination${pinned && mission ? " coordination-pinned" : ""}`}
      style={
        {
          "--panel-width": `${panelWidth}px`,
          "--panel-top": `${panelBounds.top}px`,
          "--panel-height": `${panelBounds.height}px`,
        } as CSSProperties
      }
      aria-label={t.title}
    >
      <header className="coordination-heading">
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        <button type="button" onClick={() => void refresh()}>
          {t.refresh}
        </button>
      </header>
      <FilterBar
        transport={transport}
        apiBase={apiBase}
        filters={filters}
        onChange={setFilters}
        fr={fr}
        procedures={[...new Set(plans.map((plan) => plan.procedure))].sort()}
        labels={[...new Set(plans.flatMap((plan) => plan.metadata?.labels ?? []))].sort()}
        plansAvailable={plansAvailable}
      />
      <p className="coordination-scope" role="status">
        {fr
          ? `${visible.length} missions affichées · ${missions.length} sur ${total} missions chargées pour ces filtres`
          : `${visible.length} missions shown · ${missions.length} of ${total} missions loaded for these filters`}
        {missions.length < total &&
          (fr
            ? " · Limite de 2 000 atteinte ; affinez les filtres. Les filtres de Plan portent sur les missions chargées."
            : " · 2,000 mission limit reached; narrow the filters. Plan filters apply to loaded missions.")}
        {!plansAvailable &&
          (fr
            ? " · Plans indisponibles ; filtres de Plan indisponibles."
            : " · Plans unavailable; Plan filters unavailable.")}
      </p>
      <div className="coordination-sort">
        <fieldset
          style={{ margin: 0, minWidth: 0 }}
          className="coordination-layout"
          aria-label={fr ? "Disposition" : "Layout"}
        >
          <button type="button" aria-pressed={layout === "board"} onClick={() => setLayout("board")}>
            <SectionIcon name="board" />
            {fr ? "Tableau" : "Board"}
          </button>
          <button type="button" aria-pressed={layout === "stacked"} onClick={() => setLayout("stacked")}>
            <SectionIcon name="stacked" />
            {fr ? "Empilé" : "Stacked"}
          </button>
        </fieldset>
        <label>
          {fr ? "Trier par" : "Sort by"}
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="activity">{fr ? "Dernière activité" : "Latest activity"}</option>
            <option value="newest">{fr ? "Plus récentes (création)" : "Newest created"}</option>
            <option value="oldest">{fr ? "Plus anciennes (création)" : "Oldest created"}</option>
          </select>
        </label>
        {missions.length < total && (
          <small>{fr ? "Tri des missions chargées uniquement." : "Sorting loaded missions only."}</small>
        )}
      </div>
      {error && <p role="alert">{t.error}</p>}
      {!connected && <p role="status">{t.disconnected}</p>}
      {loading ? (
        <p role="status">{t.loading}</p>
      ) : (
        <div className={`coordination-board is-${layout}`}>
          {(["pending", "claimed", "blocked", "completed", "unavailable"] as const)
            .filter((status) => status !== "unavailable" || visible.some((item) => column(item) === status))
            .map((status) => (
              <section
                className={`coordination-column is-${status}${collapsed.includes(status) ? " is-collapsed" : ""}`}
                key={status}
                aria-label={columnName(status)}
              >
                <h2>
                  <button
                    type="button"
                    aria-label={`${collapsed.includes(status) ? (fr ? "Déplier" : "Expand") : fr ? "Replier" : "Collapse"} ${columnName(status)}`}
                    aria-expanded={!collapsed.includes(status)}
                    aria-controls={`coordination-column-${status}`}
                    onClick={() => toggleColumn(status)}
                  >
                    <span className={`coordination-status-dot is-${status}`} />
                    {columnName(status)}
                    <span className="coordination-count">
                      {visible.filter((item) => column(item) === status).length}
                    </span>
                    <span className="coordination-column-chevron" aria-hidden="true">
                      ⌄
                    </span>
                  </button>
                </h2>
                <nav
                  id={`coordination-column-${status}`}
                  hidden={collapsed.includes(status)}
                  className="coordination-list"
                  aria-label={columnName(status)}
                >
                  {visible
                    .filter((item) => column(item) === status)
                    .map((item) => {
                      const plan = plans.find((value) => value.plan === item.plan);
                      const currentIntent = plan ? (plan.currentIntent ?? t.noIntent) : t.unavailable;
                      const nextIntent = plan
                        ? (plan.nextIntent ??
                          (plan.workState === "COMPLETE"
                            ? fr
                              ? "Plan terminé"
                              : "Plan complete"
                            : fr
                              ? "Pas encore déclarée"
                              : "Not yet declared"))
                        : t.unavailable;
                      return (
                        <div
                          key={item.mission}
                          className={`coordination-card${selected === item.mission ? " is-selected" : ""}`}
                        >
                          <button
                            type="button"
                            data-mission={item.mission}
                            aria-haspopup="dialog"
                            onClick={() => setSelected(item.mission)}
                          >
                            <span className="coordination-row-title" title={title(item)}>
                              {title(item)}
                            </span>
                            <span className="coordination-row-meta">
                              <span className="coordination-row-owner" title={item.assignee}>
                                {item.assignee}
                              </span>
                              <time dateTime={item.updatedAt} title={date(item.updatedAt)}>
                                {shortDate(item.updatedAt)}
                              </time>
                            </span>
                            <span
                              className="coordination-row-progress"
                              title={
                                fr
                                  ? "Checks qualifiés dans la révision courante du Plan. Le total peut changer ; ce n’est pas un pourcentage du travail."
                                  : "Qualified Checks in the current Plan revision. The total can change; this is not a task completion percentage."
                              }
                            >
                              <SectionIcon
                                name={
                                  plan?.workState === "ESCALATED"
                                    ? "blocked"
                                    : plan && plan.satisfiedChecks > 0
                                      ? "validated"
                                      : "progress"
                                }
                              />
                              <span>
                                Plan: {plan?.workState ?? t.unavailable}
                                {plan &&
                                  ` · ${plan.satisfiedChecks}/${plan.checkCount ?? "—"} ${fr ? "Checks satisfaits" : "Checks satisfied"}`}
                              </span>
                            </span>
                            {!!plan?.descendantEscalations?.length && (
                              <span className="coordination-descendant-count">
                                <SectionIcon name="blocked" />
                                {descendantCount(plan.descendantEscalations.length)}
                              </span>
                            )}
                            {(item.state === "completed" || item.state === "blocked") && (
                              <span className="coordination-row-outcome">{externalState(item.state)}</span>
                            )}
                            <span className="coordination-row-chain is-current">
                              <SectionIcon name="current" />
                              <span className="coordination-row-intent" title={`${t.intent}: ${currentIntent}`}>
                                <span className="coordination-sr-only">
                                  {fr ? "Intention courante" : "Current intent"}:{" "}
                                </span>
                                {currentIntent}
                              </span>
                            </span>
                            <span className="coordination-row-chain is-next">
                              <SectionIcon name="next" />
                              <span
                                className="coordination-row-intent"
                                title={`${fr ? "Intention suivante" : "Announced next intent"}: ${nextIntent}`}
                              >
                                <span className="coordination-sr-only">
                                  {fr ? "Intention suivante" : "Announced next intent"}:{" "}
                                </span>
                                {nextIntent}
                              </span>
                            </span>
                          </button>
                          {resourceLinks(plan)}
                        </div>
                      );
                    })}
                  {!visible.some((item) => column(item) === status) && <p className="coordination-empty">{t.empty}</p>}
                </nav>
              </section>
            ))}
        </div>
      )}
      <dialog
        ref={panel}
        className={`coordination-panel${pinned ? " is-pinned" : ""}`}
        aria-label={mission ? title(mission) : t.mission}
        onCancel={() => setSelected(null)}
        onKeyDown={(event) => {
          if (!pinned && event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            setSelected(null);
          }
        }}
        onClick={(event) => {
          if (!pinned && event.target === panel.current) setSelected(null);
        }}
      >
        <hr
          style={{ margin: 0, border: 0 }}
          className="coordination-resize"
          tabIndex={0}
          aria-label={language.startsWith("fr") ? "Largeur du panneau" : "Panel width"}
          aria-orientation="vertical"
          aria-valuenow={panelWidth}
          aria-valuemin={360}
          aria-valuemax={Math.max(360, window.innerWidth - 100)}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              resizePanel(panelWidth + (event.key === "ArrowLeft" ? 32 : -32));
            }
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) resizePanel(window.innerWidth - event.clientX);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        />
        <div className="coordination-panel-toolbar">
          <button type="button" aria-pressed={pinned} onClick={() => setPinned((value) => !value)}>
            {language.startsWith("fr") ? (pinned ? "Détacher" : "Épingler") : pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            aria-label={language.startsWith("fr") ? "Fermer le panneau" : "Close panel"}
            onClick={() => setSelected(null)}
          >
            ×
          </button>
        </div>
        <article className="coordination-inspector" aria-label={mission?.mission ?? t.select}>
          {!mission ? (
            <p className="coordination-placeholder">{t.select}</p>
          ) : (
            <>
              <button type="button" className="coordination-back" onClick={() => setSelected(null)}>
                ← {t.back}
              </button>
              <h2>{title(mission)}</h2>
              {resourceLinks(availablePlan)}
              {!!detail?.descendantEscalations?.length && (
                <section
                  className="coordination-descendant-alerts"
                  aria-label={fr ? "Escalades descendantes" : "Descendant escalations"}
                >
                  <h3>{descendantCount(detail.descendantEscalations.length)}</h3>
                  <p>
                    {fr
                      ? "Arrêts actifs des descendants, distincts de l’état propre de ce Plan."
                      : "Active descendant stops, separate from this Plan’s own state."}
                  </p>
                  <ul>
                    {detail.descendantEscalations.map((escalation) => (
                      <li key={escalation.escalationId}>
                        {navigation ? (
                          <a
                            href={navigation.planHref(escalation.plan, escalation.mode)}
                            onClick={followLink}
                            aria-label={`${fr ? "Ouvrir l’origine de l’escalade" : "Open escalation origin"}: ${escalation.title || escalation.plan}`}
                          >
                            {escalation.title || escalation.plan} ↗
                          </a>
                        ) : (
                          <strong>{escalation.title || escalation.plan}</strong>
                        )}
                        <small>
                          {escalation.path
                            .map((step) => step.parentPlan)
                            .concat(escalation.plan)
                            .join(" → ")}
                        </small>
                        <Markdown source={escalation.blockingReason} language={language} />
                        <h4>{fr ? "Action interdite" : "Forbidden further action"}</h4>
                        <Markdown source={escalation.forbiddenFurtherAction} language={language} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <details className="coordination-identifiers">
                <summary>{language.startsWith("fr") ? "Identifiants techniques" : "Technical identifiers"}</summary>
                <p>
                  {t.mission}: <code>{mission.mission}</code>
                </p>
                <p>
                  Plan: <code>{mission.plan}</code>
                </p>
              </details>
              <dl className="coordination-facts">
                <div>
                  <dt>{t.external}</dt>
                  <dd>{externalState(mission.state)}</dd>
                </div>
                <div>
                  <dt>{t.plan}</dt>
                  <dd>{detail?.workState ?? t.unavailable}</dd>
                </div>
                <div>
                  <dt>{t.assignee}</dt>
                  <dd>{mission.assignee}</dd>
                </div>
                <div>
                  <dt>{t.owner}</dt>
                  <dd>{mission.owner ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t.project}</dt>
                  <dd>{mission.project}</dd>
                </div>
                <div>
                  <dt>{t.created}</dt>
                  <dd>{date(mission.createdAt)}</dd>
                </div>
                <div>
                  <dt>{t.updated}</dt>
                  <dd>{date(mission.updatedAt)}</dd>
                </div>
                {detail && (
                  <div>
                    <dt>{t.checks}</dt>
                    <dd>
                      {detail.satisfiedChecks} / {detail.checks.length}
                    </dd>
                  </div>
                )}
              </dl>
              <p className="coordination-scope">
                {fr
                  ? "Checks qualifiés dans la révision courante du Plan. Le total peut changer ; ce n’est pas un pourcentage du travail."
                  : "Qualified Checks in the current Plan revision. The total can change; this is not a task completion percentage."}
              </p>
              <section className="coordination-intent">
                <h3>{t.intent}</h3>
                <p>{detail ? (detail.currentIntent ?? t.noIntent) : t.unavailable}</p>
                <h3>{fr ? "Intention suivante annoncée" : "Announced next intent"}</h3>
                <p>
                  {detail
                    ? (detail.nextIntent ??
                      (detail.workState === "COMPLETE"
                        ? fr
                          ? "Plan terminé"
                          : "Plan complete"
                        : fr
                          ? "Pas encore déclarée"
                          : "Not yet declared"))
                    : t.unavailable}
                </p>
                <small>
                  {fr
                    ? "Intentions déclarées par l’agent ; ne décrivent pas son activité en temps réel."
                    : "Intentions declared by the agent; these do not describe its live execution activity."}
                </small>
              </section>
              <section className="coordination-tags" aria-label={fr ? "Classification" : "Classification"}>
                <h3>{fr ? "Labels du Plan · immuables" : "Plan labels · immutable"}</h3>
                <div className="coordination-chips">
                  {availablePlan?.metadata?.labels?.map((tag) => <span key={tag}>{tag}</span>) ?? "—"}
                </div>
                <h3>{fr ? "Tags de coordination" : "Coordination tags"}</h3>
                <div className="coordination-chips">
                  {(editingTags ? draftTags : mission.tags).map((tag) =>
                    editingTags ? (
                      <button
                        type="button"
                        key={tag}
                        disabled={savingTags}
                        aria-label={`${fr ? "Retirer" : "Remove"} ${tag}`}
                        onClick={() => setDraftTags((value) => value.filter((item) => item !== tag))}
                      >
                        {tag} ×
                      </button>
                    ) : (
                      <span key={tag}>{tag}</span>
                    ),
                  )}
                </div>
                {!editingTags ? (
                  <button type="button" onClick={editTags}>
                    {fr ? "Modifier les tags" : "Edit tags"}
                  </button>
                ) : (
                  <>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const tag = tagInput.trim();
                        if (tag && tag.length <= 64 && draftTags.length < 32 && !draftTags.includes(tag)) {
                          setDraftTags((value) => [...value, tag]);
                          setTagInput("");
                        }
                      }}
                    >
                      <input
                        aria-label={fr ? "Nouveau tag" : "New tag"}
                        value={tagInput}
                        maxLength={64}
                        disabled={savingTags}
                        onChange={(event) => setTagInput(event.target.value)}
                      />
                      <button
                        type="submit"
                        disabled={
                          savingTags ||
                          !tagInput.trim() ||
                          draftTags.includes(tagInput.trim()) ||
                          draftTags.length >= 32
                        }
                      >
                        {fr ? "Ajouter" : "Add"}
                      </button>
                    </form>
                    <div className="coordination-tag-actions">
                      <button
                        type="button"
                        disabled={savingTags || !!tagInput.trim() || tagError === "conflict"}
                        onClick={() => void saveTags()}
                      >
                        {fr ? "Enregistrer" : "Save tags"}
                      </button>
                      <button
                        type="button"
                        disabled={savingTags}
                        onClick={() => {
                          setEditingTags(false);
                          setTagError("");
                        }}
                      >
                        {fr ? "Annuler" : "Cancel"}
                      </button>
                    </div>
                  </>
                )}
                {tagError && (
                  <p role="alert">
                    {tagError === "conflict"
                      ? fr
                        ? "Les tags ont changé. Rechargez-les avant de modifier à nouveau."
                        : "Tags changed elsewhere. Reload them before editing again."
                      : fr
                        ? "Impossible d’enregistrer les tags."
                        : "Tags could not be saved."}
                    {tagError === "conflict" && (
                      <button
                        type="button"
                        onClick={async () => {
                          await refresh();
                          setEditingTags(false);
                          setTagError("");
                        }}
                      >
                        {fr ? "Recharger les tags" : "Reload tags"}
                      </button>
                    )}
                  </p>
                )}
              </section>
              {(["instructions", "expected", "authorized", "forbidden"] as const).map((key) => (
                <details
                  className="coordination-section"
                  key={`${mission.mission}-${key}`}
                  open={key === "instructions"}
                >
                  <summary>
                    <SectionIcon name={key} />
                    <span>{t[key]}</span>
                    <span className="coordination-chevron" aria-hidden="true">
                      ›
                    </span>
                  </summary>
                  <Markdown
                    source={typeof mission.request[key] === "string" ? (mission.request[key] as string) : "—"}
                    language={language}
                  />
                </details>
              ))}
              <details className="coordination-section coordination-response" key={`${mission.mission}-response`} open>
                <summary>
                  <SectionIcon name="response" />
                  <span>{t.response}</span>
                  <span className="coordination-chevron" aria-hidden="true">
                    ›
                  </span>
                </summary>
                <Markdown source={mission.response || t.noResponse} language={language} />
              </details>
            </>
          )}
        </article>
      </dialog>
    </section>
  );
}
