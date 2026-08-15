import type {
  CompiledAutonomousProcedureDefinition,
  CompiledCapabilityCheckRef,
  CompilationErrorCode,
  CompiledTargetReference,
} from "@trust/procedure";

export const PROCEDURE_DEFINITION_COMPILE_METHOD = "procedure.definition.compile" as const;
export const PROCEDURE_DEFINITION_PUBLISH_METHOD = "procedure.definition.publish" as const;
export const PROCEDURE_DEFINITION_READ_METHOD = "procedure.definition.read" as const;
export const PROCEDURE_COMPILATION_ERROR_CONTRACT =
  "trust.procedure-compilation-error@1" as const;

export const SKILL_RELEASE_CLAIM_METHOD = "skill.release.claim" as const;
export const SKILL_VERIFIED_DISTRIBUTION_RECORD_METHOD =
  "skill.distribution.record-verified" as const;
export const SKILL_RELEASE_AUTHORIZATION_SET_METHOD =
  "skill.release.authorization.set" as const;
export const SKILL_DEPLOYMENT_AUTHORIZATION_SET_METHOD =
  "skill.deployment.authorization.set" as const;
export const SKILL_DEPLOYMENT_ANNOUNCE_METHOD = "skill.deployment.announce" as const;
export const SKILL_DEPLOYMENT_SELECTION_SET_METHOD =
  "skill.deployment.selection.set" as const;
export const SKILL_ENVIRONMENT_PREFLIGHT_METHOD = "environment.preflight" as const;
export const SKILL_REGISTRY_ERROR_CONTRACT = "trust.skill-registry-error@1" as const;
export const REGISTRY_AUTHORITY_ERROR_CONTRACT = "trust.registry-authority-error@1" as const;

export const PLAN_ENGAGE_METHOD = "plan.engage" as const;
export const CHECK_READ_METHOD = "check.read" as const;
export const CHECK_ATTEMPT_ADMIT_METHOD = "check.attempt.admit" as const;
export const CHECK_ATTEMPT_FINALIZE_METHOD = "check.attempt.finalize" as const;
export const SKILL_ATTEMPT_ADMIT_METHOD = "skill.attempt.admit" as const;
export const SKILL_ATTEMPT_FINALIZE_METHOD = "skill.attempt.finalize" as const;
export const PLAN_RUNTIME_ERROR_CONTRACT = "trust.plan-runtime-error@1" as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject<Data = unknown> {
  readonly code: number;
  readonly message: string;
  readonly data?: Data;
}

export interface JsonRpcSuccess<Result = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: Result;
}

export interface JsonRpcFailure<Data = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject<Data>;
}

export type JsonRpcResponse<Result = unknown, ErrorData = unknown> =
  | JsonRpcSuccess<Result>
  | JsonRpcFailure<ErrorData>;

export type SkillEnvelopeDto = "cli" | "mcp-stdio" | "mcp-http";

export interface PlanEngagementParams {
  readonly contract: "trust.plan-engagement-request@1";
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly plan: string;
  readonly environment: string;
  readonly rootInputs: Readonly<Record<string, unknown>>;
}

export interface PlanEngagementResultDto {
  readonly contract: "trust.plan-engagement@1";
  readonly status: "ENGAGED";
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly plan: string;
  readonly environment: string;
  readonly revision: number;
  readonly checkUris: readonly string[];
}

export interface CheckReadParams {
  readonly contract: "trust.check-read-request@1";
  readonly checkUri: string;
}

export interface CheckViewDto {
  readonly contract: "trust.check-view@1";
  readonly checkUri: string;
  readonly state: "OPEN" | "SATISFIED";
  readonly history: readonly {
    readonly verdict: "VALIDATED" | "NOT_VALIDATED";
    readonly reasonCode: string;
    readonly reason: string;
    readonly checklistDelta: {
      readonly newlySatisfied: readonly string[];
      readonly newlyOpened: readonly string[];
      readonly unchanged: readonly string[];
    };
  }[];
}

