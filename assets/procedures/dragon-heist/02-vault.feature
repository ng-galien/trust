# language: en
@trust-dsl:1 @procedure:dragon-heist-vault @version:1.0.0 @intent-chaining
Feature: Dragon Heist vault

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Execute only the declared Dragon Heist move through the game extension and inspect its recorded result. | Fabricate Facts, reroll a recorded move, alter game storage, or bypass an active escalation. |
    And one reference "game"

  @scenario:inspect
  Scenario: Inspect the vault
    Then Check "inspect the vault" runs Operation "dragon-heist.inspect-vault@*" on "game" as Input "game" using plan as Input "plan" and must establish "inspect the vault is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" ||
      fail("The inspect-vault move is not ready; inspect its accepted game state before retrying or escalating")
      """
  @scenario:lock
  Scenario: Delegate the lock
    Given scenario "inspect" is validated
    Then Invocation "unlock the vault" runs Procedure "dragon-heist-lock@1.0.0" on "game" as Input "game" and must establish "unlock the vault is complete"
  @scenario:open
  Scenario: Open the unlocked vault
    Given scenario "lock" is validated
    Then Check "open the vault" runs Operation "dragon-heist.open-vault@*" on "game" as Input "game" using plan as Input "plan" and must establish "open the vault is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" ||
      fail("The open-vault move is not ready; inspect its accepted game state before retrying or escalating")
      """
  @scenario:hoard
  Scenario: Secure the hoard
    Given scenario "open" is validated
    Then Check "take the hoard" runs Operation "dragon-heist.take-hoard@*" on "game" as Input "game" using plan as Input "plan" and must establish "take the hoard is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" ||
      fail("The take-hoard move is not ready; inspect its accepted game state before retrying or escalating")
      """
