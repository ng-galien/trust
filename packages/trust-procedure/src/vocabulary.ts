import type { GherkinDocument, Step, TableRow, Tag } from "@cucumber/messages";
import {
  GherkinSyntaxError,
  hasGherkinTag,
  normalizeGherkinSource,
  parseGherkin,
  parseStepGrammar,
  type StepGrammarMatch,
  tokenizeSentence,
} from "@trust/gherkin";
import { isExactVersion } from "@trust/operation/version";
import { BASE_VOCABULARY, baseVocabularySource } from "./base-vocabulary.js";
import {
  type ControlledLanguageFinding,
  type ControlledProseField,
  controlledLexicon,
  controlProse,
  lexicalRules,
  structureRules,
} from "./controlled-language.js";
import { readDescription } from "./description.js";
import { digest } from "./digest.js";
import { type VocabularyTermKind, vocabularyLanguage, vocabularyStepGrammar } from "./language.js";
import type { CompiledControlledLanguage, ProcedureLanguageDiagnostic } from "./procedure.js";

const VOCABULARY_TAG = vocabularyLanguage.tags.vocabulary;
const VERSION_TAG = vocabularyLanguage.tags.version;
const TRUST_DSL_TAG = vocabularyLanguage.tags.dsl;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** One or more words of letters, digits, hyphens or apostrophes separated by single spaces. */
const TERM = /^[\p{L}\p{N}][\p{L}\p{N}'’-]*(?: [\p{L}\p{N}][\p{L}\p{N}'’-]*)*$/u;

export interface VocabularyTerm {
  readonly term: string;
  readonly kind: VocabularyTermKind;
  readonly definition: string;
}

export interface VocabularyRejectedWord {
  readonly word: string;
  /** The declared term to use in place of the word. */
  readonly use: string;
}

export interface CompiledVocabulary {
  readonly vocabulary: string;
  readonly version: string;
  readonly title: string;
  /** Free-text description written under `Feature:`; absent when the source has none. Not part of the digest. */
  readonly description?: string;
  readonly terms: readonly VocabularyTerm[];
  readonly rejectedWords: readonly VocabularyRejectedWord[];
  readonly source: string;
  readonly definitionDigest: string;
}

/** Identity, version and digest of one vocabulary as pinned by a compiled Procedure. */
export interface VocabularyPin {
  readonly vocabulary: string;
  readonly version: string;
  readonly digest: string;
}

export interface VocabularyCompilationInput {
  readonly source: string;
  readonly sourceName?: string;
}

export type VocabularyCompilationErrorCode =
  | "invalid-vocabulary"
  | "invalid-identifier"
  | "duplicate-term"
  | "duplicate-word"
  | "unknown-term"
  | "conflicting-word"
  | "reserved-vocabulary"
  | "base-vocabulary-conflict"
  | "controlled-language";

export class VocabularyCompilationError extends Error {
  constructor(
    readonly code: VocabularyCompilationErrorCode,
    message: string,
    readonly sourceName?: string,
    readonly location?: { readonly line: number; readonly column: number },
    /** Every controlled language finding when `code` is `controlled-language`. */
    readonly languageDiagnostics: readonly ProcedureLanguageDiagnostic[] = [],
  ) {
    super(message);
    this.name = "VocabularyCompilationError";
  }
}

export interface VocabularyDiagnostic {
  readonly code: VocabularyCompilationErrorCode;
  readonly message: string;
  readonly sourceName: string;
  readonly location?: { readonly line: number; readonly column: number };
  readonly rule?: ProcedureLanguageDiagnostic["rule"];
  readonly field?: ProcedureLanguageDiagnostic["field"];
}

export interface VocabularyAnalysis {
  readonly compiled?: CompiledVocabulary;
  readonly diagnostics: readonly VocabularyDiagnostic[];
}

interface Located {
  readonly location?: { readonly line: number; readonly column?: number };
}

/**
 * Compile a domain vocabulary. It cannot take the base identity nor declare a term or rejected word of the base.
 * A rejected word can name a term of the domain vocabulary or a term of the base vocabulary.
 */
export function compileVocabulary(input: VocabularyCompilationInput): CompiledVocabulary {
  return compileVocabularyInternal(input, undefined, baseVocabulary());
}

