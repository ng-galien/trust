import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { ExtensionDescriptor, ExtensionState, Installation } from "@trust/extension-sdk";
import { extensionToolName, readInstallations } from "./manifest.js";

export interface CommandResult {
  status: number;
  body: unknown;
  text: string;
}

export class ExtensionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super("Extension request could not be completed.");
  }
}
export class ExtensionInstance {
  state: ExtensionState = "STOPPED";
  error: { code: string; message: string } | undefined;
  readonly events = new EventEmitter();
  #child: ChildProcess | undefined;
  #sequence = 0;
  #pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly installation: Installation,
    readonly timeout: number,
  ) {}
  descriptor(): ExtensionDescriptor {
    const { id, title, version, ui } = this.installation;
    return {
      id,
      title,
      version,
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      apiBase: `/extensions/${id}/api`,
      ...(this.state === "RUNNING" && ui
        ? { ui: { name: ui.name, entry: `/extensions/${id}/assets/${ui.entry}`, module: ui.module } }
        : {}),
    };
  }
  requireRunning() {
    if (this.state !== "RUNNING") throw new ExtensionError(409, "extension-not-running");
  }
  requireGrant(grant: string) {
    if (!this.installation.grants.includes(grant)) throw new ExtensionError(403, "extension-capability-denied");
  }
  async read(input: unknown) {
    this.requireRunning();
    return this.#call("read", input);
  }
  async command(input: unknown): Promise<CommandResult> {
    this.requireRunning();
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ExtensionError(400, "invalid-extension-command");
    const envelope = input as Record<string, unknown>;
    if (
      Object.keys(envelope).length !== 2 ||
      !Object.hasOwn(envelope, "command") ||
      !Object.hasOwn(envelope, "arguments") ||
      typeof envelope.command !== "string" ||
      !envelope.arguments ||
      typeof envelope.arguments !== "object" ||
      Array.isArray(envelope.arguments)
    )
      throw new ExtensionError(400, "invalid-extension-command");
    if (!this.installation.mcp?.commands.some((command) => command.name === envelope.command))
      throw new ExtensionError(400, "extension-command-not-declared");
    const result = await this.#call("command", envelope);
    if (
      !result ||
      !Number.isInteger(result.status) ||
      result.status < 200 ||
      result.status > 599 ||
      result.body === undefined ||
      typeof result.text !== "string" ||
      !result.text.trim()
    )
      throw new ExtensionError(502, "invalid-extension-response");
    return result;
  }
  transition(action: "prepare" | "start" | "stop") {
    const next = this.#queue.then(async () => {
      if (action === "prepare" && this.state === "RUNNING") throw new ExtensionError(409, "extension-running");
      if (action === "start" && this.state === "RUNNING") return this.descriptor();
      if (action === "stop" && !this.#child) {
        this.state = "STOPPED";
        this.error = undefined;
        return this.descriptor();
      }
      this.state = action === "prepare" ? "PREPARING" : action === "start" ? "STARTING" : "STOPPING";
      this.events.emit("catalog");
      this.error = undefined;
      if (action === "stop") this.events.emit("stopped");
      try {
        await this.#load();
        await this.#call(action);
        if (action !== "start") this.#terminate();
        this.state = action === "start" ? "RUNNING" : "STOPPED";
        this.events.emit("catalog");
      } catch {
        this.#fail();
        throw new ExtensionError(502, "extension-failed");
      }
      return this.descriptor();
    });
    this.#queue = next.catch(() => {});
    return next;
  }
  async #load() {
    if (this.#child) return;
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "SYSTEMROOT", ...this.installation.credentialEnvironment])
      if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = fork(fileURLToPath(new URL("./child.js", import.meta.url)), [], {
      env,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.#child = child;
    child.on("message", (raw: any) => {
      if (raw.changed === true) {
        if (this.state === "RUNNING") this.events.emit("changed");
        return;
      }
      const pending = this.#pending.get(raw.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(raw.id);
      if (raw.failed) pending.reject(new ExtensionError(502, "extension-failed"));
      else pending.resolve(raw.result);
    });
    child.on("error", () => {
      if (this.#child === child) this.#fail();
    });
    child.on("exit", () => {
      if (this.#child === child) this.#fail();
    });
    await this.#call("load", {
      server: this.installation.server,
      configuration: this.installation.configuration,
      environment: this.installation.environment,
      commands: this.installation.mcp?.commands.map((command) => command.name) ?? [],
    });
  }
  #call(method: string, input?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      const timer = setTimeout(() => this.#fail(), this.timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child?.send({ id, method, input }, (error) => {
        if (error) this.#fail();
      });
    });
  }
  #terminate() {
    const child = this.#child;
    this.#child = undefined;
    child?.kill("SIGKILL");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ExtensionError(502, "extension-failed"));
    }
    this.#pending.clear();
    this.events.emit("stopped");
  }
  #fail() {
    this.state = "FAILED";
    this.events.emit("catalog");
    this.error = { code: "extension-failed", message: "The extension failed or exceeded its execution time limit." };
    this.#terminate();
  }
}

export class ExtensionHost {
  readonly events = new EventEmitter();
  readonly #instances = new Map<string, ExtensionInstance>();
  constructor(private readonly dependencies: { extensionsFile: string | undefined; extensionTimeoutMs: number }) {}
  async initialize() {
    for (const installation of await readInstallations(this.dependencies.extensionsFile)) {
      const instance = new ExtensionInstance(installation, this.dependencies.extensionTimeoutMs);
      let listed = false;
      instance.events.on("catalog", () => {
        const next = instance.state === "RUNNING" && installation.mcp !== undefined;
        if (next !== listed) {
          listed = next;
          this.events.emit("tools-changed");
        }
      });
      this.#instances.set(installation.id, instance);
    }
    await Promise.all(
      this.list()
        .filter((value) => value.installation.autoStart)
        .map((value) => value.transition("start").catch(() => {})),
    );
  }
  list() {
    return [...this.#instances.values()];
  }
  tools() {
    return this.list()
      .filter((instance) => instance.state === "RUNNING" && instance.installation.mcp)
      .map((instance) => {
        const { id, title, mcp } = instance.installation;
        const commands = mcp!.commands;
        return {
          name: extensionToolName(id),
          title,
          description: mcp!.description,
          annotations: { readOnlyHint: commands.every((command) => command.readOnly) },
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", enum: commands.map((command) => command.name) },
              arguments: { type: "object" },
            },
            required: ["command", "arguments"],
            additionalProperties: false,
            oneOf: commands.map((command) => ({
              description: command.description,
              properties: { command: { const: command.name }, arguments: command.inputSchema },
              required: ["command", "arguments"],
            })),
          },
        };
      });
  }
  tool(name: string) {
    return this.list().find(
      (instance) => instance.installation.mcp && extensionToolName(instance.installation.id) === name,
    );
  }
  get(id: string) {
    const instance = this.#instances.get(id);
    if (!instance) throw new ExtensionError(404, "extension-not-found");
    return instance;
  }
  async close() {
    await Promise.all(this.list().map((instance) => instance.transition("stop").catch(() => {})));
  }
}
