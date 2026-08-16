# language: en
@trust-dsl:1 @procedure:food-batch-release @version:1.0.0
Feature: Release one food batch after traceability, laboratory and cold-chain checks

  Releases one food batch after traceability, laboratory results and cold-chain data have
  been confirmed by the simulated food-safety services.

  Background: Plan context
    Given one reference "batch"

  @scenario:traceability
  Scenario: Confirm complete batch traceability
    Then Check "traceability" runs Operation "food.batch-read" on "batch" as Input "batch" and must establish "the batch traceability is complete"
      | field              | relation | expectation       | failure reason                         |
      | traceabilityStatus | equals   | value "complete"   | "the batch traceability is incomplete"  |
    And the Scenario is satisfied when every Check is validated

  @scenario:laboratory
  Scenario: Accept the laboratory results
    Given scenario "traceability" is validated
    Then Check "laboratory" runs Operation "food.lab-read" on "batch" as Input "batch" and must establish "the batch laboratory results are accepted"
      | field     | relation | expectation       | failure reason                     |
      | labStatus | equals   | value "accepted"   | "the batch laboratory results are rejected" |
    And the Scenario is satisfied when every Check is validated

  @scenario:cold-chain
  Scenario: Confirm the cold chain
    Given scenario "laboratory" is validated
    Then Check "cold chain" runs Operation "food.cold-chain-read" on "batch" as Input "batch" and must establish "the batch cold chain was maintained"
      | field           | relation | expectation         | failure reason                  |
      | coldChainStatus | equals   | value "maintained"   | "the batch cold chain was interrupted" |
    And the Scenario is satisfied when every Check is validated

  @scenario:release
  Scenario: Release the food batch
    Given scenario "cold-chain" is validated
    Then Check "batch release" runs Operation "food.batch-release" on "batch" as Input "batch" and must establish "the food batch is released"
      | field         | relation | expectation      | failure reason              |
      | releaseStatus | equals   | value "released"  | "the food batch was rejected" |
    And the Scenario is satisfied when every Check is validated
