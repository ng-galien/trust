# language: en
@trust-dsl:1 @procedure:food-batch-release @version:1.0.0
Feature: Release one food batch after traceability, laboratory and cold-chain checks

  Releases one food batch after traceability, laboratory results and cold-chain data have
  been confirmed by the simulated food-safety services.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Observe and perform only the declared food batch release activities. | Alter traceability, laboratory, cold-chain, or release evidence to manufacture conformity. |
    Given one reference "batch"

  @scenario:traceability
  Scenario: Confirm complete batch traceability
    Then Check "traceability" runs Operation "food.batch-read" on "batch" as Input "batch" and must establish "the batch traceability is complete"
      """js
      fact.traceabilityStatus === "complete" ||
      fail("the batch traceability is incomplete")
      """

  @scenario:laboratory
  Scenario: Accept the laboratory results
    Given scenario "traceability" is validated
    Then Check "laboratory" runs Operation "food.lab-read" on "batch" as Input "batch" and must establish "the batch laboratory results are accepted"
      """js
      fact.labStatus === "accepted" ||
      fail("the batch laboratory results are rejected")
      """

  @scenario:cold-chain
  Scenario: Confirm the cold chain
    Given scenario "laboratory" is validated
    Then Check "cold chain" runs Operation "food.cold-chain-read" on "batch" as Input "batch" and must establish "the batch cold chain was maintained"
      """js
      fact.coldChainStatus === "maintained" ||
      fail("the batch cold chain was interrupted")
      """

  @scenario:release
  Scenario: Release the food batch
    Given scenario "cold-chain" is validated
    Then Check "batch release" runs Operation "food.batch-release" on "batch" as Input "batch" and must establish "the food batch is released"
      """js
      fact.releaseStatus === "released" ||
      fail("the food batch was rejected")
      """
