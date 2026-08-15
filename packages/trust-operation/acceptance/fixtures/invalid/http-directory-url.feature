# language: en
@trust-dsl:1 @operation:http.invalid @version:1.0.0
Feature: Invalid HTTP Environment type

  Background: Operation interface
    Given Environment
      | name       | type      |
      | serviceUrl | directory |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "response" gets Environment "serviceUrl" as JSON
    Then Produce with JSONata
      """
      { "status": steps.response.status }
      """
