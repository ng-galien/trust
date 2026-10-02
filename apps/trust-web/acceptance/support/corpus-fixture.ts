// Shared by the Corpus browser harness and its spec: ports, identities and the seeded thread and missions.
export const CORPUS_RUNTIME_PORT = 4405;
export const CORPUS_WEB_PORT = 4185;
/** The web host reaches the runtime through this proxy, which can make chosen reads fail on request. */
export const CORPUS_PROXY_PORT = 4406;
export const DIAGRAM_THREAD = "document-diagrams";
export const FRAMEWORK_PLAN = "document-diagrams-framework";

/** Missions by latest activity after seeding, most recent first; the harness runs their Checks in reverse order. */
export const MISSIONS = [
  { id: "mission-complete", verdict: "pass" },
  { id: "mission-running", verdict: "pass" },
  { id: "mission-refused", verdict: "refuse" },
  { id: "mission-relaunched", verdict: "refuse" },
  { id: "mission-escalated", verdict: "refuse" },
];

/** Three Checks whose Procedure order (claim, verify, review) differs from their alphabetical order. */
export const MISSION_PROCEDURE = `@trust-dsl:1 @procedure:corpus-ui-mission @version:0.1.0
Feature: Deliver one mission of a Corpus thread in three Checks
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the delegated thread. | Mutate it. |
    And one reference "thread"
    And one string "mission"
    And one string "verdict"
  @scenario:claim
  Scenario: Claim the work
    Then Check "claim work" runs Operation "corpus.requirements-check@0.1.0"
      on "thread" as Input "thread"
      and must establish "the mission reads its delegated thread"
      """js
      fact.thread === context["thread"] || fail("another thread was read")
      """
  @scenario:verification
  Scenario: Verify the work
    Given scenario "claim" is validated
    Then Check "verify work" runs Operation "corpus.requirements-check@0.1.0"
      on "thread" as Input "thread"
      and must establish "the verification accepts the delivered work"
      """js
      (fact.thread === context["thread"] || fail("another thread was read")) &&
      (context["verdict"] === "pass" || fail("the verification refuses the delivered work"))
      """
  @scenario:review
  Scenario: Review the work
    Given scenario "verification" is validated
    Then Check "review work" runs Operation "corpus.requirements-check@0.1.0"
      on "thread" as Input "thread"
      and must establish "the reviewer accepts the delivered work"
      """js
      fact.thread === context["thread"] || fail("another thread was read")
      """
`;

const wideChain = Array.from({ length: 16 }, (_, index) => `  S${index}[Stage ${index + 1} of the delivery]`).join(
  "\n",
);
const wideLinks = Array.from({ length: 15 }, (_, index) => `  S${index} --> S${index + 1}`).join("\n");

export const THREAD_BODY = `## Goal

Show the framework of a thread as diagrams.

\`\`\`mermaid
flowchart LR
  accTitle: Thread framework
  T[Thread]:::corpus --> P[Plan]:::trust
  P --> M[Mission]:::agent
\`\`\`

The delivery runs through many stages.

\`\`\`mermaid
flowchart LR
  accTitle: Delivery stages
${wideChain}
${wideLinks}
\`\`\`

A diagram with a syntax error keeps the document readable.

\`\`\`mermaid
flowchart LR
  A[Start] --> ((
\`\`\`

The document continues after the diagrams.

::::requirement{#CORPUS-UI-REQ-010 name=DOCUMENT_DIAGRAMS facets=interface}
A thread document shows its diagrams.

:::criterion{#AC1}
Every diagram is drawn with the host theme.
:::
::::
`;

/** Threads of the technical requirement registry: approved blocks, a shared one, a pending one and a conflict. */
export const REGISTRY_THREAD = "interface-registry";
export const CONFLICT_THREAD = "registry-conflict";
/** A thread delivered under framework 0.1.0, then reframed under a 0.4.0 framework Plan. */
export const REFRAMED_THREAD = "reframed-delivery";
export const REFRAMED_OLD_PLAN = "reframed-delivery-framework-0-1-0";
export const REFRAMED_PLAN = "reframed-delivery-framework";
export const INHERITED_MISSIONS = { complete: "inherited-complete", running: "inherited-running" };
export const CURRENT_MISSION = "reframed-current";

const requirement = (id: string, name: string, statement: string) =>
  `::::requirement{#${id} name=${name} facets=interface}\n${statement}\n\n:::criterion{#AC1}\n${statement}\n:::\n::::\n`;
export const technical = (procedure: string, nature: string, facets: string, statement: string) =>
  `::::technical{procedure=${procedure} nature=${nature} facets=${facets}}\n${statement}\n::::\n`;
export const WIREFRAME_BLOCK = technical(
  "ui-wireframe-first@1.0.0",
  "declarative",
  "interface",
  "Every interface change starts from a Maket wireframe.",
);
export const TRANSLATIONS_BLOCK = technical(
  "ui-translations@1.0.0",
  "declarative",
  "interface,documentation",
  "Visible texts live in the English and French catalogues.",
);
export const ROUTED_BLOCK = technical(
  "ui-routed-pages@1.0.0",
  "declarative",
  "interface",
  "Details and forms open as routed pages.",
);
export const CONFLICTING_BLOCK = technical(
  "ui-theme-tokens@1.0.0",
  "measurable",
  "interface",
  "Styles use the theme tokens only.",
);
export const REGISTRY_BODY = `## Goal

Keep the interface rules of the product in the registry.

${requirement("CORPUS-UI-REQ-020", "INTERFACE_RULES", "The interface rules are registered.")}
## Registry of the interface facet

${WIREFRAME_BLOCK}
${TRANSLATIONS_BLOCK}`;
export const CONFLICT_BODY = `## Goal

Declare the theme rule with another nature.

${requirement("CORPUS-UI-REQ-030", "THEME_RULE", "The theme rule is declared.")}
${CONFLICTING_BLOCK}`;
export const REFRAMED_BODY = `## Goal

Deliver the thread, then continue it under framework 0.4.0.

${requirement("CORPUS-UI-REQ-040", "REFRAMED_DELIVERY", "The delivered work is kept.")}`;
/** An addition of the reframed thread's current framework and the mission it founds. */
export const ADDITION = "reframed-addition";
export const ADDED_MISSION = "added-mission";