let compiledBaseVocabulary: CompiledVocabulary | undefined;

/** The base vocabulary of TRUST, compiled from its source in this package. */
export function baseVocabulary(): CompiledVocabulary {
  compiledBaseVocabulary ??= compileVocabularyInternal({
    source: baseVocabularySource,
    sourceName: `${BASE_VOCABULARY}.feature`,
  });
  return compiledBaseVocabulary;
}

/** Every diagnostic of a vocabulary source, as the compiler reports it. */
export function analyzeVocabulary(input: VocabularyCompilationInput): VocabularyAnalysis {
  const sourceName = input.sourceName ?? "<vocabulary>";
  const language: VocabularyDiagnostic[] = [];
  try {
    const compiled = compileVocabularyInternal(
      input,
      (finding) =>
        language.push({
          code: "controlled-language",
          message: finding.message,
          sourceName,
          location: finding.location,
          rule: finding.rule,
          field: finding.field,
        }),
      baseVocabulary(),
    );
    return language.length > 0 ? { diagnostics: language } : { compiled, diagnostics: [] };
  } catch (error) {
    if (!(error instanceof VocabularyCompilationError)) throw error;
    return {
      diagnostics: [
        {
          code: error.code,
          message: error.message,
          sourceName: error.sourceName ?? sourceName,
          ...(error.location ? { location: error.location } : {}),
        },
      ],
    };
  }
}

export function isVocabularySource(source: string): boolean {
  const normalized = normalizeGherkinSource(source);
  try {
    return parseGherkin(normalized).feature?.tags.some((tag) => tag.name.startsWith(VOCABULARY_TAG)) ?? false;
  } catch (error) {
    if (error instanceof GherkinSyntaxError) return hasGherkinTag(source, VOCABULARY_TAG);
    throw error;
  }
}

/** The pin that a compiled Procedure records for one vocabulary. */
export function vocabularyPin(vocabulary: CompiledVocabulary): VocabularyPin {
  return { vocabulary: vocabulary.vocabulary, version: vocabulary.version, digest: vocabulary.definitionDigest };
}

/** One declared term of a vocabulary, with the identity and version of that vocabulary. */
export interface VocabularyLookupTerm extends VocabularyTerm {
  readonly vocabulary: string;
  readonly version: string;
}

/** One rejected word of a vocabulary, with the declared term to use when a searched vocabulary declares it. */
export interface VocabularyLookupRejectedWord extends VocabularyRejectedWord {
  readonly vocabulary: string;
  readonly version: string;
  readonly term?: VocabularyLookupTerm;
}

/** The result of one word lookup. A word that no searched vocabulary declares has no term and no rejected word. */
export interface VocabularyLookup {
  readonly word: string;
  readonly vocabularies: readonly VocabularyPin[];
  readonly terms: readonly VocabularyLookupTerm[];
  readonly rejectedWords: readonly VocabularyLookupRejectedWord[];
}

/**
 * Look one word up in the given vocabularies, in their order. The comparison uses the whole word or term,
 * ignores case and treats any run of white space as one space. The term of a rejected word is searched in
 * the same vocabulary first, then in the other searched vocabularies.
 */
export function lookupVocabularyWord(word: string, vocabularies: readonly CompiledVocabulary[]): VocabularyLookup {
  const wanted = lookupKey(word);
  const termOf = (vocabulary: CompiledVocabulary, term: VocabularyTerm): VocabularyLookupTerm => ({
    vocabulary: vocabulary.vocabulary,
    version: vocabulary.version,
    term: term.term,
    kind: term.kind,
    definition: term.definition,
  });
  const declaredTerm = (use: string, owner: CompiledVocabulary): VocabularyLookupTerm | undefined => {
    for (const vocabulary of [owner, ...vocabularies.filter((candidate) => candidate !== owner)]) {
      const term = vocabulary.terms.find((candidate) => candidate.term === use);
      if (term) return termOf(vocabulary, term);
    }
    return undefined;
  };
  return {
    word,
    vocabularies: vocabularies.map(vocabularyPin),
    terms: vocabularies.flatMap((vocabulary) =>
      vocabulary.terms.filter(({ term }) => lookupKey(term) === wanted).map((term) => termOf(vocabulary, term)),
    ),
    rejectedWords: vocabularies.flatMap((vocabulary) =>
      vocabulary.rejectedWords
        .filter((rejected) => lookupKey(rejected.word) === wanted)
        .map((rejected) => {
          const term = declaredTerm(rejected.use, vocabulary);
          return {
            vocabulary: vocabulary.vocabulary,
            version: vocabulary.version,
            word: rejected.word,
            use: rejected.use,
            ...(term === undefined ? {} : { term }),
          };
        }),
    ),
  };
}

