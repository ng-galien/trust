import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { compileOperation, type CompiledOperation } from "@trust/operation";

import type { OperationCatalog } from "../operation/catalog.js";
import type { Procedures } from "../procedure/procedures.js";
import type { Clock } from "../time.js";
import type {
  RegistrySource,
  RegistrySourceInput,
  RegistrySourceStore,
} from "./store.js";

const execFileAsync = promisify(execFile);
const INDEX_CONTRACT = "trust.registry-index@1" as const;
const INDEX_FILE = "trust-registry.json";
const MAX_INDEX_BYTES = 1_048_576;
const MAX_ARTIFACT_BYTES = 4_194_304;
const FETCH_TIMEOUT_MS = 30_000;

export type RegistryErrorCode =
  | "invalid-source"
  | "unknown-source"
  | "source-unavailable"
  | "invalid-index"
  | "artifact-unavailable"
  | "artifact-integrity-mismatch"
  | "artifact-identity-mismatch"
  | "artifact-conflict"
  | "import-rejected";

export class RegistryError extends Error {
  constructor(
    readonly reason: RegistryErrorCode,
    message: string,
    readonly artifact?: string,
    readonly summary?: { readonly imported: number; readonly unchanged: number; readonly failed: number },
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface RegistryIndexArtifact {
  readonly kind: "operation" | "procedure";
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
}

export interface RegistryIndex {
  readonly contract: typeof INDEX_CONTRACT;
  readonly artifacts: readonly RegistryIndexArtifact[];
}

interface LoadedArtifact {
  readonly definition: RegistryIndexArtifact;
  readonly source: string;
}

export interface RegistrySyncResult {
  readonly contract: "trust.registry-sync@1";
  readonly source: RegistrySource;
  readonly index: typeof INDEX_CONTRACT;
  readonly artifacts: readonly {
    readonly kind: "operation" | "procedure";
    readonly name: string;
    readonly version: string;
    readonly status: "imported" | "unchanged";
  }[];
  readonly summary: { readonly imported: number; readonly unchanged: number; readonly failed: 0 };
}

export interface RegistryServiceDependencies {
  readonly registrySourceStore: RegistrySourceStore;
  readonly operationCatalog: OperationCatalog;
  readonly procedures: Procedures;
  readonly clock: Clock;
}

export class RegistryService {
  #synchronizations: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: RegistryServiceDependencies) {}

  list(): Promise<RegistrySource[]> {
    return this.dependencies.registrySourceStore.list();
  }

  async save(input: RegistrySourceInput): Promise<RegistrySource> {
    const source = validateSource(input);
    return this.dependencies.registrySourceStore.save(
      source,
      this.dependencies.clock.now().toISOString(),
    );
  }

  async remove(name: string): Promise<boolean> {
    validateName(name);
    return this.dependencies.registrySourceStore.remove(name);
  }

  sync(name: string): Promise<RegistrySyncResult> {
    validateName(name);
    const result = this.#synchronizations.then(
      () => this.#synchronize(name),
      () => this.#synchronize(name),
    );
    this.#synchronizations = result.then(() => undefined, () => undefined);
    return result;
  }

  async #synchronize(name: string): Promise<RegistrySyncResult> {
    const source = await this.dependencies.registrySourceStore.find(name);
    if (source === undefined) {
      throw new RegistryError("unknown-source", `Registry source ${name} does not exist`);
    }
    const loaded = await loadRegistry(source);
    const operations = loaded.artifacts.filter((artifact) => artifact.definition.kind === "operation");
    const procedures = loaded.artifacts.filter((artifact) => artifact.definition.kind === "procedure");

    const compiledOperations = compileOperations(source.name, operations).map((entry) => {
      const existing = this.dependencies.operationCatalog.entry(entry.compiled.operation, entry.compiled.version);
      if (existing !== undefined && existing.sourceName !== entry.sourceName) {
        throw new RegistryError(
          "artifact-conflict",
          `Operation ${entry.compiled.operation}@${entry.compiled.version} is already stored by another source`,
          entry.artifact.definition.path,
        );
      }
      return {
        ...entry,
        status: existing !== undefined && existing.operation.source === entry.compiled.source
          ? "unchanged" as const
          : "imported" as const,
      };
    });
    const futureOperations = mergedOperations(this.dependencies.operationCatalog.list(), compiledOperations);
    const compiledProcedures = procedures.map((artifact) => {
      try {
        const compiled = this.dependencies.procedures.compile(
          { source: artifact.source, sourceName: artifact.definition.path },
          futureOperations,
        );
        assertIdentity(artifact.definition, compiled.procedure, compiled.version);
        return { artifact, compiled, status: "imported" as "imported" | "unchanged" };
      } catch (error) {
        if (error instanceof RegistryError) throw error;
        throw new RegistryError(
          "import-rejected",
          `Procedure artifact ${artifact.definition.path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
          artifact.definition.path,
        );
      }
    });

    for (const entry of compiledProcedures) {
      const { artifact, compiled } = entry;
      const existing = await this.dependencies.procedures.find(compiled.procedure, compiled.version);
      if (existing !== undefined
        && (existing.procedure.definitionDigest !== compiled.definitionDigest
          || existing.procedure.source !== compiled.source)) {
        throw new RegistryError(
          "artifact-conflict",
          `Procedure ${compiled.procedure}@${compiled.version} is already published with another definition`,
          artifact.definition.path,
        );
      }
      if (existing !== undefined) entry.status = "unchanged";
    }

    let imported = 0;
    const unchanged = compiledOperations.filter(({ status }) => status === "unchanged").length
      + compiledProcedures.filter(({ status }) => status === "unchanged").length;
    try {
      for (const { artifact, sourceName, status } of compiledOperations) {
        if (status === "unchanged") continue;
        await this.dependencies.operationCatalog.save(artifact.source, sourceName);
        imported += 1;
      }
      for (const { artifact, status } of compiledProcedures) {
        if (status === "unchanged") continue;
        await this.dependencies.procedures.publish(
          { source: artifact.source, sourceName: artifact.definition.path },
          `registry:${source.name}`,
        );
        imported += 1;
      }
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      throw new RegistryError(
        "import-rejected",
        `Registry source ${source.name} could not be imported: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { imported, unchanged, failed: 1 },
      );
    }

    const artifacts = [
      ...compiledOperations.map(({ artifact, status }) => ({
        kind: "operation" as const,
        name: artifact.definition.name,
        version: artifact.definition.version,
        status,
      })),
      ...compiledProcedures.map(({ artifact, status }) => ({
        kind: "procedure" as const,
        name: artifact.definition.name,
        version: artifact.definition.version,
        status,
      })),
    ];

    return {
      contract: "trust.registry-sync@1",
      source,
      index: INDEX_CONTRACT,
      artifacts,
      summary: {
        imported,
        unchanged,
        failed: 0,
      },
    };
  }
}

function validateSource(input: RegistrySourceInput): RegistrySourceInput {
  validateName(input.name);
  if (input.url.length === 0 || input.url.length > 2_048 || /[\0\r\n]/u.test(input.url)) {
    throw new RegistryError("invalid-source", "Registry source URL must be a non-empty single-line value");
  }
  if (input.kind === "http") {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new RegistryError("invalid-source", "HTTP registry source URL is invalid");
    }
    if (url.username !== "" || url.password !== "") {
      throw new RegistryError("invalid-source", "HTTP registry source URL must not contain credentials");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new RegistryError("invalid-source", "HTTP registry source URL must use HTTPS (HTTP is allowed only for loopback)");
    }
    return { name: input.name, kind: "http", url: url.toString() };
  }
  if (input.url.startsWith("-")) {
    throw new RegistryError("invalid-source", "Git registry source URL must not begin with an option prefix");
  }
  rejectEmbeddedGitCredentials(input.url);
  if (input.reference !== undefined
    && (input.reference.length === 0 || input.reference.length > 255 || input.reference.startsWith("-") || /[\0\r\n]/u.test(input.reference))) {
    throw new RegistryError("invalid-source", "Git registry source reference is invalid");
  }
  return {
    name: input.name,
    kind: "git",
    url: input.url,
    ...(input.reference === undefined ? {} : { reference: input.reference }),
  };
}

function validateName(name: string): void {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(name)) {
    throw new RegistryError("invalid-source", "Registry source name must use 1-64 lowercase letters, digits, dots, underscores or hyphens");
  }
}

