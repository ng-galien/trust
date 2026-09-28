import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import {
  type AccessContext,
  type ExtensionCapability,
  type ExtensionDescriptor,
  type ExtensionInstallationHost,
  type ExtensionInstallationRequest,
  type ExtensionInvocationContext,
  type ExtensionRemovalOptions,
  type ExtensionRemovalResult,
  type ExtensionReplacementRequest,
  type ExtensionReplacementResult,
  type ExtensionSettingsIssue,
  type ExtensionSettingsSchema,
  type ExtensionSettingsUpdate,
  type ExtensionSettingsUpdateResult,
  type ExtensionSettingsValues,
  type ExtensionSettingsView,
  type ExtensionState,
  extensionCredentialSettings,
  formatExtensionSettingsIssues,
  type Installation,
  isExtensionStorageFailure,
  validateExtensionSettings,
} from "@trust/extension-sdk";
import type { AccessService } from "../access/service.js";
import type { Clock } from "../time.js";
import { extensionInvocation } from "./access.js";
import { extensionToolName, installationOf, readInstallations, readManifest } from "./manifest.js";
import type { ExtensionInstallationStore } from "./store.js";

export interface CommandResult {
  status: number;
  body: unknown;
  text: string;
}

export class ExtensionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = "Extension request could not be completed.",
  ) {
    super(message);
  }
}

/** Settings refused by the declared schema; every issue is reported. */
export class ExtensionSettingsRejected extends ExtensionError {
  constructor(readonly issues: readonly ExtensionSettingsIssue[]) {
    super(400, "invalid-extension-settings", formatExtensionSettingsIssues(issues));
  }
}

/** Closed public input of the settings update surfaces (HTTP and MCP). */
export function parseExtensionSettingsUpdate(extension: string, value: unknown): ExtensionSettingsUpdate {
  const body =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  if (
    !body ||
    Object.keys(body).some((key) => !["expectedRevision", "settings"].includes(key)) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    (body.expectedRevision as number) < 0 ||
    !body.settings ||
    typeof body.settings !== "object" ||
    Array.isArray(body.settings)
  )
    throw new ExtensionError(
      400,
      "invalid-extension-request",
      "A settings update requires expectedRevision (a non-negative integer) and a settings object.",
    );
  return {
    extension,
    expectedRevision: body.expectedRevision as number,
    settings: body.settings as ExtensionSettingsValues,
  };
}

