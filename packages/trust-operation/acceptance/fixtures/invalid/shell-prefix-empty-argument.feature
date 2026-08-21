# language: en
@trust-dsl:1 @operation:shell.invalid @version:1.0.0
Feature: Invalid Shell argument source

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input | type      | cardinality |
      | issue | reference | one         |
      | tags  | string    | many        |
    And Produced fields
      | field    | type   | cardinality | domain |
      | argument | string | one         | any    |

  Scenario: Run
    When Shell "echo" runs "printf" with cwd from Environment "workspaceRoot"
      | argument        | source                  |
      | %s              | literal                 |
      |                 | literal + Input "issue" |
    Then Produce with JSONata
      """
      { "argument": steps.echo.stdout }
      """
