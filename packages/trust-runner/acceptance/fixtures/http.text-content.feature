# language: en
@trust-dsl:1 @operation:http.text-content @version:1.0.0
Feature: Send encoded query data and multiline Text content

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Input
      | input   | type   | cardinality |
      | query   | string | one         |
      | payload | string | one         |
    And Produced fields
      | field  | type   | cardinality | domain |
      | result | string | one         | any    |

  Scenario: Run
    When HTTP "content" sends "PUT" to Environment "serviceUrl" with query "q" from Input "query" with Text body from Input "payload" and reads Text
    Then Produce with JSONata
      """
      { "result": steps.content.body }
      """
