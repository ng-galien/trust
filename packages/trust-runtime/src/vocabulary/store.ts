import type { PublishedVocabulary } from "@trust/extension-sdk";
import type { CompiledVocabulary } from "@trust/procedure";
import type { Selectable } from "kysely";

import type { Database, PublishedVocabularyTable } from "../database/database.js";

type VocabularyRow = Selectable<PublishedVocabularyTable>;

/** Immutable published vocabulary versions; rows are never updated or deleted. */
export class VocabularyStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  async publish(
    vocabulary: CompiledVocabulary,
    sourceName: string,
    publishedBy: string,
    publishedAt: string,
  ): Promise<PublishedVocabulary> {
    return this.dependencies.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("published_vocabularies")
        .values({
          vocabulary_name: vocabulary.vocabulary,
          vocabulary_version: vocabulary.version,
          definition_digest: vocabulary.definitionDigest,
          source_name: sourceName,
          source: vocabulary.source,
          compiled_vocabulary_json: JSON.stringify(vocabulary),
          published_by: publishedBy,
          published_at: publishedAt,
        })
        .onConflict((conflict) => conflict.columns(["vocabulary_name", "vocabulary_version"]).doNothing())
        .execute();
      const published = await transaction
        .selectFrom("published_vocabularies")
        .selectAll()
        .where("vocabulary_name", "=", vocabulary.vocabulary)
        .where("vocabulary_version", "=", vocabulary.version)
        .executeTakeFirst();
      if (!published) throw new Error("Published vocabulary cannot be read back");
      const result = toPublishedVocabulary(published);
      if (
        result.vocabulary.definitionDigest !== vocabulary.definitionDigest ||
        result.vocabulary.source !== vocabulary.source
      ) {
        throw new VocabularyConflictError(
          `Vocabulary ${vocabulary.vocabulary}@${vocabulary.version} is already published with another immutable definition`,
        );
      }
      return result;
    });
  }

  async find(vocabulary: string, version: string): Promise<PublishedVocabulary | undefined> {
    const row = await this.dependencies.database
      .selectFrom("published_vocabularies")
      .selectAll()
      .where("vocabulary_name", "=", vocabulary)
      .where("vocabulary_version", "=", version)
      .executeTakeFirst();
    return row ? toPublishedVocabulary(row) : undefined;
  }

  async list(): Promise<PublishedVocabulary[]> {
    const rows = await this.dependencies.database
      .selectFrom("published_vocabularies")
      .selectAll()
      .orderBy("vocabulary_name")
      .orderBy("vocabulary_version")
      .execute();
    return rows.map(toPublishedVocabulary);
  }
}

function toPublishedVocabulary(row: VocabularyRow): PublishedVocabulary {
  const compiled = row.compiled_vocabulary_json as CompiledVocabulary;
  if (
    compiled.vocabulary !== row.vocabulary_name ||
    compiled.version !== row.vocabulary_version ||
    compiled.definitionDigest !== row.definition_digest ||
    compiled.source !== row.source
  ) {
    throw new Error("Persisted vocabulary is inconsistent");
  }
  return {
    vocabulary: compiled,
    sourceName: row.source_name,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
  };
}

export class VocabularyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VocabularyConflictError";
  }
}
