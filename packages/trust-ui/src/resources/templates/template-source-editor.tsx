import type { TemplateParameter } from "@trust/extension-sdk";
import { GherkinEditor } from "../../lazy-editors.js";
import { usePreference, useResolvedTheme } from "../../lib/preferences.js";
import { useRuntime } from "../../lib/runtime-context.js";

const noParameters: readonly TemplateParameter[] = [];

/** Templates use the same editor and language client as Operations and Procedures. */
export function TemplateSourceEditor({
  value,
  onChange,
  readOnly = false,
  label,
  parameters = noParameters,
  materialized = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  label: string;
  parameters?: readonly TemplateParameter[] | undefined;
  materialized?: boolean;
}) {
  const runtime = useRuntime();
  const theme = useResolvedTheme();
  const fontSize = usePreference("editorFontSize");
  return (
    <div className="h-full min-h-0" data-doc="template.editor">
      <GherkinEditor
        kind="procedure"
        value={value}
        onChange={onChange ?? (() => {})}
        theme={theme}
        fontSize={fontSize}
        readOnly={readOnly}
        ariaLabel={label}
        languageServerUrl={runtime.languageServerUrl()}
        templateParameters={parameters}
        templateMaterialized={materialized}
      />
    </div>
  );
}
