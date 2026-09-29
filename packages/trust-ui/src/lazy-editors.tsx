import { type ComponentProps, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { GherkinEditor as GherkinEditorComponent } from "./gherkin-editor.js";
import type { JsonViewer as JsonViewerComponent } from "./ui/json-viewer.js";

/* The Monaco editor stack weighs several megabytes: it is fetched when a screen shows an editor, never with the
   application shell or a page that only lists resources. */

const LoadedGherkinEditor = lazy(() =>
  import("./gherkin-editor.js").then(({ GherkinEditor }) => ({ default: GherkinEditor })),
);
const LoadedJsonViewer = lazy(() => import("./ui/json-viewer.js").then(({ JsonViewer }) => ({ default: JsonViewer })));

function EditorLoading() {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex h-full min-h-24 items-center justify-center text-body text-muted">
      {t("ui.editor.loading")}
    </div>
  );
}

export function GherkinEditor(props: ComponentProps<typeof GherkinEditorComponent>) {
  return (
    <Suspense fallback={<EditorLoading />}>
      <LoadedGherkinEditor {...props} />
    </Suspense>
  );
}

export function JsonViewer(props: ComponentProps<typeof JsonViewerComponent>) {
  return (
    <Suspense fallback={<EditorLoading />}>
      <LoadedJsonViewer {...props} />
    </Suspense>
  );
}
