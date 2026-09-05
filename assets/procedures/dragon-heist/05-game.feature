# language: en
@trust-dsl:1 @procedure:dragon-heist-game @version:1.0.0 @intent-chaining
Feature: Dragon Heist game

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Execute only the declared Dragon Heist move through the game extension and inspect its recorded result. | Fabricate Facts, reroll a recorded move, alter game storage, or bypass an active escalation. |
    And one reference "game"

  @scenario:scout
  Scenario: Scout the dragon's lair
    Then Check "scout the lair" runs Operation "dragon-heist.scout@*" on "game" as Input "game" using plan as Input "plan" and must establish "scout the lair is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" ||
      fail("The scout move is not ready; inspect its accepted game state before retrying or escalating")
      """
  @scenario:heist
  Scenario: Execute the heist
    Given scenario "scout" is validated
    Then Invocation "execute the heist" runs Procedure "dragon-heist-heist@1.0.0" on "game" as Input "game" and must establish "execute the heist is complete"
  @scenario:distraction
  Scenario: Keep the dragon occupied
    Given scenario "scout" is validated
    Then Invocation "distract the dragon" runs Procedure "dragon-heist-distraction@1.0.0" on "game" as Input "game" and must establish "distract the dragon is complete"
  @scenario:score
  Scenario: Count the recovered treasure
    Given scenario "heist" is validated
    And scenario "distraction" is validated
    Then Check "score the heist" runs Operation "dragon-heist.score@*" on "game" as Input "game" using plan as Input "plan" and must establish "score the heist is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" && fact.completed === "true" ||
      fail("The score move is not ready; inspect its accepted game state before retrying or escalating")
      """
