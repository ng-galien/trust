# language: en
@trust-dsl:1 @operation:file.license-read @version:1.0.0
Feature: Traverse Text File content

  Background: Operation interface
    Given Environment
      | name        | type      |
      | projectRoot | directory |
    And Produced fields
      | field | type   | cardinality | domain |
      | name  | string | one         | any    |

  Scenario: Run
    When File "license" reads "LICENSE" as Text from Environment "projectRoot"
    Then Produce with JSONata
      """
      { "name": steps.license.content.name }
      """