async function loadRegistry(source: RegistrySource): Promise<{ readonly index: RegistryIndex; readonly artifacts: LoadedArtifact[] }> {
  return source.kind === "git" ? loadGitRegistry(source) : loadHttpRegistry(source);
}

async function loadGitRegistry(source: Extract<RegistrySource, { kind: "git" }>): Promise<{ readonly index: RegistryIndex; readonly artifacts: LoadedArtifact[] }> {
  const temporary = await mkdtemp(resolve(tmpdir(), "trust-registry-git-"));
  const checkout = resolve(temporary, "repository");
  try {
    const args = ["clone", "--quiet", "--depth", "1", "--single-branch"];
    if (source.reference !== undefined) args.push("--branch", source.reference);
    args.push("--", source.url, checkout);
    try {
      await execFileAsync("git", args, { timeout: 60_000, maxBuffer: 1_048_576 });
    } catch (error) {
      throw new RegistryError("source-unavailable", `Git registry source ${source.name} could not be retrieved`);
    }
    const index = parseIndex(await readBoundedCheckoutFile(checkout, INDEX_FILE, MAX_INDEX_BYTES, "index"));
    const artifacts = await Promise.all(index.artifacts.map(async (definition) => ({
      definition,
      source: await readBoundedCheckoutFile(checkout, definition.path, MAX_ARTIFACT_BYTES, definition.path),
    })));
    verifyArtifacts(artifacts);
    return { index, artifacts };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function rejectEmbeddedGitCredentials(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if ((url.protocol === "http:" || url.protocol === "https:")
    && (url.username !== "" || url.password !== "")) {
    throw new RegistryError("invalid-source", "Git registry source URL must not contain HTTP credentials");
  }
  if (url.password !== "") {
    throw new RegistryError("invalid-source", "Git registry source URL must not contain a password");
  }
}

async function readBoundedCheckoutFile(
  checkout: string,
  relativePath: string,
  limit: number,
  label: string,
): Promise<string> {
  const candidate = safeCheckoutPath(checkout, relativePath);
  try {
    let current = checkout;
    for (const segment of relativePath.split("/")) {
      current = resolve(current, segment);
      if ((await lstat(current)).isSymbolicLink()) {
        throw new RegistryError("invalid-index", `Registry ${label} must not be a symbolic link`, label === "index" ? undefined : label);
      }
    }
    const [realCheckout, realCandidate] = await Promise.all([realpath(checkout), realpath(candidate)]);
    if (!realCandidate.startsWith(`${realCheckout}${sep}`)) {
      throw new RegistryError("invalid-index", `Registry ${label} escapes the Git checkout`, label === "index" ? undefined : label);
    }
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(
      label === "index" ? "source-unavailable" : "artifact-unavailable",
      `Registry ${label} could not be read`,
      label === "index" ? undefined : label,
    );
  }
  return readBoundedFile(candidate, limit, label);
}

async function loadHttpRegistry(source: Extract<RegistrySource, { kind: "http" }>): Promise<{ readonly index: RegistryIndex; readonly artifacts: LoadedArtifact[] }> {
  const indexUrl = new URL(source.url);
  const index = parseIndex(await fetchText(indexUrl, MAX_INDEX_BYTES, "index"));
  const artifacts = await Promise.all(index.artifacts.map(async (definition) => {
    const artifactUrl = new URL(definition.path, indexUrl);
    if (artifactUrl.origin !== indexUrl.origin) {
      throw new RegistryError("invalid-index", `Artifact ${definition.path} must stay on the registry index origin`, definition.path);
    }
    return {
      definition,
      source: await fetchText(artifactUrl, MAX_ARTIFACT_BYTES, definition.path),
    };
  }));
  verifyArtifacts(artifacts);
  return { index, artifacts };
}

async function fetchText(url: URL, limit: number, label: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new RegistryError(
      label === "index" ? "source-unavailable" : "artifact-unavailable",
      `Registry ${label} could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
      label === "index" ? undefined : label,
    );
  }
  if (!response.ok) {
    throw new RegistryError(
      label === "index" ? "source-unavailable" : "artifact-unavailable",
      `Registry ${label} returned HTTP ${response.status}`,
      label === "index" ? undefined : label,
    );
  }
  const finalUrl = new URL(response.url);
  if (finalUrl.origin !== url.origin) {
    throw new RegistryError(
      label === "index" ? "source-unavailable" : "artifact-unavailable",
      `Registry ${label} redirected outside its configured origin`,
      label === "index" ? undefined : label,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > limit) {
    throw new RegistryError(
      label === "index" ? "invalid-index" : "artifact-unavailable",
      `Registry ${label} exceeds ${limit} bytes`,
      label === "index" ? undefined : label,
    );
  }
  const bytes = await readBoundedResponse(response, limit, label);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RegistryError(
      label === "index" ? "invalid-index" : "artifact-unavailable",
      `Registry ${label} is not valid UTF-8`,
      label === "index" ? undefined : label,
    );
  }
}

async function readBoundedResponse(response: Response, limit: number, label: string): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RegistryError(
          label === "index" ? "invalid-index" : "artifact-unavailable",
          `Registry ${label} exceeds ${limit} bytes`,
          label === "index" ? undefined : label,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedFile(path: string, limit: number, label: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new RegistryError(
      label === "index" ? "source-unavailable" : "artifact-unavailable",
      `Registry ${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      label === "index" ? undefined : label,
    );
  }
  if (bytes.byteLength > limit) {
    throw new RegistryError(
      label === "index" ? "invalid-index" : "artifact-unavailable",
      `Registry ${label} exceeds ${limit} bytes`,
      label === "index" ? undefined : label,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RegistryError(
      label === "index" ? "invalid-index" : "artifact-unavailable",
      `Registry ${label} is not valid UTF-8`,
      label === "index" ? undefined : label,
    );
  }
}

function parseIndex(source: string): RegistryIndex {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new RegistryError("invalid-index", "Registry index is not valid JSON");
  }
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["contract", "artifacts"])
    || value.contract !== INDEX_CONTRACT
    || !Array.isArray(value.artifacts)) {
    throw new RegistryError("invalid-index", `Registry index must use contract ${INDEX_CONTRACT}`);
  }
  const artifacts = value.artifacts.map((artifact, index) => parseArtifact(artifact, index));
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const artifact of artifacts) {
    const identity = `${artifact.kind}:${artifact.name}@${artifact.version}`;
    if (paths.has(artifact.path) || identities.has(identity)) {
      throw new RegistryError("invalid-index", `Registry index repeats artifact ${identity}`, artifact.path);
    }
    paths.add(artifact.path);
    identities.add(identity);
  }
  return { contract: INDEX_CONTRACT, artifacts };
}

