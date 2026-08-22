# language: en
@trust-dsl:1 @procedure:intent-declaration @version:1.0.0 @intent-chaining
Feature: Complete an intent chain when declarations remove the remaining work

  Background: Plan context
    Given many reference "project" declared by agent

  @scenario:inspection
  Scenario: Inspect every declared project
    Then Check "inspection" runs Operation "git.head-read" on each "project" as Input "project" and must establish "the project is clean"
      """js
      fact.workingTree === "clean" ||
      fail("the project has local changes")
      """
