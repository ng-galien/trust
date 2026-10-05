import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";
import { test } from "./support/fixtures.js";
import { startPublicRuntime } from "./support/runtime-process.js";

const LISTEN_TIMEOUT_MS = 60_000;
const LSP_TIMEOUT_MS = 20_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");
const runtimeEntry = path.join(packageRoot, "dist/src/index.js");
const fixtures = path.join(packageRoot, "acceptance/fixtures/controlled-language");

interface Runtime {
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

interface LanguageDiagnostic {
  readonly rule: string;
  readonly field: string;
  readonly message: string;
  readonly location: { readonly line: number; readonly column: number };
}

interface RpcFailureData {
  readonly contract?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly location?: { readonly line: number; readonly column: number } | null;
  readonly diagnostics?: readonly LanguageDiagnostic[];
}

interface RpcEnvelope {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: RpcFailureData };
}

interface PublishedVocabularyResult {
  readonly vocabulary: {
    readonly vocabulary: string;
    readonly version: string;
    readonly definitionDigest: string;
    readonly source: string;
    readonly terms: readonly { readonly term: string; readonly kind: string; readonly definition: string }[];
    readonly rejectedWords: readonly { readonly word: string; readonly use: string }[];
  };
  readonly sourceName: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

let runtime: Runtime;

type TermRow = readonly [term: string, kind: string, definition: string];
type RejectedRow = readonly [word: string, use: string];

const DEFAULT_TERMS: readonly TermRow[] = [
  ["repository", "noun", "A store of files with their version history."],
  ["pipeline", "noun", "A sequence of jobs that builds and ships a release."],
  ["observe", "verb", "Read a state without changing it."],
];
const DEFAULT_REJECTED: readonly RejectedRow[] = [
  ["repo", "repository"],
  ["action step", "pipeline"],
];

/** Lines: 6 Terms, 8 repository, 9 Operation, 10 observe, 11 Rejected words, 13 repo, 14 action step. */
const DELIVERY_TERMS = vocabulary({ name: "delivery-terms" });

beforeAll(async () => {
  runtime = await startRuntime();
  const published = await rpc("vocabulary.publish", { source: DELIVERY_TERMS, sourceName: "delivery-terms.feature" });
  assert.equal(published.error, undefined, JSON.stringify(published.error));
});

afterAll(async () => {
  await runtime?.close();
});

test("LANG-010 AC3 a Procedure with the tag and a vocabulary name gets the structure rules and the lexical rules", async () => {
  const delivery = (await readVocabulary("delivery-terms", "1.0.0")).vocabulary;
  const fields = { authorized: "Inspect the repo.", forbidden: `${words(21)}.` };
  assert.deepEqual(summary(await rejectedDiagnostics(procedure({ ...fields, tag: "delivery-terms" }))), [
    "8 authorized lexical.rejected-word",
    "8 forbidden structure.sentence-length",
  ]);
  assert.deepEqual(summary(await rejectedDiagnostics(procedure(fields))), ["8 forbidden structure.sentence-length"]);

  const clean = await rpc("procedure.compile", {
    source: procedure({ tag: "delivery-terms", authorized: "Inspect the repository." }),
    sourceName: "lexical.feature",
  });
  assert.equal(clean.error, undefined, JSON.stringify(clean.error));
  assert.deepEqual(clean.result?.controlledLanguage, {
    level: "lexical",
    vocabularies: [
      await basePin(),
      { vocabulary: "delivery-terms", version: "1.0.0", digest: delivery.definitionDigest },
    ],
  });
  const structureOnly = await rpc("procedure.compile", { source: procedure({}), sourceName: "structure.feature" });
  assert.deepEqual(structureOnly.result?.controlledLanguage, { level: "structure" });
});

test("LANG-010 AC4 a Procedure with the tag twice or with two vocabulary names is refused with its line", async () => {
  const tagLine = "@trust-dsl:1 @procedure:language-vocabulary @version:1.0.0 @controlled-language:delivery-terms";
  const base = procedure({ tag: "delivery-terms" });
  assert.ok(base.includes(tagLine));
  const cases: ReadonlyArray<readonly [string, number, RegExp]> = [
    [base.replace(tagLine, `${tagLine}\n@controlled-language`), 3, /at most once/],
    [base.replace(tagLine, `${tagLine}\n@controlled-language:other-terms`), 3, /at most once/],
    [
      base.replace(tagLine, tagLine.replace("delivery-terms", "delivery-terms,other-terms")),
      2,
      /at most one vocabulary/,
    ],
  ];
  for (const [source, line, message] of cases) {
    const refused = await rpc("procedure.compile", { source, sourceName: "tagged.feature" });
    assert.equal(refused.result, undefined, source);
    assert.equal(refused.error?.data?.reason, "invalid-procedure", JSON.stringify(refused.error));
    assert.equal(refused.error?.data?.location?.line, line, JSON.stringify(refused.error));
    assert.match(refused.error?.data?.message ?? "", message);
  }
});

test("LANG-030 AC1 a vocabulary source with a terms table and a rejected words table compiles and a sentence outside the grammar is refused with its line", async () => {
  const compiled = await rpc("vocabulary.compile", { source: DELIVERY_TERMS, sourceName: "delivery-terms.feature" });
  assert.equal(compiled.error, undefined, JSON.stringify(compiled.error));
  assert.equal(compiled.result?.vocabulary, "delivery-terms");
  assert.equal(compiled.result?.version, "1.0.0");
  assert.deepEqual(compiled.result?.terms, [
    { term: "repository", kind: "noun", definition: "A store of files with their version history." },
    { term: "pipeline", kind: "noun", definition: "A sequence of jobs that builds and ships a release." },
    { term: "observe", kind: "verb", definition: "Read a state without changing it." },
  ]);
  assert.deepEqual(compiled.result?.rejectedWords, [
    { word: "repo", use: "repository" },
    { word: "action step", use: "pipeline" },
  ]);
  assert.match(String(compiled.result?.definitionDigest), /^[0-9a-f]{64}$/);
  const withoutRejected = await rpc("vocabulary.compile", { source: vocabulary({ rejected: [] }) });
  assert.equal(withoutRejected.error, undefined, JSON.stringify(withoutRejected.error));
  assert.deepEqual(withoutRejected.result?.rejectedWords, []);

  const lines = DELIVERY_TERMS.split("\n");
  const outside: ReadonlyArray<readonly [string, number]> = [
    [`${DELIVERY_TERMS}    And Forbidden words\n      | word |\n      | x |\n`, lines.length],
    [DELIVERY_TERMS.replace("    Given Terms", "    When Terms"), 6],
    [DELIVERY_TERMS.replace("    And Rejected words", "    And Rejected terms"), 11],
    [DELIVERY_TERMS.replace("| term       | kind | definition", "| term       | type | definition"), 7],
    [`${DELIVERY_TERMS}\n  Scenario: Use the terms\n    Given Terms\n`, lines.length + 1],
    [DELIVERY_TERMS.replace("| verb |", "| adjective |"), 10],
    [DELIVERY_TERMS.replace("@version:1.0.0", "@version:1.0.0 @owner:team"), 2],
  ];
  for (const [source, line] of outside) {
    const refused = await rpc("vocabulary.compile", { source, sourceName: "outside.feature" });
    assert.equal(refused.result, undefined, source);
    assert.equal(refused.error?.data?.contract, "trust.vocabulary-compilation-error@1");
    assert.equal(refused.error?.data?.reason, "invalid-vocabulary", JSON.stringify(refused.error));
    assert.equal(refused.error?.data?.location?.line, line, `${JSON.stringify(refused.error)}\n${source}`);
  }
});

test("LANG-030 AC2 a duplicate term, a rejected word without its term or a word that is both term and rejected word is refused", async () => {
  const cases: ReadonlyArray<readonly [string, string, number]> = [
    [
      vocabulary({
        terms: [...DEFAULT_TERMS, ["Repository", "noun", "A second meaning of the same term."]],
      }),
      "duplicate-term",
      11,
    ],
    [vocabulary({ rejected: [["repo", "store"]] }), "unknown-term", 13],
    [vocabulary({ rejected: [["observe", "repository"]] }), "conflicting-word", 13],
  ];
  for (const [source, reason, line] of cases) {
    for (const method of ["vocabulary.compile", "vocabulary.publish"]) {
      const refused = await rpc(method, { source, sourceName: "conflict.feature" });
      assert.equal(refused.result, undefined, source);
      assert.equal(refused.error?.data?.reason, reason, JSON.stringify(refused.error));
      assert.equal(refused.error?.data?.location?.line, line, JSON.stringify(refused.error));
    }
  }
  const listed = (await rpc("vocabulary.list", {})).result?.vocabularies as PublishedVocabularyResult[];
  const delivery = listed.filter(({ vocabulary }) => vocabulary.vocabulary === "delivery-terms");
  assert.deepEqual(
    delivery.map(({ vocabulary }) => [vocabulary.version, vocabulary.source]),
    [["1.0.0", DELIVERY_TERMS]],
  );
});

test("LANG-030 AC3 each definition obeys the structure rules", async () => {
  const accepted = await rpc("vocabulary.compile", {
    source: vocabulary({ terms: [["store", "noun", `${words(25)}.`]], rejected: [] }),
  });
  assert.equal(accepted.error, undefined, JSON.stringify(accepted.error));

  const source = vocabulary({
    terms: [
      ["store", "noun", `${words(26)}.`],
      ["copy", "verb", "Read the files; write them again."],
      ["branch", "noun", "A line of work. It has a name."],
      ["tag", "noun", "A fixed name for one version."],
    ],
    rejected: [],
  });
  const refused = await rpc("vocabulary.compile", { source, sourceName: "definitions.feature" });
  assert.equal(refused.result, undefined);
  assert.equal(refused.error?.data?.reason, "controlled-language", JSON.stringify(refused.error));
  const diagnostics = refused.error?.data?.diagnostics ?? [];
  assert.deepEqual(summary(diagnostics), [
    "8 definition structure.sentence-length",
    "9 definition structure.semicolon",
    "10 definition structure.single-sentence",
  ]);
  for (const diagnostic of diagnostics) assert.ok(diagnostic.location.column > 1, JSON.stringify(diagnostic));
  const published = await rpc("vocabulary.publish", { source, sourceName: "definitions.feature" });
  assert.equal(published.error?.data?.reason, "controlled-language");
  assert.deepEqual(published.error?.data?.diagnostics, diagnostics);
});

test("LANG-030 AC4 a published vocabulary version is immutable and cannot be removed", async () => {
  const source = vocabulary({ name: "immutable-terms" });
  const first = await rpc("vocabulary.publish", { source, sourceName: "immutable-terms.feature" });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const original = first.result as unknown as PublishedVocabularyResult;

  const again = await rpc("vocabulary.publish", { source, sourceName: "again.feature" });
  assert.equal(again.error, undefined, JSON.stringify(again.error));
  assert.deepEqual(again.result, first.result);

  const changed = vocabulary({ name: "immutable-terms", rejected: [["repo", "repository"]] });
  const conflict = await rpc("vocabulary.publish", { source: changed, sourceName: "changed.feature" });
  assert.equal(conflict.result, undefined);
  assert.match(conflict.error?.data?.message ?? "", /already published with another immutable definition/);
  const mcpConflict = await mcp("trust_vocabulary_publish", { source: changed });
  assert.equal(mcpConflict.isError, true);
  assert.match(mcpConflict.text, /already published with another immutable definition/);

  const removal = await rpc("vocabulary.remove", { vocabulary: "immutable-terms", version: "1.0.0" });
  assert.equal(removal.error?.code, -32_601);
  const tools = await mcpRequest("tools/list", {});
  const vocabularyTools = (tools.result as { tools: { name: string }[] }).tools
    .map(({ name }) => name)
    .filter((name) => name.includes("vocabulary"))
    .sort();
  assert.deepEqual(vocabularyTools, [
    "trust_published_vocabulary_read",
    "trust_vocabulary_compile",
    "trust_vocabulary_list",
    "trust_vocabulary_lookup",
    "trust_vocabulary_publish",
  ]);

  const read = await rpc("vocabulary.read", { vocabulary: "immutable-terms", version: "1.0.0" });
  assert.deepEqual(read.result, { contract: "trust.published-vocabulary@1", ...original });
  const listed = (await rpc("vocabulary.list", {})).result?.vocabularies as PublishedVocabularyResult[];
  assert.deepEqual(
    listed.find(({ vocabulary }) => vocabulary.vocabulary === "immutable-terms"),
    Object.fromEntries(Object.entries(original).filter(([key]) => key !== "contract")),
  );
});

test("LANG-050 AC1 a rejected word in a prose field produces a diagnostic that names the term to use", async () => {
  const diagnostics = await rejectedDiagnostics(
    procedure({
      tag: "delivery-terms",
      authorized: "Inspect the repo.",
      forbidden: "Add an action step.",
      roleName: "repo",
      checkName: "confirm action step",
      successReason: "the repo is clean",
      failure: '"the action step failed"',
    }),
  );
  assert.deepEqual(summary(diagnostics), [
    "8 authorized lexical.rejected-word",
    "8 forbidden lexical.rejected-word",
    "9 role-name lexical.rejected-word",
    "13 check-name lexical.rejected-word",
    "13 success-reason lexical.rejected-word",
    "15 failure-reason lexical.rejected-word",
  ]);
  const terms = diagnostics.map(({ message }) => /Use the term "([^"]+)"/.exec(message)?.[1]);
  assert.deepEqual(terms, ["repository", "pipeline", "repository", "pipeline", "repository", "pipeline"]);
  assert.match(diagnostics[0]?.message ?? "", /rejected word "repo"/);
  assert.match(diagnostics[1]?.message ?? "", /rejected word "action step"/);
});

