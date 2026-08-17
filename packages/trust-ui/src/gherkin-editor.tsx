import Editor, { type BeforeMount, type Monaco, type OnMount } from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatGherkinSource } from "@trust/gherkin/format";
import { WrapText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { editor, IDisposable } from "monaco-editor";

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
  operations?: string[] | undefined;
  readOnly?: boolean | undefined;
  markers?: EditorMarker[] | undefined;
  decorations?: EditorDecoration[] | undefined;
  fontSize?: number | undefined;
  onSave?: (() => void) | undefined;
}

const commonKeywords = ["Feature", "Background", "Scenario", "Given", "When", "Then", "And", "But"];
const markerOwner = "trust";

export function GherkinEditor({ kind, value, onChange, theme, operations = [], readOnly, markers = [], decorations = [], fontSize = 13, onSave }: GherkinEditorProps) {
  const { t } = useTranslation();
  const provider = useRef<IDisposable | undefined>(undefined);
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const [mountedAt, setMountedAt] = useState(0);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const language = `trust-${kind}`;
  const completions = useMemo(() => completionItems(kind, operations, t), [kind, operations, t]);

  useEffect(() => () => provider.current?.dispose(), []);

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
      monaco.languages.setMonarchTokensProvider(language, {
        cellTypes: ["string", "number", "instant", "reference", "directory", "url", "one", "many", "literal", "input", "any", "JSON", "Text", "text", "json"],
        tokenizer: {
          root: [
            [/^\s*#.*$/, "comment"],
            [/(@[\w-]+:)([\w.-]+)/, ["tag", "tag.value"]],
            [/@[\w.:-]+/, "tag"],
            [/^\s*"""\s*$/, { token: "string.doc.fence", next: "@docstring" }],
            [/^(\s*)(Feature)(:)(.*)$/, ["", "keyword.control", "delimiter", "title"]],
            [/^(\s*)(Background|Scenario(?: Outline)?|Examples)(:)(.*)$/, ["", "keyword.control", "delimiter", "title.section"]],
            [/^\s*(Given|When|Then)\b/, "keyword"],
            [/^\s*(And|But)\b/, "keyword.continuation"],
            [/\b(Environment|Input|Produced fields|Shell|File|HTTP|Check|Plan input|Operation)\b/, "type"],
            [/\b(runs|with cwd from|accepts exits|gets|appending|posts|as JSON to|as|from|reads|and reads|Produce with JSONata|uses operation|must establish|is satisfied when every|is validated|equals|value|failure reason|success reason|no prerequisite scenario|one reference)\b/, "verb"],
            [/^\s*\|/, { token: "delimiter.table", next: "@tableHeader" }],
            [/"[^"\\]*(?:\\.[^"\\]*)*"/, "string"],
            [/\b\d+(?:\.\d+)?\b/, "number"],
            [/<[^>]+>/, "variable"],
          ],
          // Header row: entered from root on the first "|" of a table; the state survives to the next line,
          // where a leading "|" means a data row and anything else hands the line back to root.
          tableHeader: [
            [/^\s*\|/, { token: "delimiter.table", switchTo: "@tableRows" }],
            [/^\s*(?=\S)/, { token: "@rematch", next: "@pop" }],
            [/\|/, "delimiter.table"],
            [/[^|]+/, "string.table.header"],
          ],
          tableRows: [
            [/^\s*(?=\S)(?!\|)/, { token: "@rematch", next: "@pop" }],
            [/\|/, "delimiter.table"],
            [/\s+/, ""],
            [/"[^"\\]*(?:\\.[^"\\]*)*"/, "string"],
            [/\b\d+(?:\.\d+)?\b/, "number"],
            [/enum\b/, "verb"],
            [/[A-Za-z][\w-]*/, { cases: { "@cellTypes": "type.cell", "@default": "string.table.cell" } }],
            [/[^|\s"]+/, "string.table.cell"],
          ],
          docstring: [
            [/^\s*"""\s*$/, { token: "string.doc.fence", next: "@pop" }],
            [/"[^"\\]*(?:\\.[^"\\]*)*"(?=\s*:)/, "string.doc.key"],
            [/"[^"\\]*(?:\\.[^"\\]*)*"/, "string.doc.value"],
            [/\$[a-zA-Z]+/, "string.doc.function"],
            [/\b(input|environment|steps)\b/, "string.doc.root"],
            [/\b\d+(?:\.\d+)?\b/, "number"],
            [/[{}\[\]()]/, "delimiter.bracket"],
            [/[?:=<>!&|]+/, "operator"],
            [/[.,]/, "delimiter"],
            [/[A-Za-z_][\w]*/, "string.doc.path"],
            [/\s+/, ""],
            [/./, "string.doc"],
          ],
        },
      });
      // "Format document" (Shift+Alt+F / context menu): re-flows long steps onto continuation lines.
      monaco.languages.registerDocumentFormattingEditProvider(language, {
        provideDocumentFormattingEdits: (model: editor.ITextModel) => {
          const source = model.getValue();
          const formatted = formatGherkinSource(source);
          return formatted === source ? [] : [{ range: model.getFullModelRange(), text: formatted }];
        },
      });
      monaco.languages.registerFoldingRangeProvider(language, {
        provideFoldingRanges: (model: editor.ITextModel) => foldingRanges(model.getLinesContent(), monaco),
      });
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
    provider.current?.dispose();
    provider.current = monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: [" ", '"', "@"],
      provideCompletionItems: (model: editor.ITextModel, position: { lineNumber: number; column: number }) => ({
        suggestions: completions.map((item) => ({
          ...item,
          range: wordRange(model, position),
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        })),
      }),
    });
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
  };

  return (
    <div className="relative h-full">
    {!readOnly ? (
      <div className="absolute top-2 right-4 z-10">
        <IconButton size="sm" label={t("shared.gherkinEditor.format")} title={t("shared.gherkinEditor.formatHint")} onClick={() => void editorRef.current?.getAction("editor.action.formatDocument")?.run()}>
          <WrapText size={14} />
        </IconButton>
      </div>
    ) : null}
    <Editor
      height="100%"
      language={language}
      value={value}
      beforeMount={configure}
      onMount={mounted}
      onChange={(next) => onChange(next ?? "")}
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
      rules: [
        { token: "keyword", foreground: hex(token("--color-editor-keyword", "1E4FC2")), fontStyle: "bold" },
        { token: "keyword.continuation", foreground: hex(token("--color-editor-keyword", "1E4FC2")) },
        { token: "keyword.control", foreground: hex(token("--color-editor-keyword-control", "6B3FA0")), fontStyle: "bold" },
        { token: "title", foreground: hex(token("--color-text", "161A20")), fontStyle: "bold" },
        { token: "title.section", foreground: hex(token("--color-text", "161A20")) },
        { token: "type", foreground: hex(token("--color-editor-type", "0F766E")) },
        { token: "type.cell", foreground: hex(token("--color-editor-type", "0F766E")) },
        { token: "verb", foreground: hex(token("--color-editor-verb", "7C4A0F")), fontStyle: "italic" },
        { token: "string", foreground: hex(token("--color-editor-string", "1F7A4A")) },
        { token: "number", foreground: hex(token("--color-editor-number", "A2620B")) },
        { token: "string.doc", foreground: hex(token("--color-text", "161A20")) },
        { token: "string.doc.fence", foreground: hex(token("--color-editor-comment", "8A93A1")) },
        { token: "string.doc.key", foreground: hex(token("--color-editor-keyword", "1E4FC2")) },
        { token: "string.doc.value", foreground: hex(token("--color-editor-string", "1F7A4A")) },
        { token: "string.doc.function", foreground: hex(token("--color-editor-keyword-control", "6B3FA0")) },
        { token: "string.doc.root", foreground: hex(token("--color-editor-type", "0F766E")), fontStyle: "bold" },
        { token: "string.doc.path", foreground: hex(token("--color-text", "161A20")) },
        { token: "operator", foreground: hex(token("--color-editor-verb", "7C4A0F")) },
        { token: "delimiter.bracket", foreground: hex(token("--color-text-muted", "5B6472")) },
        { token: "delimiter", foreground: hex(token("--color-text-muted", "5B6472")) },
        { token: "string.table.header", foreground: hex(token("--color-editor-table-header", "5B6472")), fontStyle: "bold" },
        { token: "string.table.cell", foreground: hex(token("--color-text", "161A20")) },
        { token: "delimiter.table", foreground: hex(token("--color-editor-table-line", "C3C9D2")) },
        { token: "tag", foreground: hex(token("--color-editor-comment", "8A93A1")), fontStyle: "italic" },
        { token: "tag.value", foreground: hex(token("--color-editor-type", "0F766E")), fontStyle: "italic" },
        { token: "comment", foreground: hex(token("--color-editor-comment", "8A93A1")), fontStyle: "italic" },
        { token: "variable", foreground: hex(token("--color-editor-verb", "7C4A0F")) },
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

interface CompletionTemplate { label: string; insertText: string; detail: string; documentation?: string | undefined }
const snippet = (label: string, insertText: string, documentation?: string) => ({ label, insertText, documentation });

function completionItems(kind: LanguageKind, operations: string[], t: TFunction): CompletionTemplate[] {
  const grammar =
    kind === "operation"
      ? [
          snippet(
            t("shared.gherkinEditor.snippets.operationFeature"),
            '# language: en\n@trust-dsl:1 @operation:${1:domain.action} @version:${2:1.0.0}\nFeature: ${3:What this operation observes}\n\n  Background: Operation interface\n    Given Environment\n      | name        | type      |\n      | ${4:workspaceRoot} | ${5:directory} |\n    And Input\n      | input   | type      | cardinality |\n      | ${6:project} | ${7:reference} | one         |\n    And Produced fields\n      | field  | type   | cardinality | domain |\n      | ${8:result} | ${9:string} | one         | any    |\n\n  Scenario: Run\n    When Shell "${10:step}" runs "${11:git}" with cwd from Environment "${4:workspaceRoot}"\n      | argument | source  |\n      | ${12:status} | literal |\n    Then Produce with JSONata\n      """\n      {\n        "${8:result}": $trim(steps.${10:step}.stdout)\n      }\n      """',
            t("shared.gherkinEditor.snippets.operationFeatureDoc"),
          ),
          snippet(t("shared.gherkinEditor.snippets.environmentTable"), "Given Environment\n  | name | type |\n  | ${1:workspaceRoot} | ${2|directory,url|} |"),
          snippet(t("shared.gherkinEditor.snippets.inputTable"), "And Input\n  | input | type | cardinality |\n  | ${1:project} | ${2|string,number,instant,reference|} | ${3|one,many|} |"),
          snippet(t("shared.gherkinEditor.snippets.producedFieldsTable"), 'And Produced fields\n  | field | type | cardinality | domain |\n  | ${1:field} | ${2|string,number,instant,reference|} | ${3|one,many|} | ${4:any} |'),
          snippet(t("shared.gherkinEditor.snippets.shellStep"), 'When Shell "${1:step}" runs "${2:git}" with cwd from Environment "${3:workspaceRoot}"\n  | argument | source  |\n  | ${4:status} | literal |'),
          snippet(t("shared.gherkinEditor.snippets.shellArgumentFromInput"), "| ${1:value} | input ${2:project} |"),
          snippet(t("shared.gherkinEditor.snippets.shellAcceptedExits"), 'And Shell "${1:step}" accepts exits\n  | exit code | stdout contains | stderr contains |\n  | 0         |                 |                 |\n  | ${2:1}         |                 |                 |'),
          snippet(t("shared.gherkinEditor.snippets.httpGetStep"), 'When HTTP "${1:step}" gets Environment "${2:serviceUrl}" as ${3|JSON,Text|}'),
          snippet(t("shared.gherkinEditor.snippets.httpGetStepAppendingInput"), 'When HTTP "${1:step}" gets Environment "${2:serviceUrl}" appending Input "${3:id}" as JSON'),
          snippet(t("shared.gherkinEditor.snippets.httpPostStep"), 'When HTTP "${1:step}" posts Input as JSON to Environment "${2:serviceUrl}" and reads JSON'),
          snippet(t("shared.gherkinEditor.snippets.fileReadStep"), 'When File "${1:step}" reads "${2:relative/path.txt}" as ${3|Text,JSON|} from Environment "${4:workspaceRoot}"'),
          snippet(t("shared.gherkinEditor.snippets.produceWithJsonata"), 'Then Produce with JSONata\n  """\n  {\n    "${1:field}": ${2:steps.step.stdout}\n  }\n  """'),
        ]
      : [
          snippet(
            t("shared.gherkinEditor.snippets.procedureFeature"),
            'Feature: ${1:procedure name}\n  Version: ${2:1.0.0}\n\n  Background:\n    Given Plan input ${3:project} is a reference\n\n  Scenario: ${4:First stage}\n    Given no prerequisite scenario\n    When Check ${5:check name} uses operation ${6:operation}\n    Then ${7:result} equals "${8:value}"\n    And success reason is "${9:Requirement is satisfied}"',
          ),
          snippet(
            t("shared.gherkinEditor.snippets.scenario"),
            'Scenario: ${1:Stage}\n  Given scenario ${2:previous-stage} is satisfied\n  When Check ${3:check name} uses operation ${4:operation}\n  Then ${5:field} equals "${6:value}"\n  And success reason is "${7:Requirement is satisfied}"',
          ),
          ...operations.map((operation) => snippet(t("shared.gherkinEditor.snippets.useOperation", { operation }), `When Check \${1:check name} uses operation ${operation}`)),
        ];
  return [
    ...commonKeywords.map((keyword) => ({ label: keyword, insertText: `${keyword}: `, detail: t("shared.gherkinEditor.gherkinKeyword") })),
    ...grammar.map(({ label, insertText, documentation }) => ({ label, insertText, documentation, detail: t("shared.gherkinEditor.grammar", { kind }) })),
  ];
}

/* Folding: Background / Scenario blocks, each step with its table, tables and doc strings. */
function foldingRanges(lines: string[], monaco: Monaco) {
  const ranges: Array<{ start: number; end: number; kind?: import("monaco-editor").languages.FoldingRangeKind }> = [];
  const isBlock = (line: string) => /^\s*(Background|Scenario(?: Outline)?|Examples)\b/.test(line);
  const isStep = (line: string) => /^\s*(Given|When|Then|And|But)\b/.test(line);
  const isTable = (line: string) => /^\s*\|/.test(line);
  const isDoc = (line: string) => /^\s*"""\s*$/.test(line);
  const lastContent = (from: number, to: number) => {
    let end = to;
    while (end > from && lines[end]!.trim() === "") end -= 1;
    return end;
  };

  let block = -1;
  let step = -1;
  let table = -1;
  let doc = -1;
  const closeStep = (index: number) => {
    if (step >= 0 && index - 1 > step) ranges.push({ start: step + 1, end: lastContent(step, index - 1) + 1 });
    step = -1;
  };
  const closeTable = (index: number) => {
    if (table >= 0 && index - 1 > table) ranges.push({ start: table + 1, end: index, kind: monaco.languages.FoldingRangeKind.Region });
    table = -1;
  };

  lines.forEach((line, index) => {
    if (doc >= 0) {
      if (isDoc(line)) {
        ranges.push({ start: doc + 1, end: index + 1 });
        doc = -1;
      }
      return;
    }
    if (isDoc(line)) {
      closeTable(index);
      doc = index;
      return;
    }
    if (isTable(line)) {
      if (table < 0) table = index;
      return;
    }
    closeTable(index);
    if (isBlock(line)) {
      closeStep(index);
      if (block >= 0) ranges.push({ start: block + 1, end: lastContent(block, index - 1) + 1 });
      block = index;
      return;
    }
    if (isStep(line)) {
      closeStep(index);
      step = index;
    }
  });
  closeTable(lines.length);
  closeStep(lines.length);
  if (block >= 0 && lines.length - 1 > block) ranges.push({ start: block + 1, end: lastContent(block, lines.length - 1) + 1 });
  return ranges.filter((range) => range.end > range.start);
}

function wordRange(model: editor.ITextModel, position: { lineNumber: number; column: number }) {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
}
