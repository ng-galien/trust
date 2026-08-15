import { createHash } from "node:crypto";
import { isRfc3339Instant } from "./rfc3339.js";

import type {
  ActionContractValueType,
  CompiledAutonomousExpectation,
  CompiledAutonomousQualificationPredicate,
  CompiledCapabilityCheckRef,
} from "@trust/procedure";
import type {
  Fact,
  MaterializationOutputContract,
  MaterializedCheck,
  MaterializedRoleIncarnation,
  RuntimeJsonObject,
  ValidatedFactBatch,
  ValidatedOutputProjection,
  ValidatedCheckObservationProjection,
} from "./runtime-model.js";

export type CheckQualificationErrorCode =
  | "invalid-fact-shape"
  | "invalid-observation-type"
  | "unknown-observation"
  | "missing-observation"
  | "unknown-output"
  | "missing-output"
  | "invalid-output-type"
  | "invalid-output-parents"
  | "missing-upstream-output";

export class CheckQualificationError extends Error {
  constructor(
    readonly code: CheckQualificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CheckQualificationError";
  }
}

export interface CheckQualificationContext {
  readonly validatedOutputs?: readonly ValidatedOutputProjection[];
  readonly validatedCheckObservations?: readonly ValidatedCheckObservationProjection[];
}

export interface CheckQualificationResult {
  readonly verdict: "VALIDATED" | "NOT_VALIDATED";
  readonly reasonCode: "check-qualified" | "qualification-predicate-failed";
  readonly reason: string;
}

export function qualifyCheck(
  check: MaterializedCheck,
  facts: readonly Fact[],
  context: CheckQualificationContext = {},
): CheckQualificationResult {
  if (facts.length === 0) {
    throw new CheckQualificationError(
      "invalid-fact-shape",
      "a Check cannot be qualified without an accepted Fact",
    );
  }
  return qualifyValidatedFactBatch(check, validateFactsForCheck(check, facts), context);
}

export function qualifyValidatedFactBatch(
  check: MaterializedCheck,
  batch: ValidatedFactBatch,
  context: CheckQualificationContext = {},
): CheckQualificationResult {
  for (const predicate of check.template.qualification.predicates) {
    if (!(predicate.observation in batch.observations)) {
      throw new CheckQualificationError(
        "missing-observation",
        `Fact does not record required observation ${predicate.observation}`,
      );
    }
    const actual = batch.observations[predicate.observation];
    const expected = expectationValue(predicate.expectation, check, context);
    if (!relationHolds(predicate, actual, expected)) {
      return {
        verdict: "NOT_VALIDATED",
        reasonCode: "qualification-predicate-failed",
        reason: predicate.failureFeedback,
      };
    }
  }
  return {
    verdict: "VALIDATED",
    reasonCode: "check-qualified",
    reason: check.template.successFeedback,
  };
}

/**
 * Atomically validates correlation, observations, materialized incarnations and
 * complete Action Contract output projections. No caller may persist a subset
 * of this interpretation when this function rejects the batch.
 */
