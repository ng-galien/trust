# language: en
@trust-dsl:1 @procedure:one-for-each-declaration @version:1.0.0
Feature: Declare one branch for each repository

  Background: Plan context
    Given many reference "repository"
    And one string "branch" declared by agent for each "repository"

  @scenario:statuses
  Scenario: Read every repository status
    Then Check "repository status" runs Operation "git.head-read" on each "repository" as Input "project" and must establish "every repository status is read"
      | field       | relation | expectation   | failure reason                    |
      | workingTree | equals   | value "clean" | "a repository has local changes" |
    And the Scenario is satisfied when every Check is validated
