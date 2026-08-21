import { cx } from "../lib/format.js";

/** Free-text description from a Feature: hard-wrapped lines flow, blank lines separate paragraphs,
    lines starting with "- " form a list (one item per "- ", continuation lines flow into the item). */
export function Description({ text, className }: { text: string; className?: string }) {
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {blocks.map((block, index) => {
        if (/^-\s/.test(block)) {
          const items = block.split(/\n(?=-\s)/).map((item) => item.replace(/^-\s*/, "").replace(/\s*\n\s*/g, " ").trim());
          return <ul key={index} className="list-disc space-y-0.5 pl-5">{items.map((item, at) => <li key={at}>{item}</li>)}</ul>;
        }
        return <p key={index}>{block.replace(/\s*\n\s*/g, " ")}</p>;
      })}
    </div>
  );
}
