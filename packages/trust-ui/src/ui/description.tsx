import { cx } from "../lib/format.js";

/** Free-text description from a Feature: hard-wrapped lines flow, blank lines separate paragraphs. */
export function Description({ text, className }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