export function validateFactsForCheck(
  check: MaterializedCheck,
  facts: readonly Fact[],
  options: { readonly requireCompleteMaterialization?: boolean } = {},
): ValidatedFactBatch {
  const collected = new Map<string, unknown>();
  const candidates: CandidateIncarnation[] = [];
  for (const fact of facts) {
    assertFactCorrelation(check, fact);
    const kind = fact.payload.kind;
    const observedAt = fact.payload.observedAt;
    const values = fact.payload.values;
    if (
      typeof kind !== "string"
      || kind !== check.template.capabilityContract.capability
      || typeof observedAt !== "string"
      || !isInstant(observedAt)
      || !isPlainObject(values)
    ) {
      throw new CheckQualificationError(
        "invalid-fact-shape",
        "Fact must contain the admitted action, an RFC3339 observedAt and one values object",
      );
    }
    collectObservations(check, values, collected);

    const rawOutputs = fact.payload.outputs;
    if (rawOutputs !== undefined && !Array.isArray(rawOutputs)) {
      throw new CheckQualificationError(
        "invalid-fact-shape",
        "Fact outputs must be a list of explicit semantic incarnations",
      );
    }
    for (const raw of rawOutputs ?? []) {
      candidates.push(validateOutputCandidate(check, raw));
    }
  }

  assertRequiredObservations(check, collected);
  assertObservationCorrelations(check, collected);
  const requireCompleteMaterialization = options.requireCompleteMaterialization ?? true;
  assertOutputObservationProjection(
    check,
    candidates,
    collected,
    requireCompleteMaterialization,
  );
  assertMaterializationBatch(
    check,
    candidates,
    requireCompleteMaterialization,
  );

  const observations = Object.freeze(Object.fromEntries(
    [...collected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, cloneJson(value)]),
  ));
  const roleIncarnations = Object.freeze(candidates
    .map((candidate) => Object.freeze({
      output: candidate.contract.output,
      role: candidate.contract.role,
      value: cloneJson(candidate.value),
      parents: cloneObject(candidate.parents),
      provider: cloneJson(check.template.ref),
      providerCheckUri: check.uri,
    } satisfies MaterializedRoleIncarnation))
    .sort(compareCanonical));
  const validatedOutputs = projectValidatedOutputs(check, observations);
  const validatedCheckObservations = Object.freeze([Object.freeze({
    checkName: check.template.name,
    provider: cloneJson(check.template.ref),
    providerCheckUri: check.uri,
    observations,
  })]);

  return Object.freeze({ observations, roleIncarnations, validatedOutputs, validatedCheckObservations });
}

/** Projects every selected output, including outputs which do not incarnate a role. */
export function projectValidatedOutputs(
  check: MaterializedCheck,
  observations: RuntimeJsonObject,
): readonly ValidatedOutputProjection[] {
  return Object.freeze(check.template.materializes.map((materialization) => {
    const output = materialization.output;
    const projection = check.factContract.outputs[output];
    if (!projection) {
      throw new CheckQualificationError(
        "unknown-output",
        `Check selects output ${output} outside its Action Contract`,
      );
    }
    const values: Record<string, unknown> = {};
    for (const field of [projection.observation]) {
      if (!(field in observations)) {
        throw new CheckQualificationError(
          "missing-observation",
          `output ${output} is missing required observation ${field}`,
        );
      }
      values[field] = cloneJson(observations[field]);
    }
    return Object.freeze({
      output,
      provider: cloneJson(check.template.ref),
      providerCheckUri: check.uri,
      values: Object.freeze(values),
    });
  }).sort(compareCanonical));
}

interface CandidateIncarnation {
  readonly contract: MaterializationOutputContract;
  readonly value: unknown;
  readonly parents: RuntimeJsonObject;
  readonly coordinates: readonly ParentCoordinate[];
}

interface ParentCoordinate {
  readonly kind: "input" | "output";
  readonly port: string;
  readonly value: unknown;
}

function assertFactCorrelation(check: MaterializedCheck, fact: Fact): void {
  if (
    fact.executionHandle.length === 0
    || fact.capability !== check.template.capabilityContract.capability
    || fact.actionContractDigest !== check.template.capabilityContract.digest
  ) {
    throw new CheckQualificationError(
      "invalid-fact-shape",
      "Fact correlation does not match the admitted Check",
    );
  }
}

function collectObservations(
  check: MaterializedCheck,
  values: RuntimeJsonObject,
  collected: Map<string, unknown>,
): void {
  for (const [name, value] of Object.entries(values)) {
    const field = check.factContract.observations[name];
    if (!field) {
      throw new CheckQualificationError(
        "unknown-observation",
        `Fact records observation ${name} outside its Action Contract`,
      );
    }
    assertObservationValue(name, value, field);
    if (collected.has(name) && canonicalJson(collected.get(name)) !== canonicalJson(value)) {
      throw new CheckQualificationError(
        "invalid-fact-shape",
        `Facts record conflicting values for observation ${name}`,
      );
    }
    collected.set(name, cloneJson(value));
  }
}

