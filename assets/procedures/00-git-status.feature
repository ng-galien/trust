# language: en
@trust-dsl:1 @procedure:git-status @version:2.0.0
Feature: Establish whether a Git repository has local changes

  Background: Plan context
    Given one reference "repository"

  @scenario:repository-status
  Scenario: Read the repository status
    Then Check "repository status" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the repository has local changes"
      | field       | relation | expectation   | failure reason                          |
      | workingTree | equals   | value "dirty" | "the repository has no local changes"   |
    And the Scenario is satisfied when every Check is validated
