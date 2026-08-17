import { ChevronRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { cx } from "../lib/format.js";

export interface Crumb {
  label: ReactNode;
  to?: string;
  mono?: boolean;
}

export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("ui.breadcrumb.label")} className={cx("flex min-w-0 items-center gap-1 text-body text-muted", className)}>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        const content = (
          <span className={cx("truncate-1", item.mono && "mono", last && "font-medium text-text")}>{item.label}</span>
        );
        return (
          <Fragment key={index}>
            {index > 0 ? <ChevronRight size={12} className="shrink-0 text-faint" /> : null}
            {item.to && !last ? <Link to={item.to} className="hover:text-text">{content}</Link> : content}
          </Fragment>
        );
      })}
    </nav>
  );
}

/** Header of a full page that is not a resource collection (Overview, Settings): crumbs · title · subtitle. */
export function PageHeader({ crumbs, title, subtitle }: { crumbs: Crumb[]; title: string; subtitle?: string }) {
  return (
    <header className="shrink-0 border-b border-border bg-surface px-6 py-4">
      <Breadcrumb items={crumbs} />
      <h1 className="mt-1 text-heading font-semibold tracking-tight">{title}</h1>
      {subtitle ? <p className="text-ui text-muted">{subtitle}</p> : null}
    </header>
  );
}
