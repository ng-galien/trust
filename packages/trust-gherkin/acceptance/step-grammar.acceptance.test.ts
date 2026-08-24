import { describe, expect, test } from "vitest";

import {
  matchStepGrammar,
  parseStepGrammar,
  parseStepGrammarPrefix,
  stepChoice,
  stepGrammarExpectations,
  stepGrammarFailure,
  stepLiteral,
  stepOneOf,
  stepOptional,
  stepQuoted,
  stepRepeat,
  stepSequence,
  tokenizeSentence,
  type StepGrammar,
} from "@trust/gherkin";

const grammar: StepGrammar = {
  productions: [{
    name: "task-run",
    context: "scenario",
    expression: stepSequence(
      stepLiteral("Task", "Task"),
      stepQuoted("task", "Task name"),
      stepLiteral("runs with", "Execution"),
      stepOneOf("mode", ["fast", "safe"], "Execution mode"),
      stepOptional(stepSequence(stepLiteral("in Environment", "Environment"), stepQuoted("environment", "Environment"))),
      stepRepeat(stepSequence(stepLiteral("and Input", "Input"), stepQuoted("input", "Input"))),
      stepChoice(stepLiteral("succeeds", "Outcome"), stepLiteral("is skipped", "Outcome", "outcome")),
    ),
  }],
};

describe("TRUST Step Grammar", () => {
  test("recognizes complete sentences with choices, optional clauses and repetitions", () => {
    expect(matchStepGrammar(
      grammar,
      tokenizeSentence('Task "build" runs with safe in Environment "local" and Input "project" and Input "revision" succeeds'),
      "scenario",
    )).toBe("task-run");
    expect(matchStepGrammar(grammar, tokenizeSentence('Task "build" runs with fast is skipped'), "scenario"))
      .toBe("task-run");
    expect(matchStepGrammar(grammar, tokenizeSentence('Task "build" runs safe succeeds'), "scenario"))
      .toBeUndefined();
    expect(parseStepGrammar(grammar, tokenizeSentence('Task "build" runs with safe and Input "project" succeeds'), "scenario"))
      .toEqual({
        production: "task-run",
        captures: [
          { slot: "task", value: "build" },
          { slot: "mode", value: "safe" },
          { slot: "input", value: "project" },
        ],
      });
    expect(parseStepGrammarPrefix(grammar, tokenizeSentence('Task "build" runs with safe unexpected'), "scenario"))
      .toEqual({
        production: "task-run",
        captures: [{ slot: "task", value: "build" }, { slot: "mode", value: "safe" }],
        consumedTokens: 5,
      });
    expect(parseStepGrammar(grammar, tokenizeSentence('Task "build" runs with fast is skipped'), "scenario")?.captures)
      .toContainEqual({ slot: "outcome", value: "is skipped" });
    expect(stepGrammarFailure(grammar, tokenizeSentence('Task "build" runs with fast succeeds unexpected'), "scenario"))
      .toMatchObject({ tokenIndex: 6, expectedEnd: true, expectations: [] });
  });

  test("returns the canonical continuations at an incomplete cursor", () => {
    expect(stepGrammarExpectations(grammar, tokenizeSentence('Task "build"'), "scenario"))
      .toEqual([{ kind: "literal", value: "runs with", detail: "Execution" }]);
    expect(stepGrammarExpectations(grammar, tokenizeSentence('Task "build" runs with'), "scenario"))
      .toEqual([{ kind: "one-of", slot: "mode", values: ["fast", "safe"], detail: "Execution mode", quoted: false }]);
    expect(stepGrammarExpectations(grammar, tokenizeSentence('Task "build" runs with fast'), "scenario"))
      .toEqual(expect.arrayContaining([
        { kind: "literal", value: "in Environment", detail: "Environment" },
        { kind: "literal", value: "and Input", detail: "Input" },
        { kind: "literal", value: "succeeds", detail: "Outcome" },
        { kind: "literal", value: "is skipped", detail: "Outcome" },
      ]));
    expect(stepGrammarExpectations(grammar, tokenizeSentence('Task "build" ru'), "scenario"))
      .toEqual([{ kind: "literal", value: "runs with", detail: "Execution" }]);
  });

  test("merges compatible one-of continuations instead of dropping an alternative", () => {
    const alternatives: StepGrammar = {
      productions: [{
        name: "mode",
        context: "scenario",
        expression: stepSequence(
          stepLiteral("uses", "Mode"),
          stepChoice(
            stepOneOf("mode", ["fast"], "Mode"),
            stepOneOf("mode", ["safe"], "Mode"),
          ),
        ),
      }],
    };
    expect(stepGrammarExpectations(alternatives, tokenizeSentence("uses"), "scenario"))
      .toEqual([{ kind: "one-of", slot: "mode", values: ["fast", "safe"], detail: "Mode", quoted: false }]);
  });
});
