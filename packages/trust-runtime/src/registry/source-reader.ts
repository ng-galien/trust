import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { REGISTRY_INDEX_FILE, type RegistrySource, type RegistrySourceInput } from "@trust/extension-sdk";
import { matchRegistrySource, matchRegistrySourceInput } from "@trust/extension-sdk/match";

import { RegistryError } from "./error.js";

const execFileAsync = promisify(execFile);
export const MAX_INDEX_BYTES = 1_048_576;
export const MAX_ARTIFACT_BYTES = 4_194_304;
const FETCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 120_000;

/**
 * One opened source state. Paths are relative to the index directory (repository root, index file directory
 * or index URL); every read is bounded and confined to that root.
 */
export interface SourceReader {
  /** Git commit, or SHA-256 of the index bytes. */
  readonly revision: string;
  readonly indexBytes: Buffer;
  read(path: string, limit: number): Promise<Buffer>;
  /** Public location of a root-relative path. */
  locate(path: string): string;
  close(): Promise<void>;
}

export function validateName(name: string): void {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(name)) {
    throw new RegistryError(
      "invalid-source",
      "Registry source name must use 1-64 lowercase letters, digits, dots, underscores or hyphens",
    );
  }
}

export function validateSource(input: RegistrySourceInput): RegistrySourceInput {
  validateName(input.name);
  if (input.url.length === 0 || input.url.length > 2_048 || /[\0\r\n]/u.test(input.url)) {
    throw new RegistryError("invalid-source", "Registry source URL must be a non-empty single-line value");
  }
  return matchRegistrySourceInput<RegistrySourceInput>(input, {
    file: ({ name, url }) => {
      if (!isAbsolute(url) || resolve(url) !== url)
        throw new RegistryError(
          "invalid-source",
          "A local registry source must be the absolute path of its index file",
        );
      return { name, kind: "file", url };
    },
    http: ({ name, url: raw }) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new RegistryError("invalid-source", "HTTP registry source URL is invalid");
      }
      if (url.username !== "" || url.password !== "") {
        throw new RegistryError("invalid-source", "HTTP registry source URL must not contain credentials");
      }
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
        throw new RegistryError(
          "invalid-source",
          "HTTP registry source URL must use HTTPS (HTTP is allowed only for loopback)",
        );
      }
      return { name, kind: "http", url: url.toString() };
    },
    git: ({ name, url, reference }) => {
      if (url.startsWith("-")) {
        throw new RegistryError("invalid-source", "Git registry source URL must not begin with an option prefix");
      }
      rejectEmbeddedGitCredentials(url);
      if (
        reference !== undefined &&
        (reference.length === 0 || reference.length > 255 || reference.startsWith("-") || /[\0\r\n]/u.test(reference))
      ) {
        throw new RegistryError("invalid-source", "Git registry source reference is invalid");
      }
      return { name, kind: "git", url, ...(reference === undefined ? {} : { reference }) };
    },
  });
}

/** Open the current source state, or the pinned Git commit recorded by the last refresh. */
export function openSource(source: RegistrySource, pinnedRevision?: string): Promise<SourceReader> {
  return matchRegistrySource(source, {
    git: (git) => openGit(git, pinnedRevision),
    http: (http) => openHttp(new URL(http.url)),
    file: (file) => openFile(file.url),
  });
}

