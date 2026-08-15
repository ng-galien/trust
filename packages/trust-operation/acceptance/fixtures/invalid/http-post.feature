# language: en
@trust-dsl:1 @operation:http.invalid @version:1.0.0
Feature: Unsupported HTTP method

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "response" posts Environment "serviceUrl" as JSON
    Then Produce with JSONata
      """
      { "status": steps.response.status }
      """
