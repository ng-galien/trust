import { SentenceSyntaxError, tokenizeSentence } from "@trust/gherkin";
import { describe, expect, test } from "vitest";

describe("Gherkin sentence tokenizer", () => {
  test("keeps quoted clauses as one positioned token", () => {
    expect(tokenizeSentence('on "repository and materializes output" as input "repository"'))
      .toEqual([
        { kind: "text", value: "on", start: 0, end: 2 },
        { kind: "quoted", value: "repository and materializes output", start: 3, end: 39 },
        { kind: "text", value: "as", start: 40, end: 42 },
        { kind: "text", value: "input", start: 43, end: 48 },
        { kind: "quoted", value: "repository", start: 49, end: 61 },
      ]);
  });

  test("accepts a comma directly between two separated values", () => {
    expect(tokenizeSentence('"first", "second"').map(({ kind, value }) => ({ kind, value })))
      .toEqual([
        { kind: "quoted", value: "first" },
        { kind: "comma", value: "," },
        { kind: "quoted", value: "second" },
      ]);
  });

  test.each([
    "value,",
    "value , next",
    "  , next",
    "value,, next",
    "value, , next",
  ])("rejects the invalid comma boundary in %s", (source) => {
    expect(() => tokenizeSentence(source)).toThrow(SentenceSyntaxError);
  });
});