test("LANG-050 AC2 the comparison uses whole words and ignores case", async () => {
  const matched: ReadonlyArray<Partial<ProseFields>> = [
    { authorized: "Inspect the REPO." },
    { authorized: "Repo. Read it." },
    { authorized: "Read the (Repo) state." },
    { forbidden: "Add one Action   STEP." },
  ];
  for (const fields of matched)
    assert.equal(
      summary(await rejectedDiagnostics(procedure({ tag: "delivery-terms", ...fields }))).filter((entry) =>
        entry.endsWith("lexical.rejected-word"),
      ).length,
      1,
      JSON.stringify(fields),
    );
  const accepted = await rpc("procedure.compile", {
    source: procedure({
      tag: "delivery-terms",
      authorized: "Inspect repos, the repository and the prepo copy.",
      forbidden: "Change the repo-like actions or one step.",
    }),
    sourceName: "words.feature",
  });
  assert.equal(accepted.error, undefined, JSON.stringify(accepted.error));
});

test("LANG-050 AC3 a Procedure that names an unpublished vocabulary is refused", async () => {
  const source = procedure({ tag: "missing-terms", name: "unpublished-vocabulary" });
  for (const method of ["procedure.compile", "procedure.publish"]) {
    const refused = await rpc(method, { source, sourceName: "unpublished.feature" });
    assert.equal(refused.result, undefined);
    assert.equal(refused.error?.data?.reason, "unknown-vocabulary", JSON.stringify(refused.error));
    assert.equal(refused.error?.data?.location?.line, 2);
    assert.match(refused.error?.data?.message ?? "", /Vocabulary "missing-terms" is not published/);
  }
  const mcpRefused = await mcp("trust_procedure_compile", { source });
  assert.equal(mcpRefused.isError, true);
  assert.match(mcpRefused.text, /Reason: unknown-vocabulary/);
  const read = await rpc("procedure.read", { procedure: "unpublished-vocabulary", version: "1.0.0" });
  assert.equal(read.result, undefined);
});

