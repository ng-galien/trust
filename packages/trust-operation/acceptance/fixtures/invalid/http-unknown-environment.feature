# language: en
@trust-dsl:1 @operation:http.invalid @version:1.0.0
Feature: Unknown HTTP Environment

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "response" gets Environment "otherUrl" as JSON
    Then Produce with JSONata
      """
      { "status": steps.response.status }
      """
