# language: en
@trust-dsl:1 @procedure:dragon-heist-distraction @version:1.0.0 @intent-chaining
Feature: Dragon Heist distraction

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Execute only the declared Dragon Heist move through the game extension and inspect its recorded result. | Fabricate Facts, reroll a recorded move, alter game storage, or bypass an active escalation. |
    And one reference "game"
    And one string "distraction" declared by agent

  @scenario:dragon
  Scenario: Distract the dragon
    Then Check "distract the dragon" runs Operation "dragon-heist.distract@*" on "game" as Input "game" using plan as Input "plan" using "distraction" as Input "choice" and must establish "distract the dragon is recorded and ready"
      """js
      fact.recorded === "true" && fact.ready === "true" ||
      fail("The distract move is not ready; inspect its accepted game state before retrying or escalating")
      """
