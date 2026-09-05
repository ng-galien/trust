# language: en
@trust-dsl:1 @procedure:dragon-heist-lock @version:1.0.0 @intent-chaining
Feature: Dragon Heist lock

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Execute only the declared Dragon Heist move through the game extension and inspect its recorded result. | Fabricate Facts, reroll a recorded move, alter game storage, or bypass an active escalation. |
    And one reference "game"
    And one string "tactic" declared by agent

  @scenario:runes
  Scenario: Turn the alarmed runes
    Then Check "turn the runes" runs Operation "dragon-heist.turn-runes@*" on "game" as Input "game" using plan as Input "plan" using "tactic" as Input "choice" and must establish "turn the runes is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" && fact.alarm === "false" ||
      fail("The turn-runes move is not ready; inspect its accepted game state before retrying or escalating")
      """
  @scenario:lock
  Scenario: Open the prepared lock
    Given scenario "runes" is validated
    Then Check "open the lock" runs Operation "dragon-heist.open-lock@*" on "game" as Input "game" using plan as Input "plan" and must establish "open the lock is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" ||
      fail("The open-lock move is not ready; inspect its accepted game state before retrying or escalating")
      """
