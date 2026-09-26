import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

export {
  createAccessTestProvider,
  DEVELOPMENT_INTROSPECTION_RESOURCE,
} from "../../../environments/trust-test/auth/provider.mjs";
export {
  admit,
  denied,
  engage,
  facts,
  resources,
  root,
  rpc,
  runtimeFixture,
  scopes,
  seed,
  storageTarget,
} from "./access-ownership-support.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
export async function runnerModules() {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-private-auth-"));
  const outfile = path.join(directory, "runner.mjs");
  await build({
    stdin: {
      contents: ["auth/credentials", "telemetry/otlp", "check/client", "shell/run", "http/run"]
        .map((name) => `export * from ${JSON.stringify(path.join(root, `packages/trust-runner/src/${name}.ts`))};`)
        .join("\n"),
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
  });
  return { module: await import(outfile), directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
export async function privateCredential(modules, endpoint, credential, name = "credential.json") {
  const file = path.join(modules.directory, name);
  const { issuer, clientId, accessToken, expiresAt, refreshToken, resource } = credential;
  await modules.module.writeRunnerCredential(file, {
    version: 1,
    origin: endpoint,
    issuer,
    clientId,
    accessToken,
    expiresAt,
    ...(refreshToken ? { refreshToken } : {}),
    resource,
  });
  return file;
}
export async function runPackaged(endpoint, file, uri) {
  const env = {
    ...process.env,
    TRUST_RPC_ENDPOINT: `${endpoint}/rpc`,
    TRUST_OTLP_ENDPOINT: `${endpoint}/v1/traces`,
    TRUST_AUTH_FILE: file,
  };
  delete env.TRUST_ACCESS_TOKEN;
  delete env.TRUST_REFRESH_TOKEN;
  delete env.TRUST_AUTHORIZATION;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"), uri, "--json"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr, result: code === 0 ? JSON.parse(stdout) : undefined }));
  });
}
export function assertPrivateOutput(result, credentials) {
  for (const credential of credentials)
    for (const token of [credential.accessToken, credential.refreshToken].filter(Boolean))
      assert.ok(!`${result.stdout}${result.stderr}`.includes(token), "Token must not appear in Runner output");
}

export async function unusedLoopbackCallback() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const uri = `http://127.0.0.1:${server.address().port}/callback`;
  await new Promise((resolve) => server.close(resolve));
  return uri;
}

/** Drive only the provider's development HTML interactions; OAuth validation stays in auth.js. */
export async function acquirePackaged(provider, modules, endpoint, scope) {
  const config = path.join(modules.directory, "login.json");
  const file = path.join(modules.directory, "acquired.json");
  await writeFile(
    config,
    JSON.stringify({
      issuer: provider.issuer,
      clientId: "trust-runner",
      origin: endpoint,
      resource: "urn:trust:runtime",
      scope,
      redirectUri: provider.runnerRedirectUri,
    }),
    { mode: 0o600, flag: "wx" },
  );
  const child = spawn(
    process.execPath,
    [path.join(root, "packages/trust-runner/dist/skill/trust/scripts/auth.js"), "--config", config, "--output", file],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  let resolveUrl, rejectUrl;
  const urlReady = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const match = stdout.match(/Open this authorization URL in your browser:\n([^\n]+)\n/u);
    if (match) resolveUrl(new URL(match[1]));
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const completion = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      rejectUrl(error);
      reject(error);
    });
    child.on("exit", (code) => {
      rejectUrl(new Error("Packaged authentication helper exited before authorization."));
      resolve(code);
    });
  });
  const timeout = setTimeout(() => {
    rejectUrl(new Error("Packaged authentication helper timed out."));
    child.kill();
  }, 20000);
  try {
    let target = await urlReady;
    const invalid = new URL(provider.runnerRedirectUri);
    invalid.searchParams.set("state", "wrong");
    assert.equal(
      (await fetch(invalid, { redirect: "manual" })).status,
      400,
      "Callback refuses an invalid state without ending login",
    );
    const cookies = new Map();
    let init;
    let callbackReached = false;
    for (let step = 0; step < 16; step++) {
      if (target.origin !== provider.issuer) {
        assert.equal(
          target.origin + target.pathname,
          provider.runnerRedirectUri,
          "Only registered callback receives the code",
        );
        assert.equal((await fetch(target, { redirect: "error" })).status, 200);
        callbackReached = true;
        break;
      }
      const response = await fetch(target, {
        ...init,
        redirect: "manual",
        headers: { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), ...init?.headers },
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [part] = cookie.split(";");
        const equals = part.indexOf("=");
        cookies.set(part.slice(0, equals), part.slice(equals + 1));
      }
      const location = response.headers.get("location");
      if (location) {
        target = new URL(location, target);
        init = undefined;
        continue;
      }
      const html = await response.text();
      const action = html.match(/<form[^>]+action="([^"]+)"/u)?.[1];
      assert.equal(response.status, 200);
      assert.ok(action, "Real provider interaction must have a form");
      target = new URL(action.replaceAll("&amp;", "&"), target);
      init = {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(
          html.includes('name="login"') ? { prompt: "login", login: "alice" } : { prompt: "consent" },
        ),
      };
    }
    assert.equal(callbackReached, true);
    assert.equal(await completion, 0, stderr);
    const credential = await modules.module.readRunnerCredential(file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(credential.refreshToken, "Real offline grant must issue a private refresh token");
    assertPrivateOutput({ stdout, stderr }, [credential]);
    await assert.rejects(
      fetch(provider.runnerRedirectUri),
      "Callback listener must close after successful acquisition",
    );
    return { file, credential, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await completion.catch(() => undefined);
  }
}