export interface SkillAttemptAdmissionParams {
  readonly contract: "trust.skill-admission-request@1";
  readonly attemptKey: string;
  readonly checkUri: string;
  readonly releaseDigest: string;
  readonly environment: string;
  readonly deploymentKey: string;
  readonly envelope: SkillEnvelopeDto;
  readonly runtimeIdentity: string;
  readonly processIdentity: string;
}

export interface CheckAttemptAdmissionParams {
  readonly contract: "trust.check-admission-request@1";
  readonly attemptKey: string;
  readonly checkUri: string;
}

export interface CheckAttemptFinalizationParams {
  readonly contract: "trust.check-finalization-request@1";
  readonly executionHandle: string;
}

export interface SkillAttemptFinalizationParams {
  readonly contract: "trust.skill-finalization-request@1";
  readonly executionHandle: string;
}

export type PlanRuntimeFailureReason =
  | "invalid-hosted-procedure-config"
  | "invalid-plan-engagement"
  | "invalid-plan-declarations"
  | "procedure-not-found"
  | "plan-conflict"
  | "check-not-found"
  | "fact-batch-rejected"
  | "execution-not-found"
  | "facts-missing";

export interface PlanRuntimeFailureData {
  readonly contract: typeof PLAN_RUNTIME_ERROR_CONTRACT;
  readonly reason: PlanRuntimeFailureReason;
  readonly message: string;
}

export interface SkillCapabilityClaimDto {
  readonly capability: string;
  readonly actionContractDigest: string;
}

export interface SkillReleaseClaimDto {
  readonly contract: "trust.skill-release@1";
  readonly skill: string;
  readonly version: string;
  readonly releaseDigest: string;
  readonly publisher: string;
  readonly implements: readonly SkillCapabilityClaimDto[];
  readonly entrypoints: {
    readonly cli: string;
    readonly mcpStdio?: string;
    readonly mcpHttp?: string;
  };
  readonly probes: readonly string[];
}

export interface SkillReleaseClaimParams {
  readonly release: SkillReleaseClaimDto;
}

export interface SkillReleaseClaimResult {
  readonly releaseDigest: string;
  readonly recordedAt: string;
}

export interface VerifiedSkillDistributionDto {
  readonly contract: "trust.verified-skill-distribution@1";
  readonly releaseDigest: string;
  readonly distributionDigest: string;
  readonly issuer: string;
  readonly verifiedAt: string;
  readonly signature: string;
}

export interface VerifiedSkillDistributionRecordParams {
  readonly distribution: VerifiedSkillDistributionDto;
}

export interface VerifiedSkillDistributionRecordResult {
  readonly releaseDigest: string;
  readonly distributionDigest: string;
  readonly verifiedAt: string;
}

export interface SkillReleaseAuthorizationSetParams {
  readonly environment: string;
  readonly releaseDigest: string;
  readonly decision: "ALLOW" | "REVOKE";
}

export interface SkillDeploymentAuthorizationSetParams {
  readonly environment: string;
  readonly deploymentKey: string;
  readonly releaseDigest: string;
  readonly envelope: SkillEnvelopeDto;
  readonly runtimeIdentity: string;
  readonly decision: "ALLOW" | "REVOKE";
}

export interface SkillAuthorizationSetResult {
  readonly decision: "ALLOW" | "REVOKE";
  readonly effectiveAt: string;
}

export interface SkillProbeResultDto {
  readonly name: string;
  readonly status: "PASS" | "FAIL";
  readonly reason: string;
  readonly observedAt: string;
}

export interface SkillDeploymentAnnouncementDto {
  readonly environment: string;
  readonly deploymentKey: string;
  readonly envelope: SkillEnvelopeDto;
  readonly runtimeIdentity: string;
  readonly processIdentity: string;
  readonly releaseDigest: string;
  readonly distributionDigest: string;
  readonly probes: readonly SkillProbeResultDto[];
  readonly announcedAt: string;
  readonly leaseExpiresAt: string;
}