function lookupKey(value: string): string {
  return value.trim().split(/\s+/u).join(" ").toLowerCase();
}

/** One prose text that an agent declares on a Plan, with the field that it fills. */
export interface AgentDeclaration {
  readonly field: ControlledProseField;
  readonly text: string;
}

/**
 * Control the prose that an agent declares on a Plan whose Procedure carries the controlled language tag.
 * The structure rules always apply. The lexical rules apply with exactly the vocabularies that the Procedure pins.
 * A pinned vocabulary that the supplied catalog lacks, or that has another digest, is an error.
 */
export function controlAgentDeclarations(
  language: CompiledControlledLanguage,
  catalog: readonly CompiledVocabulary[],
  declarations: readonly AgentDeclaration[],
): readonly ControlledLanguageFinding[] {
  const pins = language.vocabularies ?? [];
  const pinned = pins.map((pin) => {
    const vocabulary = catalog.find(
      (candidate) =>
        candidate.vocabulary === pin.vocabulary &&
        candidate.version === pin.version &&
        candidate.definitionDigest === pin.digest,
    );
    if (!vocabulary) throw new Error(`Pinned vocabulary ${pin.vocabulary}@${pin.version} is unavailable`);
    return vocabulary;
  });
  const lexicon = pinned.length > 0 ? controlledLexicon(pinned) : undefined;
  const rules = lexicon ? [...structureRules, ...lexicalRules] : structureRules;
  return declarations.flatMap(({ field, text }) => controlProse(text, field, rules, lexicon));
}

