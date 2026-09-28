import { type AuthenticationConfiguration, parseAuthenticationConfiguration } from "./authentication-configuration.js";
import { normalizeAuthority } from "./authority.js";

/** A bind host remains raw; URL authorities bracket IPv6 literals. */
export function configurationAuthority(host: string, port: number): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

export type StorageConfiguration =
  | { readonly kind: "pglite"; readonly directory: string }
  | { readonly kind: "postgresql"; readonly connectionString: string };
export type ConfigurationEnvironment = Readonly<Record<string, string | undefined>>;
export type ConfigurationSource = "environment" | "file" | "default";
export interface TrustConfiguration {
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly webPort: number;
    readonly stateDirectory: string;
    readonly semanticAuthority: string;
    readonly operationsDirectory?: string;
    readonly extensionsFile?: string;
    readonly sessionDurationMs: number;
    readonly trialTimeoutMs: number;
    readonly extensionTimeoutMs: number;
    readonly runnerTrialScript?: string;
    readonly diagnosticsEndpoint?: string;
  };
  readonly storage: StorageConfiguration;
  readonly authentication: AuthenticationConfiguration;
  readonly logging: { readonly level: string; readonly runtimePath?: string; readonly runnerPath: string };
  readonly runner: {
    readonly rpcEndpoint: string;
    readonly otlpEndpoint: string;
    readonly authFile?: string;
    readonly shellTimeoutMs: number;
    readonly additionalPath: readonly string[];
  };
  readonly shell: {
    readonly installRoot?: string;
    readonly url: string;
    readonly webAccessPassword?: string;
    readonly mobileUpstreams: Readonly<
      Record<string, { readonly url: string; readonly pathMode?: "strip" | "preserve" }>
    >;
  };
}
export interface ResolvedTrustConfiguration {
  readonly configuration: TrustConfiguration;
  readonly sources: Readonly<Record<string, ConfigurationSource>>;
}

