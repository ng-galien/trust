import {
  ExtensionError,
  type ExtensionHost,
  ExtensionSettingsRejected,
  parseExtensionSettingsUpdate,
} from "../extensions/host.js";

export const EXTENSION_TOOL_NAMES = [
  "trust_extensions_list",
  "trust_extension_status",
  "trust_extension_prepare",
  "trust_extension_start",
  "trust_extension_stop",
  "trust_extension_restart",
  "trust_extension_settings_read",
  "trust_extension_settings_update",
] as const;

export type ExtensionToolName = (typeof EXTENSION_TOOL_NAMES)[number];

export function isExtensionToolName(value: unknown): value is ExtensionToolName {
  return typeof value === "string" && (EXTENSION_TOOL_NAMES as readonly string[]).includes(value);
}

export function extensionTools() {
  const extension = { type: "string", pattern: "^[a-z][a-z0-9-]*$", description: "Installed extension identifier" };
  return EXTENSION_TOOL_NAMES.map((name) => ({
    name,
    title: {
      trust_extensions_list: "List TRUST extensions",
      trust_extension_status: "Read TRUST extension status",
      trust_extension_prepare: "Prepare a TRUST extension",
      trust_extension_start: "Start a TRUST extension",
      trust_extension_stop: "Stop a TRUST extension",
      trust_extension_restart: "Restart a TRUST extension",
      trust_extension_settings_read: "Read TRUST extension settings",
      trust_extension_settings_update: "Update TRUST extension settings",
    }[name],
    description: {
      trust_extensions_list: "List installed extensions and their actual runtime states and errors.",
      trust_extension_status: "Read the actual state and error of one installed extension.",
      trust_extension_prepare: "Run the existing explicit preparation lifecycle for one stopped extension.",
      trust_extension_start: "Start one prepared extension through the existing lifecycle.",
      trust_extension_stop: "Stop one extension through the existing lifecycle.",
      trust_extension_restart: "Stop then start one extension; report a failed state if either transition fails.",
      trust_extension_settings_read:
        "Read one installation's settings schema, stored values and revision; credentials appear only as environment variable names.",
      trust_extension_settings_update:
        "Validate new settings, stop the extension, store them, renew its instance and restart it if it was running. A newly selected store without schema requires explicit prepare; no store is migrated or replaced.",
    }[name],
    annotations: {
      readOnlyHint: ["trust_extensions_list", "trust_extension_status", "trust_extension_settings_read"].includes(name),
    },
    inputSchema:
      name === "trust_extensions_list"
        ? { type: "object", properties: {}, additionalProperties: false }
        : name === "trust_extension_settings_update"
          ? {
              type: "object",
              properties: {
                extension,
                expectedRevision: { type: "integer", minimum: 0, description: "Revision read with the settings" },
                settings: { type: "object", description: "Complete settings values validated by the extension schema" },
              },
              required: ["extension", "expectedRevision", "settings"],
              additionalProperties: false,
            }
          : { type: "object", properties: { extension }, required: ["extension"], additionalProperties: false },
  }));
}

export async function callExtensionTool(
  name: ExtensionToolName,
  argumentsValue: Record<string, unknown>,
  host: ExtensionHost,
) {
  if (name === "trust_extensions_list") {
    if (Object.keys(argumentsValue).length !== 0)
      return { isError: true, text: "Extension list arguments are invalid." };
    return {
      isError: false,
      text: JSON.stringify({ extensions: host.list().map((instance) => instance.descriptor()) }),
    };
  }
  const { extension: _extension, ...update } = argumentsValue;
  if (
    Object.keys(argumentsValue).length !== (name === "trust_extension_settings_update" ? 3 : 1) ||
    typeof argumentsValue.extension !== "string" ||
    argumentsValue.extension.length > 64 ||
    !/^[a-z][a-z0-9-]*$/.test(argumentsValue.extension)
  )
    return { isError: true, text: "Extension identifier is invalid." };
  const id = argumentsValue.extension;
  try {
    const instance = host.get(id);
    if (name === "trust_extension_settings_read")
      return { isError: false, text: JSON.stringify({ settings: await host.readSettings(id) }) };
    if (name === "trust_extension_settings_update")
      return {
        isError: false,
        text: JSON.stringify(await host.updateSettings(parseExtensionSettingsUpdate(id, update))),
      };
    if (name === "trust_extension_status")
      return { isError: false, text: JSON.stringify({ extension: instance.descriptor() }) };
    if (name === "trust_extension_restart") {
      await instance.transition("stop");
      await instance.transition("start");
    } else {
      const action =
        name === "trust_extension_prepare" ? "prepare" : name === "trust_extension_start" ? "start" : "stop";
      await instance.transition(action);
    }
    return { isError: false, text: JSON.stringify({ extension: instance.descriptor() }) };
  } catch (error) {
    if (error instanceof ExtensionError) {
      const state = error.status === 404 ? null : host.get(id).descriptor();
      return {
        isError: true,
        text: JSON.stringify({
          error: error.code,
          message: error.message,
          ...(error instanceof ExtensionSettingsRejected ? { issues: error.issues } : {}),
          extension: state,
        }),
      };
    }
    throw error;
  }
}
