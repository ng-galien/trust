# language: en
@trust-dsl:1 @procedure:optional-agent-declarations @version:1.0.0
Feature: Create Checks only for agent declarations that are present

  Background: Plan context
    Given one reference "workspace"
    And one string "required note" declared by agent
    And one reference "optional project" declared optionally by agent
    And one reference "optional revision" for "optional project"
    And many reference "optional target" declared optionally by agent

  @scenario:workspace
  Scenario: Read the workspace
    Then Check "workspace head" runs Operation "git.head-read"
        on "workspace" as Input "project"
        and must establish "the workspace head is readable"
      """js
      fact.headRevision !== "" ||
      fail("the workspace head is unavailable")
      """

  @scenario:optional-project
  Scenario: Read the optional project
    Then Check "optional project head" runs Operation "git.head-read"
        on "optional project" as Input "project"
        and must establish "the optional project head is readable"
      """js
      fact.headRevision !== "" ||
      fail("the optional project head is unavailable")
      """

  @scenario:optional-materialization
  Scenario: Materialize a role only when its optional parent exists
    Then Check "optional materialization" runs Operation "git.head-read"
        on "workspace" as Input "project"
        and materializes "optional revision" from field "headRevision"
        and must establish "the optional revision is readable"
      """js
      fact.headRevision !== "" ||
      fail("the optional revision is unavailable")
      """

  @scenario:optional-targets
  Scenario: Read every optional target
    Then Check "optional target head" runs Operation "git.head-read"
        on each "optional target" as Input "project"
        and must establish "the optional target head is readable"
      """js
      fact.headRevision !== "" ||
      fail("the optional target head is unavailable")
      """

  @scenario:after-optional-targets
  Scenario: Continue when the optional target branch is absent or validated
    Given scenario "optional-targets" is validated
    Then Check "after optional targets" runs Operation "git.head-read"
        on "workspace" as Input "project"
        and must establish "the optional target branch no longer blocks the Plan"
      """js
      fact.headRevision !== "" ||
      fail("the workspace head is unavailable after the optional target branch")
      """

  @scenario:optional-qualification
  Scenario: Read context only when the optional declaration exists
    Then Check "optional qualification" runs Operation "git.head-read"
        on "workspace" as Input "project"
        and must establish "the optional project is available to the qualification"
      """js
      context["optional project"] !== "" ||
      fail("the optional project is unavailable")
      """

  @scenario:optional-check-observation
  Scenario: Read a Check observation only when its optional provider exists
    Given scenario "optional-project" is validated
    Then Check "optional observed head" runs Operation "git.head-read"
        on "workspace" as Input "project"
        and must establish "the optional project Check is available to the qualification"
      """js
      checks["optional project head"].headRevision !== "" ||
      fail("the optional project Check is unavailable")
      """

  @scenario:optional-transitive-observation
  Scenario: Read a Check observation only when its transitive optional provider exists
    Given scenario "optional-check-observation" is validated
    Then Check "optional transitive head" runs Operation "git.head-read"
        on "workspace" as Input "project"
        and must establish "the transitive optional Check is available to the qualification"
      """js
      checks["optional observed head"].headRevision !== "" ||
      fail("the transitive optional Check is unavailable")
      """

  @scenario:after-optional-check-observation
  Scenario: Continue when the transitively optional Check branch is absent or validated
    Given scenario "optional-check-observation" is validated
    Then Check "after optional check observation" runs Operation "git.head-read"
        on "workspace" as Input "project"
        and must establish "the optional Check branch no longer blocks the Plan"
      """js
      fact.headRevision !== "" ||
      fail("the workspace head is unavailable after the optional Check branch")
      """
