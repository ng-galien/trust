import { ImageOff, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Language } from "../../i18n/index.js";
import { cx } from "../../lib/format.js";
import { usePreference, useResolvedTheme } from "../../lib/preferences.js";
import { Legend } from "./blocks.js";

/* Real screenshots of the interface, captured by `apps/trust-web/acceptance/docs/*.capture.ts` on the seeded
   runtime (light/dark × language) into `../captures/<id>.<theme>.<language>.png`, with a sidecar JSON giving the
   boxes of the elements marked `data-doc="…"` on the screen. The callouts ①②③ are drawn here, over the image:
   they follow the interface when it moves, and the legend is text of the page (translated with it). */

interface Capture {
  width: number;
  height: number;
  density: "operator" | "expert";
  callouts: Array<{ key: string; x: number; y: number; w: number; h: number }>;
}

const images = import.meta.glob<string>("../captures/*.png", { eager: true, query: "?url", import: "default" });
const sidecars = import.meta.glob<Capture>("../captures/*.json", { eager: true, import: "default" });

function pick<T>(records: Record<string, T>, id: string, theme: string, language: string, extension: string): T | undefined {
  const candidates = [`${id}.${theme}.${language}`, `${id}.${theme}.en`, `${id}.light.${language}`, `${id}.light.en`];
  for (const name of candidates) {
    const hit = records[`../captures/${name}.${extension}`];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function Screenshot({ id, legend, caption, alt, className }: { id: string; legend?: Record<string, ReactNode>; caption?: ReactNode; alt?: string; className?: string }) {
  const { t } = useTranslation();
  const theme = useResolvedTheme();
  const language = usePreference("language") as Language;
  const [active, setActive] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setZoomed(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoomed]);
  const src = pick(images, id, theme, language, "png");
  const capture = pick(sidecars, id, theme, language, "json");
  const keys = Object.keys(legend ?? {});
  const numbered = keys.map((key, index) => ({ key, n: index + 1, box: capture?.callouts.find((callout) => callout.key === key) }));

  const picture = src ? (
    <>
      <img src={src} alt={alt ?? (typeof caption === "string" ? caption : id)} width={capture?.width} height={capture?.height} className="block h-auto w-full" />
      {numbered.map(({ key, n, box }) => box ? (
        <span
          key={key}
          className={cx("docs-callout-box", active === key && "docs-callout-box-active")}
          style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}
          onMouseEnter={() => setActive(key)}
          onMouseLeave={() => setActive(null)}
        >
          <span className="docs-mark docs-mark-float" aria-label={t("docs.screenshot.callout", { n: String(n) })}>{n}</span>
        </span>
      ) : null)}
    </>
  ) : null;

  return (
    <figure className={cx("docs-screenshot my-5", className)}>
      <div className={cx("relative overflow-hidden rounded-(--radius-3) border border-border bg-surface-2 shadow-(--shadow-1)", src && "cursor-zoom-in")} onClick={() => src && setZoomed(true)}>
        {picture ?? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 p-6 text-center text-body text-muted">
            <ImageOff size={20} className="text-faint" />
            <span className="mono text-caption">{t("docs.screenshot.missing", { id })}</span>
          </div>
        )}
      </div>
      {(caption || capture) ? (
        <figcaption className="mt-2 flex items-baseline gap-2 text-body-lg text-muted">
          <span className="min-w-0 flex-1">{caption}</span>
          {capture ? <span className="shrink-0 text-caption text-faint">{t("docs.screenshot.mode", { mode: t(`docs.screenshot.${capture.density}`) })}</span> : null}
        </figcaption>
      ) : null}
      {legend && keys.length ? (
        <div onMouseLeave={() => setActive(null)}>
          <Legend items={keys.map((key) => <span key={key} onMouseEnter={() => setActive(key)} className={cx("block rounded-(--radius-1) px-1 -mx-1", active === key && "bg-accent-soft")}>{legend[key]}</span>)} />
        </div>
      ) : null}
      {zoomed ? (
        <div role="dialog" aria-modal className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--color-overlay-backdrop)] p-6" onClick={() => setZoomed(false)}>
          <button type="button" aria-label={t("common.actions.close")} className="absolute top-4 right-4 grid h-8 w-8 place-items-center rounded-full bg-surface text-text shadow-(--shadow-2)" onClick={() => setZoomed(false)}><X size={16} /></button>
          <div className="relative max-h-full w-auto max-w-[96vw] overflow-hidden rounded-(--radius-3) shadow-(--shadow-3) [&>img]:max-h-[92vh] [&>img]:w-auto" onClick={(event) => event.stopPropagation()}>{picture}</div>
        </div>
      ) : null}
    </figure>
  );
}
