# language: en
@trust-dsl:1 @procedure:stable-upstream-uri @version:1.0.0
Feature: Reopen a Check when an upstream Check keeps its URI but changes its context

  Background: Plan context
    Given one reference "workspace"
    And one reference "baseline revision" declared by agent for "workspace"

  @scenario:baseline
  Scenario: Compare the workspace with the declared baseline
    Then Check "baseline" runs Operation "git.head-compare" on "workspace" as Input "project" using "baseline revision" as Input "baseRevision" and must establish "the workspace is based on the declared revision"
      | field                | relation | expectation                 | failure reason                       |
      | comparedBaseRevision | equals   | context "baseline revision" | "the workspace uses another baseline" |
      | workingTree          | equals   | value "clean"               | "the workspace has local changes"     |
    And the Scenario is satisfied when every Check is validated

  @scenario:consumer
  Scenario: Confirm the resulting revision
    Given scenario "baseline" is validated
    Then Check "consumer" runs Operation "git.head-read" on "workspace" as Input "project" and must establish "the resulting revision is confirmed"
      | field        | relation | expectation                              | failure reason                    |
      | headRevision | equals   | field "headRevision" from Check "baseline" | "the resulting revision changed" |
    And the Scenario is satisfied when every Check is validated
