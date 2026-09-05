import { useEffect, useId, useRef, useState } from "react";
import { command } from "./commands";
import { SectionIcon } from "./section-icon";

export type Filters = { search: string; project: string; assignee: string; procedure: string; label: string; tag: string };
type Facet = Exclude<keyof Filters, "search">;
interface Suggestions { values: string[]; hasMore: boolean }
interface Props {
  apiBase: string; filters: Filters; onChange(filters: Filters): void; fr: boolean;
  procedures: string[]; labels: string[]; plansAvailable: boolean;
}

function FacetPicker({ field, label, apiBase, filters, values, fr, onSelect, disabled }: {
  field: Facet; label: string; apiBase: string; filters: Filters; values: string[] | undefined; fr: boolean; disabled: boolean; onSelect(value: string): void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Suggestions>({ values: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(-1);
  const [retry, setRetry] = useState(0);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const source = JSON.stringify({ ...(filters.search ? { search: filters.search } : {}), ...(field !== "project" && filters.project ? { project: filters.project } : {}), ...(field !== "assignee" && filters.assignee ? { assignee: filters.assignee } : {}), ...(field !== "tag" && filters.tag ? { tags: [filters.tag] } : {}) });
  const localValues = values ? JSON.stringify(values) : undefined;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setFailed(false); setActive(-1); setResult({ values: [], hasMore: false });
    const timer = setTimeout(() => {
      if (disabled) { setLoading(false); return; }
      if (localValues) {
        const matching = (JSON.parse(localValues) as string[]).filter(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
        setResult({ values: matching.slice(0, 10), hasMore: matching.length > 10 }); setLoading(false); return;
      }
      void command<Suggestions>(apiBase, "missions.suggest", { ...JSON.parse(source), field: field === "tag" ? "tags" : field, query: query.trim(), limit: 10 }, controller.signal)
        .then(value => { if (!controller.signal.aborted) setResult(value); })
        .catch(() => { if (!controller.signal.aborted) setFailed(true); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 160);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [apiBase, source, field, query, localValues, disabled, retry]);
  useEffect(() => { list.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const select = (value: string) => { onSelect(value); setQuery(""); setActive(-1); };
  return <section className="coordination-facet-picker" aria-label={label}>
    <label htmlFor={`${id}-input`}>{label}</label>
    <div className="coordination-facet-input"><SectionIcon name="search" /><input id={`${id}-input`} autoFocus role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined} value={query} disabled={disabled} placeholder={fr ? "Saisir pour trouver une valeur…" : "Type to find a value…"} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive(value => !result.values.length ? -1 : value < 0 ? event.key === "ArrowDown" ? 0 : result.values.length - 1 : (value + (event.key === "ArrowDown" ? 1 : result.values.length - 1)) % result.values.length); }
      if (event.key === "Enter") { event.preventDefault(); const value = result.values[active] ?? result.values.find(value => value === query.trim()); if (value) select(value); }
    }} /></div>
    <div ref={list} id={`${id}-list`} role="listbox" aria-label={`${label} ${fr ? "— suggestions" : "suggestions"}`} aria-busy={loading} className="coordination-suggestions">
      {result.values.map((value, index) => <button id={`${id}-option-${index}`} data-option-index={index} key={value} type="button" role="option" tabIndex={-1} aria-selected={filters[field] === value} className={index === active ? "is-active" : ""} onPointerDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => select(value)}><span>{value}</span>{filters[field] === value && <SectionIcon name="validated" />}</button>)}
    </div>
    <p className="coordination-suggestion-status" role="status">{disabled ? fr ? "Plans indisponibles." : "Plans unavailable." : loading ? fr ? "Recherche de valeurs…" : "Finding values…" : failed ? fr ? "Suggestions indisponibles." : "Suggestions unavailable." : result.values.length === 0 ? fr ? "Aucune valeur pour ces filtres." : "No values match these filters." : result.hasMore ? fr ? "D’autres valeurs existent. Précisez votre recherche." : "More values available. Keep typing to narrow the list." : fr ? `${result.values.length} valeurs disponibles` : `${result.values.length} values available`}{failed && <button type="button" onClick={() => setRetry(value => value + 1)}>{fr ? "Réessayer" : "Retry suggestions"}</button>}</p>
    <small>{field === "procedure" || field === "label" ? fr ? "Plans autorisés dans cet environnement." : "Authorized Plans in this environment." : fr ? "Valeurs correspondant aux autres filtres de missions. Les filtres de Plan portent sur le tableau." : "Values match the other mission filters. Plan filters apply to the board."}</small>
  </section>;
}

export function FilterBar({ apiBase, filters, onChange, procedures, labels, plansAvailable, fr }: Props) {
  const [open, setOpen] = useState(false);
  const [facet, setFacet] = useState<Facet>("project");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const names: Record<Facet, string> = { project: fr ? "Projet" : "Project", assignee: fr ? "Attribuée à" : "Assigned to", procedure: fr ? "Procédure" : "Procedure", label: fr ? "Label du Plan" : "Plan label", tag: fr ? "Tag de coordination" : "Coordination tag" };
  const facets = Object.keys(names) as Facet[];
  const selected = facets.filter(key => filters[key]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div ref={root} className="coordination-filters" role="search" aria-label={fr ? "Filtrer les missions" : "Filter missions"} onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <div className="coordination-searchbar">
      <SectionIcon name="search" />
      <div className="coordination-query-content">
        {selected.map(key => <button className="coordination-filter-chip" type="button" key={key} aria-label={`${fr ? "Retirer" : "Remove"} ${names[key]}: ${filters[key]}`} onClick={() => onChange({ ...filters, [key]: "" })}><span>{names[key]}</span><strong>{filters[key]}</strong><span aria-hidden="true">×</span></button>)}
        <input type="search" aria-label={fr ? "Rechercher" : "Search"} placeholder={fr ? "Rechercher des missions…" : "Search missions…"} value={filters.search} onChange={event => onChange({ ...filters, search: event.target.value })} />
      </div>
      {Object.values(filters).some(Boolean) && <button className="coordination-clear" type="button" onClick={() => onChange({ search: "", project: "", assignee: "", procedure: "", label: "", tag: "" })}>{fr ? "Effacer" : "Clear"}</button>}
      <button ref={trigger} type="button" aria-label={fr ? "Filtres" : "Filters"} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><SectionIcon name="filters" />{fr ? "Filtres" : "Filters"}{selected.length > 0 && <span className="coordination-filter-count">{selected.length}</span>}</button>
    </div>
    {open && <div id={id} className="coordination-filter-popover" role="dialog" aria-label={fr ? "Choisir des filtres" : "Choose filters"}>
      <div className="coordination-facet-categories" aria-label={fr ? "Catégories de filtres" : "Filter categories"}>{facets.map(key => <button type="button" key={key} aria-label={names[key]} aria-pressed={facet === key} onClick={() => setFacet(key)}>{names[key]}{filters[key] && <span aria-label={fr ? "Filtre actif" : "Active filter"}>•</span>}<span aria-hidden="true">›</span></button>)}</div>
      <FacetPicker key={facet} field={facet} label={names[facet]} apiBase={apiBase} filters={filters} values={facet === "procedure" ? procedures : facet === "label" ? labels : undefined} fr={fr} onSelect={value => onChange({ ...filters, [facet]: value })} disabled={!plansAvailable && (facet === "procedure" || facet === "label")} />
      <footer><span>{fr ? "↑ ↓ parcourir · Entrée choisir · Échap fermer" : "↑ ↓ browse · Enter select · Esc close"}</span><button type="button" onClick={close}>{fr ? "Terminé" : "Done"}</button></footer>
    </div>}
  </div>;
}
