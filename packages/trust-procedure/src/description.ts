/** Free-text block under `Feature:` — the human description. Lines are de-indented, blank runs kept as paragraphs. */
export function readDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const indent = Math.min(
    ...lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length),
  );
  const text = lines
    .map((line) => (line.trim() === "" ? "" : line.slice(Number.isFinite(indent) ? indent : 0).trimEnd()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? undefined : text;
}
