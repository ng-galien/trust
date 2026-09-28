import type {
  AccessConfiguration,
  BrowserAuthenticationConfiguration,
  DevelopmentAuthenticationConfiguration,
} from "@trust/extension-sdk";
import { matchAccessConfiguration } from "@trust/extension-sdk/match";

export function allowedBrowserOrigin(
  origin: string | undefined,
  browser: BrowserAuthenticationConfiguration | undefined,
  development: DevelopmentAuthenticationConfiguration | undefined,
  access?: AccessConfiguration,
): boolean {
  if (origin === undefined) return true;
  if (access) {
    const fixed = matchAccessConfiguration(access, {
      local: () => undefined,
      fixed: (value) => value.allowedOrigins?.includes(origin) ?? false,
      "local-jwt": () => undefined,
      introspection: () => undefined,
    });
    if (fixed !== undefined) return fixed;
  }
  if (browser && origin === new URL(browser.redirectUri).origin) return true;
  if (!development) return false;
  if (origin === development.tailnetOrigin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}
