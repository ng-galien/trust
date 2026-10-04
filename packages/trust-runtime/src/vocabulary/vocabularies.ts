import type { PublishedVocabulary } from "@trust/extension-sdk";
import { compareVersions } from "@trust/operation/version";
import {
  type AgentDeclaration,
  BASE_VOCABULARY,
  baseVocabulary,
  type CompiledProcedure,
  type CompiledVocabulary,
  type ControlledLanguageFinding,
  compileVocabulary,
  controlAgentDeclarations,
  lookupVocabularyWord,
  type VocabularyCompilationInput,
  type VocabularyLookup,
} from "@trust/procedure";
import type { Clock } from "../time.js";
import type { VocabularyStore } from "./store.js";

export interface VocabulariesDependencies {
  readonly clock: Clock;
  readonly vocabularyStore: VocabularyStore;
}

/** Compile, publish, list and read controlled language vocabularies. RPC and MCP call these functions. */
export class Vocabularies {
  readonly #clock: Clock;
  readonly #store: VocabularyStore;

  constructor({ clock, vocabularyStore }: VocabulariesDependencies) {
    this.#clock = clock;
    this.#store = vocabularyStore;
  }

  /** Publish the base vocabulary of this runtime when its version is absent from the catalog. */
  async initialize(): Promise<void> {
    const base = baseVocabulary();
    if (await this.#store.find(base.vocabulary, base.version)) return;
    await this.#store.publish(base, `${BASE_VOCABULARY}.feature`, "trust-runtime", this.#clock.now().toISOString());
  }

  compile(input: VocabularyCompilationInput): CompiledVocabulary {
    return compileVocabulary(input);
  }

  async publish(input: VocabularyCompilationInput, publisher: string): Promise<PublishedVocabulary> {
    const vocabulary = this.compile(input);
    return this.#store.publish(
      vocabulary,
      input.sourceName ?? "<vocabulary>",
      publisher,
      this.#clock.now().toISOString(),
    );
  }

  async find(vocabulary: string, version: string): Promise<PublishedVocabulary | undefined> {
    return this.#store.find(vocabulary, version);
  }

  async list(): Promise<readonly PublishedVocabulary[]> {
    return this.#store.list();
  }

  /**
   * Control prose that an agent declares on a Plan of this Procedure. A Procedure without the controlled
   * language tag has no finding. A tagged one uses the same engine as the compiler and its pinned vocabularies.
   * A pinned vocabulary that the catalog lacks, or holds with another digest, makes the control impossible:
   * the call throws {@link ControlledLanguageUnavailableError} and no text passes without control.
   */
  async controlDeclarations(
    procedure: CompiledProcedure,
    declarations: readonly AgentDeclaration[],
  ): Promise<readonly ControlledLanguageFinding[]> {
    const language = procedure.controlledLanguage;
    if (!language) return [];
    const pinned: CompiledVocabulary[] = [];
    for (const pin of language.vocabularies ?? []) {
      const vocabulary = (await this.#store.find(pin.vocabulary, pin.version))?.vocabulary;
      if (vocabulary?.definitionDigest !== pin.digest)
        throw new ControlledLanguageUnavailableError(
          vocabulary === undefined
            ? `The pinned vocabulary ${pin.vocabulary}@${pin.version} is absent from the catalog.`
            : `The pinned vocabulary ${pin.vocabulary}@${pin.version} has another digest in the catalog.`,
        );
      pinned.push(vocabulary);
    }
    return controlAgentDeclarations(language, pinned, declarations);
  }

  /**
   * Look one word up in the base vocabulary and, when named, in the highest published version of a domain
   * vocabulary. The base vocabulary is its highest published version.
   */
  async lookup(word: string, vocabulary?: string): Promise<VocabularyLookup> {
    const catalog = await this.catalog();
    const highest = (identity: string) =>
      catalog
        .filter((candidate) => candidate.vocabulary === identity)
        .sort((left, right) => compareVersions(right.version, left.version))[0];
    const base = highest(BASE_VOCABULARY) ?? baseVocabulary();
    if (vocabulary === undefined || vocabulary === BASE_VOCABULARY) return lookupVocabularyWord(word, [base]);
    const named = highest(vocabulary);
    if (!named) throw new VocabularyNotFoundError(`Vocabulary ${vocabulary} is not published.`);
    return lookupVocabularyWord(word, [base, named]);
  }

  /** Every published vocabulary version, the catalog that a Procedure compilation resolves against. */
  async catalog(): Promise<readonly CompiledVocabulary[]> {
    return (await this.#store.list()).map((published) => published.vocabulary);
  }
}

/** The vocabulary versions that a compiled Procedure pinned, so recompilation keeps its pins. */
export function pinnedVocabularies(
  procedure: CompiledProcedure,
  catalog: readonly CompiledVocabulary[],
): readonly CompiledVocabulary[] {
  const pins = procedure.controlledLanguage?.vocabularies ?? [];
  return catalog.filter((vocabulary) =>
    pins.some(
      (pin) =>
        pin.vocabulary === vocabulary.vocabulary &&
        pin.version === vocabulary.version &&
        pin.digest === vocabulary.definitionDigest,
    ),
  );
}

/** The controlled language of a Plan cannot run, so the controlled call is refused and changes nothing. */
export class ControlledLanguageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlledLanguageUnavailableError";
  }
}

/** A lookup names a vocabulary that has no published version. */
export class VocabularyNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VocabularyNotFoundError";
  }
}
