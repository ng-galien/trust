/* Facet helpers shared by the resource homes: option counts computed with the facet's own group
   excluded (so a selected value still shows the alternatives), list toggling, and one URL update per
   pick (the facet change and the query reset travel together). */

export function facetHelpers<Row, Filters extends { q: string }>(
  rows: Row[],
  filters: Filters,
  applyFacets: (rows: Row[], filters: Filters, except?: keyof Filters) => Row[],
  update: (patch: Partial<Filters>) => void,
) {
  return {
    count: (except: keyof Filters, predicate: (row: Row) => boolean) => applyFacets(rows, filters, except).filter(predicate).length,
    toggle: <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]),
    pick: (patch: Partial<Filters>, options?: { clearQuery?: boolean }) => update({ ...patch, ...(options?.clearQuery ? ({ q: "" } as Partial<Filters>) : {}) }),
  };
}