const integer = { type: "integer", minimum: 1, maximum: 2147483647 } as const;
const text = { type: "string", minLength: 1 } as const;
const fields = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties });
const credentialReferenceSchema = { ...fields({ environment: text, name: text }), required: ["environment", "name"] };
const commonAccessProperties = {
  issuer: text,
  audience: text,
  discovery: { enum: ["oidc", "oauth"] },
  clockToleranceSeconds: { type: "integer", minimum: 0, maximum: 60 },
  maxTokenAgeSeconds: { type: "integer", minimum: 1, maximum: 86400 },
  timeoutMs: { type: "integer", minimum: 100, maximum: 30000 },
  allowInsecureLoopback: { type: "boolean" },
};
const accessSchema = {
  oneOf: [
    { ...fields({ mode: { const: "local" } }), required: ["mode"] },
    {
      ...fields({
        mode: { const: "fixed" },
        issuer: text,
        subject: text,
        scopes: { type: "array", items: { type: "string", pattern: "^trust\\.[a-z0-9.-]+$" } },
        allowedOrigins: {
          type: "array",
          items: {
            type: "string",
            pattern: "^(https://[^/?#@]+|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?)$",
          },
        },
      }),
      required: ["mode", "issuer", "subject", "scopes"],
    },
    {
      ...fields({
        ...commonAccessProperties,
        mode: { const: "local-jwt" },
        algorithms: {
          type: "array",
          minItems: 1,
          items: { enum: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] },
        },
        tokenProfile: {
          ...fields({ headerType: text, requiredClaims: { type: "object", additionalProperties: text } }),
          required: ["headerType"],
        },
      }),
      required: ["mode", "issuer", "audience"],
    },
    {
      ...fields({
        ...commonAccessProperties,
        mode: { const: "introspection" },
        introspection: {
          ...fields({
            clientId: text,
            clientSecretReference: credentialReferenceSchema,
            authenticationMethod: { enum: ["client_secret_basic", "client_secret_post"] },
          }),
          required: ["clientId", "clientSecretReference"],
        },
      }),
      required: ["mode", "issuer", "audience"],
    },
  ],
};
const browserSchema = {
  ...fields({
    issuer: text,
    clientId: text,
    redirectUri: text,
    postLogoutRedirectUri: text,
    scope: text,
    resource: text,
  }),
  required: ["issuer", "clientId", "redirectUri", "postLogoutRedirectUri", "scope"],
};
const developmentPrincipalSchema = fields({
  subject: text,
  scopes: { type: "array", items: text },
});
const developmentSchema = fields({
  tailnetOrigin: text,
  users: {
    type: "array",
    items: {
      ...developmentPrincipalSchema,
      properties: { ...developmentPrincipalSchema.properties, login: text },
      required: ["login", "subject", "scopes"],
    },
  },
  local: {
    ...developmentPrincipalSchema,
    properties: { ...developmentPrincipalSchema.properties, codeFile: text },
    required: ["subject", "scopes", "codeFile"],
  },
  services: {
    type: "array",
    items: {
      ...developmentPrincipalSchema,
      properties: { ...developmentPrincipalSchema.properties, clientId: text, secretFile: text },
      required: ["subject", "scopes", "clientId", "secretFile"],
    },
  },
});
/** File-input schema: required target values are checked after environment overrides. */
export const TRUST_CONFIGURATION_SCHEMA = fields({
  server: fields({
    host: text,
    port: { type: "integer", minimum: 0, maximum: 65535 },
    webPort: { type: "integer", minimum: 1, maximum: 65535 },
    stateDirectory: text,
    semanticAuthority: text,
    operationsDirectory: text,
    extensionsFile: text,
    sessionDurationMs: integer,
    trialTimeoutMs: integer,
    extensionTimeoutMs: integer,
    runnerTrialScript: text,
    diagnosticsEndpoint: text,
  }),
  storage: fields({ kind: { enum: ["pglite", "postgresql"] }, directory: text, connectionString: text }),
  authentication: {
    ...fields({
      profile: { enum: ["local", "fixed", "development", "shared"] },
      access: accessSchema,
      browser: browserSchema,
      resourceUrl: text,
      development: developmentSchema,
    }),
    allOf: [
      {
        if: { properties: { profile: { const: "fixed" } }, required: ["profile"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a Promise-like API.
        then: {
          required: ["access"],
          properties: { access: { properties: { mode: { const: "fixed" } } } },
          not: { anyOf: [{ required: ["browser"] }, { required: ["resourceUrl"] }, { required: ["development"] }] },
        },
        else: { properties: { access: { not: { properties: { mode: { const: "fixed" } }, required: ["mode"] } } } },
      },
    ],
  },
  logging: fields({
    level: { enum: ["fatal", "error", "warn", "info", "debug", "trace", "silent"] },
    runtimePath: text,
    runnerPath: text,
  }),
  runner: fields({
    rpcEndpoint: text,
    otlpEndpoint: text,
    authFile: text,
    shellTimeoutMs: integer,
    additionalPath: { type: "array", items: text },
  }),
  shell: fields({
    installRoot: text,
    url: text,
    webAccessPassword: text,
    mobileUpstreams: {
      type: "object",
      additionalProperties: fields({ url: text, pathMode: { enum: ["strip", "preserve"] } }),
    },
  }),
});

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Invalid configuration ${label}`);
  return value as Record<string, unknown>;
};
function validateShape(value: unknown, schema: unknown, label: string): void {
  const definition = schema as { type?: string; properties?: Record<string, unknown>; additionalProperties?: unknown };
  if (!definition.properties) return;
  const input = record(value, label);
  for (const [name, item] of Object.entries(input)) {
    const child = definition.properties[name];
    if (!child) throw new TypeError(`Unknown configuration field ${label}.${name}`);
    validateShape(item, child, `${label}.${name}`);
  }
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.trim() !== value)
    throw new TypeError(`Invalid configuration ${label}`);
  return value;
}
function count(value: unknown, label: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(`Invalid configuration ${label}`);
  return value;
}
function url(value: unknown, label: string, protocols = ["http:", "https:"]): string {
  const raw = nonempty(value, label);
  try {
    const parsed = new URL(raw);
    if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search)
      throw new Error();
  } catch {
    throw new TypeError(`Invalid configuration ${label}`);
  }
  return raw;
}
const absolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

/** Pure merge/validation. The host owns file reads and platform path resolution. */
export function resolveTrustConfiguration(options: {
  readonly file?: unknown;
  readonly environment: ConfigurationEnvironment;
  readonly resolvePath: (value: string) => string;
  readonly mode: "server" | "runtime" | "runner";
  readonly defaultStateDirectory?: string;
  readonly defaultRunnerTrialScript?: string;
}): ResolvedTrustConfiguration {
  const input = options.file ?? {};
  validateShape(input, TRUST_CONFIGURATION_SCHEMA, "configuration");
  const root = record(input, "configuration");
  const env = options.environment;
  if (env.TRUST_DATABASE_PATH !== undefined)
    throw new TypeError(
      "TRUST_DATABASE_PATH is retired; preserve SQLite and explicitly import before selecting storage",
    );
  const sources: Record<string, ConfigurationSource> = {};
  const pick = (section: string, key: string, environment: string | undefined, fallback: unknown): unknown => {
    const value = root[section] === undefined ? undefined : record(root[section], section)[key];
    const name = `${section}.${key}`;
    if (environment && env[environment] !== undefined) {
      sources[name] = "environment";
      return env[environment];
    }
    if (value !== undefined) {
      sources[name] = "file";
      return value;
    }
    sources[name] = "default";
    return fallback;
  };
  const stringValue = (section: string, key: string, environment: string | undefined, fallback: string): string =>
    nonempty(pick(section, key, environment, fallback), `${section}.${key}`);
  const optional = (
    section: string,
    key: string,
    environment: string | undefined,
    fallback?: string,
  ): string | undefined => {
    const value = pick(section, key, environment, fallback);
    return value === undefined ? undefined : nonempty(value, `${section}.${key}`);
  };
  const numberValue = (
    section: string,
    key: string,
    environment: string,
    fallback: number,
    min = 1,
    max = 2147483647,
  ): number => {
    const raw = pick(section, key, environment, fallback);
    const value =
      sources[`${section}.${key}`] === "environment" && typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : raw;
    return count(value, `${section}.${key}`, min, max);
  };
  const pathValue = (
    section: string,
    key: string,
    environment: string | undefined,
    fallback?: string,
  ): string | undefined => {
    const raw = optional(section, key, environment, fallback);
    return raw === undefined ? undefined : options.resolvePath(raw);
  };
  const jsonValue = (section: string, key: string, environment: string, fallback: unknown): unknown => {
    const raw = pick(section, key, environment, fallback);
    if (sources[`${section}.${key}`] !== "environment") return raw;
    try {
      return JSON.parse(raw as string) as unknown;
    } catch {
      throw new TypeError(`Invalid configuration ${section}.${key} JSON`);
    }
  };
  const host = stringValue("server", "host", "TRUST_HOST", "127.0.0.1");
  if (/[\s/\\?#@]/.test(host)) throw new TypeError("Invalid configuration server.host");
  const port = numberValue("server", "port", "TRUST_PORT", 4318, options.mode === "runtime" ? 0 : 1, 65535);
  const webPort = numberValue("server", "webPort", "TRUST_WEB_PORT", 4173, 1, 65535);
  if (options.mode === "server" && port === webPort) throw new TypeError("Runtime and web ports must differ");
  const stateDirectory = pathValue(
    "server",
    "stateDirectory",
    "TRUST_SERVER_STATE_DIRECTORY",
    options.defaultStateDirectory ?? ".trust/server",
  )!;
  const authority = stringValue(
    "server",
    "semanticAuthority",
    "TRUST_SEMANTIC_AUTHORITY",
    options.mode === "server" ? configurationAuthority(host, port) : "localhost:4318",
  );
  if (host.includes(":") && sources["server.semanticAuthority"] === "default") {
    throw new TypeError("IPv6 bind requires explicit server.semanticAuthority using a lowercase DNS or IPv4 host");
  }
  try {
    normalizeAuthority(authority);
  } catch {
    throw new TypeError(
      "Invalid configuration server.semanticAuthority; use a canonical lowercase DNS or IPv4 authority with an optional port",
    );
  }
  const operationsDirectory = pathValue(
    "server",
    "operationsDirectory",
    "TRUST_OPERATIONS_DIRECTORY",
    options.mode === "server" ? `${stateDirectory}/operations` : undefined,
  );
  const extensionsFile = pathValue("server", "extensionsFile", "TRUST_EXTENSIONS_FILE");
  const runnerTrialScript = pathValue(
    "server",
    "runnerTrialScript",
    "TRUST_RUNNER_TRIAL_SCRIPT",
    options.defaultRunnerTrialScript,
  );
  const diagnosticsEndpoint = optional(
    "server",
    "diagnosticsEndpoint",
    "TRUST_DIAGNOSTICS_ENDPOINT",
    port !== 0 ? `http://${configurationAuthority(host, port)}/otlp/diagnostics` : undefined,
  );
  if (diagnosticsEndpoint) url(diagnosticsEndpoint, "server.diagnosticsEndpoint");
  const kind = stringValue("storage", "kind", "TRUST_STORAGE", "pglite");
  const directory = pathValue("storage", "directory", "TRUST_PGLITE_DIRECTORY");
  const connectionString = optional("storage", "connectionString", "TRUST_DATABASE_URL");
  let storage: StorageConfiguration;
  if (kind === "postgresql") {
    if (directory !== undefined || connectionString === undefined)
      throw new TypeError("PostgreSQL storage requires connectionString and excludes directory");
    try {
      if (!["postgres:", "postgresql:"].includes(new URL(connectionString).protocol)) throw new Error();
    } catch {
      throw new TypeError("Invalid configuration storage.connectionString");
    }
    storage = Object.freeze({ kind, connectionString });
  } else if (kind === "pglite") {
    if (connectionString !== undefined) throw new TypeError("PGlite storage excludes connectionString");
    storage = Object.freeze({
      kind,
      directory:
        directory ?? options.resolvePath(options.mode === "server" ? `${stateDirectory}/pglite` : ".trust/pglite"),
    });
  } else throw new TypeError("Unknown configuration storage.kind");
  let auth: unknown = root.authentication ?? { profile: "local", access: { mode: "local" } };
  sources.authentication = root.authentication === undefined ? "default" : "file";
  if (env.TRUST_AUTHENTICATION !== undefined) {
    try {
      auth = JSON.parse(env.TRUST_AUTHENTICATION);
    } catch {
      throw new TypeError("Invalid TRUST_AUTHENTICATION JSON");
    }
    sources.authentication = "environment";
  }
  const authentication = parseAuthenticationConfiguration(auth);
  const level = stringValue("logging", "level", "TRUST_LOG_LEVEL", "info");
  if (!["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(level))
    throw new TypeError("Invalid configuration logging.level");
  const runtimePath = pathValue(
    "logging",
    "runtimePath",
    "TRUST_RUNTIME_LOG_PATH",
    options.mode === "server" ? `${stateDirectory}/runtime.log` : undefined,
  );
  const runnerPath = pathValue("logging", "runnerPath", "TRUST_RUNNER_LOG_PATH", `${stateDirectory}/runner.log`)!;
  const rpcEndpoint = url(
    pick("runner", "rpcEndpoint", "TRUST_RPC_ENDPOINT", "http://127.0.0.1:4318/rpc"),
    "runner.rpcEndpoint",
  );
  const otlpEndpoint = url(
    pick("runner", "otlpEndpoint", "TRUST_OTLP_ENDPOINT", "http://127.0.0.1:4318/v1/traces"),
    "runner.otlpEndpoint",
  );
  const authFile = optional("runner", "authFile", "TRUST_AUTH_FILE");
  if (authFile && !absolute(authFile)) throw new TypeError("runner.authFile must be absolute");
  const additionalPath = jsonValue("runner", "additionalPath", "TRUST_RUNNER_ADDITIONAL_PATH", []);
  if (
    !Array.isArray(additionalPath) ||
    additionalPath.some((item) => typeof item !== "string" || !absolute(item) || item.includes("\0"))
  )
    throw new TypeError("Invalid configuration runner.additionalPath");
  const installRoot = optional("shell", "installRoot", "TRUST_INSTALL_ROOT");
  if (installRoot && !absolute(installRoot)) throw new TypeError("shell.installRoot must be absolute");
  const webAccessPassword = optional("shell", "webAccessPassword", "TRUST_WEB_ACCESS_PASSWORD");
  if (webAccessPassword && (webAccessPassword.length < 20 || authentication.profile !== "local"))
    throw new TypeError("Basic web gate requires at least 20 characters and local authentication");
  const upstreams = record(
    jsonValue("shell", "mobileUpstreams", "TRUST_MOBILE_UPSTREAMS", {}),
    "shell.mobileUpstreams",
  );
  const mobileUpstreams: Record<string, { url: string; pathMode?: "strip" | "preserve" }> = {};
  for (const [id, raw] of Object.entries(upstreams)) {
    const item = record(raw, "shell.mobileUpstreams entry");
    if (!/^[a-z][a-z0-9-]*$/.test(id) || Object.keys(item).some((key) => !["url", "pathMode"].includes(key)))
      throw new TypeError("Invalid mobile upstream entry");
    const endpoint = new URL(url(item.url, "shell.mobileUpstreams.url"));
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      !endpoint.port ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      (item.pathMode !== undefined && item.pathMode !== "strip" && item.pathMode !== "preserve")
    )
      throw new TypeError("Mobile upstreams require exact loopback origins");
    mobileUpstreams[id] = Object.freeze({
      url: endpoint.origin,
      ...(item.pathMode ? { pathMode: item.pathMode } : {}),
    });
  }
  return Object.freeze({
    configuration: Object.freeze({
      server: Object.freeze({
        host,
        port,
        webPort,
        stateDirectory,
        semanticAuthority: authority,
        ...(operationsDirectory ? { operationsDirectory } : {}),
        ...(extensionsFile ? { extensionsFile } : {}),
        ...(runnerTrialScript ? { runnerTrialScript } : {}),
        ...(diagnosticsEndpoint ? { diagnosticsEndpoint } : {}),
        sessionDurationMs: numberValue("server", "sessionDurationMs", "TRUST_SESSION_DURATION_MS", 86400000),
        trialTimeoutMs: numberValue("server", "trialTimeoutMs", "TRUST_TRIAL_TIMEOUT_MS", 600000),
        extensionTimeoutMs: numberValue("server", "extensionTimeoutMs", "TRUST_EXTENSION_TIMEOUT_MS", 10000),
      }),
      storage,
      authentication,
      logging: Object.freeze({ level, ...(runtimePath ? { runtimePath } : {}), runnerPath }),
      runner: Object.freeze({
        rpcEndpoint,
        otlpEndpoint,
        ...(authFile ? { authFile } : {}),
        shellTimeoutMs: numberValue("runner", "shellTimeoutMs", "TRUST_SHELL_TIMEOUT_MS", 600000),
        additionalPath: Object.freeze([...additionalPath]),
      }),
      shell: Object.freeze({
        ...(installRoot ? { installRoot } : {}),
        url: url(pick("shell", "url", "TRUST_URL", `http://${configurationAuthority(host, webPort)}`), "shell.url"),
        ...(webAccessPassword ? { webAccessPassword } : {}),
        mobileUpstreams: Object.freeze(mobileUpstreams),
      }),
    }),
    sources: Object.freeze(sources),
  });
}

/** Host IO is injected so the canonical SDK remains independent of Node and server code. */
export async function loadTrustConfiguration(
  options: Omit<Parameters<typeof resolveTrustConfiguration>[0], "file"> & {
    readonly readJson: (file: string) => Promise<unknown>;
  },
): Promise<ResolvedTrustConfiguration> {
  const read = async (name: string): Promise<unknown> => {
    const file = options.environment[name];
    if (file === undefined) return undefined;
    if (!absolute(file)) throw new TypeError(`${name} must be an absolute path`);
    try {
      return await options.readJson(file);
    } catch {
      throw new TypeError(`${name} must contain readable JSON`);
    }
  };
  if (options.environment.TRUST_AUTH_CONFIG_FILE !== undefined)
    throw new TypeError("TRUST_AUTH_CONFIG_FILE is retired; use TRUST_CONFIG_FILE with an authentication section");
  const file = await read("TRUST_CONFIG_FILE");
  return resolveTrustConfiguration({ ...options, ...(file === undefined ? {} : { file }) });
}

export function publicTrustConfiguration(result: ResolvedTrustConfiguration): unknown {
  const configuration = result.configuration;
  return {
    configuration: {
      ...configuration,
      storage:
        configuration.storage.kind === "postgresql"
          ? { kind: configuration.storage.kind, connectionString: "[redacted]" }
          : configuration.storage,
      shell: {
        ...configuration.shell,
        ...(configuration.shell.webAccessPassword ? { webAccessPassword: "[redacted]" } : {}),
      },
    },
    sources: result.sources,
  };
}
