import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../lib/format.js";
import { Description } from "./description.js";
import { Popover } from "./menu.js";

/** Small ⓘ trigger opening a description panel; render only when there is something to say. */
export function InfoBadge({ title, children, label, className }: { title?: ReactNode; children: ReactNode; label?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <Popover
      align="start"
      className={className}
      panelClassName="w-[26rem] max-w-[80vw] p-3"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-label={label ?? t("ui.infoPopover.description")}
          aria-expanded={open}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            toggle();
          }}
          className={cx("inline-flex h-5 w-5 items-center justify-center rounded-full text-faint hover:bg-surface-3 hover:text-accent", open && "bg-surface-3 text-accent")}
        >
          <Info size={13} />
        </button>
      )}
    >
      {title ? <div className="mb-1.5 text-body-lg font-semibold">{title}</div> : null}
      <div className="text-body-lg leading-relaxed text-text">{typeof children === "string" ? <Description text={children} /> : children}</div>
    </Popover>
  );
}