export interface SkillDeploymentAnnounceParams {
  readonly announcement: SkillDeploymentAnnouncementDto;
}

export interface SkillDeploymentAnnounceResult {
  readonly environment: string;
  readonly deploymentKey: string;
  readonly announcedAt: string;
  readonly recordedAt: string;
  readonly leaseExpiresAt: string;
}

export interface SkillDeploymentSelectionSetParams {
  readonly environment: string;
  readonly requirement: SkillRequirementDto;
  readonly deploymentKey: string | null;
}

export interface SkillDeploymentSelectionSetResult {
  readonly environment: string;
  readonly requirement: SkillRequirementDto;
  readonly deploymentKey: string | null;
  readonly selectedAt: string | null;
}

export interface SkillRequirementDto {
  readonly capability: string;
  readonly actionContractDigest: string;
}

export interface SkillEnvironmentPreflightParams {
  readonly environment: string;
  readonly requirements: readonly SkillRequirementDto[];
}

export type SkillRequirementStatusDto =
  | "MISSING"
  | "INCOMPATIBLE"
  | "UNAUTHORIZED"
  | "UNAVAILABLE"
  | "READY";

export interface SkillRequirementPreflightDto extends SkillRequirementDto {
  readonly status: SkillRequirementStatusDto;
  readonly reasonCode:
    | "deployment-selection-missing"
    | "release-claim-missing"
    | "capability-not-implemented"
    | "action-contract-digest-mismatch"
    | "distribution-release-link-missing"
    | "release-compatible"
    | "release-unauthorized"
    | "deployment-unauthorized"
    | "deployment-announcement-missing"
    | "deployment-lease-expired"
    | "probe-missing"
    | "probe-failed"
    | "probe-stale"
    | "deployment-ready";
  readonly reason: string;
  readonly deploymentKey?: string;
  readonly skill?: string;
  readonly version?: string;
  readonly envelope?: SkillEnvelopeDto;
}

export interface SkillEnvironmentPreflightResult {
  readonly contract: "trust.environment-preflight@1";
  readonly scope: "environment";
  readonly environment: string;
  readonly evaluatedAt: string;
  readonly status: "READY" | "NOT_OPERABLE";
  readonly authorizesPlanEngagement: false;
  readonly summary: {
    readonly required: number;
    readonly ready: number;
    readonly blocked: number;
  };
  readonly coverage: readonly SkillRequirementPreflightDto[];
}

export type SkillRegistryFailureReason =
  | "invalid-record"
  | "release-digest-conflict"
  | "release-version-conflict"
  | "unknown-release"
  | "unknown-deployment"
  | "deployment-lease-conflict"
  | "announcement-clock-skew"
  | "announcement-not-monotonic"
  | "untrusted-distribution"
  | "invalid-lease";

export interface SkillRegistryFailureData {
  readonly contract: typeof SKILL_REGISTRY_ERROR_CONTRACT;
  readonly reason: SkillRegistryFailureReason;
  readonly message: string;
}

export type RegistryAuthorityFailureReason =
  | "credential-required"
  | "credential-invalid"
  | "role-denied"
  | "identity-mismatch"
  | "signature-invalid";

export interface RegistryAuthorityFailureData {
  readonly contract: typeof REGISTRY_AUTHORITY_ERROR_CONTRACT;
  readonly reason: RegistryAuthorityFailureReason;
  readonly message: string;
}

export type ProcedureActionContractValueType = "string" | "number" | "instant" | "reference";

export interface ProcedureDefinitionCompileParams {
  readonly source: string;
  readonly sourceName?: string;
}

export type ProcedureDefinitionPublishParams = ProcedureDefinitionCompileParams;

export interface ProcedureDefinitionReadParams {
  readonly procedure: string;
  readonly version: string;
}