test("LANG-050 AC4 the compiled Procedure pins its vocabulary and an engaged Plan keeps it after a newer publication", async () => {
  const first = await rpc("vocabulary.publish", { source: vocabulary({ name: "pinning-terms" }) });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const pinned = (first.result as unknown as PublishedVocabularyResult).vocabulary;
  const source = procedure({ tag: "pinning-terms", name: "pinned-language" });
  const published = await rpc("procedure.publish", { source, sourceName: "pinned-language.feature" });
  assert.equal(published.error, undefined, JSON.stringify(published.error));
  const definition = published.result?.procedure as { definitionDigest: string; controlledLanguage: unknown };
  const pin = {
    level: "lexical",
    vocabularies: [await basePin(), { vocabulary: "pinning-terms", version: "1.0.0", digest: pinned.definitionDigest }],
  };
  assert.deepEqual(definition.controlledLanguage, pin);

  const engagedBefore = await engage("pinned-before");
  const newer = await rpc("vocabulary.publish", {
    source: vocabulary({
      name: "pinning-terms",
      version: "1.1.0",
      terms: [...DEFAULT_TERMS, ["listed", "verb", "Named in a table of the Procedure."]],
      rejected: [...DEFAULT_REJECTED, ["declared", "listed"]],
    }),
  });
  assert.equal(newer.error, undefined, JSON.stringify(newer.error));
  const newerDigest = (newer.result as unknown as PublishedVocabularyResult).vocabulary.definitionDigest;
  assert.notEqual(newerDigest, pinned.definitionDigest);

  const read = await rpc("procedure.read", { procedure: "pinned-language", version: "1.0.0" });
  assert.deepEqual((read.result?.procedure as { controlledLanguage: unknown } | undefined)?.controlledLanguage, pin);
  assert.deepEqual(await planDigests("pinned-before"), [definition.definitionDigest]);
  assert.equal(engagedBefore, definition.definitionDigest);
  assert.equal(await engage("pinned-after"), definition.definitionDigest);
  assert.deepEqual(await planDigests("pinned-after"), [definition.definitionDigest]);

  assert.deepEqual(summary(await rejectedDiagnostics(source)), ["8 authorized lexical.rejected-word"]);
  const recompiled = await rpc("procedure.compile", {
    source: source.replace("Run the declared Operation.", "Run the listed Operation."),
  });
  assert.equal(recompiled.error, undefined, JSON.stringify(recompiled.error));
  assert.deepEqual((recompiled.result?.controlledLanguage as { vocabularies: unknown } | undefined)?.vocabularies, [
    await basePin(),
    { vocabulary: "pinning-terms", version: "1.1.0", digest: newerDigest },
  ]);
});

