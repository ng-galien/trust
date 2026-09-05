import * as monaco from "@codingame/monaco-vscode-editor-api";
import { type HighlightTokenTone, highlightTokenTable } from "@trust/gherkin";
import { WrapText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorResourceNavigation } from "./editor-resource-navigation.js";
import { TrustMonacoEditor } from "./monaco-editor.js";
import {
  ensureTrustLanguageClient,
  initializeTrustMonaco,
  subscribeTrustLanguageServerStatus,
} from "./monaco-stack.js";
import { Button } from "./ui/button.js";

type LanguageKind = "operation" | "procedure";

export interface EditorMarker {
  message: string;
  line: number;
  column: number;
  severity?: "error" | "warning" | "info";
}

/** Read-only hydration of a source line: a tone on the whole line and an inline note after it (state, value…). */
export interface EditorDecoration {
  line: number;
  tone: "satisfied" | "failed" | "actionable" | "open" | "info";
  text?: string | undefined;
}

interface GherkinEditorProps {
  kind: LanguageKind;
  value: string;
  onChange: (value: string) => void;
  theme: "light" | "dark";
  languageServerUrl?: string | undefined;
  readOnly?: boolean | undefined;
  markers?: EditorMarker[] | undefined;
  decorations?: EditorDecoration[] | undefined;
  fontSize?: number | undefined;
  onSave?: (() => void) | undefined;
}

const markerOwner = "trust";
export function GherkinEditor({
  kind,
  value,
  onChange,
  theme,
  languageServerUrl,
  readOnly,
  markers = [],
  decorations = [],
  fontSize = 13,
  onSave,
}: GherkinEditorProps) {
  const { t } = useTranslation();
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const documentUri = useRef(`inmemory://trust/${kind}/${crypto.randomUUID()}.feature`);
  const currentValue = useRef(value);
  currentValue.current = value;
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor>();
  const [editorReady, setEditorReady] = useState(false);
  const [editorFailed, setEditorFailed] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const [languageServerStatus, setLanguageServerStatus] = useState<"connecting" | "ready" | "unavailable">(
    "connecting",
  );
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const language = `trust-${kind}`;
  const options = useMemo(
    () => ({ ...editorOptions(readOnly, fontSize), wordWrap: wordWrap ? ("on" as const) : ("off" as const) }),
    [fontSize, readOnly, wordWrap],
  );

  useEffect(() => {
    if (!languageServerUrl) return;
    const unsubscribe = subscribeTrustLanguageServerStatus(setLanguageServerStatus);
    void ensureTrustLanguageClient(languageServerUrl).catch((error: unknown) => {
      console.error("TRUST language client initialization failed", error);
      setLanguageServerStatus("unavailable");
    });
    return unsubscribe;
  }, [languageServerUrl]);

  // Themes are rebuilt from the token layer whenever the theme flips.
  useEffect(() => {
    void initializeTrustMonaco()
      .then(() => {
        defineThemes(monaco);
        monaco.editor.setTheme(`trust-${theme}`);
        setEditorFailed(false);
      })
      .catch((error: unknown) => {
        console.error("TRUST editor theme initialization failed", error);
        setEditorFailed(true);
      });
  }, [theme]);

  useEffect(() => {
    const model = editor?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      markerOwner,
      markers.map((marker) => ({
        message: marker.message,
        severity:
          marker.severity === "warning"
            ? monaco.MarkerSeverity.Warning
            : marker.severity === "info"
              ? monaco.MarkerSeverity.Info
              : monaco.MarkerSeverity.Error,
        startLineNumber: marker.line,
        startColumn: marker.column,
        endLineNumber: marker.line,
        endColumn: Math.max(marker.column + 1, model.getLineMaxColumn(Math.min(marker.line, model.getLineCount()))),
      })),
    );
    return () => {
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, markerOwner, []);
    };
  }, [markers, editor]);

  // Hydration decorations: whole-line tone + inline note; re-applied whenever they change (or the editor mounts).
  useEffect(() => {
    const instance = editor;
    const model = instance?.getModel();
    if (!instance || !model) return;
    const collection = instance.createDecorationsCollection();
    collection.set(
      decorations
        .filter((entry) => entry.line >= 1 && entry.line <= model.getLineCount())
        .map((entry) => ({
          range: {
            startLineNumber: entry.line,
            startColumn: 1,
            endLineNumber: entry.line,
            endColumn: model.getLineMaxColumn(entry.line),
          },
          options: {
            isWholeLine: true,
            className: `trust-line-${entry.tone}`,
            linesDecorationsClassName: `trust-gutter-${entry.tone}`,
            ...(entry.text
              ? { after: { content: `  ${entry.text}`, inlineClassName: `trust-inline-${entry.tone}` } }
              : {}),
          },
        })),
    );
    return () => {
      if (!model.isDisposed()) collection.clear();
    };
  }, [decorations, editor]);

  const mounted = (instance: monaco.editor.IStandaloneCodeEditor) => {
    editorRef.current = instance;
    setEditor(instance);
    setEditorReady(true);
    defineThemes(monaco);
    monaco.editor.setTheme(`trust-${theme}`);
    monaco.languages.setLanguageConfiguration(language, {
      comments: { lineComment: "#" },
      brackets: [
        ["{", "}"],
        ["[", "]"],
        ["(", ")"],
      ],
      autoClosingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: '"', close: '"' },
      ],
    });
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
  };

  return (
    <div className="relative h-full" data-doc="editor">
      <EditorResourceNavigation />
      {editorFailed || (languageServerUrl && languageServerStatus === "unavailable") ? (
        <div
          role="status"
          className="absolute top-2 left-14 z-10 rounded-(--radius-1) bg-danger-soft px-2 py-1 text-caption text-danger"
        >
          {t(editorFailed ? "shared.gherkinEditor.editorUnavailable" : "shared.gherkinEditor.unavailable")}
        </div>
      ) : null}
      <div className="absolute top-2 right-4 z-10 flex gap-2" data-doc="editor.format">
        <Button
          size="sm"
          aria-pressed={wordWrap}
          title={t("shared.gherkinEditor.wrapHint")}
          icon={<WrapText size={14} />}
          onClick={() => setWordWrap((current) => !current)}
        >
          {t("shared.gherkinEditor.wrap")}
        </Button>
        {!readOnly ? (
          <Button
            size="sm"
            title={t("shared.gherkinEditor.formatHint")}
            onClick={() => void editorRef.current?.getAction("editor.action.formatDocument")?.run()}
          >
            {t("shared.gherkinEditor.format")}
          </Button>
        ) : null}
      </div>
      {!editorReady ? (
        <div className="absolute inset-0 p-4 text-body text-muted">{t("shared.gherkinEditor.loading")}</div>
      ) : null}
      <TrustMonacoEditor
        className="h-full"
        value={value}
        language={language}
        uri={documentUri.current}
        options={options}
        onReady={mounted}
        onChange={(modified) => {
          if (modified !== currentValue.current) onChange(modified);
        }}
        onError={(error) => {
          console.error("TRUST Monaco initialization failed", error);
          setEditorFailed(true);
        }}
        onDispose={() => {
          editorRef.current = undefined;
          setEditor(undefined);
          setEditorReady(false);
        }}
      />
    </div>
  );
}