export interface ProcedureDefinitionPublicationResult {
  readonly contract: "trust.published-procedure@1";
  readonly definition: ProcedureDefinitionCompileResultV2;
  readonly sourceName: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export interface ProcedureCapabilityCheckRefDto {
  readonly scenario: string;
  readonly capability: string;
  readonly target: ProcedureTargetDto;
}

export type ProcedureCapabilityExpectationDto =
  | {
      readonly kind: "literal";
      readonly token: string;
      readonly value: string | number;
      readonly valueType: "string" | "number";
      readonly cardinality: "one";
    }
  | {
      readonly kind: "valid-value";
      readonly token: "valid rfc3339";
      readonly codec: "rfc3339";
      readonly valueType: "instant";
      readonly cardinality: "one";
    }
  | {
      readonly kind: "context";
      readonly role: string;
      readonly valueType: ProcedureActionContractValueType;
      readonly cardinality: "one" | "many";
      readonly parents: readonly { readonly kind: "input" | "observation"; readonly port: string }[];
    }
  | {
      readonly kind: "check-observation";
      readonly check: string;
      readonly provider: ProcedureCapabilityCheckRefDto;
      readonly observation: string;
      readonly valueType: ProcedureActionContractValueType;
      readonly cardinality: "one" | "many";
      readonly parents: readonly { readonly kind: "input" | "observation"; readonly port: string }[];
    };

export interface ProcedureCapabilityPredicateDto {
  readonly observation: string;
  readonly observationType: ProcedureActionContractValueType;
  readonly observationCardinality: "one" | "many";
  readonly observationParents: readonly {
    readonly kind: "input" | "observation";
    readonly port: string;
  }[];
  readonly relation: "equals" | "at least" | "has at least" | "is in" | "before" | "after";
  readonly expectation: ProcedureCapabilityExpectationDto;
  readonly failureFeedback: string;
}

export interface ProcedureDefinitionCompileResultV2 {
  readonly contract: "trust.compiled-procedure@2";
  readonly procedure: string;
  readonly version: string;
  readonly title: string;
  /** Exact immutable authoring source for editor round-trip and audit. */
  readonly source: string;
  readonly definitionDigest: string;
  readonly requiredCapabilities: CompiledAutonomousProcedureDefinition["requiredCapabilities"];
  readonly roles: ReadonlyArray<{
    readonly name: string;
    readonly cardinality: "one" | "many";
    readonly parents: readonly { readonly role: string; readonly each: boolean }[];
    readonly valueType: ProcedureActionContractValueType;
    readonly materialization:
      | { readonly kind: "plan-input" }
      | { readonly kind: "agent-declaration" }
      | { readonly kind: "static"; readonly value: string }
      | {
          readonly kind: "capability-output";
          readonly output: string;
          readonly providers: readonly ProcedureCapabilityCheckRefDto[];
        };
  }>;
  readonly scenarios: ReadonlyArray<{
    readonly slug: string;
    readonly title: string;
    readonly dependencies: readonly string[];
    readonly aggregation: "all-skill-actions";
    readonly checks: readonly ProcedureCapabilityCheckRefDto[];
  }>;
  readonly checks: ReadonlyArray<{
    readonly ref: ProcedureCapabilityCheckRefDto;
    readonly capabilityContract: { readonly capability: string; readonly digest: string };
    readonly compiledCheckDigest: string;
    readonly uriTemplate: {
      readonly procedure: string;
      readonly version: string;
      readonly scenario: string;
      readonly capabilitySegment: string;
      readonly target: ProcedureTargetDto;
    };
    readonly name: string;
    readonly requiredCheckObservations: readonly string[];
    readonly inputBindings: CompiledAutonomousProcedureDefinition["checkTemplates"][number]["inputBindings"];
    readonly materializes: CompiledAutonomousProcedureDefinition["checkTemplates"][number]["materializes"];
    readonly successFeedback: string;
    readonly qualification: {
      readonly kind: "all";
      readonly predicates: readonly ProcedureCapabilityPredicateDto[];
    };
  }>;
}

export interface ProcedureTargetUseDto {
  readonly role: string;
  readonly selection: "one" | "all";
}

export interface ProcedureTargetDto {
  readonly primary: {
    readonly role: string;
    readonly selection: "one" | "each" | "all";
  };
  readonly using: readonly ProcedureTargetUseDto[];
}

export interface ProcedureCompilationFailureData {
  readonly contract: typeof PROCEDURE_COMPILATION_ERROR_CONTRACT;
  readonly reason: CompilationErrorCode;
  readonly message: string;
  readonly sourceName: string;
  readonly location: { readonly line: number; readonly column: number } | null;
}

const projectTarget = (target: CompiledTargetReference): ProcedureTargetDto => ({
  primary: {
    role: target.primary.role,
    selection: target.primary.selection,
  },
  using: target.using.map((use) => ({ role: use.role, selection: use.selection })),
});

const projectCapabilityCheckRef = (
  ref: CompiledCapabilityCheckRef,
): ProcedureCapabilityCheckRefDto => ({
  scenario: ref.scenario,
  capability: ref.capability,
  target: projectTarget(ref.target),
});

const projectCapabilityExpectation = (
  expectation: CompiledAutonomousProcedureDefinition["checkTemplates"][number]["qualification"]["predicates"][number]["expectation"],
): ProcedureCapabilityExpectationDto => {
  switch (expectation.kind) {
    case "literal":
      return { ...expectation };
    case "valid-value":
      return { ...expectation };
    case "context":
      return { ...expectation };
    case "check-observation":
      return {
        ...expectation,
        provider: projectCapabilityCheckRef(expectation.provider),
      };
  }
};

export const projectAutonomousCompiledDefinition = (
  definition: CompiledAutonomousProcedureDefinition,
): ProcedureDefinitionCompileResultV2 => ({
  contract: definition.contract,
  procedure: definition.procedure,
  version: definition.version,
  title: definition.title,
  source: definition.source,
  definitionDigest: definition.definitionDigest,
  requiredCapabilities: definition.requiredCapabilities.map((requirement) => ({
    capability: requirement.capability,
    contractCoreDigest: requirement.contractCoreDigest,
    actionContractDigest: requirement.actionContractDigest,
    contract: requirement.contract,
  })),
  roles: definition.roles.map((role) => ({
    name: role.name,
    cardinality: role.cardinality,
    parents: role.parents.map((parent) => ({ ...parent })),
    valueType: role.valueType,
    materialization: role.materialization.kind === "capability-output"
      ? {
          kind: role.materialization.kind,
          output: role.materialization.output,
          providers: role.materialization.providers.map(projectCapabilityCheckRef),
        }
      : role.materialization.kind === "static"
        ? { kind: role.materialization.kind, value: role.materialization.value }
        : { kind: role.materialization.kind },
  })),
  scenarios: definition.scenarios.map((scenario) => ({
    slug: scenario.slug,
    title: scenario.title,
    dependencies: [...scenario.dependencies],
    aggregation: scenario.aggregation,
    checks: scenario.checks.map(projectCapabilityCheckRef),
  })),
  checks: definition.checkTemplates.map((check) => ({
    ref: projectCapabilityCheckRef(check.ref),
    capabilityContract: { ...check.capabilityContract },
    compiledCheckDigest: check.compiledCheckDigest,
    uriTemplate: {
      procedure: check.uriTemplate.procedure,
      version: check.uriTemplate.version,
      scenario: check.uriTemplate.scenario,
      capabilitySegment: check.uriTemplate.capabilitySegment,
      target: projectTarget(check.uriTemplate.target),
    },
    name: check.name,
    requiredCheckObservations: [...check.requiredCheckObservations],
    inputBindings: check.inputBindings.map((binding) => ({ ...binding })),
    materializes: check.materializes.map((materialization) => ({
      ...materialization,
      parents: materialization.parents.map((parent) => ({ ...parent })),
    })),
    successFeedback: check.successFeedback,
    qualification: {
      kind: check.qualification.kind,
      predicates: check.qualification.predicates.map((predicate) => ({
        ...predicate,
        expectation: projectCapabilityExpectation(predicate.expectation),
      })),
    },
  })),
});