test("LANG-070 AC1 MCP tools compile, publish, list and read a vocabulary through the same runtime functions as RPC", async () => {
  const source = vocabulary({ name: "mcp-terms" });
  const rpcCompiled = await rpc("vocabulary.compile", { source, sourceName: "mcp-terms.feature" });
  assert.equal(rpcCompiled.error, undefined, JSON.stringify(rpcCompiled.error));
  const digest = String(rpcCompiled.result?.definitionDigest);

  const compiled = await mcp("trust_vocabulary_compile", { source, sourceName: "mcp-terms.feature" });
  assert.equal(compiled.isError, false, compiled.text);
  assert.match(compiled.text, /^VOCABULARY COMPILED\nVocabulary: mcp-terms@1\.0\.0\n/);
  assert.match(compiled.text, new RegExp(`Definition digest: ${digest}`));
  assert.match(compiled.text, /- repository \(noun\): A store of files with their version history\./);
  assert.match(compiled.text, /- action step: use "pipeline"/);
  assert.equal((await rpc("vocabulary.read", { vocabulary: "mcp-terms", version: "1.0.0" })).result, undefined);

  const mcpPublished = await mcp("trust_vocabulary_publish", { source, sourceName: "mcp-terms.feature" });
  assert.equal(mcpPublished.isError, false, mcpPublished.text);
  assert.match(mcpPublished.text, /^VOCABULARY PUBLISHED\n/);
  const rpcRead = await rpc("vocabulary.read", { vocabulary: "mcp-terms", version: "1.0.0" });
  const fromMcp = rpcRead.result as unknown as PublishedVocabularyResult;
  assert.equal(fromMcp.vocabulary.definitionDigest, digest);
  assert.deepEqual(fromMcp.vocabulary, rpcCompiled.result);
  assert.equal(fromMcp.publishedBy, "mcp-agent");
  assert.equal(fromMcp.sourceName, "mcp-terms.feature");

  const rpcPublished = await rpc("vocabulary.publish", {
    source: vocabulary({ name: "mcp-terms", version: "1.1.0" }),
    sourceName: "mcp-terms-1.1.feature",
  });
  assert.equal(rpcPublished.error, undefined, JSON.stringify(rpcPublished.error));
  const fromRpc = rpcPublished.result as unknown as PublishedVocabularyResult;
  const mcpRead = await mcp("trust_published_vocabulary_read", { vocabulary: "mcp-terms", version: "1.1.0" });
  assert.equal(mcpRead.isError, false, mcpRead.text);
  assert.match(mcpRead.text, /^PUBLISHED VOCABULARY\nVocabulary: mcp-terms@1\.1\.0\n/);
  assert.match(mcpRead.text, new RegExp(`Definition digest: ${fromRpc.vocabulary.definitionDigest}`));
  assert.match(mcpRead.text, /Published by: local-operator/);
  assert.match(mcpRead.text, new RegExp(`Published at: ${fromRpc.publishedAt.replaceAll(".", "\\.")}`));
  assert.ok(mcpRead.text.endsWith(`SOURCE\n${fromRpc.vocabulary.source}\n`));

  const rpcList = (await rpc("vocabulary.list", {})).result?.vocabularies as PublishedVocabularyResult[];
  const mcpList = await mcp("trust_vocabulary_list", {});
  assert.equal(mcpList.isError, false, mcpList.text);
  assert.match(mcpList.text, new RegExp(`^VOCABULARY CATALOG\nCount: ${rpcList.length}\n`));
  const listedByMcp = [...mcpList.text.matchAll(/^- ([a-z0-9-]+@[0-9.]+): /gm)].map(([, identity]) => identity);
  assert.deepEqual(
    listedByMcp,
    rpcList.map(({ vocabulary }) => `${vocabulary.vocabulary}@${vocabulary.version}`),
  );
  assert.ok(listedByMcp.includes("mcp-terms@1.0.0") && listedByMcp.includes("mcp-terms@1.1.0"));

  const invalid = vocabulary({ name: "mcp-terms", rejected: [["repo", "store"]] });
  const rpcRefused = await rpc("vocabulary.compile", { source: invalid });
  const mcpRefused = await mcp("trust_vocabulary_compile", { source: invalid });
  assert.equal(mcpRefused.isError, true);
  assert.match(mcpRefused.text, /Reason: unknown-term/);
  assert.ok(mcpRefused.text.includes(`Message: ${rpcRefused.error?.data?.message}`), mcpRefused.text);
  assert.ok(mcpRefused.text.includes(`Location: ${rpcRefused.error?.data?.location?.line}:`), mcpRefused.text);
});

