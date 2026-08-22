# language: en
@trust-dsl:1 @procedure:intent-chaining @version:1.0.0 @intent-chaining
Feature: Carry one agent intent across independent Checks

  Background: Plan context
    Given one reference "repository"

  @scenario:observations
  Scenario: Read the repository for two independent purposes
    Then Check "working tree observation" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the working tree was observed"
      """js
      fact.workingTree === "clean" ||
      fail("the working tree is not clean")
      """
    And Check "revision observation" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the revision was observed"
      """js
      fact.workingTree === "clean" ||
      fail("the working tree is not clean")
      """
