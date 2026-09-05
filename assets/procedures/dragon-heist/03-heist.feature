# language: en
@trust-dsl:1 @procedure:dragon-heist-heist @version:1.0.0 @intent-chaining
Feature: Dragon Heist heist

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Execute only the declared Dragon Heist move through the game extension and inspect its recorded result. | Fabricate Facts, reroll a recorded move, alter game storage, or bypass an active escalation. |
    And one reference "game"
    And one string "tool" declared by agent

  @scenario:equip
  Scenario: Equip the heist
    Then Check "equip the thief" runs Operation "dragon-heist.equip@*" on "game" as Input "game" using plan as Input "plan" using "tool" as Input "choice" and must establish "equip the thief is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" ||
      fail("The equip move is not ready; inspect its accepted game state before retrying or escalating")
      """
  @scenario:vault
  Scenario: Delegate the vault
    Given scenario "equip" is validated
    Then Invocation "retrieve the hoard" runs Procedure "dragon-heist-vault@1.0.0" on "game" as Input "game" and must establish "retrieve the hoard is complete"
  @scenario:escape
  Scenario: Escape with the treasure
    Given scenario "vault" is validated
    Then Check "escape the vault" runs Operation "dragon-heist.escape@*" on "game" as Input "game" using plan as Input "plan" and must establish "escape the vault is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" ||
      fail("The escape move is not ready; inspect its accepted game state before retrying or escalating")
      """
