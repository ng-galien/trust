import { pathToFileURL } from "node:url";

interface Extension {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  read(input: unknown): Promise<unknown>;
  command?(input: unknown): Promise<unknown>;
}
let extension: Extension | undefined;
let commands: string[] = [];
process.on("disconnect", () => process.exit(0));
process.on("message", async (raw: unknown) => {
  const message = raw as { id: number; method: string; input: any };
  try {
    let result: unknown;
    if (message.method === "load") {
      const module = await import(pathToFileURL(message.input.server).href);
      extension = await module.createExtension({
        configuration: message.input.configuration,
        environment: message.input.environment,
        publishChanged: () => process.send?.({ changed: true }),
      });
      if (!extension || ["prepare", "start", "stop", "read"].some(key => typeof (extension as any)[key] !== "function")) throw new Error("Invalid extension module");
      commands = message.input.commands;
      if (commands.length && typeof extension.command !== "function") throw new Error("Missing extension command hook");
    } else if (extension?.command && message.method === "command" && commands.includes(message.input?.command)) {
      result = await extension.command(message.input);
    } else if (extension && ["prepare", "start", "stop", "read"].includes(message.method)) {
      result = message.method === "read" ? await extension.read(message.input) : await extension[message.method as "prepare" | "start" | "stop"]();
    } else throw new Error("Invalid extension invocation");
    process.send?.({ id: message.id, result });
  } catch {
    process.send?.({ id: message.id, failed: true });
  }
});
