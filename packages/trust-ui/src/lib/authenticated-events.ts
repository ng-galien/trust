import { authenticatedFetch } from "./authentication.js";

/** Fetch-based SSE carries the bearer header; credentials never enter the URL. */
export class AuthenticatedEventSource extends EventTarget {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #controller = new AbortController();
  #lastEventId = "";
  constructor(
    readonly url: string,
    private readonly request: typeof authenticatedFetch = authenticatedFetch,
  ) {
    super();
    void this.#run();
  }
  close(): void {
    this.readyState = 2;
    this.#controller.abort();
  }
  async #run(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      try {
        const response = await this.request(this.url, {
          signal: this.#controller.signal,
          headers: {
            accept: "text/event-stream",
            ...(this.#lastEventId ? { "last-event-id": this.#lastEventId } : {}),
          },
        });
        if (!response.ok || !response.body) throw new Error("Event stream unavailable");
        this.readyState = 1;
        this.onopen?.(new Event("open"));
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!this.#controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let type = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) type = line.slice(6).trimStart();
              if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
              if (line.startsWith("id:")) this.#lastEventId = line.slice(3).trimStart();
            }
            if (data.length)
              this.dispatchEvent(new MessageEvent(type, { data: data.join("\n"), lastEventId: this.#lastEventId }));
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (this.#controller.signal.aborted) return;
      }
      if (this.#controller.signal.aborted) return;
      this.readyState = 0;
      this.onerror?.(new Event("error"));
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.#controller.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 3000);
        this.#controller.signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}