function parseArtifact(value: unknown, index: number): RegistryIndexArtifact {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["kind", "path", "name", "version", "sha256"])
    || (value.kind !== "operation" && value.kind !== "procedure")
    || !validArtifactPath(value.path)
    || !nonEmptyString(value.name, 255)
    || !nonEmptyString(value.version, 255)
    || typeof value.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new RegistryError("invalid-index", `Registry artifact ${index} is invalid`);
  }
  return {
    kind: value.kind,
    path: value.path,
    name: value.name,
    version: value.version,
    sha256: value.sha256,
  };
}

function verifyArtifacts(artifacts: readonly LoadedArtifact[]): void {
  for (const artifact of artifacts) {
    const actual = createHash("sha256").update(artifact.source).digest("hex");
    if (actual !== artifact.definition.sha256) {
      throw new RegistryError(
        "artifact-integrity-mismatch",
        `Artifact ${artifact.definition.path} SHA-256 does not match the registry index`,
        artifact.definition.path,
      );
    }
  }
}

function compileOperations(sourceName: string, artifacts: readonly LoadedArtifact[]): Array<{
  readonly artifact: LoadedArtifact;
  readonly sourceName: string;
  readonly compiled: CompiledOperation;
}> {
  return artifacts.map((artifact) => {
    try {
      const storedSourceName = operationSourceName(sourceName, artifact.definition);
      const compiled = compileOperation({ source: artifact.source, sourceName: storedSourceName });
      assertIdentity(artifact.definition, compiled.operation, compiled.version);
      return { artifact, sourceName: storedSourceName, compiled };
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      throw new RegistryError(
        "import-rejected",
        `Operation artifact ${artifact.definition.path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        artifact.definition.path,
      );
    }
  });
}

function mergedOperations(
  current: readonly CompiledOperation[],
  imported: readonly { readonly compiled: CompiledOperation }[],
): CompiledOperation[] {
  const importedIdentities = new Set(imported.map(({ compiled }) => `${compiled.operation}@${compiled.version}`));
  return [
    ...current.filter((operation) => !importedIdentities.has(`${operation.operation}@${operation.version}`)),
    ...imported.map(({ compiled }) => compiled),
  ];
}

function assertIdentity(definition: RegistryIndexArtifact, actualName: string, actualVersion: string): void {
  if (actualName !== definition.name || actualVersion !== definition.version) {
    throw new RegistryError(
      "artifact-identity-mismatch",
      `Artifact ${definition.path} declares ${actualName}@${actualVersion}; expected ${definition.name}@${definition.version}`,
      definition.path,
    );
  }
}

function operationSourceName(source: string, artifact: RegistryIndexArtifact): string {
  const digest = createHash("sha256")
    .update(`${source}\0${artifact.name}\0${artifact.version}`)
    .digest("hex")
    .slice(0, 24);
  return `registry-${digest}.feature`;
}

function safeCheckoutPath(checkout: string, path: string): string {
  const candidate = resolve(checkout, ...path.split("/"));
  if (!candidate.startsWith(`${checkout}${sep}`)) {
    throw new RegistryError("invalid-index", `Artifact path ${path} escapes the Git checkout`, path);
  }
  return candidate;
}

function validArtifactPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1_024
    && !value.startsWith("/")
    && !value.includes("\\")
    && posix.normalize(value) === value
    && value.split("/").every((part) => part !== "." && part !== "..");
}

function nonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
