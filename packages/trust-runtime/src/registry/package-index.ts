import { posix } from "node:path";
import {
  REGISTRY_ARTIFACT_INDEX_CONTRACT,
  REGISTRY_PACKAGE_INDEX_CONTRACT,
  type RegistryAvailablePackage,
  type RegistryContentCategory,
  type RegistryContentDeclaration,
  type RegistryExtensionDeclaration,
  type RegistryPackageContent,
  type RegistryPackageDeclaration,
  type RegistryPackageIndex,
} from "@trust/extension-sdk";
import { isExactVersion } from "@trust/operation/version";

import { RegistryError } from "./error.js";
import { decodeUtf8 } from "./source-reader.js";

const MAX_EXTENSION_FILES = 2_000;

export interface RegistryIndexArtifact {
  readonly kind: "operation" | "procedure";
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
}

export interface RegistryArtifactIndex {
  readonly contract: typeof REGISTRY_ARTIFACT_INDEX_CONTRACT;
  readonly artifacts: readonly RegistryIndexArtifact[];
}

function parseJson(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, "index")) as unknown;
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("invalid-index", "Registry index is not valid JSON");
  }
  if (!isRecord(value)) throw new RegistryError("invalid-index", "Registry index must be a JSON object");
  return value;
}

/** `trust.registry-index@1`: Operations and Procedures imported by synchronization. */
export function parseArtifactIndex(bytes: Uint8Array): RegistryArtifactIndex {
  const value = parseJson(bytes);
  if (
    !hasOnlyKeys(value, ["contract", "artifacts"]) ||
    value.contract !== REGISTRY_ARTIFACT_INDEX_CONTRACT ||
    !Array.isArray(value.artifacts)
  ) {
    throw new RegistryError("invalid-index", `Registry index must use contract ${REGISTRY_ARTIFACT_INDEX_CONTRACT}`);
  }
  const artifacts = value.artifacts.map((artifact, index) => {
    if (
      !isRecord(artifact) ||
      !hasOnlyKeys(artifact, ["kind", "path", "name", "version", "sha256"]) ||
      (artifact.kind !== "operation" && artifact.kind !== "procedure") ||
      !validRelativePath(artifact.path) ||
      !nonEmptyString(artifact.name, 255) ||
      !nonEmptyString(artifact.version, 255) ||
      !validDigest(artifact.sha256)
    ) {
      throw new RegistryError("invalid-index", `Registry artifact ${index} is invalid`);
    }
    return {
      kind: artifact.kind,
      path: artifact.path,
      name: artifact.name,
      version: artifact.version,
      sha256: artifact.sha256,
    } as RegistryIndexArtifact;
  });
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
  return { contract: REGISTRY_ARTIFACT_INDEX_CONTRACT, artifacts };
}

/** `trust.registry-index@2`: packages with independent optional content categories. */
export function parsePackageIndex(bytes: Uint8Array): RegistryPackageIndex {
  const value = parseJson(bytes);
  if (
    !hasOnlyKeys(value, ["contract", "base", "packages"]) ||
    value.contract !== REGISTRY_PACKAGE_INDEX_CONTRACT ||
    !Array.isArray(value.packages)
  ) {
    throw new RegistryError(
      "invalid-index",
      `Registry package index must use contract ${REGISTRY_PACKAGE_INDEX_CONTRACT} with base and packages`,
    );
  }
  if (value.base !== "." && !validRelativePath(value.base))
    throw new RegistryError(
      "invalid-index",
      "Registry index base must be '.' or a relative directory inside the source",
    );
  const base = value.base as string;
  const packages = value.packages.map((raw, index) => parsePackage(raw, index));
  const identities = new Set<string>();
  for (const declaration of packages) {
    const identity = `${declaration.name}@${declaration.version}`;
    if (identities.has(identity))
      throw new RegistryError("invalid-index", `Registry index repeats package ${identity}`);
    identities.add(identity);
  }
  return { contract: REGISTRY_PACKAGE_INDEX_CONTRACT, base, packages };
}

function parsePackage(raw: unknown, index: number): RegistryPackageDeclaration {
  const label = `Registry package ${index}`;
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, ["name", "version", "title", "description", "extension", "operations", "procedures"]) ||
    typeof raw.name !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(raw.name) ||
    typeof raw.version !== "string" ||
    !isExactVersion(raw.version) ||
    (raw.title !== undefined && !nonEmptyString(raw.title, 200)) ||
    (raw.description !== undefined && !nonEmptyString(raw.description, 2_000))
  )
    throw new RegistryError("invalid-index", `${label} requires a lowercase name and an exact SemVer version`);
  const operations = raw.operations === undefined ? undefined : contents(raw.operations, `${label} operations`);
  const procedures = raw.procedures === undefined ? undefined : contents(raw.procedures, `${label} procedures`);
  const extension = raw.extension === undefined ? undefined : parseExtension(raw.extension, label);
  if (extension === undefined && !operations?.length && !procedures?.length)
    throw new RegistryError("invalid-index", `${label} declares no extension code, Operation or Procedure`);
  const declaration: RegistryPackageDeclaration = {
    name: raw.name,
    version: raw.version,
    ...(raw.title === undefined ? {} : { title: raw.title as string }),
    ...(raw.description === undefined ? {} : { description: raw.description as string }),
    ...(extension ? { extension } : {}),
    ...(operations?.length ? { operations } : {}),
    ...(procedures?.length ? { procedures } : {}),
  };
  const paths = contentPaths(declaration);
  if (new Set(paths).size !== paths.length)
    throw new RegistryError("invalid-index", `${label} declares the same content path twice`);
  return declaration;
}

