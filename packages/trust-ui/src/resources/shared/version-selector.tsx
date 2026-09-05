import { useTranslation } from "react-i18next";
import { useLocation, useSearchParams } from "react-router";

export function VersionSelector({
  versions,
  selected,
  dirty,
}: {
  versions: readonly string[];
  selected: string;
  dirty: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  return (
    <label
      className="inline-flex items-center gap-1.5 text-caption text-muted"
      title={dirty ? t("shared.versions.discardFirst") : t("shared.versions.exact")}
    >
      <span>{t("shared.versions.label")}</span>
      <select
        aria-label={t("shared.versions.label")}
        value={selected}
        disabled={dirty}
        className="mono rounded-(--radius-1) border border-border bg-surface px-1.5 py-0.5 text-body text-text disabled:opacity-50"
        onChange={(event) => {
          const next = new URLSearchParams(search);
          next.set("version", event.target.value);
          next.delete("sel");
          setSearch(next, { state: location.state });
        }}
      >
        {versions.map((version) => (
          <option key={version} value={version}>
            {version}
          </option>
        ))}
      </select>
    </label>
  );
}