test("LANG-070 AC3 the language server returns the compiler diagnostics for a Procedure source and for a vocabulary source", async () => {
  const procedureSource = procedure({
    tag: "delivery-terms",
    authorized: "Inspect the repo; observe it.",
    roleName: "the repo value now",
    failure: '"the action step failed"',
  });
  const definitions = vocabulary({
    name: "lsp-terms",
    terms: [
      ["store", "noun", `${words(26)}.`],
      ["copy", "verb", "Read the files; write them again."],
    ],
    rejected: [],
  });
  const grammar = vocabulary({ name: "lsp-grammar", rejected: [["repo", "store"]] });

  const compiledProcedure = await rpc("procedure.compile", { source: procedureSource, sourceName: "lsp.feature" });
  const compiledDefinitions = await rpc("vocabulary.compile", { source: definitions, sourceName: "lsp.feature" });
  const compiledGrammar = await rpc("vocabulary.compile", { source: grammar, sourceName: "lsp.feature" });
  const expected = (data: RpcFailureData | undefined) =>
    (data?.diagnostics ?? []).map(({ location, rule, field, message }) => ({
      line: location.line,
      code: data?.reason,
      rule,
      field,
      message,
    }));
  assert.ok((compiledProcedure.error?.data?.diagnostics ?? []).length >= 4, JSON.stringify(compiledProcedure.error));
  assert.equal(compiledDefinitions.error?.data?.diagnostics?.length, 2, JSON.stringify(compiledDefinitions.error));
  assert.equal(compiledGrammar.error?.data?.reason, "unknown-term");

  const lsp = await LanguageClient.connect(runtime.endpoint);
  try {
    const observed = await lsp.diagnostics("file:///workspace/lexical.feature", procedureSource);
    assert.deepEqual(
      observed.map(({ line, code, rule, field, message }) => ({ line, code, rule, field, message })),
      expected(compiledProcedure.error?.data),
    );
    assert.ok(observed.every(({ source }) => source === "trust-procedure"));
    const vocabularyDiagnostics = await lsp.diagnostics("file:///workspace/definitions.feature", definitions);
    assert.deepEqual(
      vocabularyDiagnostics.map(({ line, code, rule, field, message }) => ({ line, code, rule, field, message })),
      expected(compiledDefinitions.error?.data),
    );
    assert.ok(vocabularyDiagnostics.every(({ source }) => source === "trust-vocabulary"));
    const grammarDiagnostics = await lsp.diagnostics("file:///workspace/grammar.feature", grammar);
    assert.deepEqual(
      grammarDiagnostics.map(({ line, code, message }) => ({ line, code, message })),
      [
        {
          line: compiledGrammar.error?.data?.location?.line,
          code: compiledGrammar.error?.data?.reason,
          message: compiledGrammar.error?.data?.message,
        },
      ],
    );
    const accepted = await lsp.diagnostics("file:///workspace/accepted.feature", DELIVERY_TERMS);
    assert.deepEqual(accepted, []);
  } finally {
    await lsp.close();
  }
});

