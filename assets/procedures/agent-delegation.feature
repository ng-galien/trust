# language: en
@trust-dsl:1 @procedure:agent-delegation @version:1.0.0 @intent-chaining
Feature: Delegate a bounded mission and observe the agent response
  The host launches the agent. PostgreSQL owns the mission transitions.
  Completion here means a persisted completed response, not independent approval of its contents.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Execute the mission Operations and perform the work within the persisted authorized scope. | Expand the mission scope, change its request, impersonate another agent, or bypass the runner to write coordination state. |
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
  Scenario: Persist the mission before dispatch
    Then Check "create mission" runs Operation "coordination.mission-create@*"
      on "mission" as Input "mission"
      using plan as Input "plan"
      using "assignee" as Input "assignee"
      using "project" as Input "project"
      using "instructions" as Input "instructions"
      using "expected" as Input "expected"
      using "authorized" as Input "authorized"
      using "forbidden" as Input "forbidden"
      and must establish "the exact mission is stored"
      """js
      fact.mission === context.mission && fact.assignee === context.assignee ||
      fail("the database did not return the assigned mission")
      """

  @scenario:claim
  Scenario: Take responsibility for the mission
    Given scenario "creation" is validated
    Then Check "claim mission" runs Operation "coordination.mission-claim@*"
      on "mission" as Input "mission"
      using "assignee" as Input "actor"
      and must establish "the assigned agent owns the mission"
      """js
      fact.owner === context.assignee && fact.state === "claimed" ||
      fail("the assigned agent has not claimed the mission")
      """

  @scenario:response
  Scenario: Persist the agent response
    Given scenario "claim" is validated
    Then Check "submit response" runs Operation "coordination.mission-submit@*"
      on "mission" as Input "mission"
      using "assignee" as Input "actor"
      using "response" as Input "response"
      using "outcome" as Input "outcome"
      and must establish "the owner response is stored"
      """js
      fact.owner === context.assignee && fact.response === context.response ||
      fail("the database did not persist the owner response")
      """

  @scenario:completion
  Scenario: Observe the declared completion
    Given scenario "response" is validated
    Then Check "observe completion" runs Operation "coordination.mission-read@*"
      on "mission" as Input "mission"
      and must establish "the assigned agent returned a completed response"
      """js
      fact.owner === context.assignee && fact.state === "completed" ||
      fail("the agent reported a blocker; escalate instead of declaring completion")
      """
