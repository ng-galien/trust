import Editor, { type BeforeMount, type Monaco, type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { WrapText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { editor, IDisposable } from "monaco-editor";

import { monacoCompletionKind, monacoMarker, TrustLspClient } from "./lsp-client.js";
import { IconButton } from "./ui/button.js";

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
const lspMarkerOwner = "trust-lsp";

export function GherkinEditor({ kind, value, onChange, theme, languageServerUrl, readOnly, markers = [], decorations = [], fontSize = 13, onSave }: GherkinEditorProps) {
  const { t } = useTranslation();
  const providers = useRef<IDisposable[]>([]);
  const lspRef = useRef<TrustLspClient | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const [mountedAt, setMountedAt] = useState(0);
  const [languageServerStatus, setLanguageServerStatus] = useState<"connecting" | "ready" | "unavailable">("connecting");
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const language = `trust-${kind}`;

  useEffect(() => () => {
    providers.current.forEach((provider) => provider.dispose());
    lspRef.current?.dispose();
  }, []);

  // Themes are rebuilt from the token layer whenever the theme flips.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    defineThemes(monaco);
    monaco.editor.setTheme(`trust-${theme}`);
  }, [theme]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
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
  }, [markers]);

  // React Router can reuse the same editor while the selected resource changes.
  // Keep the LSP document synchronized with controlled-value updates as well as typing.
  useEffect(() => {
    if (mountedAt > 0) void lspRef.current?.change(value);
  }, [mountedAt, value]);

  // Hydration decorations: whole-line tone + inline note; re-applied whenever they change (or the editor mounts).
  useEffect(() => {
    const instance = editorRef.current;
    const model = instance?.getModel();
    if (!instance || !model) return;
    decorationsRef.current ??= instance.createDecorationsCollection();
    decorationsRef.current.set(decorations.filter((entry) => entry.line >= 1 && entry.line <= model.getLineCount()).map((entry) => ({
      range: { startLineNumber: entry.line, startColumn: 1, endLineNumber: entry.line, endColumn: model.getLineMaxColumn(entry.line) },
      options: {
        isWholeLine: true,
        className: `trust-line-${entry.tone}`,
        linesDecorationsClassName: `trust-gutter-${entry.tone}`,
        ...(entry.text ? { after: { content: `  ${entry.text}`, inlineClassName: `trust-inline-${entry.tone}` } } : {}),
      },
    })));
  }, [decorations, mountedAt]);

  const configure: BeforeMount = (monaco) => {
    monacoRef.current = monaco;
    if (!monaco.languages.getLanguages().some((entry: { id: string }) => entry.id === language)) {
      monaco.languages.register({ id: language });
      monaco.languages.setLanguageConfiguration(language, {
        comments: { lineComment: "#" },
        brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
        autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: '"', close: '"' }],
      });
    }
    defineThemes(monaco);
  };

  const mounted: OnMount = (instance, monaco) => {
    editorRef.current = instance;
    setMountedAt((count) => count + 1);
    providers.current.forEach((provider) => provider.dispose());
    providers.current = [];
    lspRef.current?.dispose();
    if (languageServerUrl) {
      const client = new TrustLspClient({
        url: languageServerUrl,
        kind,
        source: instance.getValue(),
        diagnostics: (diagnostics) => {
          const model = instance.getModel();
          if (model) monaco.editor.setModelMarkers(model, lspMarkerOwner, diagnostics.map(monacoMarker));
        },
        status: setLanguageServerStatus,
      });
      lspRef.current = client;
      if (!readOnly) {
        providers.current.push(monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: [" ", '"', ".", "$", "@"],
        provideCompletionItems: async (model: editor.ITextModel, position: { lineNumber: number; column: number }) => {
          const completions = await client.complete(position.lineNumber - 1, position.column - 1).catch(() => []);
          // Replace ranges are the server's decision: completions carry a textEdit whenever the
          // prefix matters. The fallback is plain Monaco word detection, no language knowledge.
          const word = model.getWordUntilPosition(position);
          const wordRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          return {
            suggestions: completions.map((completion) => ({
              label: completion.label,
              detail: completion.detail,
              documentation: typeof completion.documentation === "string" ? completion.documentation : completion.documentation?.value,
              insertText: completion.textEdit?.newText ?? completion.insertText ?? completion.label,
              kind: monacoCompletionKind(completion.kind, monaco),
              range: completion.textEdit ? {
                startLineNumber: completion.textEdit.range.start.line + 1,
                startColumn: completion.textEdit.range.start.character + 1,
                endLineNumber: completion.textEdit.range.end.line + 1,
                endColumn: completion.textEdit.range.end.character + 1,
              } : wordRange,
              ...(completion.insertTextFormat === 2 ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
            })),
          };
        },
        }));
        providers.current.push(monaco.languages.registerDocumentFormattingEditProvider(language, {
          provideDocumentFormattingEdits: async () => (await client.format(2, true).catch(() => [])).map((edit) => ({
            range: {
              startLineNumber: edit.range.start.line + 1,
              startColumn: edit.range.start.character + 1,
              endLineNumber: edit.range.end.line + 1,
              endColumn: edit.range.end.character + 1,
            },
            text: edit.newText,
          })),
        }));
      }
      providers.current.push(monaco.languages.registerFoldingRangeProvider(language, {
        provideFoldingRanges: async () => (await client.foldingRanges().catch(() => [])).map((range) => ({
          start: range.startLine + 1,
          end: range.endLine + 1,
          kind: range.kind === "comment" ? monaco.languages.FoldingRangeKind.Comment : monaco.languages.FoldingRangeKind.Region,
        })),
      }));
      providers.current.push(monaco.languages.registerDocumentSemanticTokensProvider(language, {
        getLegend: () => ({ tokenTypes: ["comment", "keyword", "string", "number", "operator", "type", "variable", "function", "property"], tokenModifiers: [] }),
        provideDocumentSemanticTokens: async () => ({ data: new Uint32Array((await client.semanticTokens().catch(() => ({ data: [] }))).data) }),
        releaseDocumentSemanticTokens: () => undefined,
      }));
    }
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
  };

  return (
    <div className="relative h-full" data-doc="editor">
    {languageServerUrl && languageServerStatus === "unavailable" ? (
      <div role="status" className="absolute top-2 left-14 z-10 rounded-(--radius-1) bg-danger-soft px-2 py-1 text-caption text-danger">
        {t("shared.gherkinEditor.unavailable")}
      </div>
    ) : null}
    {!readOnly ? (
      <div className="absolute top-2 right-4 z-10" data-doc="editor.format">
        <IconButton size="sm" label={t("shared.gherkinEditor.format")} title={t("shared.gherkinEditor.formatHint")} onClick={() => void editorRef.current?.getAction("editor.action.formatDocument")?.run()}>
          <WrapText size={14} />
        </IconButton>
      </div>
    ) : null}
    <Editor
      key={`${language}:${languageServerUrl ?? "offline"}`}
      height="100%"
      language={language}
      value={value}
      beforeMount={configure}
      onMount={mounted}
      onChange={(next) => {
        const source = next ?? "";
        onChange(source);
      }}
      theme={`trust-${theme}`}
      loading={<div className="p-4 text-body text-muted">{t("shared.gherkinEditor.loading")}</div>}
      options={{
        readOnly: readOnly ?? false,
        minimap: { enabled: false },
        fontFamily: "JetBrains Mono Variable, ui-monospace, monospace",
        fontSize,
        lineHeight: Math.round(fontSize * 1.65),
        padding: { top: 14, bottom: 14 },
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
      }}
    />
    </div>
  );
}

