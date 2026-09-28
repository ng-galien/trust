import { pathToFileURL } from "node:url";
import { type ExtensionLifecycle, isExtensionStorageFailure } from "@trust/extension-sdk";
import { parseExtensionInvocation } from "./access.js";

let extension: ExtensionLifecycle | undefined;
let commands: string[] = [];
let extensionId = "";
process.on("disconnect", () => process.exit(0));
process.on("message", async (raw: unknown) => {
  const message = raw as { id: number; method: string; input: any; context?: unknown };
  try {
    let result: unknown;
    if (message.method === "load") {
      const module = await import(pathToFileURL(message.input.server).href);
      extension = await module.createExtension({
        configuration: message.input.configuration,
        environment: message.input.environment,
        publishChanged: () => process.send?.({ changed: true }),
      });
      if (
        !extension ||
        ["prepare", "start", "stop", "read"].some((key) => typeof (extension as any)[key] !== "function")
      )
        throw new Error("Invalid extension module");
      commands = message.input.commands;
      extensionId = message.input.extensionId;
      if (commands.length && typeof extension.command !== "function") throw new Error("Missing extension command hook");
    } else if (extension?.command && message.method === "command" && commands.includes(message.input?.command)) {
      result = await extension.command(message.input, parseExtensionInvocation(message.context, extensionId));
    } else if (extension && message.method === "deleteData") {
      if (typeof extension.deleteData === "function") {
        await extension.deleteData();
        result = { deleted: true };
      } else result = { deleted: false };
    } else if (extension && ["prepare", "start", "stop", "read"].includes(message.method)) {
      result =
        message.method === "read"
          ? await extension.read(message.input, parseExtensionInvocation(message.context, extensionId))
          : await extension[message.method as "prepare" | "start" | "stop"]();
    } else throw new Error("Invalid extension invocation");
    process.send?.({ id: message.id, result });
  } catch (error) {
    // Only a closed storage failure code crosses the boundary; messages and stacks stay private.
    const failure = (error as { failure?: unknown } | null)?.failure;
    process.send?.({ id: message.id, failed: true, ...(isExtensionStorageFailure(failure) ? { failure } : {}) });
  }
});
