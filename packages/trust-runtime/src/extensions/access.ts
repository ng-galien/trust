import type { AccessContext, ExtensionCommandAccess, ExtensionInvocationContext } from "@trust/extension-sdk";
import { matchAccessContext } from "@trust/extension-sdk/match";
import type { AccessService } from "../access/service.js";

/** Only the host constructs this identity projection, after validating the current request. */
export function extensionInvocation(
  authority: AccessService,
  extensionId: string,
  access: AccessContext | undefined,
  right: ExtensionCommandAccess,
): ExtensionInvocationContext {
  authority.authorizeExtension(access, extensionId, right);
  let write = true;
  try {
    authority.authorizeExtension(access, extensionId, "write");
  } catch {
    write = false;
  }
  if (!authority.shared) return Object.freeze({ mode: "local" });
  if (!access) throw new Error("Verified extension authority is required");
  return matchAccessContext(access, {
    local: () => {
      throw new Error("Verified extension authority is required");
    },
    authenticated: (context) =>
      Object.freeze({
        mode: "authenticated" as const,
        principal: context.principal,
        extensionId,
        // Fixed users have no credential expiry; the private IPC delegation remains short-lived.
        expiresAt: context.expiresAt ?? Date.now() / 1000 + 60,
        write,
      }),
  });
}

/** The private IPC context is separate from, and cannot be replaced by, command input. */
export function parseExtensionInvocation(value: unknown, extensionId: string): ExtensionInvocationContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing extension authority");
  const record = value as Record<string, unknown>;
  if (record.mode === "local" && Object.keys(record).length === 1) return Object.freeze({ mode: "local" });
  const principal = record.principal as Record<string, unknown> | undefined;
  if (
    record.mode !== "authenticated" ||
    Object.keys(record).some((key) => !["mode", "principal", "extensionId", "expiresAt", "write"].includes(key)) ||
    !principal ||
    typeof principal !== "object" ||
    Array.isArray(principal) ||
    Object.keys(principal).length !== 2 ||
    typeof principal.issuer !== "string" ||
    !principal.issuer ||
    typeof principal.subject !== "string" ||
    !principal.subject ||
    record.extensionId !== extensionId ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt) ||
    record.expiresAt <= Date.now() / 1000 ||
    typeof record.write !== "boolean"
  ) {
    throw new Error("Invalid extension authority");
  }
  return Object.freeze({
    mode: "authenticated",
    principal: Object.freeze({ issuer: principal.issuer, subject: principal.subject }),
    extensionId,
    expiresAt: record.expiresAt,
    write: record.write,
  });
}
