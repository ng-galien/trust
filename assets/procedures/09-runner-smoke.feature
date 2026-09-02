# language: en
@trust-dsl:1 @procedure:runner-smoke @version:1.0.0
Feature: Confirm the TRUST runner observes a controlled signal

  Provides one deterministic live Check without requiring a project or an external service.
  The operator controls the result by writing either "blocked" or "ready" to trust-smoke.json
  in the selected Environment workspace root.

  Background: Plan context
    Given Procedure scope
      | check        | authorized | forbidden |
      | all          | Read the controlled smoke signal from the selected Environment. | Modify the signal, Operation, runner, runtime, or Environment to manufacture a Check result. |
      | smoke signal | Read trust-smoke.json exactly as supplied by the operator. | Write, replace, or hide trust-smoke.json while executing the Check. |
    And one string "expected signal" fixed as "ready"

  @scenario:smoke-signal
  Scenario: Observe the controlled smoke signal
    Then Check "smoke signal" runs Operation "file.smoke-signal-read"
        on "expected signal" as Input "expectedSignal"
        and must establish "the smoke signal is ready"
      """js
      fact.signal === fact.expectedSignal ||
      fail(`the smoke signal is ${fact.signal}`)
      """