function parseExtension(raw: unknown, label: string): RegistryExtensionDeclaration {
  const declaration = content(raw, `${label} extension`, ["files"]);
  const value = raw as Record<string, unknown>;
  if (posix.basename(declaration.path) !== "extension.json" || !Array.isArray(value.files))
    throw new RegistryError("invalid-index", `${label} extension must locate extension.json and list its files`);
  if (value.files.length > MAX_EXTENSION_FILES)
    throw new RegistryError("invalid-index", `${label} extension lists more than ${MAX_EXTENSION_FILES} files`);
  const directory = posix.dirname(declaration.path);
  const files = value.files.map((file) => {
    if (
      !isRecord(file) ||
      !hasOnlyKeys(file, ["path", "sha256"]) ||
      !validRelativePath(file.path) ||
      file.path.endsWith("/") ||
      !validDigest(file.sha256) ||
      (directory !== "." && !file.path.startsWith(`${directory}/`))
    )
      throw new RegistryError(
        "invalid-index",
        `${label} extension files must be located inside the extension directory with a SHA-256`,
      );
    return { path: file.path, sha256: file.sha256 };
  });
  return { ...declaration, files };
}

function contents(raw: unknown, label: string): RegistryContentDeclaration[] {
  if (!Array.isArray(raw)) throw new RegistryError("invalid-index", `${label} must be a list`);
  return raw.map((item) => content(item, label));
}

function content(item: unknown, label: string, extraKeys: readonly string[] = []): RegistryContentDeclaration {
  if (
    !isRecord(item) ||
    !hasOnlyKeys(item, ["path", "name", "version", "sha256", ...extraKeys]) ||
    !validRelativePath(item.path) ||
    item.path.endsWith("/") ||
    !nonEmptyString(item.name, 255) ||
    !nonEmptyString(item.version, 255) ||
    !validDigest(item.sha256)
  )
    throw new RegistryError("invalid-index", `${label} entries require path, name, version and sha256`);
  return { path: item.path, name: item.name, version: item.version, sha256: item.sha256 };
}

export function contentPaths(declaration: RegistryPackageDeclaration): string[] {
  return [
    ...(declaration.extension ? [declaration.extension.path, ...declaration.extension.files.map((f) => f.path)] : []),
    ...(declaration.operations ?? []).map((content) => content.path),
    ...(declaration.procedures ?? []).map((content) => content.path),
  ];
}

/** Root-relative path of a base-relative content path. */
export function rootPath(base: string, path: string): string {
  return base === "." ? path : posix.join(base, path);
}

export function categoriesOf(declaration: RegistryPackageDeclaration): RegistryContentCategory[] {
  return [
    ...(declaration.extension ? (["extension"] as const) : []),
    ...(declaration.operations?.length ? (["operations"] as const) : []),
    ...(declaration.procedures?.length ? (["procedures"] as const) : []),
  ];
}

export function buildRequired(declaration: RegistryPackageDeclaration): boolean {
  const extension = declaration.extension;
  if (!extension) return false;
  const directory = posix.dirname(extension.path);
  return extension.files.some(
    (file) => file.path === (directory === "." ? "package.json" : `${directory}/package.json`),
  );
}

/** Declared contents with their resolved locations; reading them never downloads anything. */
export function availablePackage(
  source: string,
  index: RegistryPackageIndex,
  declaration: RegistryPackageDeclaration,
  locate: (rootRelativePath: string) => string,
  installedVersion: string | null,
): RegistryAvailablePackage {
  const content = (
    kind: RegistryPackageContent["kind"],
    value: { path: string; sha256: string; name?: string; version?: string },
  ): RegistryPackageContent => ({
    kind,
    path: value.path,
    location: locate(rootPath(index.base, value.path)),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.version === undefined ? {} : { version: value.version }),
    sha256: value.sha256,
  });
  const extension = declaration.extension;
  return {
    source,
    name: declaration.name,
    version: declaration.version,
    ...(declaration.title === undefined ? {} : { title: declaration.title }),
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
    categories: categoriesOf(declaration),
    buildRequired: buildRequired(declaration),
    contents: [
      ...(extension
        ? [content("extension", extension), ...extension.files.map((file) => content("extension-file", file))]
        : []),
      ...(declaration.operations ?? []).map((value) => content("operation", value)),
      ...(declaration.procedures ?? []).map((value) => content("procedure", value)),
    ],
    installedVersion,
  };
}

export function validRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    posix.normalize(value) === value &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