function editorOptions(
  readOnly: boolean | undefined,
  fontSize: number,
): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    readOnly: readOnly ?? false,
    minimap: { enabled: false },
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace",
    fontSize,
    lineHeight: Math.round(fontSize * 1.65),
    padding: { top: 44, bottom: 14 },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    quickSuggestions: true,
    wordBasedSuggestions: "off",
    "semanticHighlighting.enabled": true,
    suggestOnTriggerCharacters: true,
    automaticLayout: true,
    renderLineHighlight: "line",
    folding: true,
    showFoldingControls: "always",
    foldingHighlight: false,
    smoothScrolling: true,
    tabSize: 2,
  };
}

/* Read the token layer so Monaco follows the active theme without duplicating colours. */
function token(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = value || fallback;
  // CSS minification produces #rgb/#rgba, but Monaco token colors require full hex.
  return /^#[\da-f]{3,4}$/i.test(color) ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}` : color;
}

function hex(value: string) {
  return value.replace("#", "");
}

export function defineThemes(monacoApi: typeof monaco) {
  const dark = document.documentElement.classList.contains("dark");
  const tokenTones: Record<HighlightTokenTone, readonly [string, string]> = {
    comment: ["--color-editor-comment", "8A93A1"],
    "keyword-control": ["--color-editor-keyword-control", "6B3FA0"],
    keyword: ["--color-editor-keyword", "1E4FC2"],
    text: ["--color-text", dark ? "E6E9EE" : "161A20"],
    type: ["--color-editor-type", "0F766E"],
    verb: ["--color-editor-verb", "7C4A0F"],
    string: ["--color-editor-string", "1F7A4A"],
    number: ["--color-editor-number", "A2620B"],
    "table-line": ["--color-editor-table-line", "C3C9D2"],
    "table-header": ["--color-editor-table-header", "5B6472"],
    reference: ["--color-editor-reference", "245B91"],
    property: ["--color-editor-property", "735526"],
  };
  const define = (name: string, base: "vs" | "vs-dark") =>
    monacoApi.editor.defineTheme(name, {
      base,
      inherit: true,
      rules: highlightTokenTable.map(({ kind, tone, fontStyle }) => {
        const [name, fallback] = tokenTones[tone];
        return { token: kind, foreground: hex(token(name, fallback)), fontStyle };
      }),
      colors: {
        "editor.background": token("--color-editor-bg", dark ? "#161a21" : "#ffffff"),
        "editor.foreground": token("--color-text", dark ? "#e6e9ee" : "#161a20"),
        "editorLineNumber.foreground": token("--color-editor-gutter", "#8a93a1"),
        "editorLineNumber.activeForeground": token("--color-text", "#161a20"),
        "editor.lineHighlightBackground": token("--color-surface-2", dark ? "#1b2029" : "#f6f7f9"),
        "editorGutter.background": token("--color-editor-bg", dark ? "#161a21" : "#ffffff"),
        "editorIndentGuide.background1": token("--color-border", "#dfe3e8"),
        "editorWidget.background": token("--color-surface", "#ffffff"),
        "editorWidget.border": token("--color-border", "#dfe3e8"),
        "editorSuggestWidget.background": token("--color-surface", "#ffffff"),
        "editorSuggestWidget.border": token("--color-border", "#dfe3e8"),
        "editorSuggestWidget.selectedBackground": token("--color-surface-3", "#e9ecf1"),
        focusBorder: token("--color-border-focus", "#2f6feb"),
      },
    });
  define("trust-light", "vs");
  define("trust-dark", "vs-dark");
}
