# language: en
@trust-dsl:1 @operation:http.text-read @version:1.0.0
Feature: Read HTTP text

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Produced fields
      | field  | type   | cardinality | domain |
      | body   | string | one         | any    |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "response" gets Environment "serviceUrl" as Text
    Then Produce with JSONata
      """
      { "body": steps.response.body, "status": steps.response.status }
      """
