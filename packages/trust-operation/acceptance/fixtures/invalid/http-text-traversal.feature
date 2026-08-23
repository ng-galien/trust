# language: en
@trust-dsl:1 @operation:http.invalid @version:1.0.0
Feature: Invalid Text HTTP traversal

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Produced fields
      | field   | type   | cardinality | domain |
      | service | string | one         | any    |

  Scenario: Run
    When HTTP "response" sends "GET" to Environment "serviceUrl" and reads Text
    Then Produce with JSONata
      """
      { "service": steps.response.body.service }
      """
