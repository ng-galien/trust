import type { ExtensionDescriptor } from "./extension.js";
import type { ExtensionCapability } from "./index.js";
import type { ExtensionSettingsValues } from "./settings.js";

/** Operations and Procedures imported by explicit synchronization. */
export const REGISTRY_ARTIFACT_INDEX_CONTRACT = "trust.registry-index@1" as const;
/** Versioned packages: optional extension code, Operations and Procedures. */
export const REGISTRY_PACKAGE_INDEX_CONTRACT = "trust.registry-index@2" as const;
/** Fixed index location at the root of a Git registry repository. */
export const REGISTRY_INDEX_FILE = "trust-registry.json" as const;

/**
 * A named registry source. `url` is the Git repository, the HTTP(S) index URL, or the absolute path of a local
 * index file. Removing a source never uninstalls a package installed from it.
 */
export type RegistrySource =
  | {
      readonly name: string;
      readonly kind: "git";
      readonly url: string;
      readonly reference?: string;
      readonly createdAt: string;
      readonly updatedAt: string;
    }
  | {
      readonly name: string;
      readonly kind: "http";
      readonly url: string;
      readonly createdAt: string;
      readonly updatedAt: string;
    }
  | {
      readonly name: string;
      readonly kind: "file";
      readonly url: string;
      readonly createdAt: string;
      readonly updatedAt: string;
    };
export type RegistrySourceKind = RegistrySource["kind"];
export type RegistrySourceInput =
  | { readonly name: string; readonly kind: "git"; readonly url: string; readonly reference?: string }
  | { readonly name: string; readonly kind: "http"; readonly url: string }
  | { readonly name: string; readonly kind: "file"; readonly url: string };

/** One located content file. `path` is relative to the index `base`; `sha256` covers its exact bytes. */
export interface RegistryContentDeclaration {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
}
/**
 * Extension code: `path` locates `extension.json` (its `id` and `version` are `name` and `version`); `files`
 * lists every other source file of the extension directory. A `package.json` at that directory root makes the
 * installer build the extension before placing it.
 */
export interface RegistryExtensionDeclaration extends RegistryContentDeclaration {
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}
/** Every category is optional and independent; a package declares at least one. */
export interface RegistryPackageDeclaration {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description?: string;
  readonly extension?: RegistryExtensionDeclaration;
  readonly operations?: readonly RegistryContentDeclaration[];
  readonly procedures?: readonly RegistryContentDeclaration[];
}
/**
 * `trust.registry-index@2`. `base` is a relative directory resolved from the index location (the repository
 * root for Git, the index file directory for a local file, the index URL for HTTP); content paths resolve from it.
 */
export interface RegistryPackageIndex {
  readonly contract: typeof REGISTRY_PACKAGE_INDEX_CONTRACT;
  readonly base: string;
  readonly packages: readonly RegistryPackageDeclaration[];
}

export type RegistryContentCategory = "extension" | "operations" | "procedures";
export type RegistryContentKind = "extension" | "extension-file" | "operation" | "procedure";
export interface RegistryPackageContent {
  readonly kind: RegistryContentKind;
  /** Relative to the index base. */
  readonly path: string;
  /** Resolved location: repository-relative path (Git), absolute path (file) or absolute URL (HTTP). */
  readonly location: string;
  /** Declared identity; absent for extension files other than `extension.json`. */
  readonly name?: string;
  readonly version?: string;
  readonly sha256: string;
}
export interface RegistryAvailablePackage {
  readonly source: string;
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description?: string;
  readonly categories: readonly RegistryContentCategory[];
  /** True only when the package declares extension code with a `package.json`. */
  readonly buildRequired: boolean;
  readonly contents: readonly RegistryPackageContent[];
  /** Version currently installed from any source, or null. Availability never changes an installation. */
  readonly installedVersion: string | null;
}
/** Last explicitly refreshed index of one source; reading it never contacts the source. */
export interface RegistrySourceIndexView {
  readonly contract: "trust.registry-source-index@1";
  readonly source: RegistrySource;
  /** Git commit, or SHA-256 of the index bytes for HTTP and local file sources. */
  readonly revision: string;
  /** Resolved index base: repository-relative path, absolute directory or absolute URL. */
  readonly base: string;
  readonly refreshedAt: string;
  readonly packages: readonly RegistryAvailablePackage[];
}

export interface RegistryInstalledPackage {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly revision: string;
  /** Runtime-owned directory `<packages directory>/<name>/<version>`. */
  readonly directory: string;
  readonly categories: readonly RegistryContentCategory[];
  readonly extension: { readonly id: string; readonly version: string } | null;
  readonly operations: readonly { readonly name: string; readonly version: string }[];
  readonly procedures: readonly { readonly name: string; readonly version: string }[];
  /** Versions of this package in the source's last refreshed index; empty when the source was removed. */
  readonly availableVersions: readonly string[];
  readonly latestVersion: string | null;
  readonly installedAt: string;
  readonly updatedAt: string;
}
export interface RegistryPackageCatalog {
  readonly contract: "trust.registry-package-catalog@1";
  readonly packages: readonly RegistryInstalledPackage[];
}

