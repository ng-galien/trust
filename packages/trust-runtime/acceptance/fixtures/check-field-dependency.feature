# language: en
@trust-dsl:1 @procedure:check-field-dependency @version:1.0.0
Feature: Reopen a Check when its exact upstream Checks change

  Background: Plan context
    Given one reference "workspace"
    And many reference "project" declared by agent for "workspace"

  @scenario:baselines
  Scenario: Read every project baseline
    Then Check "baseline" runs Operation "git.head-read" on each "project" as Input "project" and must establish "every project baseline is clean"
      | field       | relation | expectation   | failure reason               |
      | workingTree | equals   | value "clean" | "a project baseline is dirty" |
    And the Scenario is satisfied when every Check is validated

  @scenario:workspace
  Scenario: Compare the workspace with its project baseline
    Given scenario "baselines" is validated
    Then Check "workspace" runs Operation "git.head-read" on "workspace" as Input "project" and must establish "the workspace matches its project baseline"
      | field        | relation | expectation                              | failure reason                         |
      | headRevision | equals   | field "headRevision" from Check "baseline" | "the workspace uses another revision" |
    And the Scenario is satisfied when every Check is validated
