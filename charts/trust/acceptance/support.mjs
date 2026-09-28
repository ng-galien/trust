import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { createServer, request as tlsRequest } from "node:https";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Provider from "oidc-provider";
import { parse, parseAllDocuments, stringify } from "yaml";

export const root = path.resolve(import.meta.dirname, "../../..");
export const chart = path.join(root, "charts/trust");
export async function temporary() {
  return mkdtemp(path.join(tmpdir(), "trust-helm-"));
}
export async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function helmEnvironment(directory) {
  const plugins = path.join(directory, "plugins");
  await mkdir(plugins, { recursive: true });
  return {
    ...process.env,
    HELM_PLUGINS: plugins,
    HELM_CACHE_HOME: path.join(directory, "cache"),
    HELM_CONFIG_HOME: path.join(directory, "helm-config"),
    HELM_DATA_HOME: path.join(directory, "helm-data"),
  };
}
export async function render(directory, values = {}) {
  if (values.config?.authentication === undefined) {
    const example = parse(await readFile(path.join(chart, "examples/oidc-values.yaml"), "utf8"));
    values = { ...values, config: { ...values.config, authentication: example.config.authentication } };
  }
  const file = path.join(directory, `values-${randomUUID()}.yaml`);
  await writeFile(file, stringify(values));
  const text = execFileSync("helm", ["template", "acceptance", chart, "-f", file], {
    cwd: root,
    env: await helmEnvironment(directory),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseAllDocuments(text)
    .map((document) => document.toJSON())
    .filter(Boolean);
}
export const scopes = [
  "trust.procedure.publish",
  "trust.procedure.read",
  "trust.environment.save",
  "trust.environment.list",
  "trust.plan.engage.own",
  "trust.plan.read.own",
  "trust.plan.list.own",
];

/** Maintained OAuth provider, served through real TLS with a private disposable CA. */
export async function identityProvider(directory) {
  const keyFile = path.join(directory, "tls.key"),
    caFile = path.join(directory, "tls.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      caFile,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const ca = await readFile(caFile);
  const server = createServer({ key: await readFile(keyFile), cert: ca });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `https://127.0.0.1:${server.address().port}`;
  const secret = randomBytes(32).toString("base64url");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: "helm-service",
        client_secret: secret,
        redirect_uris: [],
        response_types: [],
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: "client_secret_post",
        scope: scopes.join(" "),
      },
    ],
    jwks: { keys: [{ ...privateKey.export({ format: "jwk" }), kid: randomUUID(), alg: "RS256", use: "sig" }] },
    cookies: { keys: [randomBytes(32).toString("hex")] },
    scopes,
    ttl: { ClientCredentials: 120 },
    features: {
      devInteractions: { enabled: false },
      clientCredentials: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => "urn:trust:helm",
        getResourceServerInfo: () => ({
          scope: scopes.join(" "),
          audience: "urn:trust:helm",
          accessTokenFormat: "jwt",
          jwt: { sign: { alg: "RS256" } },
        }),
      },
    },
  });
  server.on("request", provider.callback());
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: "helm-service",
    client_secret: secret,
    scope: scopes.join(" "),
    resource: "urn:trust:helm",
  }).toString();
  const token = await new Promise((resolve, reject) => {
    const request = tlsRequest(
      issuer + "/token",
      {
        method: "POST",
        ca,
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error("Maintained provider token acquisition failed"));
          try {
            resolve(JSON.parse(text).access_token);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
  assert.equal(typeof token, "string");
  return {
    issuer,
    token,
    caFile,
    authentication: {
      profile: "shared",
      access: {
        mode: "local-jwt",
        issuer,
        audience: "urn:trust:helm",
        discovery: "oidc",
        algorithms: ["RS256"],
        tokenProfile: { headerType: "at+jwt" },
        maxTokenAgeSeconds: 300,
        clockToleranceSeconds: 0,
      },
      resourceUrl: "https://trust.example.com/mcp",
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function prepareRuntime(
  directory,
  { storage = { kind: "pglite", directory: "/var/lib/trust/pglite" }, secretEnvironment = [], databaseUrl, authentication } = {},
) {
  const identity = authentication === undefined ? await identityProvider(directory) : undefined;
  const runtimePort = await freePort(),
    webPort = await freePort();
  const documents = await render(directory, {
    config: {
      server: { port: runtimePort, webPort },
      storage,
      authentication: authentication ?? identity.authentication,
    },
    secretEnvironment,
  });
  const deployment = documents.find((value) => value.kind === "Deployment");
  const configMap = documents.find((value) => value.kind === "ConfigMap");
  const configFile = path.join(directory, "trust.json");
  await writeFile(configFile, configMap.data["trust.json"]);
  // Translate the chart's two physical volume locations to disposable host directories.
  // All business configuration and the startup command come from the rendered deployment.
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith("TRUST_")) delete environment[name];
  Object.assign(environment, {
    TRUST_CONFIG_FILE: configFile,
    TRUST_SERVER_STATE_DIRECTORY: path.join(directory, "state"),
    TRUST_INSTALL_ROOT: root,
    ...(identity ? { NODE_EXTRA_CA_CERTS: identity.caFile } : {}),
  });
  if (storage.kind === "pglite") environment.TRUST_PGLITE_DIRECTORY = path.join(directory, "state/pglite");
  if (databaseUrl) environment.TRUST_DATABASE_URL = databaseUrl;
  const container = deployment.spec.template.spec.containers[0];
  assert.deepEqual(container.args, ["server", "start"]);
  const command = [...container.command.slice(1), ...container.args].map((value) =>
    value.replace("/opt/trust/", root + "/"),
  );
  let processHandle,
    output = "";
  const stop = async () => {
    if (!processHandle || processHandle.exitCode !== null) return;
    processHandle.kill("SIGTERM");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        processHandle.kill("SIGKILL");
        reject(new Error("Public shell failed graceful shutdown"));
      }, 15000);
      processHandle.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  const start = async () => {
    output = "";
    processHandle = spawn(process.execPath, command, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processHandle.stdout.on("data", (chunk) => (output += chunk));
    processHandle.stderr.on("data", (chunk) => (output += chunk));
    for (let i = 0; i < 250; i++) {
      if (processHandle.exitCode !== null) throw new Error(`Public shell exited: ${output.slice(-1500)}`);
      try {
        const response = await fetch(`http://127.0.0.1:${webPort}/health`);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Public shell did not become available");
  };
  return {
    documents,
    identity,
    endpoint: `http://127.0.0.1:${webPort}`,
    environment,
    command,
    start,
    stop,
    get output() {
      return output;
    },
    close: async () => {
      await stop();
      await identity?.close();
    },
  };
}
export async function rpc(runtime, method, params = {}) {
  const response = await fetch(runtime.endpoint + "/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", ...(runtime.identity ? { authorization: `Bearer ${runtime.identity.token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  const envelope = await response.json();
  assert.equal(response.status, 200);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}
export { rm };