/** Installation values of the extension code; required when the package declares extension code. */
export interface RegistryExtensionInstallationValues {
  readonly environment: string;
  readonly grants?: readonly ExtensionCapability[];
  readonly credentialEnvironment?: readonly string[];
  readonly autoStart?: boolean;
  readonly settings?: ExtensionSettingsValues;
}
export interface RegistryPackageInstallRequest {
  readonly source: string;
  readonly package: string;
  readonly version: string;
  readonly extension?: RegistryExtensionInstallationValues;
}
/** Explicit update to an identified version of the same source; settings and grants default to the current ones. */
export interface RegistryPackageUpdateRequest {
  readonly package: string;
  readonly version: string;
  readonly settings?: ExtensionSettingsValues;
  readonly grants?: readonly ExtensionCapability[];
}
export interface RegistryPackageUninstallRequest {
  readonly package: string;
  /** Deletes the extension's own stored data through its `deleteData` hook; false by default. */
  readonly deleteData?: boolean;
}

export type RegistryStepStatus = "completed" | "skipped";
export interface RegistryInstallationSteps {
  readonly acquisition: RegistryStepStatus;
  readonly verification: RegistryStepStatus;
  readonly build: RegistryStepStatus;
  readonly placement: RegistryStepStatus;
  readonly catalog: RegistryStepStatus;
  readonly extension: RegistryStepStatus;
}
export interface RegistryCatalogImportEntry {
  readonly kind: "operation" | "procedure";
  readonly name: string;
  readonly version: string;
  readonly status: "imported" | "unchanged";
}
export interface RegistryPackageInstallation {
  readonly contract: "trust.registry-package-installation@1";
  readonly package: RegistryInstalledPackage;
  readonly steps: RegistryInstallationSteps;
  readonly catalog: readonly RegistryCatalogImportEntry[];
  /** Registered STOPPED; storage preparation and start remain explicit. */
  readonly extension: ExtensionDescriptor | null;
}
export interface RegistryPackageUpdate {
  readonly contract: "trust.registry-package-update@1";
  readonly previousVersion: string;
  readonly package: RegistryInstalledPackage;
  readonly steps: RegistryInstallationSteps;
  readonly catalog: readonly RegistryCatalogImportEntry[];
  readonly extension: ExtensionDescriptor | null;
  readonly preparationRequired: boolean;
  readonly removed: readonly RegistryPackageItem[];
}

/** One item reported by an uninstallation or update. */
export interface RegistryPackageItem {
  readonly kind:
    | "files"
    | "extension"
    | "extension-settings"
    | "extension-data"
    | "operation"
    | "procedure"
    | "plans"
    | "source";
  readonly name: string;
  readonly version?: string;
  readonly reason?: string;
}
export interface RegistryPackageUninstallation {
  readonly contract: "trust.registry-package-uninstallation@1";
  readonly package: { readonly name: string; readonly version: string; readonly source: string };
  readonly removed: readonly RegistryPackageItem[];
  readonly kept: readonly RegistryPackageItem[];
}
export interface RegistrySourceRemoval {
  readonly contract: "trust.registry-source-removal@1";
  readonly name: string;
  readonly removed: boolean;
  /** Packages installed from this source; they stay installed. */
  readonly keptPackages: readonly string[];
}

export type RegistryErrorReason =
  | "invalid-source"
  | "unknown-source"
  | "source-unavailable"
  | "invalid-index"
  | "index-not-refreshed"
  | "artifact-unavailable"
  | "artifact-integrity-mismatch"
  | "artifact-identity-mismatch"
  | "artifact-conflict"
  | "import-rejected"
  | "invalid-request"
  | "unknown-package"
  | "package-already-installed"
  | "package-not-installed"
  | "package-version-installed"
  | "build-failed"
  | "extension-rejected"
  | "extension-start-failed"
  | "data-deletion-unsupported";
export type RegistryStep = keyof RegistryInstallationSteps | "uninstall";
/** JSON-RPC error data (code -32050) and MCP error body of every registry refusal. */
export interface RegistryFailure {
  readonly contract: "trust.registry-error@1";
  readonly reason: RegistryErrorReason;
  readonly message: string;
  readonly artifact?: string;
  readonly step?: RegistryStep;
  /** Bounded tail of the build output. */
  readonly output?: string;
  readonly summary: { readonly imported: number; readonly unchanged: number; readonly failed: number };
}
