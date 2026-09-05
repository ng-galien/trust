export function SectionIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    filters: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
    board: "M3 4h5v16H3z M10 4h5v16h-5z M17 4h4v16h-4z",
    stacked: "M4 4h16v4H4z M4 11h16v3H4z M4 17h16v3H4z",
    progress: "M12 4a8 8 0 1 1-8 8 M4 7V4h3",
    instructions: "M8 4h8v3H8z M6 5H4v16h16V5h-2 M8 11h8 M8 15h6",
    expected: "M20 12a8 8 0 1 1-8-8 M12 8a4 4 0 1 0 4 4 M12 12l9-9 M16 3h5v5",
    authorized: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6",
    forbidden: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M9 10l6 6 M15 10l-6 6",
    response: "M4 4h16v12H9l-5 4z M8 8h8 M8 12h5",
    current: "M20 12a8 8 0 1 1-8-8 M12 8a4 4 0 1 0 4 4 M12 12l9-9 M16 3h5v5",
    next: "M4 12h16 M14 6l6 6-6 6",
    validated: "M20 12a8 8 0 1 1-4-7 M8 11l4 4 9-11",
    blocked: "M8 4v16 M16 4v16",
  };
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? paths.instructions} /></svg>;
}
