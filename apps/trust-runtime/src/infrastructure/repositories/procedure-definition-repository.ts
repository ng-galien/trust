import type {
  CompiledAutonomousProcedureDefinition,
  CompiledRequiredCapability,
} from "@trust/procedure";
import type { DatabaseDriver, DatabaseRow } from "../../ports/database.js";

interface ProcedureRow extends DatabaseRow {
  procedure_name: string;
  procedure_version: string;
  definition_digest: string;
  source_name: string;
  source: string;
  compiled_definition_json: string;
  published_by: string;
  published_at: string;
}

interface RequirementRow extends DatabaseRow {
  definition_digest: string;
  capability: string;
  contract_core_digest: string;
  action_contract_digest: string;
  requirement_json: string;
}

export interface PublishedProcedureDefinition {
  readonly definition: CompiledAutonomousProcedureDefinition;
  readonly sourceName: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export interface ProcedureDefinitionRepositoryDependencies {
  readonly databaseDriver: DatabaseDriver;
}

export class ProcedureDefinitionRepository {
  readonly #database: DatabaseDriver;

  constructor({ databaseDriver }: ProcedureDefinitionRepositoryDependencies) {
    this.#database = databaseDriver;
  }

  publish(
    definition: CompiledAutonomousProcedureDefinition,
    sourceName: string,
    publishedBy: string,
    publishedAt: string,
  ): PublishedProcedureDefinition {
    return this.#database.transaction(() => {
      const existing = this.find(definition.procedure, definition.version);
      if (existing) {
        if (
          existing.definition.definitionDigest !== definition.definitionDigest
          || existing.definition.source !== definition.source
        ) {
          throw new ProcedureDefinitionConflictError(
            `procedure ${definition.procedure}@${definition.version} is already published with another immutable definition`,
          );
        }
        return existing;
      }

      this.#database.prepare(
        `INSERT INTO published_procedures (
           procedure_name, procedure_version, definition_digest, source_name, source,
           compiled_definition_json, published_by, published_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        definition.procedure,
        definition.version,
        definition.definitionDigest,
        sourceName,
        definition.source,
        JSON.stringify(definition),
        publishedBy,
        publishedAt,
      );

      const insertRequirement = this.#database.prepare(
        `INSERT INTO published_definition_requirements (
           definition_digest, capability, contract_core_digest,
           action_contract_digest,
           requirement_json, published_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const requirement of definition.requiredCapabilities) {
        insertRequirement.run(
          definition.definitionDigest,
          requirement.capability,
          requirement.contractCoreDigest,
          requirement.actionContractDigest,
          JSON.stringify(requirement),
          publishedAt,
        );
        const exact = this.findCapabilityRequirement(
          requirement.capability,
          requirement.actionContractDigest,
        );
        if (!exact || canonicalJson(exact) !== canonicalJson(requirement)) {
          throw new ProcedureDefinitionConflictError(
            `capability ${requirement.capability} at Action Contract ${requirement.actionContractDigest} is inconsistent`,
          );
        }
      }
      const published = this.find(definition.procedure, definition.version);
      if (!published) throw new Error("published procedure cannot be read back");
      return published;
    });
  }

  find(procedure: string, version: string): PublishedProcedureDefinition | undefined {
    const row = this.#database.prepare(
      `SELECT procedure_name, procedure_version, definition_digest, source_name, source,
              compiled_definition_json, published_by, published_at
         FROM published_procedures
        WHERE procedure_name = ? AND procedure_version = ?`,
    ).get<ProcedureRow>(procedure, version);
    if (!row) return undefined;
    const definition = JSON.parse(row.compiled_definition_json) as CompiledAutonomousProcedureDefinition;
    if (
      definition.procedure !== row.procedure_name
      || definition.version !== row.procedure_version
      || definition.definitionDigest !== row.definition_digest
      || definition.source !== row.source
    ) {
      throw new Error("persisted procedure definition is inconsistent");
    }
    return {
      definition,
      sourceName: row.source_name,
      publishedBy: row.published_by,
      publishedAt: row.published_at,
    };
  }

  findCapabilityRequirement(
    capability: string,
    actionContractDigest: string,
  ): CompiledRequiredCapability | undefined {
    const rows = this.#database.prepare(
      `SELECT definition_digest, capability, contract_core_digest,
              action_contract_digest, requirement_json
         FROM published_definition_requirements
        WHERE capability = ? AND action_contract_digest = ?
        ORDER BY definition_digest`,
    ).all<RequirementRow>(capability, actionContractDigest);
    let result: CompiledRequiredCapability | undefined;
    for (const row of rows) {
      const requirement = JSON.parse(row.requirement_json) as CompiledRequiredCapability;
      if (
        requirement.capability !== row.capability
        || requirement.contractCoreDigest !== row.contract_core_digest
        || requirement.actionContractDigest !== row.action_contract_digest
      ) {
        throw new Error("persisted capability requirement is inconsistent");
      }
      if (result && canonicalJson(result) !== canonicalJson(requirement)) {
        throw new ProcedureDefinitionConflictError(
          "published capability requirement has conflicting contracts",
        );
      }
      result = requirement;
    }
    return result;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class ProcedureDefinitionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcedureDefinitionConflictError";
  }
}
