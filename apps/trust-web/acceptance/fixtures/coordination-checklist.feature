# language: en
@trust-dsl:1 @procedure:coordination-checklist @version:1.0.0 @intent-chaining
Feature: Qualify a four-Check dry-run independently of a submitted response

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Exercise public dry-run qualification for the board acceptance. | Treat operator observations as live external execution. |
    Given one reference "repository"

  @scenario:observations
  Scenario: Qualify the current checklist
    Then Check "first observation" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the first observation is qualified"
      """js
      fact.workingTree === "clean" || fail("The observation is not clean")
      """
    And Check "second observation" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the second observation is qualified"
      """js
      fact.workingTree === "clean" || fail("The observation is not clean")
      """
    And Check "third observation" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the third observation is qualified"
      """js
      fact.workingTree === "clean" || fail("The observation is not clean")
      """
    And Check "observe completion" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the final observation is qualified"
      """js
      fact.workingTree === "clean" || fail("The observation is not clean")
      """