async function openGit(
  source: Extract<RegistrySource, { kind: "git" }>,
  pinnedRevision: string | undefined,
): Promise<SourceReader> {
  const temporary = await mkdtemp(resolve(tmpdir(), "trust-registry-git-"));
  const checkout = resolve(temporary, "repository");
  const git = (args: string[]) =>
    execFileAsync("git", args, {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1_048_576,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  try {
    const args = ["clone", "--quiet", "--single-branch"];
    args.push(...(pinnedRevision === undefined ? ["--depth", "1"] : ["--no-checkout"]));
    if (source.reference !== undefined) args.push("--branch", source.reference);
    args.push("--", source.url, checkout);
    try {
      await git(args);
    } catch {
      throw new RegistryError("source-unavailable", `Git registry source ${source.name} could not be retrieved`);
    }
    if (pinnedRevision !== undefined) {
      try {
        await git(["-C", checkout, "checkout", "--quiet", "--detach", pinnedRevision]);
      } catch {
        throw new RegistryError(
          "source-unavailable",
          `Revision ${pinnedRevision} of registry source ${source.name} is no longer available; refresh the index explicitly`,
        );
      }
    }
    const revision = (await git(["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
    const indexBytes = await readConfined(checkout, REGISTRY_INDEX_FILE, MAX_INDEX_BYTES, "index");
    return {
      revision,
      indexBytes,
      read: (path, limit) => readConfined(checkout, path, limit, path),
      locate: (path) => path,
      close: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function openFile(indexFile: string): Promise<SourceReader> {
  const root = dirname(indexFile);
  let indexBytes: Buffer;
  try {
    indexBytes = await readConfined(root, posix.basename(indexFile.split(sep).join("/")), MAX_INDEX_BYTES, "index");
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("source-unavailable", "Registry index could not be read");
  }
  return {
    revision: sha256(indexBytes),
    indexBytes,
    read: (path, limit) => readConfined(root, path, limit, path),
    locate: (path) => resolve(root, ...path.split("/")),
    close: async () => {},
  };
}

async function openHttp(indexUrl: URL): Promise<SourceReader> {
  const indexBytes = await fetchBytes(indexUrl, MAX_INDEX_BYTES, "index");
  const resolveUrl = (path: string) => {
    const url = new URL(path, indexUrl);
    if (url.origin !== indexUrl.origin)
      throw new RegistryError("invalid-index", `Artifact ${path} must stay on the registry index origin`, path);
    return url;
  };
  return {
    revision: sha256(indexBytes),
    indexBytes,
    read: (path, limit) => fetchBytes(resolveUrl(path), limit, path),
    locate: (path) => resolveUrl(path).toString(),
    close: async () => {},
  };
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function decodeUtf8(bytes: Uint8Array, label: string): string {
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

function rejectEmbeddedGitCredentials(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && (url.username !== "" || url.password !== "")) {
    throw new RegistryError("invalid-source", "Git registry source URL must not contain HTTP credentials");
  }
  if (url.password !== "") {
    throw new RegistryError("invalid-source", "Git registry source URL must not contain a password");
  }
}

const failureReason = (label: string) => (label === "index" ? "source-unavailable" : "artifact-unavailable");
const failureArtifact = (label: string) => (label === "index" ? undefined : label);

/** Read one root-relative file without following a symbolic link or leaving the root. */
async function readConfined(root: string, relativePath: string, limit: number, label: string): Promise<Buffer> {
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!candidate.startsWith(`${root}${sep}`)) {
    throw new RegistryError("invalid-index", `Registry ${label} escapes the source root`, failureArtifact(label));
  }
  try {
    let current = root;
    for (const segment of relativePath.split("/")) {
      current = resolve(current, segment);
      if ((await lstat(current)).isSymbolicLink()) {
        throw new RegistryError(
          "invalid-index",
          `Registry ${label} must not be a symbolic link`,
          failureArtifact(label),
        );
      }
    }
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!realCandidate.startsWith(`${realRoot}${sep}`)) {
      throw new RegistryError("invalid-index", `Registry ${label} escapes the source root`, failureArtifact(label));
    }
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(failureReason(label), `Registry ${label} could not be read`, failureArtifact(label));
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(candidate);
  } catch (error) {
    throw new RegistryError(
      failureReason(label),
      `Registry ${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      failureArtifact(label),
    );
  }
  if (bytes.byteLength > limit) {
    throw new RegistryError(
      label === "index" ? "invalid-index" : "artifact-unavailable",
      `Registry ${label} exceeds ${limit} bytes`,
      failureArtifact(label),
    );
  }
  return bytes;
}

async function fetchBytes(url: URL, limit: number, label: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new RegistryError(
      failureReason(label),
      `Registry ${label} could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
      failureArtifact(label),
    );
  }
  if (!response.ok) {
    throw new RegistryError(
      failureReason(label),
      `Registry ${label} returned HTTP ${response.status}`,
      failureArtifact(label),
    );
  }
  if (new URL(response.url).origin !== url.origin) {
    throw new RegistryError(
      failureReason(label),
      `Registry ${label} redirected outside its configured origin`,
      failureArtifact(label),
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > limit) {
    throw new RegistryError(
      label === "index" ? "invalid-index" : "artifact-unavailable",
      `Registry ${label} exceeds ${limit} bytes`,
      failureArtifact(label),
    );
  }
  if (response.body === null) return Buffer.alloc(0);
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
          failureArtifact(label),
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