interface ProseFields {
  readonly name: string;
  readonly tag?: string;
  readonly authorized: string;
  readonly forbidden: string;
  readonly roleName: string;
  readonly checkName: string;
  readonly successReason: string;
  /** JavaScript expression passed to `fail(...)`. */
  readonly failure: string;
}

/** A tagged Procedure. Lines: 2 tags, 8 scope row, 9 role, 13 Check and success reason, 15 failure reason. */
function procedure(fields: Partial<ProseFields>): string {
  const value: ProseFields = {
    name: "language-vocabulary",
    authorized: "Run the declared Operation.",
    forbidden: "Change the Operation definition.",
    roleName: "request",
    checkName: "confirm run",
    successReason: "the Operation completed",
    failure: '"the Operation did not complete"',
    ...fields,
  };
  const tag = value.tag === undefined ? "@controlled-language" : `@controlled-language:${value.tag}`;
  return `# language: en
@trust-dsl:1 @procedure:${value.name} @version:1.0.0 ${tag}
Feature: Control the prose words of a Procedure

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | ${value.authorized} | ${value.forbidden} |
    And one string "${value.roleName}" fixed as "run"

  @scenario:execute
  Scenario: Execute the Operation
    Then Check "${value.checkName}" runs Operation "test.language-check@*" on "${value.roleName}" as Input "request" and must establish "${value.successReason}"
      """js
      fact.completed === "yes" || fail(${value.failure})
      """
`;
}

