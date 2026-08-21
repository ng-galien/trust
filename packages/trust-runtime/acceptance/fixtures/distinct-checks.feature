# language: en
@trust-dsl:1 @procedure:distinct-checks @version:1.0.0
Feature: Keep distinct Checks that use the same Operation and target

  Background: Plan context
    Given one reference "repository"

  @scenario:reads
  Scenario: Read the repository twice for two different reasons
    Then Check "working tree" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the working tree is clean"
      """js
      fact.workingTree === "clean" ||
      fail("the working tree is dirty")
      """
    And Check "head revision" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the head revision exists"
      """js
      fact.workingTree === "clean" ||
      fail("the repository is dirty")
      """
