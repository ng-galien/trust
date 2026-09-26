import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import Provider from 'oidc-provider';
import * as oauth from 'openid-client';
import { PLAN_ACCESS_ACTIONS, RESOURCE_ACCESS_ACTIONS } from '../../../packages/trust-extension-sdk/src/access.ts';

export const DEVELOPMENT_RESOURCE = 'urn:trust:runtime';
export const DEVELOPMENT_INTROSPECTION_RESOURCE = 'urn:trust:runtime:introspection';
const extensionUse = ['coordination', 'mobile-companion', 'dragon-heist'].map(id => `trust.extension.${id}.use`);
const own = PLAN_ACCESS_ACTIONS.map(action => `trust.${action}.own`);
const all = PLAN_ACCESS_ACTIONS.map(action => `trust.${action}.all`);
const catalog = RESOURCE_ACCESS_ACTIONS.map(action => `trust.${action}`);
export const DEVELOPMENT_SCOPES = Object.freeze([...own, ...all, ...catalog, ...extensionUse]);
const accounts = new Map([
  ['alice', [...own, ...catalog.filter(scope => /\.(read|list)$/.test(scope)), ...extensionUse]],
  ['bob', [...own, ...catalog.filter(scope => /\.(read|list)$/.test(scope)), ...extensionUse]],
  ['admin', DEVELOPMENT_SCOPES],
]);