/** Lines: 2 tags, 6 Terms, 7 header, 8 first term, then one line per term, the Rejected words step, its header and rows. */
function vocabulary(
  options: {
    readonly name?: string;
    readonly version?: string;
    readonly terms?: readonly TermRow[];
    readonly rejected?: readonly RejectedRow[];
  } = {},
): string {
  const terms = options.terms ?? DEFAULT_TERMS;
  const rejected = options.rejected ?? DEFAULT_REJECTED;
  const termWidth = Math.max(4, ...terms.map(([term]) => term.length));
  const rows = [
    `      | ${"term".padEnd(termWidth)} | kind | definition |`,
    ...terms.map(([term, kind, definition]) => `      | ${term.padEnd(termWidth)} | ${kind} | ${definition} |`),
  ];
  const rejectedRows =
    rejected.length === 0
      ? []
      : [
          "    And Rejected words",
          "      | word | use |",
          ...rejected.map(([word, use]) => `      | ${word} | ${use} |`),
        ];
  return [
    "# language: en",
    `@trust-dsl:1 @vocabulary:${options.name ?? "delivery-terms"} @version:${options.version ?? "1.0.0"}`,
    "Feature: Delivery terms",
    "",
    "  Background: Vocabulary",
    "    Given Terms",
    ...rows,
    ...rejectedRows,
    "",
  ].join("\n");
}

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
}

function summary(diagnostics: readonly LanguageDiagnostic[]): readonly string[] {
  return diagnostics.map(({ location, field, rule }) => `${location.line} ${field} ${rule}`);
}

async function rejectedDiagnostics(source: string): Promise<readonly LanguageDiagnostic[]> {
  const envelope = await rpc("procedure.compile", { source, sourceName: "language.feature" });
  assert.equal(envelope.result, undefined, "the tagged Procedure must be rejected");
  assert.equal(envelope.error?.data?.reason, "controlled-language", JSON.stringify(envelope.error));
  const diagnostics = envelope.error?.data?.diagnostics ?? [];
  assert.equal(envelope.error?.data?.location?.line, diagnostics[0]?.location.line);
  return diagnostics;
}

async function readVocabulary(name: string, version: string): Promise<PublishedVocabularyResult> {
  const read = await rpc("vocabulary.read", { vocabulary: name, version });
  assert.equal(read.error, undefined, JSON.stringify(read.error));
  return read.result as unknown as PublishedVocabularyResult;
}

/** Pin of the base vocabulary that the runtime published at start, included in every lexical control. */
async function basePin(): Promise<{ vocabulary: string; version: string; digest: string }> {
  const base = (await readVocabulary("trust-base", "1.0.0")).vocabulary;
  return { vocabulary: base.vocabulary, version: base.version, digest: base.definitionDigest };
}

async function engage(plan: string): Promise<string> {
  const engaged = await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "pinned-language",
    procedureVersion: "1.0.0",
    plan,
    environment: "local",
    rootInputs: {},
  });
  assert.equal(engaged.error, undefined, JSON.stringify(engaged.error));
  const digests = await planDigests(plan);
  assert.equal(digests.length, 1);
  return digests[0] ?? "";
}

