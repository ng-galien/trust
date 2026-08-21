# language: en
@trust-dsl:1 @procedure:one-for-each-declaration @version:1.0.0
Feature: Declare one branch for each repository

  Background: Plan context
    Given many reference "repository"
    And one string "branch" declared by agent for each "repository"

  @scenario:statuses
  Scenario: Read every repository status
    Then Check "repository status" runs Operation "git.head-read" on each "repository" as Input "project" and must establish "every repository status is read"
      """js
      fact.workingTree === "clean" ||
      fail("a repository has local changes")
      """
