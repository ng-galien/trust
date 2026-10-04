export const docs = {
  title: "Documentation",
  crumb: "Documentation",
  nav: {
    label: "Documentation contents",
    collapse: "Hide the contents",
    expand: "Show the contents",
    toc: "On this page",
    previous: "Previous",
    next: "Next",
    inThisSection: "In this section",
    home: "Introduction",
  },
  search: {
    label: "Search the documentation",
    placeholder: "Search the documentation…",
    noResult: "No page matches.",
    group: "Documentation",
  },
  page: {
    notFound: "No such documentation page.",
    backHome: "Back to the introduction",
    fallback: "This page is not translated yet; it is shown in English.",
    draft: "Draft — this page is being written; the structure is final, the content is not.",
    openScreen: "Open the screen",
  },
  details: {
    expert: "Expert",
    expertHint: "Detail shown by default in expert mode",
  },
  snippet: {
    copy: "Copy",
    copied: "Copied",
    openOperation: "Open the operation",
    openProcedure: "Open the procedure",
    fragment: "Fragment",
    lines: "{{count}} lines",
  },
  screenshot: {
    missing: "Screenshot “{{id}}” has not been captured yet (run `npm run docs:capture` in apps/trust-web).",
    legend: "Legend",
    callout: "Callout {{n}}",
    mode: "{{mode}} mode",
    operator: "operator",
    expert: "expert",
  },
  diagram: {
    loading: "Rendering the diagram…",
    error: "The diagram could not be rendered: {{error}}",
  },
  visual: {
    expand: "View full screen",
    diagram: "Expanded diagram",
    screenshot: "Expanded screenshot",
    figure: "Expanded figure",
  },
  callout: {
    note: "Note",
    tip: "Tip",
    warning: "Careful",
    rule: "Rule",
  },
  language: {
    roots: "Roots",
    operators: "Operators",
    functions: "Functions",
    math: "Math functions",
    collections: "Collection methods",
    strings: "String methods",
  },
  figures: {
    model: {
      alt: "The TRUST model: authored objects on top, what a running Plan produces below",
      design: "Definitions",
      run: "Execution",
      operation: "Operation",
      procedure: "Procedure",
      scenario: "Scenario",
      check: "Check",
      usedBy: "used by",
      engagedAs: "creates",
      plan: "Plan",
      attempt: "Attempt",
      facts: "Facts",
      verdict: "Qualification",
      revision: "Revision",
      cascade: "reopens",
    },
    architecture: {
      alt: "The agent and Runner share an agent system while TRUST remains the authority",
      agentSystem: "Agent system",
      agent: "Agent",
      skill: "Runner",
      runtime: "TRUST authority",
      interface: "Operator",
      external: "External systems",
      mcpRead: "reads",
      checkUri: "delegates",
      admission: "requests",
      facts: "observes",
      execute: "acts",
      rpc: "operates",
    },
  },
  glossary: {
    label: "Glossary",
    agent: {
      term: "Agent",
      definition:
        "An AI system that receives an objective, reasons about the work and chooses actions, and whose own account of the result is not proof.",
    },
    tool: {
      term: "Tool",
      definition:
        "A means for an agent to interact with something outside its model, such as a file, command, application or remote service.",
    },
    operator: {
      term: "Operator",
      definition:
        "The person who engages and follows a Plan, controls its Environment and decides whether an escalated Plan may resume.",
    },
    operation: {
      term: "Operation",
      definition:
        "One predefined action on an external system that specifies its Inputs, ordered steps and Produced fields, and never decides whether a Check passes.",
    },
    check: {
      term: "Check",
      definition:
        "One question the work must answer, naming an Operation, the object concerned and the rule that decides whether the expected result is established.",
    },
    scenario: {
      term: "Scenario",
      definition:
        "A group of Checks that is satisfied when every Check is validated and that can require other Scenarios first.",
    },
    procedure: {
      term: "Procedure",
      definition: "The human-authored definition of what must be established, in what order and within which limits.",
    },
    plan: {
      term: "Plan",
      definition:
        "One concrete use of a Procedure that records the inputs, the current state of every Check and the history of the work.",
    },
    session: {
      term: "Session",
      definition: "The open work on a Plan, whose closing keeps the Plan and its history.",
    },
    attempt: {
      term: "Attempt",
      definition:
        "One authorized execution of the Operation of a Check, by the agent on a live Plan or from operator observations on a dry-run.",
    },
    fact: {
      term: "Fact",
      definition: "The accepted value of one Produced field of an Operation.",
    },
    verdict: {
      term: "Verdict",
      definition: "The result of qualification: the Check is validated or not, with a reason the agent can act on.",
    },
    qualification: {
      term: "Qualification",
      definition:
        "The evaluation of the typed guards of a Check against accepted Facts to compute its verdict and reason, performed only by TRUST.",
    },
    cascade: {
      term: "Cascade",
      definition:
        "The recomputation of a Check after new Facts, which reopens every Check that depends on it through Scenario prerequisites and field references.",
    },
    environment: {
      term: "Environment",
      definition:
        "The named place and access context in which an action runs, which can provide directories, URLs, ordinary values and credential references.",
    },
    credential: {
      term: "Credential",
      definition:
        "A secret that the runtime stores write-only, that an Environment references and that is never displayed nor injected during a dry-run.",
    },
    runner: {
      term: "Runner",
      definition:
        "The component that performs one predefined action for the exact Check and Operation from TRUST and reports what it observed without deciding success.",
    },
    skill: {
      term: "Skill",
      definition:
        "The integration an agent installs to work with TRUST, with the instructions for following Plans and the Runner that executes Checks.",
    },
    delegation: {
      term: "Delegation",
      definition: "The entrusting of one piece of work to a child Plan.",
    },
    dryRun: {
      term: "Dry-run",
      definition:
        "A Plan rehearsed by the operator with the same Checks and rules, Facts entered by hand and no Environment value given to a Runner.",
    },
    snapshot: {
      term: "Snapshot",
      definition:
        "The immutable record of one qualification, with its accepted Facts, verdict, reason and the checklist delta it caused.",
    },
    revision: {
      term: "Revision",
      definition:
        "The state of a Plan after one accepted Fact batch, so that every acceptance produces a new revision.",
    },
    intent: {
      term: "Intent",
      definition:
        "The short statement of the agent about the work it plans to do next, which never counts as proof or influences qualification.",
    },
    escalation: {
      term: "Escalation",
      definition:
        "A recorded stop when the agent cannot continue within its authority, which leaves the Check open and returns the decision to an operator.",
    },
    otlp: {
      term: "OTLP",
      definition:
        "The OpenTelemetry protocol through which the Runner reports the Facts of a live Plan as trace spans.",
    },
    mcp: {
      term: "MCP",
      definition:
        "The Model Context Protocol through which an agent reads Plans and Checks, calling the same runtime functions as RPC.",
    },
    jsonata: {
      term: "JSONata",
      definition:
        "The expression language of the Produce step, with one closed expression that turns Input, Environment and step results into the Produced fields.",
    },
    grant: {
      term: "Grant",
      definition: "A right that TRUST gives to an extension.",
    },
    vocabulary: {
      term: "Vocabulary",
      definition: "A catalog object that declares terms, their kind, their definition and rejected words.",
    },
    term: {
      term: "Term",
      definition: "A word or phrase that a vocabulary declares with its kind and one definition.",
    },
  },
} as const;