function assertObservationCorrelations(
  check: MaterializedCheck,
  observations: ReadonlyMap<string, unknown>,
): void {
  for (const [name, field] of Object.entries(check.factContract.observations)) {
    if (field.parents.length === 0 || !observations.has(name)) continue;
    const raw = observations.get(name);
    if (!Array.isArray(raw)) invalidObservation(name);
    for (const parent of field.parents) {
      const parentRaw = parent.kind === "input"
        ? check.actionInput[parent.port]
        : observations.get(parent.port);
      const expected = uniqueSemanticValues(correlatedParentValues(parentRaw));
      if (expected.length === 0) invalidObservation(name);
      if (field.parents.length === 1 && raw.length !== expected.length) {
        throw new CheckQualificationError(
          "invalid-observation-type",
          `observation ${name} must contain exactly one value for each ${parent.kind} ${parent.port}`,
        );
      }
      for (const parentValue of expected) {
        const matches = raw.filter((candidate) => isPlainObject(candidate) && Array.isArray(candidate.parents)
          && candidate.parents.some((coordinate) => isPlainObject(coordinate)
            && coordinate.kind === parent.kind
            && coordinate.port === parent.port
            && canonicalJson(coordinate.value) === canonicalJson(parentValue)));
        if (matches.length !== 1) {
          throw new CheckQualificationError(
            "invalid-observation-type",
            `observation ${name} must contain exactly one value for each ${parent.kind} ${parent.port}`,
          );
        }
      }
    }
  }
}

