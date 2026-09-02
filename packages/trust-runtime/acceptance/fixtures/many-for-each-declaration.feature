# language: en
@trust-dsl:1 @procedure:many-for-each-declaration @version:1.0.0
Feature: Declare several runtime dependencies for each library

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Perform only the actions declared by this acceptance Procedure. | Alter the environment or accepted observations to make a Check pass. |
    Given many reference "library project"
    And many reference "runtime dependency project" declared by agent for each "library project"

  @scenario:libraries
  Scenario: Read every library project
    Then Check "library" runs Operation "git.head-read" on each "library project" as Input "project" and must establish "every library project is readable"
      """js
      fact.workingTree === "clean" ||
      fail("a library project has local changes")
      """

  @scenario:dependencies
  Scenario: Read every related runtime project
    Given scenario "libraries" is validated
    Then Check "runtime dependency" runs Operation "git.head-read" on each "runtime dependency project" as Input "project" and must establish "every related runtime project is readable"
      """js
      fact.workingTree === "clean" ||
      fail("a runtime dependency project has local changes")
      """