/** Explicit development-only provider: ephemeral keys, fixed accounts, loopback listener. */
export async function startDevelopmentProvider({ enabled = false, port = 0, browserRedirectUri = 'http://127.0.0.1:4181/auth/callback', browserPostLogoutUri = 'http://127.0.0.1:4181/', runnerRedirectUri = 'http://127.0.0.1:4522/callback' } = {}) {
  if (!enabled) throw new Error('Development identity requires explicit opt-in.');
  for (const value of [browserRedirectUri, browserPostLogoutUri, runnerRedirectUri]) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) throw new Error('Development callbacks must be explicit loopback HTTP URLs.');
  }
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const secrets = Object.fromEntries(['trust-introspection', 'service-alice', 'service-bob', 'service-admin'].map(id => [id, randomBytes(32).toString('base64url')]));
  const publicClient = (id, redirect) => ({ client_id: id, redirect_uris: [redirect], ...(id === 'trust-browser' ? {post_logout_redirect_uris:[browserPostLogoutUri]} : {}), response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', scope: ['openid', 'offline_access', ...DEVELOPMENT_SCOPES].join(' ') });
  const clients = [publicClient('trust-browser', browserRedirectUri), publicClient('trust-runner', runnerRedirectUri), ...Object.entries(secrets).map(([id, secret]) => ({ client_id: id, client_secret: secret, redirect_uris: [], response_types: [], grant_types: ['client_credentials'], token_endpoint_auth_method: 'client_secret_post', scope: (id === 'service-admin' ? DEVELOPMENT_SCOPES : id === 'trust-introspection' ? ['openid'] : own).join(' ') }))];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'RS256' };
  let provider;
  try {
    provider = new Provider(issuer, {
      clients, jwks: { keys: [jwk] }, cookies: { keys: [randomBytes(32).toString('hex')] },
      scopes: ['openid', 'offline_access', ...DEVELOPMENT_SCOPES],
      ttl: { AccessToken: 120, ClientCredentials: 120, RefreshToken: 3600, Interaction: 600, Session: 3600, Grant: 3600, IdToken: 120 },
      pkce: { required: () => true },
      findAccount: async (_ctx, id) => accounts.has(id) ? { accountId: id, claims: async () => ({ sub: id }) } : undefined,
      extraTokenClaims: async (_ctx, token) => {
        if (token.accountId && token.scope) {
          const allowed = accounts.get(token.accountId);
          if (!allowed || token.scope.split(' ').some(scope => !['openid', 'offline_access', ...allowed].includes(scope))) throw new Error('Requested permissions exceed this development account.');
        }
        return undefined;
      },
      features: {
        devInteractions: { enabled: true }, clientCredentials: { enabled: true },
        introspection: { enabled: true, allowedPolicy: (_ctx, client, token) => client.clientId === 'trust-introspection' || client.clientId === token.clientId },
        revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => client.clientId === token.clientId },
        resourceIndicators: { enabled: true, defaultResource: () => DEVELOPMENT_RESOURCE, useGrantedResource: () => true, getResourceServerInfo: (_ctx, resource) => {
          if (![DEVELOPMENT_RESOURCE, DEVELOPMENT_INTROSPECTION_RESOURCE].includes(resource)) throw new Error('Unknown development resource.');
          return { scope: DEVELOPMENT_SCOPES.join(' '), audience: DEVELOPMENT_RESOURCE, accessTokenFormat: resource === DEVELOPMENT_RESOURCE ? 'jwt' : 'opaque', jwt: { sign: { alg: 'RS256' } } };
        } },
      },
    });
    server.on('request', provider.callback());
  } catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  const configuration = { mode: 'local-jwt', issuer, audience: DEVELOPMENT_RESOURCE, discovery: 'oidc', allowInsecureLoopback: true, algorithms: ['RS256'], tokenProfile: { headerType: 'at+jwt' }, maxTokenAgeSeconds: 120, clockToleranceSeconds: 0 };
  return { issuer, provider, configuration, secrets, browserRedirectUri, runnerRedirectUri,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

/** Public protocol fixture: real authorization, PKCE, consent and token endpoints. */
export async function createAccessTestProvider(options = {}) {
  const instance = await startDevelopmentProvider({ ...options, enabled: true });
  const discovery = await (await fetch(`${instance.issuer}/.well-known/openid-configuration`)).json();
  const configurationFor = (id, secret) => oauth.discovery(new URL(instance.issuer), id, secret, secret ? oauth.ClientSecretPost(secret) : oauth.None(), { execute: [oauth.allowInsecureRequests] });
  return { ...instance, jwksUri: discovery.jwks_uri,
    async issue({ subject = 'alice', scope = own.join(' '), clientId = 'trust-runner', resource = DEVELOPMENT_RESOURCE } = {}) {
      if (!accounts.has(subject)) throw new Error('Unknown development account.');
      const config = await configurationFor(clientId);
      const verifier = oauth.randomPKCECodeVerifier();
      const state = oauth.randomState();
      const nonce = oauth.randomNonce();
      const redirectUri = clientId === 'trust-browser' ? instance.browserRedirectUri : instance.runnerRedirectUri;
      let target = oauth.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: `openid offline_access ${scope}`, resource, code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce, prompt: 'consent' });
      const cookies = new Map();
      let init;
      for (let step = 0; step < 16; step++) {
        if (target.origin !== instance.issuer) {
          if (target.origin + target.pathname !== redirectUri) throw new Error('Unexpected authorization callback.');
          const result = await oauth.authorizationCodeGrant(config, target, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce }, { resource });
          return { token: result.access_token, accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: Date.now() + result.expires_in * 1000, issuer: instance.issuer, clientId, resource, configuration: config };
        }
        const response = await fetch(target, { ...init, redirect: 'manual', headers: { cookie: [...cookies].map(([key,value]) => `${key}=${value}`).join('; '), ...init?.headers } });
        for (const cookie of response.headers.getSetCookie()) { const [part] = cookie.split(';'); const equals = part.indexOf('='); cookies.set(part.slice(0, equals), part.slice(equals + 1)); }
        const location = response.headers.get('location');
        if (location) { target = new URL(location, target); init = undefined; continue; }
        const html = await response.text();
        const action = html.match(/<form[^>]+action="([^"]+)"/u)?.[1];
        if (!action || response.status !== 200) throw new Error('Development authorization interaction failed.');
        const login = html.includes('name="login"');
        target = new URL(action.replaceAll('&amp;', '&'), target);
        init = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(login ? { prompt: 'login', login: subject } : { prompt: 'consent' }) };
      }
      throw new Error('Development authorization interaction exceeded its bound.');
    },
    async service({ subject = 'service-alice', scope = own.join(' ') } = {}) {
      const secret = instance.secrets[subject];
      if (!secret || subject === 'trust-introspection') throw new Error('Unknown development service.');
      const config = await configurationFor(subject, secret);
      const result = await oauth.clientCredentialsGrant(config, { scope, resource: DEVELOPMENT_RESOURCE });
      return { token: result.access_token, accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000, issuer: instance.issuer, clientId: subject, resource: DEVELOPMENT_RESOURCE, configuration: config };
    },
    async introspect(token) { const config = await configurationFor('trust-introspection', instance.secrets['trust-introspection']); return oauth.tokenIntrospection(config, token); },
    async revoke(credential) { await oauth.tokenRevocation(credential.configuration, credential.refreshToken ?? credential.accessToken); },
  };
}