function uniqueSemanticValues(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = canonicalJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function correlatedParentValues(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return value === undefined ? [] : [value];
  if (value.every((candidate) => isPlainObject(candidate) && "value" in candidate && "parents" in candidate)) {
    return value.map((candidate) => candidate.value);
  }
  return value;
}

function assertRequiredObservations(
  check: MaterializedCheck,
  observations: ReadonlyMap<string, unknown>,
): void {
  const required = new Set(
    check.template.qualification.predicates.map((predicate) => predicate.observation),
  );
  for (const materialization of check.template.materializes) {
    const projection = check.factContract.outputs[materialization.output];
    if (!projection) {
      throw new CheckQualificationError(
        "unknown-output",
        `Check selects output ${materialization.output} outside its Action Contract`,
      );
    }
    required.add(projection.observation);
  }
  for (const observation of check.template.requiredCheckObservations) {
    required.add(observation);
  }
  for (const observation of required) {
    if (!observations.has(observation)) {
      throw new CheckQualificationError(
        "missing-observation",
        `Fact batch does not record required observation ${observation}`,
      );
    }
  }
}

function validateOutputCandidate(
  check: MaterializedCheck,
  raw: unknown,
): CandidateIncarnation {
  if (!isPlainObject(raw)) {
    throw new CheckQualificationError(
      "invalid-fact-shape",
      "each Fact output must be one object",
    );
  }
  const keys = Object.keys(raw).sort();
  if (canonicalJson(keys) !== canonicalJson(["output", "parents", "value"])) {
    throw new CheckQualificationError(
      "invalid-fact-shape",
      "each Fact output must contain exactly output, value and parents",
    );
  }
  const output = raw.output;
  const contract = typeof output === "string"
    ? check.materializationContract.find((candidate) => candidate.output === output)
    : undefined;
  if (!contract) {
    throw new CheckQualificationError(
      "unknown-output",
      `Fact cannot materialize output ${String(output)} for this Check`,
    );
  }
  assertScalarOutputValue(contract, raw.value);
  if (!Array.isArray(raw.parents)) invalidOutputParents(contract.output);
  const expectedParents = new Map(
    contract.parents.map((parent) => [`${parent.kind}\0${parent.port}`, parent]),
  );
  const seen = new Set<string>();
  const roleParents: Record<string, unknown> = {};
  const coordinates = raw.parents.map((rawParent) => {
    if (!isPlainObject(rawParent)) invalidOutputParents(contract.output);
    const keys = Object.keys(rawParent).sort();
    if (canonicalJson(keys) !== canonicalJson(["kind", "port", "value"])) {
      invalidOutputParents(contract.output);
    }
    const kind = rawParent.kind;
    const port = rawParent.port;
    if ((kind !== "input" && kind !== "output") || typeof port !== "string") {
      invalidOutputParents(contract.output);
    }
    const normalizedKind: ParentCoordinate["kind"] = kind;
    const key = `${kind}\0${port}`;
    const parent = expectedParents.get(key);
    if (!parent || seen.has(key)) invalidOutputParents(contract.output);
    seen.add(key);
    assertScalarOutputValue(
      { ...contract, output: parent.role, valueType: parent.valueType },
      rawParent.value,
      "invalid-output-parents",
    );
    roleParents[parent.role] = cloneJson(rawParent.value);
    return Object.freeze({
      kind: normalizedKind,
      port,
      value: cloneJson(rawParent.value),
    });
  });
  if (seen.size !== expectedParents.size) invalidOutputParents(contract.output);
  return Object.freeze({
    contract,
    value: cloneJson(raw.value),
    parents: Object.freeze(roleParents),
    coordinates: Object.freeze(coordinates),
  });
}

function assertOutputObservationProjection(
  check: MaterializedCheck,
  candidates: readonly CandidateIncarnation[],
  observations: ReadonlyMap<string, unknown>,
  requireComplete: boolean,
): void {
  for (const contract of check.materializationContract) {
    const observed = observations.get(contract.observation);
    if (observed === undefined) continue;
    const observationField = check.factContract.observations[contract.observation];
    if (!observationField) invalidObservation(contract.observation);
    const expected = observationField.parents.length > 0
      ? Array.isArray(observed)
        ? observed.map((candidate) => isPlainObject(candidate) ? candidate.value : invalidObservation(contract.observation))
        : invalidObservation(contract.observation)
      : contract.sourceCardinality === "many"
        ? Array.isArray(observed) ? observed : invalidObservation(contract.observation)
        : Array.isArray(observed) ? invalidObservation(contract.observation) : [observed];
    const actual = candidates
      .filter((candidate) => candidate.contract.output === contract.output)
      .map((candidate) => candidate.value);
    const remaining = [...expected];
    for (const value of actual) {
      const index = remaining.findIndex(
        (candidate) => canonicalJson(candidate) === canonicalJson(value),
      );
      if (index < 0) {
        throw new CheckQualificationError(
          "invalid-output-type",
          `output ${contract.output} must project observation ${contract.observation} exactly`,
        );
      }
      remaining.splice(index, 1);
    }
    if (requireComplete && remaining.length > 0) {
      throw new CheckQualificationError(
        "missing-output",
        `output ${contract.output} must project every value of observation ${contract.observation}`,
      );
    }
  }
}

function assertMaterializationBatch(
  check: MaterializedCheck,
  candidates: readonly CandidateIncarnation[],
  requireCompleteMaterialization: boolean,
): void {
  const available = new Map<string, unknown[]>();
  for (const binding of check.template.inputBindings) {
    const value = check.actionInput[binding.input];
    available.set(binding.role, Array.isArray(value) ? [...value] : [value]);
  }
  for (const candidate of candidates) {
    const values = available.get(candidate.contract.role) ?? [];
    values.push(candidate.value);
    available.set(candidate.contract.role, values);
  }

  for (const candidate of candidates) {
    for (const coordinate of candidate.coordinates) {
      const values = coordinate.kind === "input"
        ? valueList(check.actionInput[coordinate.port])
        : candidates
            .filter((provider) => provider.contract.output === coordinate.port)
            .map((provider) => provider.value);
      if (!values.some((value) => canonicalJson(value) === canonicalJson(coordinate.value))) {
        throw new CheckQualificationError(
          "invalid-output-parents",
          `output ${candidate.contract.output} is not correlated to admitted ${coordinate.kind} parent ${coordinate.port}`,
        );
      }
    }
  }

  // A semantically negative observation is still valid evidence. In that case the
  // Skill may legitimately have no downstream role to materialize (for example a
  // ticket declaring zero affected projects). Completeness becomes mandatory only
  // when the observations would qualify the Check and therefore advance the Plan.
  if (!requireCompleteMaterialization) return;

  for (const contract of check.materializationContract) {
    const matching = candidates.filter(
      (candidate) => candidate.contract.output === contract.output,
    );
    if (matching.length === 0) {
      throw new CheckQualificationError(
        "missing-output",
        `Fact batch does not materialize required output ${contract.output}`,
      );
    }
    if (contract.cardinality === "one") {
      const byParents = new Map<string, number>();
      for (const candidate of matching) {
        const key = canonicalJson(candidate.parents);
        byParents.set(key, (byParents.get(key) ?? 0) + 1);
      }
      if (
        (contract.parents.every((parent) => !parent.each) && matching.length !== 1)
        || [...byParents.values()].some((count) => count !== 1)
      ) {
        throw new CheckQualificationError(
          "invalid-output-type",
          `output ${contract.output} must materialize exactly one value per parent coordinates`,
        );
      }
    }
    for (const parent of contract.parents.filter((candidate) => candidate.each)) {
      for (const parentValue of uniqueValues(available.get(parent.role) ?? [])) {
        const correlated = matching.filter(
          (candidate) =>
            canonicalJson(candidate.parents[parent.role]) === canonicalJson(parentValue),
        );
        if (correlated.length !== 1) {
          throw new CheckQualificationError(
            "missing-output",
            `output ${contract.output} must materialize one value for each ${parent.role}`,
          );
        }
      }
    }
  }
}

function valueList(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function assertObservationValue(
  name: string,
  value: unknown,
  field: MaterializedCheck["factContract"]["observations"][string],
): void {
  if (field.parents.length > 0) {
    if (!Array.isArray(value) || value.length === 0) invalidObservation(name);
    const expectedParents = new Set(field.parents.map((parent) => `${parent.kind}\0${parent.port}`));
    for (const candidate of value) {
      if (!isPlainObject(candidate) || Object.keys(candidate).sort().join(",") !== "parents,value") {
        invalidObservation(name);
      }
      if (!valueMatchesType(candidate.value, field.type) || !Array.isArray(candidate.parents)) {
        invalidObservation(name);
      }
      if (
        field.type === "string"
        && field.domain.kind === "enum"
        && !field.domain.values.includes(String(candidate.value))
      ) {
        invalidObservation(name);
      }
      const seen = new Set<string>();
      for (const coordinate of candidate.parents) {
        if (
          !isPlainObject(coordinate)
          || Object.keys(coordinate).sort().join(",") !== "kind,port,value"
          || (coordinate.kind !== "input" && coordinate.kind !== "observation")
          || typeof coordinate.port !== "string"
        ) {
          invalidObservation(name);
        }
        const key = `${coordinate.kind}\0${coordinate.port}`;
        if (!expectedParents.has(key) || seen.has(key)) invalidObservation(name);
        seen.add(key);
      }
      if (seen.size !== expectedParents.size) invalidObservation(name);
    }
    return;
  }
  const values = field.cardinality === "many"
    ? Array.isArray(value)
      ? value
      : invalidObservation(name)
    : Array.isArray(value)
      ? invalidObservation(name)
      : [value];
  for (const candidate of values) {
    const valid = valueMatchesType(candidate, field.type);
    if (!valid) invalidObservation(name);
    if (
      field.type === "string"
      && field.domain.kind === "enum"
      && !field.domain.values.includes(String(candidate))
    ) {
      invalidObservation(name);
    }
  }
}

function assertScalarOutputValue(
  contract: Pick<MaterializationOutputContract, "output" | "valueType">,
  value: unknown,
  code: "invalid-output-type" | "invalid-output-parents" = "invalid-output-type",
): void {
  if (Array.isArray(value) || !valueMatchesType(value, contract.valueType)) {
    throw new CheckQualificationError(
      code,
      `output ${contract.output} does not match its semantic value type`,
    );
  }
}

function valueMatchesType(value: unknown, type: ActionContractValueType): boolean {
  return (
    (type === "number" && typeof value === "number" && Number.isFinite(value))
    || ((type === "string" || type === "reference") && typeof value === "string")
    || (type === "instant" && typeof value === "string" && isInstant(value))
  );
}

function invalidObservation(name: string): never {
  throw new CheckQualificationError(
    "invalid-observation-type",
    `observation ${name} does not match its Action Contract type and cardinality`,
  );
}

function invalidOutputParents(output: string): never {
  throw new CheckQualificationError(
    "invalid-output-parents",
    `output ${output} must contain its exact immediate parent bindings`,
  );
}

function expectationValue(
  expectation: CompiledAutonomousExpectation,
  check: MaterializedCheck,
  context: CheckQualificationContext,
): unknown {
  switch (expectation.kind) {
    case "literal":
      return expectation.value;
    case "valid-value":
      return VALID_RFC3339;
    case "context":
      return actionInputForRole(check, expectation.role);
    case "check-observation":
      return projectedCheckObservation(
        context.validatedCheckObservations ?? [],
        check,
        expectation.check,
        expectation.provider,
        expectation.observation,
      );
  }
}

function projectedCheckObservation(
  projections: readonly ValidatedCheckObservationProjection[],
  check: MaterializedCheck,
  checkName: string,
  provider: CompiledCapabilityCheckRef,
  observation: string,
): unknown {
  const dependencies = check.checkDependencies.filter((dependency) =>
    dependency.checkName === checkName
  );
  if (
    dependencies.length !== 1
    || !dependencies[0]
    || dependencies[0].observationDigest === undefined
  ) {
    missingUpstream(`${checkName}.${observation}`);
  }
  const dependency = dependencies[0];
  const candidates = projections.filter(
    (candidate) =>
      candidate.checkName === checkName
      && candidate.providerCheckUri === dependency.providerCheckUri
      && sameProvider(candidate.provider, provider),
  );
  if (
    candidates.length !== 1
    || canonicalDigest(candidates[0]) !== dependency.observationDigest
    || !(observation in (candidates[0]?.observations ?? {}))
  ) {
    missingUpstream(`${checkName}.${observation}`);
  }
  return cloneJson(candidates[0]?.observations[observation]);
}

function actionInputForRole(check: MaterializedCheck, role: string): unknown {
  const binding = check.template.inputBindings.find((candidate) => candidate.role === role);
  if (!binding) {
    throw new CheckQualificationError(
      "missing-upstream-output",
      `compiled context role ${role} is not bound to a capability input`,
    );
  }
  return check.actionInput[binding.input];
}

function missingUpstream(output: string): never {
  throw new CheckQualificationError(
    "missing-upstream-output",
    `validated upstream output ${output} is unavailable`,
  );
}

const VALID_RFC3339 = Symbol("valid-rfc3339");

function relationHolds(
  predicate: CompiledAutonomousQualificationPredicate,
  actual: unknown,
  expected: unknown,
): boolean {
  switch (predicate.relation) {
    case "equals":
      return expected === VALID_RFC3339
        ? typeof actual === "string" && isInstant(actual)
        : canonicalJson(semanticComparisonValue(actual)) === canonicalJson(semanticComparisonValue(expected));
    case "at least":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "has at least":
      return Array.isArray(actual) && typeof expected === "number" && actual.length >= expected;
    case "is in":
      return Array.isArray(expected) && expected.some(
        (candidate) => canonicalJson(candidate) === canonicalJson(actual),
      );
    case "before":
      return typeof actual === "string" && typeof expected === "string"
        && isInstant(actual) && isInstant(expected) && Date.parse(actual) < Date.parse(expected);
    case "after":
      return typeof actual === "string" && typeof expected === "string"
        && isInstant(actual) && isInstant(expected) && Date.parse(actual) > Date.parse(expected);
  }
}

function semanticComparisonValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((candidate) => {
    if (
      !isPlainObject(candidate)
      || !Array.isArray(candidate.parents)
      || !("value" in candidate)
    ) {
      return cloneJson(candidate);
    }
    return {
      value: cloneJson(candidate.value),
      // Port names are local to the compared contracts. Their compatible
      // topology is compiled before runtime; equality preserves the semantic
      // parent values which coordinate each member.
      parents: candidate.parents
        .map((coordinate: unknown) =>
          isPlainObject(coordinate) ? cloneJson(coordinate.value) : cloneJson(coordinate)
        )
        .sort(compareCanonical),
    };
  }).sort(compareCanonical);
}

function uniqueValues(values: readonly unknown[]): readonly unknown[] {
  return [...new Map(values.map((value) => [canonicalJson(value), value])).values()];
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function sameProvider(
  left: CompiledCapabilityCheckRef,
  right: CompiledCapabilityCheckRef,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function cloneObject(value: RuntimeJsonObject): RuntimeJsonObject {
  return Object.freeze(cloneJson(value));
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (error) {
    throw new CheckQualificationError(
      "invalid-fact-shape",
      `Fact values must be JSON-compatible: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function isInstant(value: string): boolean {
  return isRfc3339Instant(value);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
