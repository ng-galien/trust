# language: en
@trust-dsl:1 @procedure:correlated-plan @version:1.0.0
Feature: Keep one revision for each declared project

  Background: Plan context
    Given many reference "project" declared by agent
    And many reference "baseline revision" for each "project"

  @scenario:baselines
  Scenario: Read every project baseline
    Then Check "baseline" runs Operation "git.head-read" on each "project" as Input "project" and materializes "baseline revision" from field "headRevision" and must establish "every baseline is read"
      """js
      fact.workingTree === "clean" ||
      fail("a project has local changes")
      """

  @scenario:comparisons
  Scenario: Compare every project with its own baseline
    Given scenario "baselines" is validated
    Then Check "comparison" runs Operation "git.head-compare" on each "project" as Input "project" using "baseline revision" as Input "baseRevision" and must establish "every project uses its own baseline"
      """js
      fact.comparedBaseRevision === context["baseline revision"] ||
      fail("a project uses another baseline")
      """
