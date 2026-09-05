# language: en
@trust-dsl:1 @operation:dragon-heist.escape @version:1.0.0
Feature: Record the Dragon Heist escape move

  Background: Operation interface
    Given Environment
      | name | type |
      | gameUrl | url |
      | gameToken | string |
    And Input
      | input | type | cardinality |
      | game | reference | one |
      | plan | reference | one |
    And Produced fields
      | field | type | cardinality | domain |
      | game | reference | one | any |
      | move | string | one | any |
      | plan | reference | one | any |
      | recorded | string | one | enum "true", "false" |
      | ready | string | one | enum "true", "false" |
      | die | number | one | any |
      | score | number | one | any |
      | alarm | string | one | enum "true", "false" |
      | tool | string | one | any |
      | tactic | string | one | any |
      | dragon | string | one | any |
      | chest | string | one | any |
      | completed | string | one | enum "true", "false" |

  Scenario: Run
    When HTTP "move" sends "POST" to Environment "gameUrl" with JSONata body and reads JSON
      """
      { "command": "game.move", "arguments": { "game": input.game, "move": "escape", "plan": input.plan, "choice": "", "token": environment.gameToken } }
      """
    Then Produce with JSONata
      """
      {
        "game": steps.move.body.game,
        "move": steps.move.body.move,
        "plan": steps.move.body.plan,
        "recorded": $string(steps.move.body.recorded),
        "ready": $string(steps.move.body.ready),
        "die": steps.move.body.die,
        "score": steps.move.body.score,
        "alarm": $string(steps.move.body.alarm),
        "tool": steps.move.body.tool,
        "tactic": steps.move.body.tactic,
        "dragon": steps.move.body.dragon,
        "chest": steps.move.body.chest,
        "completed": $string(steps.move.body.completed)
      }
      """
