import type { BrowserAuthenticationConfiguration } from "@trust/extension-sdk";
import { InMemoryWebStorage, UserManager, WebStorageStateStore } from "oidc-client-ts";

/** Tokens live in this page's memory only. Transaction state contains no issued tokens. */
export class BrowserAuthentication {
  #manager: UserManager | undefined;
  #initialization: Promise<boolean> | undefined;
  #renewal: Promise<string> | undefined;
  #required = false;
  #generation = 0;
  #listeners = new Set<(ready: boolean) => void>();
  constructor(readonly baseUrl: string) {}
  get required(): boolean {
    return this.#required;
  }
  subscribe(listener: (ready: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #changed(ready: boolean): void {
    this.#initialization = Promise.resolve(ready);
    for (const listener of this.#listeners) listener(ready);
  }
  async requireLogin(): Promise<void> {
    this.#generation += 1;
    await this.#manager?.removeUser();
    this.#changed(false);
  }

  initialize(): Promise<boolean> {
    this.#initialization ??= this.#initialize();
    return this.#initialization;
  }
  async #initialize(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/auth/config`, { cache: "no-store" });
    if (!response.ok) throw new Error("Authentication configuration is unavailable");
    const configuration = (await response.json()) as {
      required: boolean;
      browser: BrowserAuthenticationConfiguration | null;
    };
    this.#required = configuration.required;
    if (!configuration.required) return true;
    if (!configuration.browser) throw new Error("Browser sign-in is not configured for this server");
    const browser = configuration.browser;
    if (
      new URL(browser.redirectUri).origin !== window.location.origin ||
      new URL(browser.postLogoutRedirectUri).origin !== window.location.origin
    )
      throw new Error("Browser sign-in origin does not match this application");
    this.#manager = new UserManager({
      authority: browser.issuer,
      client_id: browser.clientId,
      redirect_uri: browser.redirectUri,
      post_logout_redirect_uri: browser.postLogoutRedirectUri,
      response_type: "code",
      scope: browser.scope,
      ...(browser.resource ? { resource: browser.resource } : {}),
      userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
      stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
      automaticSilentRenew: false,
      loadUserInfo: false,
      monitorSession: false,
      disablePKCE: false,
    });
    const url = new URL(window.location.href);
    if (
      url.pathname === new URL(browser.redirectUri).pathname &&
      (url.searchParams.has("code") || url.searchParams.has("error"))
    ) {
      await this.#manager.signinRedirectCallback();
      window.history.replaceState(null, "", "/overview");
    }
    return (await this.#manager.getUser()) !== null;
  }
  async login(): Promise<void> {
    await this.initialize();
    if (!this.#manager) throw new Error("Browser sign-in is unavailable");
    await this.#manager.signinRedirect({ nonce: crypto.randomUUID(), prompt: "consent" });
  }
  async logout(): Promise<void> {
    if (!this.#manager) return;
    // Local sign-out discards tokens; it does not revoke the provider's grant/session.
    await this.requireLogin();
  }
  async token(): Promise<string | undefined> {
    if (!(await this.initialize())) throw new Error("Sign in required");
    if (!this.#required) return undefined;
    const manager = this.#manager;
    if (!manager) throw new Error("Sign in required");
    const user = await manager.getUser();
    if (!user) throw new Error("Sign in required");
    if ((user.expires_in ?? 0) > 30) return user.access_token;
    if (!user.refresh_token) {
      await this.requireLogin();
      throw new Error("Sign in required");
    }
    const generation = this.#generation;
    this.#renewal ??= manager
      .signinSilent()
      .then(async (renewed) => {
        if (generation !== this.#generation) {
          await manager.removeUser();
          throw new Error("Sign in required");
        }
        if (!renewed || renewed.expired) throw new Error("Sign in required");
        return renewed.access_token;
      })
      .catch(async () => {
        await this.requireLogin();
        throw new Error("Sign in required");
      })
      .finally(() => {
        this.#renewal = undefined;
      });
    return this.#renewal;
  }
}

const authenticationByOrigin = new Map<string, BrowserAuthentication>();
export function authenticationFor(baseUrl: string): BrowserAuthentication {
  const origin = new URL(baseUrl || window.location.origin, window.location.origin).origin;
  let authentication = authenticationByOrigin.get(origin);
  if (!authentication) {
    authentication = new BrowserAuthentication(baseUrl);
    authenticationByOrigin.set(origin, authentication);
  }
  return authentication;
}
export async function authenticatedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, window.location.origin);
  const authentication = authenticationByOrigin.get(url.origin);
  const token = await authentication?.token();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers, redirect: "error" });
  if (response.status === 401 && authentication) await authentication.requireLogin();
  return response;
}

export async function authenticatedWebSocket(input: string): Promise<WebSocket> {
  const http = new URL(input);
  http.protocol = http.protocol === "wss:" ? "https:" : "http:";
  const authentication = authenticationByOrigin.get(http.origin);
  const token = await authentication?.token();
  if (!token) return new WebSocket(input);
  const encoded = btoa(token).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return new WebSocket(input, ["trust-lsp", `bearer.${encoded}`]);
}
