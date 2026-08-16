# language: en
@trust-dsl:1 @operation:file.package-read @version:1.0.0
Feature: Windows absolute File path

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Produced fields
      | field | type   | cardinality | domain |
      | name  | string | one         | any    |

  Scenario: Run
    When File "manifest" reads "C:/Windows/system.ini" as Text from Environment "workspaceRoot"
    Then Produce with JSONata
      """
      { "name": steps.manifest.content }
      """
