import { pathToFileURL } from "node:url";
import {
  EXTENSION_TRUST_FAILURES,
  type ExtensionContext,
  type ExtensionInvocationContext,
  type ExtensionLifecycle,
  type ExtensionTrust,
  ExtensionTrustError,
  type ExtensionTrustFailure,
  isExtensionStorageFailure,
} from "@trust/extension-sdk";
import { parseExtensionInvocation } from "./access.js";

let extension: ExtensionLifecycle | undefined;
let commands: string[] = [];
let extensionId = "";
let trustSequence = 0;
/** Each host invocation's context object identifies it to the host while it is in progress. */
const invocations = new WeakMap<ExtensionInvocationContext, number>();
const inProgress = new Set<number>();
const trustCalls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

/** The host answers with the canonical view of the requested surface. */
function askTrust<T>(method: string, input: unknown, invocation: ExtensionInvocationContext): Promise<T> {
  const id = invocations.get(invocation);
  if (id === undefined || !inProgress.has(id)) return Promise.reject(new ExtensionTrustError("invocation-ended"));
  return new Promise<T>((resolve, reject) => {
    const trust = ++trustSequence;
    trustCalls.set(trust, { resolve: (value) => resolve(value as T), reject });
    process.send?.({ trust, invocation: id, method, input });
  });
}

const trust: ExtensionTrust = {
  listPlans: (invocation, selection = {}) => askTrust("plans.list", selection, invocation),
  readPlan: (plan, invocation) => askTrust("plans.read", { plan }, invocation),
  readEpisode: (plan, invocation) => askTrust("episodes.read", { plan }, invocation),
  replaceDeclarations: (input, invocation) => askTrust("plans.declarations.replace", input, invocation),
  readProcedure: (procedure, version, invocation) => askTrust("procedures.read", { procedure, version }, invocation),
  readOperation: (operation, version, invocation) => askTrust("operations.read", { operation, version }, invocation),
};

function invoke<T>(id: number, context: ExtensionInvocationContext, run: (context: ExtensionInvocationContext) => T) {
  invocations.set(context, id);
  inProgress.add(id);
  return Promise.resolve()
    .then(() => run(context))
    .finally(() => inProgress.delete(id));
}

process.on("disconnect", () => process.exit(0));
process.on("message", async (raw: unknown) => {
  const answer = raw as { trust?: number; result?: unknown; failure?: unknown; message?: unknown };
  if (typeof answer.trust === "number") {
    const call = trustCalls.get(answer.trust);
    trustCalls.delete(answer.trust);
    if (!call) return;
    if (answer.failure === undefined) call.resolve(answer.result);
    else {
      const failure = (EXTENSION_TRUST_FAILURES as readonly unknown[]).includes(answer.failure)
        ? (answer.failure as ExtensionTrustFailure)
        : "unavailable";
      call.reject(new ExtensionTrustError(failure, typeof answer.message === "string" ? answer.message : failure));
    }
    return;
  }
  const message = raw as { id: number; method: string; input: unknown; context?: unknown };
  try {
    let result: unknown;
    if (message.method === "ping") result = "pong";
    else if (message.method === "load") {
      const load = message.input as {
        server: string;
        configuration: ExtensionContext["configuration"];
        environment: string;
        commands: string[];
        extensionId: string;
      };
      const module = await import(pathToFileURL(load.server).href);
      extension = await module.createExtension({
        configuration: load.configuration,
        environment: load.environment,
        publishChanged: () => process.send?.({ changed: true }),
        trust,
      });
      if (
        !extension ||
        ["prepare", "start", "stop", "read"].some(
          (key) => typeof (extension as unknown as Record<string, unknown>)[key] !== "function",
        )
      )
        throw new Error("Invalid extension module");
      commands = load.commands;
      extensionId = load.extensionId;
      if (commands.length && typeof extension.command !== "function") throw new Error("Missing extension command hook");
    } else if (
      extension?.command &&
      message.method === "command" &&
      commands.includes(String((message.input as { command?: unknown } | undefined)?.command))
    ) {
      const loaded = extension;
      result = await invoke(message.id, parseExtensionInvocation(message.context, extensionId), (context) =>
        loaded.command?.(message.input, context),
      );
    } else if (extension && message.method === "deleteData") {
      if (typeof extension.deleteData === "function") {
        await extension.deleteData();
        result = { deleted: true };
      } else result = { deleted: false };
    } else if (extension && ["prepare", "start", "stop", "read"].includes(message.method)) {
      const loaded = extension;
      result =
        message.method === "read"
          ? await invoke(message.id, parseExtensionInvocation(message.context, extensionId), (context) =>
              loaded.read(message.input, context),
            )
          : await extension[message.method as "prepare" | "start" | "stop"]();
    } else throw new Error("Invalid extension invocation");
    process.send?.({ id: message.id, result });
  } catch (error) {
    // Only a closed storage failure code crosses the boundary; messages and stacks stay private.
    const failure = (error as { failure?: unknown } | null)?.failure;
    process.send?.({ id: message.id, failed: true, ...(isExtensionStorageFailure(failure) ? { failure } : {}) });
  }
});
