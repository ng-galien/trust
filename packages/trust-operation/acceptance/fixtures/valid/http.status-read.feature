# language: en
@trust-dsl:1 @operation:http.status-read @version:1.0.0
Feature: Read service status

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Produced fields
      | field   | type   | cardinality | domain |
      | service | string | one         | any    |
      | status  | number | one         | any    |

  Scenario: Run
    When HTTP "response" sends "GET" to Environment "serviceUrl" and reads JSON
    Then Produce with JSONata
      """
      { "service": steps.response.body.service, "status": steps.response.status }
      """