/** Lifecycle refusals leave the instance STOPPED with an explanation; they are not crashes. */
const REFUSALS: Readonly<Record<string, string>> = {
  "extension-storage-unprepared":
    "The selected extension store is not prepared. Run explicit preparation, then start the extension.",
  "extension-storage-incompatible":
    "The selected extension store has an incompatible schema. It was left unchanged; operator review is required.",
  "extension-settings-invalid": "The stored settings do not satisfy the settings schema of this extension version.",
  "extension-credential-missing":
    "A credential environment variable named by the settings is not set in the runtime environment.",
};
const refusal = (code: string) => new ExtensionError(409, code, REFUSALS[code]);
const invalidAs = <T>(code: string, read: () => T): T => {
  try {
    return read();
  } catch {
    throw new ExtensionError(400, code);
  }
};
export class ExtensionInstance {
  state: ExtensionState = "STOPPED";
  error: { code: string; message: string } | undefined;
  readonly events = new EventEmitter();
  #child: ChildProcess | undefined;
  #sequence = 0;
  #pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  #queue: Promise<unknown> = Promise.resolve();
  #retired = false;
  constructor(
    readonly installation: Installation,
    readonly timeout: number,
    private readonly authority: AccessService,
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
  requireGrant(grant: ExtensionCapability) {
    if (!this.installation.grants.includes(grant)) throw new ExtensionError(403, "extension-capability-denied");
  }
  async read(input: unknown, access?: AccessContext) {
    this.requireRunning();
    const context = extensionInvocation(this.authority, this.installation.id, access);
    return this.#call("read", input, context);
  }
  async command(input: unknown, access?: AccessContext): Promise<CommandResult> {
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
    const context = extensionInvocation(this.authority, this.installation.id, access);
    const result = await this.#call("command", envelope, context);
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
  /** Stop, then refuse every later transition: the host renewed or removed this installation. */
  retire() {
    const stopped = this.#transition("stop", true);
    this.#retired = true;
    return stopped;
  }
  transition(action: "prepare" | "start" | "stop") {
    return this.#transition(action, false);
  }
  /** Run the `deleteData` hook in a transient child while stopped; false when the extension declares none. */
  deleteData(): Promise<boolean> {
    const next = this.#queue.then(async () => {
      if (this.#retired) throw new ExtensionError(409, "extension-renewed");
      if (this.state !== "STOPPED" && this.state !== "FAILED") throw new ExtensionError(409, "extension-running");
      try {
        await this.#load();
        return (await this.#call("deleteData"))?.deleted === true;
      } catch (error) {
        if (error instanceof ExtensionError && REFUSALS[error.code]) throw error;
        throw new ExtensionError(502, "extension-failed");
      } finally {
        if (this.#child) this.#terminate();
        if (this.state !== "FAILED") this.state = "STOPPED";
      }
    });
    this.#queue = next.catch(() => {});
    return next;
  }
  #transition(action: "prepare" | "start" | "stop", retiring: boolean) {
    const next = this.#queue.then(async () => {
      if (this.#retired && !retiring) throw new ExtensionError(409, "extension-renewed");
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
      } catch (error) {
        if (error instanceof ExtensionError && REFUSALS[error.code]) {
          this.#terminate();
          this.state = "STOPPED";
          this.error = { code: error.code, message: error.message };
          this.events.emit("catalog");
          throw error;
        }
        this.#fail();
        throw new ExtensionError(502, "extension-failed");
      }
      return this.descriptor();
    });
    this.#queue = next.catch(() => {});
    return next;
  }
  /** Defaults applied and credential references resolved; computed for each new child process only. */
  #configuration(): ExtensionSettingsValues {
    const validation = validateExtensionSettings(this.installation.settingsSchema, this.installation.settings);
    if (!validation.valid) throw refusal("extension-settings-invalid");
    const configuration = { ...validation.effective };
    for (const name of extensionCredentialSettings(this.installation.settingsSchema)) {
      const variable = configuration[name];
      if (variable === undefined) continue;
      const value = process.env[String(variable)];
      if (value === undefined || value === "") throw refusal("extension-credential-missing");
      configuration[name] = value;
    }
    return configuration;
  }
  async #load() {
    if (this.#child) return;
    const configuration = this.#configuration();
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
      if (raw.failed)
        pending.reject(
          isExtensionStorageFailure(raw.failure)
            ? refusal(`extension-${raw.failure}`)
            : new ExtensionError(502, "extension-failed"),
        );
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
      extensionId: this.installation.id,
      configuration,
      environment: this.installation.environment,
      commands: this.installation.mcp?.commands.map((command) => command.name) ?? [],
    });
  }
  #call(method: string, input?: unknown, context?: ExtensionInvocationContext): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      const timer = setTimeout(() => this.#fail(), this.timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child?.send({ id, method, input, context }, (error) => {
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

