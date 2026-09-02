# language: en
@trust-dsl:1 @procedure:check-field-dependency @version:1.0.0
Feature: Reopen a Check when its exact upstream Checks change

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Perform only the actions declared by this acceptance Procedure. | Alter the environment or accepted observations to make a Check pass. |
    Given one reference "workspace"
    And many reference "project" declared by agent for "workspace"

  @scenario:baselines
  Scenario: Read every project baseline
    Then Check "baseline" runs Operation "git.head-read" on each "project" as Input "project" and must establish "every project baseline is clean"
      """js
      fact.workingTree === "clean" ||
      fail("a project baseline is dirty")
      """

  @scenario:workspace
  Scenario: Compare the workspace with its project baseline
    Given scenario "baselines" is validated
    Then Check "workspace" runs Operation "git.head-read" on "workspace" as Input "project" and must establish "the workspace matches its project baseline"
      """js
      fact.headRevision === checks.baseline.headRevision ||
      fail("the workspace uses another revision")
      """