function compileVocabularyInternal(
  input: VocabularyCompilationInput,
  reportLanguageDiagnostic?: (diagnostic: ProcedureLanguageDiagnostic) => void,
  base?: CompiledVocabulary,
): CompiledVocabulary {
  const sourceName = input.sourceName ?? "<vocabulary>";
  const source = normalizeGherkinSource(input.source);
  let document: GherkinDocument;
  try {
    document = parseGherkin(source);
  } catch (error) {
    if (!(error instanceof GherkinSyntaxError)) throw error;
    throw new VocabularyCompilationError(
      "invalid-vocabulary",
      `Vocabulary is not valid Gherkin: ${error.message}`,
      sourceName,
      error.location,
    );
  }
  const feature = document.feature;
  if (!feature || feature.language !== "en")
    fail("invalid-vocabulary", "Vocabulary must contain one English Feature", sourceName);
  const vocabulary = uniqueTag(feature.tags, VOCABULARY_TAG, "vocabulary", sourceName, feature);
  const version = uniqueTag(feature.tags, VERSION_TAG, "version", sourceName, feature);
  const dsl = uniqueTag(feature.tags, TRUST_DSL_TAG, "TRUST DSL", sourceName, feature);
  const unknownTag = feature.tags.find(
    (tag) => ![VOCABULARY_TAG, VERSION_TAG, TRUST_DSL_TAG].some((prefix) => tag.name.startsWith(prefix)),
  );
  if (unknownTag) fail("invalid-vocabulary", `Unknown tag "${unknownTag.name}"`, sourceName, unknownTag);
  if (!SLUG.test(vocabulary))
    fail("invalid-identifier", `Vocabulary "${vocabulary}" must be a lowercase slug`, sourceName, feature);
  if (!isExactVersion(version))
    fail("invalid-identifier", `Version "${version}" must be semantic`, sourceName, feature);
  if (dsl !== vocabularyLanguage.dslVersion)
    fail("invalid-vocabulary", `TRUST DSL "${dsl}" is unsupported`, sourceName, feature);
  if (base && vocabulary === base.vocabulary)
    fail(
      "reserved-vocabulary",
      `Vocabulary "${vocabulary}" is the base vocabulary of TRUST and cannot be declared as a domain vocabulary`,
      sourceName,
      feature.tags.find((tag) => tag.name === `${VOCABULARY_TAG}${vocabulary}`) ?? feature,
    );
  const baseWords = new Map<string, string>();
  for (const { word } of base?.rejectedWords ?? []) baseWords.set(word.toLowerCase(), `rejected word "${word}"`);
  for (const { term } of base?.terms ?? []) baseWords.set(term.toLowerCase(), `term "${term}"`);
  const assertOutsideBase = (word: string, row: TableRow): void => {
    const declared = baseWords.get(word.toLowerCase());
    if (declared)
      fail(
        "base-vocabulary-conflict",
        `"${word}" is the ${declared} of the base vocabulary ${base?.vocabulary}`,
        sourceName,
        row,
      );
  };

  const backgrounds = feature.children.flatMap((child) => (child.background ? [child.background] : []));
  for (const child of feature.children) {
    if (child.scenario)
      fail("invalid-vocabulary", "A Scenario is outside the vocabulary grammar", sourceName, child.scenario);
    if (child.rule) fail("invalid-vocabulary", "A Rule is outside the vocabulary grammar", sourceName, child.rule);
  }
  if (backgrounds.length !== 1 || !backgrounds[0])
    fail("invalid-vocabulary", "Vocabulary must declare exactly one Background", sourceName, backgrounds[1] ?? feature);
  const [termsStep, rejectedStep, ...extraSteps] = backgrounds[0].steps;
  if (!termsStep || termsStep.keyword.trim() !== "Given" || parseVocabularyStep(termsStep.text)?.production !== "terms")
    fail(
      "invalid-vocabulary",
      `The vocabulary Background must start with "Given ${vocabularyLanguage.phrases.terms}"`,
      sourceName,
      termsStep ?? backgrounds[0],
    );
  if (
    rejectedStep &&
    (rejectedStep.keyword.trim() !== "And" || parseVocabularyStep(rejectedStep.text)?.production !== "rejected-words")
  )
    fail(
      "invalid-vocabulary",
      `The sentence "${rejectedStep.keyword.trim()} ${rejectedStep.text}" is outside the vocabulary grammar`,
      sourceName,
      rejectedStep,
    );
  if (extraSteps[0])
    fail(
      "invalid-vocabulary",
      `The sentence "${extraSteps[0].keyword.trim()} ${extraSteps[0].text}" is outside the vocabulary grammar`,
      sourceName,
      extraSteps[0],
    );

  const termRows = tableRows(termsStep, vocabularyLanguage.tables.terms, sourceName);
  if (termRows.length === 0) fail("invalid-vocabulary", "The Terms table must declare one term", sourceName, termsStep);
  const terms: VocabularyTerm[] = [];
  const termByKey = new Map<string, VocabularyTerm>();
  const definitions: { readonly text: string; readonly location: { line: number; column: number } }[] = [];
  for (const row of termRows) {
    const [termCell, kindCell, definitionCell] = row.cells;
    const term = wordForm(termCell?.value ?? "", "term", sourceName, row);
    const kind = kindCell?.value.trim() ?? "";
    if (!(vocabularyLanguage.kinds as readonly string[]).includes(kind))
      fail(
        "invalid-vocabulary",
        `The kind of term "${term}" must be ${vocabularyLanguage.kinds.join(" or ")}`,
        sourceName,
        kindCell ?? row,
      );
    const definition = definitionCell?.value.trim() ?? "";
    if (definition === "") fail("invalid-vocabulary", `Term "${term}" needs a definition`, sourceName, row);
    const key = term.toLowerCase();
    if (termByKey.has(key)) fail("duplicate-term", `Term "${term}" is declared twice`, sourceName, row);
    assertOutsideBase(term, row);
    const value: VocabularyTerm = { term, kind: kind as VocabularyTermKind, definition };
    termByKey.set(key, value);
    terms.push(value);
    const location = definitionCell?.location ?? row.location;
    definitions.push({ text: definition, location: { line: location.line, column: location.column ?? 1 } });
  }

  const baseTermByKey = new Map((base?.terms ?? []).map((term) => [term.term.toLowerCase(), term]));
  const rejectedWords: VocabularyRejectedWord[] = [];
  const rejectedKeys = new Set<string>();
  for (const row of rejectedStep ? tableRows(rejectedStep, vocabularyLanguage.tables.rejectedWords, sourceName) : []) {
    const [wordCell, useCell] = row.cells;
    const word = wordForm(wordCell?.value ?? "", "rejected word", sourceName, row);
    const use = wordForm(useCell?.value ?? "", "term to use", sourceName, row);
    const key = word.toLowerCase();
    if (rejectedKeys.has(key)) fail("duplicate-word", `Rejected word "${word}" is declared twice`, sourceName, row);
    if (termByKey.has(key))
      fail("conflicting-word", `Word "${word}" is both a term and a rejected word`, sourceName, row);
    assertOutsideBase(word, row);
    const target = termByKey.get(use.toLowerCase()) ?? baseTermByKey.get(use.toLowerCase());
    if (!target)
      fail(
        "unknown-term",
        `Rejected word "${word}" refers to the term "${use}" that neither this vocabulary nor the base vocabulary declares`,
        sourceName,
        useCell ?? row,
      );
    rejectedKeys.add(key);
    rejectedWords.push({ word, use: target.term });
  }

  const languageDiagnostics = definitions.flatMap(({ text, location }) =>
    controlProse(text, "definition").map((finding) => ({ ...finding, location })),
  );
  if (languageDiagnostics.length > 0 && !reportLanguageDiagnostic)
    throw new VocabularyCompilationError(
      "controlled-language",
      `Vocabulary definitions have ${languageDiagnostics.length} controlled language diagnostic(s)`,
      sourceName,
      languageDiagnostics[0]?.location,
      languageDiagnostics,
    );
  for (const diagnostic of languageDiagnostics) reportLanguageDiagnostic?.(diagnostic);

  const body = { vocabulary, version, title: feature.name, terms, rejectedWords };
  const description = readDescription(feature.description);
  return {
    ...body,
    ...(description === undefined ? {} : { description }),
    source,
    definitionDigest: digest(body),
  };
}