/* Read the token layer so Monaco follows the active theme without duplicating colours. */
function token(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function hex(value: string) {
  return value.replace("#", "");
}

export function defineThemes(monaco: Monaco) {
  const dark = document.documentElement.classList.contains("dark");
  const define = (name: string, base: "vs" | "vs-dark") =>
    monaco.editor.defineTheme(name, {
      base,
      inherit: true,
      semanticHighlighting: true,
      rules: [
        { token: "keyword", foreground: hex(token("--color-editor-keyword", "1E4FC2")), fontStyle: "bold" },
        { token: "type", foreground: hex(token("--color-editor-type", "0F766E")) },
        { token: "string", foreground: hex(token("--color-editor-string", "1F7A4A")) },
        { token: "number", foreground: hex(token("--color-editor-number", "A2620B")) },
        { token: "operator", foreground: hex(token("--color-editor-verb", "7C4A0F")) },
        { token: "comment", foreground: hex(token("--color-editor-comment", "8A93A1")), fontStyle: "italic" },
        { token: "variable", foreground: hex(token("--color-editor-verb", "7C4A0F")) },
        { token: "function", foreground: hex(token("--color-editor-keyword-control", "6B3FA0")) },
        { token: "property", foreground: hex(token("--color-editor-table-header", "5B6472")), fontStyle: "bold" },
      ],
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
        "focusBorder": token("--color-border-focus", "#2f6feb"),
      },
    });
  define("trust-light", "vs");
  define("trust-dark", "vs-dark");
}

