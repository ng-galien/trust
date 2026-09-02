# language: en
@trust-dsl:1 @procedure:git-status @version:2.0.0
Feature: Establish whether a Git repository has local changes

  Answers one question about a repository checked out below the workspace: does it carry
  local changes? A single Check reads the working tree; the Plan is satisfied only when it
  is dirty.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Read the declared repository state. | Modify the repository or its environment to obtain the expected state. |
      | repository status | Read Git metadata required to observe this Check. | Change repository files while observing repository status. |
    Given one reference "repository"

  @scenario:repository-status
  Scenario: Read the repository status
    Then Check "repository status" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the repository has local changes"
      """js
      fact.workingTree === "dirty" ||
      fail("the repository has no local changes")
      """