function tableRows(step: Step, header: readonly string[], sourceName: string): readonly TableRow[] {
  if (!step.dataTable || step.docString)
    fail("invalid-vocabulary", `"${step.text}" must carry one table`, sourceName, step);
  const [first, ...rows] = step.dataTable.rows;
  const columns = first?.cells.map((cell) => cell.value.trim()) ?? [];
  if (columns.length !== header.length || columns.some((column, index) => column !== header[index]))
    fail("invalid-vocabulary", `The "${step.text}" columns must be ${header.join(", ")}`, sourceName, first ?? step);
  for (const row of rows)
    if (row.cells.length !== header.length)
      fail("invalid-vocabulary", `Every "${step.text}" row must contain ${header.join(", ")}`, sourceName, row);
  return rows;
}

/** Trim and collapse white space; refuse a value that is not one or more plain words. */
function wordForm(value: string, label: string, sourceName: string, located: Located): string {
  const form = value.trim().split(/\s+/u).join(" ");
  if (!TERM.test(form))
    fail(
      "invalid-vocabulary",
      `The ${label} "${value.trim()}" must be one or more words of letters, digits, hyphens or apostrophes`,
      sourceName,
      located,
    );
  return form;
}

function parseVocabularyStep(text: string): StepGrammarMatch | undefined {
  try {
    return parseStepGrammar(vocabularyStepGrammar, tokenizeSentence(text), "background");
  } catch {
    return undefined;
  }
}

function uniqueTag(tags: readonly Tag[], prefix: string, label: string, sourceName: string, located: Located): string {
  const matches = tags.filter((tag) => tag.name.startsWith(prefix));
  if (matches.length !== 1)
    fail("invalid-vocabulary", `${label} tag must appear exactly once`, sourceName, matches[1] ?? located);
  const value = matches[0]?.name.slice(prefix.length) ?? "";
  if (value === "") fail("invalid-vocabulary", `${label} tag cannot be empty`, sourceName, matches[0] ?? located);
  return value;
}

function fail(code: VocabularyCompilationErrorCode, message: string, sourceName: string, located?: Located): never {
  throw new VocabularyCompilationError(
    code,
    message,
    sourceName,
    located?.location ? { line: located.location.line, column: located.location.column ?? 1 } : undefined,
  );
}
