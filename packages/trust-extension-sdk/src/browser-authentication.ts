/** Public OAuth client settings. No credential or private server configuration belongs here. */
export interface BrowserAuthenticationConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly postLogoutRedirectUri: string;
  readonly scope: string;
  readonly resource?: string;
}
