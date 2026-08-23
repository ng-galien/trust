# language: en
@trust-dsl:1 @operation:http.connect @version:1.0.0
Feature: Establish and close one bounded CONNECT handshake

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "tunnel" sends "CONNECT" to Environment "serviceUrl" and reads no body
    Then Produce with JSONata
      """
      { "status": steps.tunnel.status }
      """
