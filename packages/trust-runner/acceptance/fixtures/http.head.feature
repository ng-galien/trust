# language: en
@trust-dsl:1 @operation:http.head @version:1.0.0
Feature: Read representation metadata without response content

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "metadata" sends "HEAD" to Environment "serviceUrl" and reads no body
    Then Produce with JSONata
      """
      { "status": steps.metadata.status }
      """
