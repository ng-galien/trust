# language: en
# Draft date: 2026-09-23
@trust-dsl:1 @procedure:catalog-metadata-delivery @version:0.1.0 @intent-chaining
Feature: Deliver the catalog metadata change

  This inline mission governs one bounded implementation or review assignment for the dated
  catalog request. The coordinator supplies the exact requested deliverable as root Inputs,
  including the affected surfaces, invariants and public verification. The assigned agent
  reports the work and any unresolved product choices. A completed response is not product
  approval or an inferred Check verdict for code outside this mission.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Implement or review the bounded catalog assignment in the coordinator's instructions; preserve published executable methods and engaged Plans; verify changed behavior through public boundaries; report code, evidence and remaining choices. | Invent a classification taxonomy, summary mandate or semantic ranking; reset the retained database; publish resources or engage Plans as a demonstration; claim product approval without evidence. |
    And one string "mission"
    And one string "assignee"
    And one string "project"
    And one string "instructions"
    And one string "expected"
    And one string "authorized"
    And one string "forbidden"
    And one string "response" declared by agent
    And one string "outcome" declared by agent

  @scenario:creation
  Scenario: Persist the bounded request
    Then Check "create mission" runs Operation "coordination.mission-create@1.0.0"
      on "mission" as Input "mission"
      using plan as Input "plan"
      using "assignee" as Input "assignee"
      using "project" as Input "project"
      using "instructions" as Input "instructions"
      using "expected" as Input "expected"
      using "authorized" as Input "authorized"
      using "forbidden" as Input "forbidden"
      and must establish "the bounded request is stored"
      """js
      fact.mission === context.mission && fact.assignee === context.assignee ||
      fail("the database did not return the assigned mission")
      """

  @scenario:claim
  Scenario: Assign responsibility for the change
    Given scenario "creation" is validated
    Then Check "claim mission" runs Operation "coordination.mission-claim@1.0.0"
      on "mission" as Input "mission"
      using "assignee" as Input "actor"
      and must establish "the assigned agent owns the mission"
      """js
      fact.owner === context.assignee && fact.state === "claimed" ||
      fail("the assigned agent has not claimed the mission")
      """

  @scenario:response
  Scenario: Persist the reviewable response
    Given scenario "claim" is validated
    Then Check "submit response" runs Operation "coordination.mission-submit@1.0.0"
      on "mission" as Input "mission"
      using "assignee" as Input "actor"
      using "response" as Input "response"
      using "outcome" as Input "outcome"
      and must establish "the assigned agent's response is stored"
      """js
      fact.owner === context.assignee && fact.response === context.response ||
      fail("the database did not persist the assigned response")
      """

  @scenario:completion
  Scenario: Observe the declared outcome
    Given scenario "response" is validated
    Then Check "observe completion" runs Operation "coordination.mission-read@1.0.0"
      on "mission" as Input "mission"
      and must establish "the assigned agent returned a completed response"
      """js
      fact.owner === context.assignee && fact.state === "completed" ||
      fail("the agent reported a blocker; escalate instead of declaring completion")
      """