export class ExtensionHost implements ExtensionInstallationHost {
  readonly events = new EventEmitter();
  readonly #instances = new Map<string, ExtensionInstance>();
  readonly #detach = new Map<string, () => void>();
  readonly #declared = new Set<string>();
  readonly #exclusive = new Map<string, Promise<unknown>>();
  constructor(
    private readonly dependencies: {
      extensionsFile: string | undefined;
      extensionTimeoutMs: number;
      accessService: AccessService;
      extensionInstallationStore: ExtensionInstallationStore;
      clock: Clock;
    },
  ) {}
  async initialize() {
    const store = this.dependencies.extensionInstallationStore;
    const installations = new Map<string, Installation>();
    for (const installation of await readInstallations(this.dependencies.extensionsFile)) {
      this.#declared.add(installation.id);
      installations.set(installation.id, installation);
    }
    for (const stored of await store.installations()) {
      const manifest = await readManifest(stored.manifest);
      if (manifest.id !== stored.id) throw new Error("Installed extension manifest identity changed");
      installations.set(stored.id, installationOf(manifest, { ...stored, settings: {} }));
    }
    for (const installation of installations.values()) {
      const stored = await store.settings(installation.id);
      this.#register(
        new ExtensionInstance(
          stored ? { ...installation, settings: stored.values } : installation,
          this.dependencies.extensionTimeoutMs,
          this.dependencies.accessService,
        ),
      );
    }
    await Promise.all(
      this.list()
        .filter((value) => value.installation.autoStart)
        .map((value) => value.transition("start").catch(() => {})),
    );
  }
  #register(instance: ExtensionInstance) {
    const id = instance.installation.id;
    this.#detach.get(id)?.();
    let listed = false;
    const catalog = () => {
      const next = instance.state === "RUNNING" && instance.installation.mcp !== undefined;
      if (next !== listed) {
        listed = next;
        this.events.emit("tools-changed");
      }
    };
    instance.events.on("catalog", catalog);
    this.#detach.set(id, () => instance.events.off("catalog", catalog));
    this.#instances.set(id, instance);
    this.events.emit("tools-changed");
  }
  #serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.#exclusive.get(id) ?? Promise.resolve()).then(operation);
    this.#exclusive.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }
  /** Stop the current instance, run the change, then register a new instance and restart it if it was running. */
  async #renew(current: ExtensionInstance, installation: Installation, change: () => Promise<void>) {
    const wasRunning = current.state === "RUNNING";
    await current.retire().catch(() => {});
    this.#detach.get(installation.id)?.();
    try {
      await change();
    } catch (error) {
      this.#register(this.#instance(current.installation));
      throw error;
    }
    const next = this.#instance(installation);
    this.#register(next);
    let preparationRequired = false;
    if (wasRunning)
      await next.transition("start").catch((error: unknown) => {
        preparationRequired = error instanceof ExtensionError && error.code === "extension-storage-unprepared";
      });
    return { extension: next.descriptor(), preparationRequired };
  }
  #validated(schema: ExtensionSettingsSchema, settings: unknown) {
    const validation = validateExtensionSettings(schema, settings);
    if (!validation.valid) throw new ExtensionSettingsRejected(validation.issues);
    return validation.values;
  }
  #instance(installation: Installation) {
    return new ExtensionInstance(installation, this.dependencies.extensionTimeoutMs, this.dependencies.accessService);
  }
  async readSettings(id: string): Promise<ExtensionSettingsView> {
    const { installation } = this.get(id);
    const stored = await this.dependencies.extensionInstallationStore.settings(id);
    const validation = validateExtensionSettings(installation.settingsSchema, installation.settings);
    return {
      extension: id,
      schema: installation.settingsSchema,
      settings: installation.settings,
      effective: validation.valid ? validation.effective : installation.settings,
      revision: stored?.revision ?? 0,
      source: stored ? "runtime" : "installation",
    };
  }
  /** Validate, stop, store, renew the instance and restart it when it was running; never prepares a store. */
  updateSettings(update: ExtensionSettingsUpdate): Promise<ExtensionSettingsUpdateResult> {
    return this.#serialized(update.extension, async () => {
      const current = this.get(update.extension);
      const settings = this.#validated(current.installation.settingsSchema, update.settings);
      const store = this.dependencies.extensionInstallationStore;
      if (((await store.settings(update.extension))?.revision ?? 0) !== update.expectedRevision)
        throw new ExtensionError(
          409,
          "extension-settings-conflict",
          "The settings revision has changed; read them again.",
        );
      const { extension, preparationRequired } = await this.#renew(
        current,
        { ...current.installation, settings },
        async () => {
          if (!(await store.saveSettings(update.extension, settings, update.expectedRevision, this.#now())))
            throw new ExtensionError(
              409,
              "extension-settings-conflict",
              "The settings revision has changed; read them again.",
            );
        },
      );
      return { extension, settings: await this.readSettings(update.extension), preparationRequired };
    });
  }
  /** Register a new installation, stopped; the operator prepares and starts it explicitly. */
  async install(request: ExtensionInstallationRequest): Promise<ExtensionDescriptor> {
    const manifest = await readManifest(request.manifest);
    return this.#serialized(manifest.id, async () => {
      if (this.#instances.has(manifest.id)) throw new ExtensionError(409, "extension-already-installed");
      const settings = this.#validated(manifest.settingsSchema, request.settings);
      const installation = invalidAs("invalid-extension-installation", () =>
        installationOf(manifest, {
          environment: request.environment,
          grants: request.grants,
          credentialEnvironment: request.credentialEnvironment ?? [],
          autoStart: request.autoStart ?? false,
          settings,
        }),
      );
      const store = this.dependencies.extensionInstallationStore;
      const at = this.#now();
      await store.saveInstallation(installation, at);
      if (!(await store.saveSettings(installation.id, settings, 0, at)))
        throw new ExtensionError(409, "extension-settings-conflict");
      const instance = this.#instance(installation);
      this.#register(instance);
      return instance.descriptor();
    });
  }
  /** Replace the installed version; current settings must satisfy the new schema unless new ones are given. */
  replace(id: string, request: ExtensionReplacementRequest): Promise<ExtensionReplacementResult> {
    return this.#serialized(id, async () => {
      const current = this.get(id);
      const manifest = await readManifest(request.manifest);
      if (manifest.id !== id) throw new ExtensionError(400, "extension-identity-mismatch");
      const previous = current.installation;
      const settings = this.#validated(manifest.settingsSchema, request.settings ?? previous.settings);
      const installation = invalidAs("invalid-extension-replacement", () =>
        installationOf(manifest, {
          environment: previous.environment,
          grants: request.grants ?? previous.grants,
          credentialEnvironment: previous.credentialEnvironment,
          autoStart: previous.autoStart,
          settings,
        }),
      );
      const store = this.dependencies.extensionInstallationStore;
      const revision = (await store.settings(id))?.revision ?? 0;
      const { extension, preparationRequired } = await this.#renew(current, installation, async () => {
        const at = this.#now();
        await store.saveInstallation(installation, at);
        if (!(await store.saveSettings(id, settings, revision, at)))
          throw new ExtensionError(409, "extension-settings-conflict");
      });
      return { extension, previousVersion: previous.version, preparationRequired };
    });
  }
  /**
   * Stop and remove an installation and its settings; installed files are kept. The extension's own stored data
   * is deleted only when requested, through its `deleteData` hook, before anything is removed.
   */
  remove(id: string, options: ExtensionRemovalOptions = {}): Promise<ExtensionRemovalResult> {
    return this.#serialized(id, async () => {
      const current = this.get(id);
      if (this.#declared.has(id))
        throw new ExtensionError(
          409,
          "extension-declared-by-installation-file",
          "This installation is declared by the operator installation file.",
        );
      if (options.deleteData === true) {
        const wasRunning = current.state === "RUNNING";
        await current.transition("stop");
        if (!(await current.deleteData())) {
          if (wasRunning) await current.transition("start").catch(() => {});
          throw new ExtensionError(
            409,
            "extension-data-deletion-unsupported",
            "This extension declares no data deletion; nothing was removed.",
          );
        }
      }
      await current.retire().catch(() => {});
      await this.dependencies.extensionInstallationStore.removeInstallation(id);
      this.#detach.get(id)?.();
      this.#detach.delete(id);
      this.#instances.delete(id);
      this.events.emit("tools-changed");
      return { extension: id, dataDeleted: options.deleteData === true };
    });
  }
  #now() {
    return this.dependencies.clock.now().toISOString();
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
