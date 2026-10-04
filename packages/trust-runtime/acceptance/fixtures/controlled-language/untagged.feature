# language: en
@trust-dsl:1 @procedure:language-untagged @version:1.0.0
Feature: Keep the compiled definition of a Procedure without the controlled language tag
  This description stays free text; it may contain a semicolon and long sentences without any language diagnostic.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Run the declared Operation; observe its result. | Change the Operation definition. |
      | confirm the requested run now | Observe the completion of the requested run and compare the produced value with the expected value before you report any result. | Manufacture a result, edit the produced value, skip the comparison or report a completion that the Operation did not observe in this Plan run. |
    And one string "requested run value here" fixed as "run"

  @scenario:execute
  Scenario: Execute the Operation
    Then Check "confirm the requested run now" runs Operation "test.language-check@*" on "requested run value here" as Input "request" and must establish "the Operation completed. The result is recorded"
      """js
      fact.completed === "yes" || fail("the Operation did not complete; retry the run")
      """
