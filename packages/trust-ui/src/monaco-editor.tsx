import * as monaco from "@codingame/monaco-vscode-editor-api";
import { useEffect, useRef } from "react";

import { initializeTrustMonaco } from "./monaco-stack.js";

interface TrustMonacoEditorProps {
  value: string;
  language: string;
  uri: string;
  options: monaco.editor.IStandaloneEditorConstructionOptions;
  className?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  onReady?: ((editor: monaco.editor.IStandaloneCodeEditor) => void) | undefined;
  onDispose?: (() => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
}

/** Thin React ownership adapter around the stable Monaco/VS Code editor services. */
export function TrustMonacoEditor({ value, language, uri, options, className, onChange, onReady, onDispose, onError }: TrustMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const modelRef = useRef<monaco.editor.ITextModel | undefined>(undefined);
  const valueRef = useRef(value);
  const languageRef = useRef(language);
  const optionsRef = useRef(options);
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  const onDisposeRef = useRef(onDispose);
  const onErrorRef = useRef(onError);
  valueRef.current = value;
  languageRef.current = language;
  optionsRef.current = options;
  onChangeRef.current = onChange;
  onReadyRef.current = onReady;
  onDisposeRef.current = onDispose;
  onErrorRef.current = onError;

  useEffect(() => {
    let active = true;
    let changeSubscription: monaco.IDisposable | undefined;
    void initializeTrustMonaco().then(() => {
      if (!active || !containerRef.current) return;
      if (!monaco.languages.getLanguages().some((entry) => entry.id === languageRef.current)) {
        monaco.languages.register({ id: languageRef.current });
      }
      const model = monaco.editor.createModel(valueRef.current, languageRef.current, monaco.Uri.parse(uri));
      const editor = monaco.editor.create(containerRef.current, { ...optionsRef.current, model });
      modelRef.current = model;
      editorRef.current = editor;
      changeSubscription = model.onDidChangeContent(() => onChangeRef.current?.(model.getValue()));
      onReadyRef.current?.(editor);
    }).catch((error: unknown) => {
      onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
    });

    return () => {
      active = false;
      changeSubscription?.dispose();
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = undefined;
      modelRef.current = undefined;
      onDisposeRef.current?.();
    };
  }, [uri]);

  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions(options);
  }, [options]);

  return <div ref={containerRef} className={className} style={{ height: "100%" }} />;
}
