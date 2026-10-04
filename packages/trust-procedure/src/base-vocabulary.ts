/** Identity of the base vocabulary of TRUST, always included in a lexical control. */
export const BASE_VOCABULARY = "trust-base";

/** Source of the base vocabulary of TRUST: one definition for each TRUST concept. */
export const baseVocabularySource = `# language: en
@trust-dsl:1 @vocabulary:trust-base @version:1.0.0
Feature: Base vocabulary of TRUST
  The concepts of TRUST, each with one definition. Every lexical control includes this vocabulary.

  Background: Vocabulary
    Given Terms
      | term                    | kind | definition                                                                                                                                                 |
      | agent                   | noun | An AI system that receives an objective, reasons about the work and chooses actions, and whose own account of the result is not proof.                     |
      | tool                    | noun | A means for an agent to interact with something outside its model, such as a file, command, application or remote service.                                 |
      | operator                | noun | The person who engages and follows a Plan, controls its Environment and decides whether an escalated Plan may resume.                                      |
      | Operation               | noun | One predefined action on an external system that specifies its Inputs, ordered steps and Produced fields, and never decides whether a Check passes.        |
      | Check                   | noun | One question the work must answer, naming an Operation, the object concerned and the rule that decides whether the expected result is established.         |
      | Scenario                | noun | A group of Checks that is satisfied when every Check is validated and that can require other Scenarios first.                                              |
      | Procedure               | noun | The human-authored definition of what must be established, in what order and within which limits.                                                          |
      | Plan                    | noun | One concrete use of a Procedure that records the inputs, the current state of every Check and the history of the work.                                     |
      | Session                 | noun | The open work on a Plan, whose closing keeps the Plan and its history.                                                                                     |
      | Attempt                 | noun | One authorized execution of the Operation of a Check, by the agent on a live Plan or from operator observations on a dry-run.                              |
      | Fact                    | noun | The accepted value of one Produced field of an Operation.                                                                                                  |
      | Fact batch              | noun | The complete set of Facts of one Attempt, which TRUST accepts or rejects as a whole.                                                                       |
      | verdict                 | noun | The result of qualification: the Check is validated or not, with a reason the agent can act on.                                                            |
      | qualification           | noun | The evaluation of the typed guards of a Check against accepted Facts to compute its verdict and reason, performed only by TRUST.                           |
      | cascade                 | noun | The recomputation of a Check after new Facts, which reopens every Check that depends on it through Scenario prerequisites and field references.            |
      | Environment             | noun | The named place and access context in which an action runs, which can provide directories, URLs, ordinary values and credential references.                |
      | credential              | noun | A secret that the runtime stores write-only, that an Environment references and that is never displayed nor injected during a dry-run.                     |
      | Runner                  | noun | The component that performs one predefined action for the exact Check and Operation from TRUST and reports what it observed without deciding success.      |
      | skill                   | noun | The integration an agent installs to work with TRUST, with the instructions for following Plans and the Runner that executes Checks.                       |
      | delegation              | noun | The entrusting of one piece of work to a child Plan.                                                                                                       |
      | dry-run                 | noun | A Plan rehearsed by the operator with the same Checks and rules, Facts entered by hand and no Environment value given to a Runner.                         |
      | Snapshot                | noun | The immutable record of one qualification, with its accepted Facts, verdict, reason and the checklist delta it caused.                                     |
      | revision                | noun | The state of a Plan after one accepted Fact batch, so that every acceptance produces a new revision.                                                       |
      | intent                  | noun | The short statement of the agent about the work it plans to do next, which never counts as proof or influences qualification.                              |
      | escalation              | noun | A recorded stop when the agent cannot continue within its authority, which leaves the Check open and returns the decision to an operator.                  |
      | OTLP                    | noun | The OpenTelemetry protocol through which the Runner reports the Facts of a live Plan as trace spans.                                                       |
      | MCP                     | noun | The Model Context Protocol through which an agent reads Plans and Checks, calling the same runtime functions as RPC.                                       |
      | JSONata                 | noun | The expression language of the Produce step, with one closed expression that turns Input, Environment and step results into the Produced fields.           |
      | grant                   | noun | A right that TRUST gives to an extension.                                                                                                                  |
      | scope                   | noun | The authorized and forbidden limits that apply to a Check.                                                                                                 |
      | role                    | noun | A typed value of a Plan, supplied as a root input, fixed in the Procedure, produced by a Check or declared by the agent.                                   |
      | Invocation              | noun | A Scenario item that engages a published child Procedure as a child Plan with fixed Inputs.                                                                |
      | mission                 | noun | One entry of a mission collection, with its identifier, root inputs and Procedure definition.                                                              |
      | mission collection      | noun | A named list in a Procedure that an agent fills with missions after engagement.                                                                            |
      | guard                   | noun | One condition of a Check qualification, written as a boolean expression that otherwise fails with a stated reason.                                         |
      | success reason          | noun | The statement that a validated Check establishes, written after must establish in the Procedure.                                                           |
      | Result                  | noun | A role of a child Procedure marked returned, which the parent Invocation maps to one of its own roles.                                                     |
      | Input                   | noun | One typed value that an Operation needs, bound by a Check from a role of the Plan.                                                                         |
      | Produced field          | noun | A typed field that an Operation promises to return after it runs.                                                                                          |
      | step                    | noun | One ordered action in the technical definition of an Operation.                                                                                            |
      | Product Action Contract | noun | The reusable product capability that owns the shape and meaning of the Facts expected from it.                                                             |
      | engagement              | noun | The creation of a Plan from an exact Procedure version, an identifier, an Environment and its root inputs.                                                 |
      | admission               | noun | The authorization of one Attempt after TRUST checks the Check, its Session, its dependencies, the Operation contract and the Environment.                  |
      | declaration             | noun | A value that the agent supplies after engagement for a role that the Procedure leaves to the agent.                                                        |
      | dependency              | noun | A Scenario or Check that must be validated before another Check can be admitted.                                                                           |
      | catalog                 | noun | The set of published and immutable versions of Operations, Procedures and vocabularies that a runtime holds.                                               |
      | vocabulary              | noun | A catalog object that declares terms, their kind, their definition and rejected words.                                                                     |
      | term                    | noun | A word or phrase that a vocabulary declares with its kind and one definition.                                                                              |
      | root input              | noun | A business value given at engagement that stays fixed for the life of the Plan.                                                                            |
      | child Plan              | noun | The Plan that TRUST creates for one mission or one Invocation.                                                                                             |
      | Feature                 | noun | The Gherkin block that defines one Operation, Procedure or vocabulary, whose tags carry its identity and whose description is free text that never runs.   |
      | Background              | noun | The one block of a Feature that declares the interface of an Operation or the scope and roles of a Procedure.                                              |
      | Produce                 | noun | The last step of every Operation, whose one closed JSONata expression turns Input, Environment and step results into exactly the declared Produced fields. |
      | Shell step              | noun | A step that runs one executable with structured arguments in an Environment directory and decides which exit codes are observations.                       |
      | HTTP step               | noun | A step that sends one registered HTTP method to an Environment URL and reads the response as JSON, Text or no body.                                        |
      | File step               | noun | A step that reads one file at a fixed relative path below an Environment directory, as Text or as JSON.                                                    |
      | cardinality             | noun | Whether an Input, a Produced field or a role holds one value of its type or a collection of that type.                                                     |
      | prerequisite            | noun | A Scenario that must be validated before the Checks and Invocations of another Scenario become actionable.                                                 |
      | engage                  | verb | Create a Plan from an exact Procedure version with its root inputs.                                                                                        |
      | admit                   | verb | Authorize one Attempt of a Check after its dependencies, Session, Operation contract and Environment are valid.                                            |
      | qualify                 | verb | Evaluate the guards of a Check against accepted Facts to compute its verdict.                                                                              |
      | escalate                | verb | Stop the work on a Plan and return the decision to an operator.                                                                                            |
      | resume                  | verb | Let an escalated Plan continue after an operator decision.                                                                                                 |
      | publish                 | verb | Add an immutable version of an Operation, a Procedure or a vocabulary to the catalog.                                                                      |
      | declare                 | verb | Supply the value of a role or a mission that the Procedure leaves to the agent.                                                                            |
      | materialize             | verb | Fill a role of the Plan from a Produced field of a Check or from a Result of an Invocation.                                                                |
      | delegate                | verb | Entrust one piece of work to a child Plan.                                                                                                                 |
    And Rejected words
      | word           | use        |
      | intention      | intent     |
      | Produced value | Fact       |
      | action scope   | scope      |
      | perimeter      | scope      |
      | Plan input     | root input |
      | delegated Plan | child Plan |
`;
