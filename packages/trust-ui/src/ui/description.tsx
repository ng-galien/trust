import { cx } from "../lib/format.js";

/** Free-text description from a Feature: hard-wrapped lines flow, blank lines separate paragraphs,
    lines starting with "- " form a list (one item per "- ", continuation lines flow into the item). */
export function Description({ text, className }: { text: string; className?: string }) {
  // Source spans identify repeated prose independently of its display position.
  const blocks = Array.from(text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g));
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {blocks.map((match) => {
        const block = match[0].trim();
        if (!block) return null;
        if (/^-\s/.test(block)) {
          const items = Array.from(block.matchAll(/-\s[^\n]*(?:\n(?!-\s)[^\n]*)*/g));
          return (
            <ul key={match.index} className="list-disc space-y-0.5 pl-5">
              {items.map((item) => (
                <li key={item.index}>
                  {item[0]
                    .replace(/^-\s*/, "")
                    .replace(/\s*\n\s*/g, " ")
                    .trim()}
                </li>
              ))}
            </ul>
          );
        }
        return <p key={match.index}>{block.replace(/\s*\n\s*/g, " ")}</p>;
      })}
    </div>
  );
}
