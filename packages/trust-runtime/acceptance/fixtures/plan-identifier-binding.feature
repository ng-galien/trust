# language: en
@trust-dsl:1 @procedure:plan-identifier-binding @version:1.0.0
Feature: Hand the Plan identifier to an Operation Input

  Background: Plan context
    Given one reference "project"

  @scenario:comparison
  Scenario: Compare the project with a revision named after the Plan
    Then Check "comparison" runs Operation "git.head-compare" on "project" as Input "project" using plan as Input "baseRevision" and must establish "the project is ahead of the Plan revision"
      | field        | relation | expectation | failure reason                          |
      | commitsAhead | at least | number 1    | "the project is not ahead of the Plan" |
    And the Scenario is satisfied when every Check is validated
