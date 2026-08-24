import type { editor, languages } from "monaco-editor";

interface RpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface LspDiagnostic {
  readonly message: string;
  readonly severity?: number;
  readonly range: LspRange;
}

interface LspRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface LspCompletion {
  readonly label: string;
  readonly kind?: number;
  readonly detail?: string;
  readonly documentation?: string | { readonly value?: string };
  readonly insertText?: string;
  readonly insertTextFormat?: number;
  readonly textEdit?: LspTextEdit;
}

export interface LspFoldingRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly kind?: string;
}

export interface LspTextEdit {
  readonly range: LspRange;
  readonly newText: string;
}

export interface LspSemanticTokens { readonly data: readonly number[] }

type LspStatus = "connecting" | "ready" | "unavailable";
type ReadyWaiter = { resolve(): void; reject(error: Error): void };

/** Minimal standard LSP client for Monaco; language behavior remains entirely server-owned. */
export class TrustLspClient {
  readonly #url: string;
  readonly #uri: string;
  readonly #languageId: string;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly #readyWaiters = new Set<ReadyWaiter>();
  readonly #diagnostics: (diagnostics: readonly LspDiagnostic[]) => void;
  readonly #status: (status: LspStatus) => void;
  #socket: WebSocket | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #requestId = 0;
  #version = 1;
  #opened = false;
  #ready = false;
  #disposed = false;
  #source: string;

  constructor({ url, kind, source, diagnostics, status }: {
    url: string;
    kind: "operation" | "procedure";
    source: string;
    diagnostics: (diagnostics: readonly LspDiagnostic[]) => void;
    status: (status: LspStatus) => void;
  }) {
    this.#url = url;
    this.#uri = `inmemory://trust/${kind}/${crypto.randomUUID()}.feature`;
    this.#languageId = `trust-${kind}`;
    this.#source = source;
    this.#diagnostics = diagnostics;
    this.#status = status;
    this.#connect();
  }

  async change(source: string): Promise<void> {
    this.#source = source;
    this.#version += 1;
    // didOpen sends the latest source after a reconnect. Do not queue stale
    // intermediate edits while the socket is unavailable.
    if (!this.#ready || this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#notify("textDocument/didChange", {
      textDocument: { uri: this.#uri, version: this.#version },
      contentChanges: [{ text: source }],
    });
  }

