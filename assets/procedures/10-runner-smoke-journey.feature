# language: en
@trust-dsl:1 @procedure:runner-smoke-journey @version:1.0.0
Feature: Complete a controlled runner journey with operator escalation

  Exercises three sequential Checks against one operator-controlled signal. The middle
  Check deliberately allows an escalation and requires the operator to resume the Plan.

  Background: Plan context
    Given Procedure scope
      | check           | authorized | forbidden |
      | all             | Read the controlled smoke signal from the selected Environment and report the observed value. | Modify the signal, Operation, runner, runtime, or Environment to manufacture a Check result. |
      | approval signal | Ask the operator to resolve an escalation and resume the Plan before observing the signal again. | Resume the Plan or turn a blocked signal into an approved signal on the operator's behalf. |
    And one string "initial expected signal" fixed as "ready"
    And one string "approval expected signal" fixed as "approved"
    And one string "completion expected signal" fixed as "complete"

  @scenario:initial-signal
  Scenario: Confirm the initial signal
    Then Check "initial signal" runs Operation "file.smoke-signal-read"
        on "initial expected signal" as Input "expectedSignal"
        and must establish "the initial smoke signal is ready"
      """js
      fact.signal === fact.expectedSignal ||
      fail(`the smoke signal is ${fact.signal}`)
      """

  @scenario:approval-signal
  Scenario: Confirm the operator-approved signal
    Given scenario "initial-signal" is validated
    Then Check "approval signal" runs Operation "file.smoke-signal-read"
        on "approval expected signal" as Input "expectedSignal"
        and must establish "the operator-approved smoke signal is available"
      """js
      fact.signal === fact.expectedSignal ||
      fail(`the smoke signal is ${fact.signal}`)
      """

  @scenario:completion-signal
  Scenario: Confirm the completion signal
    Given scenario "approval-signal" is validated
    Then Check "completion signal" runs Operation "file.smoke-signal-read"
        on "completion expected signal" as Input "expectedSignal"
        and must establish "the completion smoke signal is available"
      """js
      fact.signal === fact.expectedSignal ||
      fail(`the smoke signal is ${fact.signal}`)
      """
