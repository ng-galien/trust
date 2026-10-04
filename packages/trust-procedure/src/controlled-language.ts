/** Stable identifiers of the controlled language structure rules. */
export const controlledLanguageStructureRules = {
  sentenceLength: "structure.sentence-length",
  semicolon: "structure.semicolon",
  singleSentence: "structure.single-sentence",
  nameLength: "structure.name-length",
} as const;

/** Stable identifiers of the controlled language lexical rules. */
export const controlledLanguageLexicalRules = {
  rejectedWord: "lexical.rejected-word",
} as const;

export type ControlledLanguageRule =
  | (typeof controlledLanguageStructureRules)[keyof typeof controlledLanguageStructureRules]
  | (typeof controlledLanguageLexicalRules)[keyof typeof controlledLanguageLexicalRules];

export const structureRules: readonly ControlledLanguageRule[] = Object.values(controlledLanguageStructureRules);
export const lexicalRules: readonly ControlledLanguageRule[] = Object.values(controlledLanguageLexicalRules);

/** `structure` applies the structure rules; `lexical` applies the structure rules and the lexical rules. */
export type ControlledLanguageLevel = "structure" | "lexical";

interface ProseFieldProfile {
  /** Maximum words in one sentence. */
  readonly sentenceWords?: number;
  /** The field holds exactly one sentence. */
  readonly singleSentence?: true;
  /** Maximum words in the whole field. */
  readonly nameWords?: number;
}

/** Prose fields controlled by the structure rules, with their limits. */
export const controlledProseFields = {
  authorized: { sentenceWords: 20 },
  forbidden: { sentenceWords: 20 },
  "success-reason": { sentenceWords: 25, singleSentence: true },
  "failure-reason": { sentenceWords: 25, singleSentence: true },
  "check-name": { nameWords: 3 },
  "role-name": { nameWords: 3 },
  definition: { sentenceWords: 25, singleSentence: true },
  "next-intent": { sentenceWords: 25, singleSentence: true },
  "blocking-reason": { sentenceWords: 25 },
  "forbidden-further-action": { sentenceWords: 25, singleSentence: true },
} as const satisfies Readonly<Record<string, ProseFieldProfile>>;

export type ControlledProseField = keyof typeof controlledProseFields;

export interface ControlledLanguageFinding {
  readonly rule: ControlledLanguageRule;
  readonly field: ControlledProseField;
  readonly message: string;
}

/** One rejected word with the term to use in its place. */
export interface ControlledLexiconEntry {
  readonly word: string;
  readonly use: string;
}

/** Rejected words of every vocabulary that a lexical control includes, in a fixed order. */
export interface ControlledLexicon {
  readonly entries: readonly (ControlledLexiconEntry & { readonly pattern: RegExp })[];
}

/** Letters, digits, underscores and hyphens continue a word; any other character ends it. */
const WORD_CHARACTER = "[\\p{L}\\p{N}_-]";

/** Build the lexicon of the given vocabularies. A later vocabulary does not hide an earlier entry. */
export function controlledLexicon(
  vocabularies: readonly { readonly rejectedWords: readonly ControlledLexiconEntry[] }[],
): ControlledLexicon {
  return {
    entries: vocabularies.flatMap((vocabulary) =>
      vocabulary.rejectedWords.map(({ word, use }) => ({
        word,
        use,
        pattern: new RegExp(
          `(?<!${WORD_CHARACTER})${proseWords(word).map(escapeRegExp).join("\\s+")}(?!${WORD_CHARACTER})`,
          "iu",
        ),
      })),
    ),
  };
}

/** A sentence ends at a full stop, a question mark or an exclamation mark followed by white space or the end. */
export function proseSentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.?!])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** A word is a run of characters without white space. */
export function proseWords(text: string): readonly string[] {
  return text.split(/\s+/u).filter((word) => word !== "");
}

/** Pure control of one prose field: the same text, field, rules and lexicon always give the same findings. */
export function controlProse(
  text: string,
  field: ControlledProseField,
  rules: readonly ControlledLanguageRule[] = structureRules,
  lexicon?: ControlledLexicon,
): readonly ControlledLanguageFinding[] {
  const profile: ProseFieldProfile = controlledProseFields[field];
  const active = new Set(rules);
  const findings: ControlledLanguageFinding[] = [];
  const sentences = proseSentences(text);
  if (active.has(controlledLanguageStructureRules.semicolon) && text.includes(";")) {
    findings.push({
      rule: controlledLanguageStructureRules.semicolon,
      field,
      message: `The ${field} text contains a semicolon. Write separate sentences.`,
    });
  }
  if (active.has(controlledLanguageStructureRules.sentenceLength) && profile.sentenceWords !== undefined) {
    for (const sentence of sentences) {
      const count = proseWords(sentence).length;
      if (count > profile.sentenceWords)
        findings.push({
          rule: controlledLanguageStructureRules.sentenceLength,
          field,
          message: `A ${field} sentence has ${count} words. The limit is ${profile.sentenceWords}.`,
        });
    }
  }
  if (active.has(controlledLanguageStructureRules.singleSentence) && profile.singleSentence && sentences.length > 1) {
    findings.push({
      rule: controlledLanguageStructureRules.singleSentence,
      field,
      message: `The ${field} text has ${sentences.length} sentences. Write one sentence.`,
    });
  }
  if (active.has(controlledLanguageStructureRules.nameLength) && profile.nameWords !== undefined) {
    const count = proseWords(text).length;
    if (count > profile.nameWords)
      findings.push({
        rule: controlledLanguageStructureRules.nameLength,
        field,
        message: `The ${field} has ${count} words. The limit is ${profile.nameWords}.`,
      });
  }
  if (active.has(controlledLanguageLexicalRules.rejectedWord) && lexicon) {
    for (const entry of lexicon.entries) {
      if (!entry.pattern.test(text)) continue;
      findings.push({
        rule: controlledLanguageLexicalRules.rejectedWord,
        field,
        message: `The ${field} text uses the rejected word "${entry.word}". Use the term "${entry.use}".`,
      });
    }
  }
  return findings;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
