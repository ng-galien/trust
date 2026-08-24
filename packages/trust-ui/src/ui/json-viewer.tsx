import * as monaco from "@codingame/monaco-vscode-editor-api";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { defineThemes } from "../gherkin-editor.js";
import { useResolvedTheme } from "../lib/preferences.js";
import { TrustMonacoEditor } from "../monaco-editor.js";

/** Read-only Monaco JSON view: folding, search (Cmd+F), bracket matching, token-driven theme. */
export function JsonViewer({ value, fontSize = 12 }: { value: unknown; fontSize?: number }) {
  const { t } = useTranslation();
  const theme = useResolvedTheme();
  const documentUri = useRef(`inmemory://trust/json/${crypto.randomUUID()}.json`);
  const [editorReady, setEditorReady] = useState(false);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const options = useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(() => ({
    readOnly: true,
    domReadOnly: true,
    minimap: { enabled: false },
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace",
    fontSize,
    lineHeight: Math.round(fontSize * 1.65),
    padding: { top: 12, bottom: 12 },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    folding: true,
    showFoldingControls: "always",
    renderLineHighlight: "none",
    lineNumbers: "on",
    automaticLayout: true,
    contextmenu: false,
    occurrencesHighlight: "off",
    stickyScroll: { enabled: true },
  }), [fontSize]);

  useEffect(() => {
    if (!editorReady) return;
    defineThemes(monaco);
    monaco.editor.setTheme(`trust-${theme}`);
  }, [editorReady, theme]);

  return (
    <div className="relative h-full">
      {!editorReady ? <div className="absolute inset-0 p-4 text-body text-muted">{t("ui.jsonViewer.loading")}</div> : null}
      <TrustMonacoEditor
        className="h-full"
        value={text}
        language="json"
        uri={documentUri.current}
        options={options}
        onReady={() => {
          defineThemes(monaco);
          monaco.editor.setTheme(`trust-${theme}`);
          setEditorReady(true);
        }}
        onError={(error) => console.error("TRUST Monaco initialization failed", error)}
        onDispose={() => setEditorReady(false)}
      />
    </div>
  );
}