async function planDigests(plan: string): Promise<readonly string[]> {
  const read = await rpc("plan.read", { plan });
  assert.equal(read.error, undefined, JSON.stringify(read.error));
  return ((read.result?.revisions ?? []) as { definitionDigest: string }[]).map(
    ({ definitionDigest }) => definitionDigest,
  );
}

async function rpc(method: string, params: Readonly<Record<string, unknown>>): Promise<RpcEnvelope> {
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  return (await response.json()) as RpcEnvelope;
}

async function mcpRequest(
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<{ result?: unknown; error?: unknown }> {
  const response = await fetch(`${runtime.endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { result?: unknown; error?: unknown };
}

async function mcp(name: string, args: Readonly<Record<string, unknown>>): Promise<{ text: string; isError: boolean }> {
  const envelope = (await mcpRequest("tools/call", { name, arguments: args })) as {
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    error?: unknown;
  };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return { text: text ?? "", isError: envelope.result?.isError === true };
}

interface ObservedDiagnostic {
  readonly line: number;
  readonly code: string;
  readonly source: string;
  readonly message: string;
  readonly rule?: string;
  readonly field?: string;
}

/** A minimal LSP client over the runtime's public `/lsp` WebSocket. */
class LanguageClient {
  #nextId = 1;
  #version = 1;
  readonly #socket: WebSocket;
  readonly #responses = new Map<number, (value: unknown) => void>();
  readonly #diagnostics = new Map<string, (value: { version?: number; diagnostics: unknown[] }) => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        params?: { uri: string; version?: number; diagnostics: unknown[] };
      };
      if (typeof message.id === "number" && message.method === undefined) {
        this.#responses.get(message.id)?.(message.result);
        this.#responses.delete(message.id);
      }
      if (message.method === "textDocument/publishDiagnostics" && message.params)
        this.#diagnostics.get(message.params.uri)?.(message.params);
    });
  }

  static async connect(endpoint: string): Promise<LanguageClient> {
    const socket = new WebSocket(`${endpoint.replace("http://", "ws://")}/lsp`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("LSP WebSocket failed to open")), { once: true });
    });
    const client = new LanguageClient(socket);
    await client.#request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.#send({ jsonrpc: "2.0", method: "initialized", params: {} });
    return client;
  }

  async diagnostics(uri: string, text: string): Promise<readonly ObservedDiagnostic[]> {
    const version = this.#version++;
    const published = new Promise<{ diagnostics: unknown[] }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No diagnostics for ${uri}`)), LSP_TIMEOUT_MS);
      this.#diagnostics.set(uri, (value) => {
        if (value.version !== undefined && value.version !== version) return;
        clearTimeout(timeout);
        this.#diagnostics.delete(uri);
        resolve(value);
      });
    });
    this.#send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "trust-procedure", version, text } },
    });
    const { diagnostics } = await published;
    return (
      diagnostics as {
        range: { start: { line: number } };
        code: string;
        source: string;
        message: string;
        data?: { rule?: string; field?: string };
      }[]
    ).map(({ range, code, source, message, data }) => ({
      line: range.start.line + 1,
      code,
      source,
      message,
      ...(data?.rule === undefined ? {} : { rule: data.rule }),
      ...(data?.field === undefined ? {} : { field: data.field }),
    }));
  }

  async close(): Promise<void> {
    await this.#request("shutdown", null);
    const closed = new Promise<void>((resolve) => this.#socket.addEventListener("close", () => resolve()));
    this.#send({ jsonrpc: "2.0", method: "exit", params: null });
    await closed;
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`LSP ${method} timed out`)), LSP_TIMEOUT_MS);
      this.#responses.set(id, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  #send(message: unknown): void {
    this.#socket.send(JSON.stringify(message));
  }
}

/** An isolated runtime with a disposable PGlite store, a private copy of the fixture Operation and one Environment. */
async function startRuntime(): Promise<Runtime> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "trust-controlled-vocabulary-"));
  const operationsDirectory = path.join(dataDirectory, "operations");
  const workspaceRoot = path.join(dataDirectory, "workspace");
  await cp(path.join(fixtures, "operations"), operationsDirectory, { recursive: true });
  await mkdir(workspaceRoot);
  const started = await startPublicRuntime("trust-controlled-vocabulary-", {
    operationsDirectory,
    environments: { local: { workspaceRoot } },
  });
  return {
    endpoint: started.endpoint,
    close: async () => {
      await started.close();
      await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
