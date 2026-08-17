import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import type { EditorMarker } from "../../gherkin-editor.js";
import { useDebounced } from "../../lib/use-debounced.js";
import { RuntimeError } from "../../runtime.js";
import { stripEphemeral } from "./overlay-state.js";

/* Authoring an item from Gherkin source (Operations, Procedures): the draft against the catalog copy,
   "duplicate from" seeding, live compilation with editor markers, and the derived status. The overlays
   only add their resource-specific compile/save calls, tabs and inspector. */

type DraftStatus = "COMPILING" | "INVALID" | "DRAFT" | "CURRENT";

export function useSourceDraft<Compiled>({ mode, id, catalogSource, seedSource, template, compile, compileKey }: {
  mode: "item" | "new";
  /** Item identifier from the route (undefined for a new item). */
  id: string | undefined;
  /** Source held by the runtime for this item, when known. */
  catalogSource: string | undefined;
  /** Source of the item named by `?from=`, when duplicating. */
  seedSource: (from: string) => string | undefined;
  template: string;
  compile: (source: string) => Promise<Compiled>;
  compileKey: string;
}) {
  const [search] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const from = mode === "new" ? search.get("from") : null;
  const seed = from ? seedSource(from) : undefined;
  const baseSource = mode === "new" ? (seed ?? template) : (catalogSource ?? "");

  const [draft, setDraft] = useState<string | null>(null);
  const source = draft ?? baseSource;
  const dirty = draft !== null && draft !== baseSource;
  const authoring = dirty || mode === "new";
  useEffect(() => setDraft(null), [id, from]);

  const listSearch = useMemo(() => stripEphemeral(location.search), [location.search]);

  const debounced = useDebounced(source, 350);
  const compilation = useQuery({
    queryKey: [compileKey, debounced],
    queryFn: () => compile(debounced),
    enabled: debounced.trim().length > 0 && authoring,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const compileError = compilation.error instanceof RuntimeError ? compilation.error : compilation.error ? new RuntimeError(compilation.error.message, 0) : null;
  const markers: EditorMarker[] = useMemo(
    () => (compileError?.location ? [{ message: compileError.detail, line: compileError.location.line, column: compileError.location.column }] : []),
    [compileError],
  );
  const status: DraftStatus = compilation.isFetching && authoring ? "COMPILING" : compileError ? "INVALID" : authoring ? "DRAFT" : "CURRENT";
  const compiling = compilation.isFetching && authoring;

  /** After a save/publish: forget the draft and land on the item, keeping the list filters and the current tab. */
  const settle = (path: string, tab: string | undefined) => {
    setDraft(null);
    const next = new URLSearchParams(listSearch);
    if (tab) next.set("tab", tab);
    const query = next.toString();
    navigate(`${path}${query ? `?${query}` : ""}`, { replace: true });
  };

  return { from, seed, source, setDraft, dirty, authoring, listSearch, compiled: authoring ? compilation.data : undefined, compileError, compiling, markers, status, settle };
}
