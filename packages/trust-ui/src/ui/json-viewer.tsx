import Editor, { type BeforeMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Monaco } from "@monaco-editor/react";

import { defineThemes } from "../gherkin-editor.js";
import { useResolvedTheme } from "../lib/preferences.js";

/** Read-only Monaco JSON view: folding, search (⌘F), bracket matching, token-driven theme. */
export function JsonViewer({ value, fontSize = 12 }: { value: unknown; fontSize?: number }) {
  const { t } = useTranslation();
  const theme = useResolvedTheme();
  const monacoRef = useRef<Monaco | null>(null);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    defineThemes(monaco);
    monaco.editor.setTheme(`trust-${theme}`);
  }, [theme]);

  const configure: BeforeMount = (monaco) => {
    monacoRef.current = monaco;
    defineThemes(monaco);
  };

  return (
    <Editor
      height="100%"
      language="json"
      value={text}
      beforeMount={configure}
      theme={`trust-${theme}`}
      loading={<div className="p-4 text-body text-muted">{t("ui.jsonViewer.loading")}</div>}
      options={{
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
      }}
    />
  );
}