  async complete(line: number, character: number): Promise<readonly LspCompletion[]> {
    const result = await this.#request("textDocument/completion", {
      textDocument: { uri: this.#uri },
      position: { line, character },
    });
    return Array.isArray(result) ? result as LspCompletion[] : (result as { items?: LspCompletion[] } | null)?.items ?? [];
  }

  async format(tabSize: number, insertSpaces: boolean): Promise<readonly LspTextEdit[]> {
    const result = await this.#request("textDocument/formatting", {
      textDocument: { uri: this.#uri }, options: { tabSize, insertSpaces },
    });
    return Array.isArray(result) ? result as LspTextEdit[] : [];
  }

  async foldingRanges(): Promise<readonly LspFoldingRange[]> {
    const result = await this.#request("textDocument/foldingRange", { textDocument: { uri: this.#uri } });
    return Array.isArray(result) ? result as LspFoldingRange[] : [];
  }

  async semanticTokens(): Promise<LspSemanticTokens> {
    const result = await this.#request("textDocument/semanticTokens/full", { textDocument: { uri: this.#uri } });
    return result && Array.isArray((result as LspSemanticTokens).data) ? result as LspSemanticTokens : { data: [] };
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#rejectReadyWaiters(new Error("TRUST language server connection closed"));
    const socket = this.#socket;
    if (this.#opened && socket?.readyState === WebSocket.OPEN) {
      this.#notify("textDocument/didClose", { textDocument: { uri: this.#uri } });
    }
    socket?.close();
    this.#rejectPending(new Error("TRUST language server connection closed"));
  }

  #connect(): void {
    if (this.#disposed) return;
    this.#ready = false;
    this.#opened = false;
    this.#status("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#url);
    } catch (error) {
      this.#markUnavailable(asError(error));
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.#socket === socket) this.#receive(String(event.data));
    });
    socket.addEventListener("open", async () => {
      try {
        await this.#sendRequest("initialize", {
          processId: null,
          rootUri: null,
          capabilities: {
            textDocument: {
              completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              foldingRange: {},
              semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ["relative"] },
            },
          },
        }, socket);
        if (this.#disposed || this.#socket !== socket) return;
        this.#notify("initialized", {});
        this.#notify("textDocument/didOpen", {
          textDocument: { uri: this.#uri, languageId: this.#languageId, version: this.#version, text: this.#source },
        });
        this.#opened = true;
        this.#ready = true;
        this.#reconnectAttempt = 0;
        this.#status("ready");
        this.#resolveReadyWaiters();
      } catch (error) {
        if (this.#socket !== socket) return;
        this.#markUnavailable(asError(error));
        socket.close();
        this.#scheduleReconnect();
      }
    }, { once: true });
    socket.addEventListener("error", () => {
      if (this.#socket !== socket || this.#disposed) return;
      this.#markUnavailable(new Error("TRUST language server connection failed"));
      this.#scheduleReconnect();
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket || this.#disposed) return;
      this.#socket = undefined;
      this.#ready = false;
      this.#opened = false;
      this.#markUnavailable(new Error("TRUST language server connection closed"));
      this.#scheduleReconnect();
    });
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    await this.#whenReady();
    return this.#sendRequest(method, params);
  }

  #sendRequest(method: string, params: unknown, socket = this.#socket): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (socket?.readyState !== WebSocket.OPEN) {
        reject(new Error("TRUST language server connection is unavailable"));
        return;
      }
      const id = ++this.#requestId;
      this.#pending.set(id, { resolve, reject });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        const failure = asError(error);
        this.#markUnavailable(failure);
        reject(failure);
      }
    });
  }

  #notify(method: string, params: unknown): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      this.#markUnavailable(new Error("TRUST language server connection is unavailable"));
      return;
    }
    try {
      this.#socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    } catch (error) {
      this.#markUnavailable(asError(error));
    }
  }

  #receive(raw: string): void {
    const message = JSON.parse(raw) as RpcMessage;
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] };
      if (params.uri === this.#uri) this.#diagnostics(params.diagnostics ?? []);
    }
  }

  #markUnavailable(error: Error): void {
    this.#ready = false;
    if (!this.#disposed) this.#status("unavailable");
    this.#rejectPending(error);
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#reconnectTimer) return;
    const delay = Math.min(250 * 2 ** this.#reconnectAttempt, 2_000);
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }

  #whenReady(): Promise<void> {
    if (this.#ready && this.#socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.#disposed) return Promise.reject(new Error("TRUST language server connection closed"));
    return new Promise<void>((resolve, reject) => this.#readyWaiters.add({ resolve, reject }));
  }

  #resolveReadyWaiters(): void {
    for (const waiter of this.#readyWaiters) waiter.resolve();
    this.#readyWaiters.clear();
  }

  #rejectReadyWaiters(error: Error): void {
    for (const waiter of this.#readyWaiters) waiter.reject(error);
    this.#readyWaiters.clear();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function monacoMarker(diagnostic: LspDiagnostic): editor.IMarkerData {
  return {
    message: diagnostic.message,
    severity: diagnostic.severity === 2 ? 4 : diagnostic.severity === 3 ? 2 : 8,
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  };
}

/* Complete LSP → Monaco CompletionItemKind mapping: LSP 3.17 numbering, identical kind names on both sides. */
const lspCompletionKinds = [
  "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module",
  "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder",
  "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter",
] as const;

export function monacoCompletionKind(kind: number | undefined, monaco: typeof import("monaco-editor")): languages.CompletionItemKind {
  return monaco.languages.CompletionItemKind[lspCompletionKinds[(kind ?? 1) - 1] ?? "Text"];
}
