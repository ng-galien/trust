# language: en
@trust-dsl:1 @operation:http.query @version:1.0.0
Feature: Send a safe HTTP query with content

  Background: Operation interface
    Given Environment
      | name       | type   |
      | serviceUrl | url    |
      | apiMode    | string |
    And Input
      | input | type   | cardinality |
      | query | string | one         |
    And Produced fields
      | field  | type   | cardinality | domain |
      | result | string | one         | any    |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "query" sends "QUERY" to Environment "serviceUrl" appending literal "search" with query "limit" as "5" with header "x-api-mode" from Environment "apiMode" with JSONata body and reads JSON
      """
      { "query": input.query }
      """
    And HTTP "query" accepts statuses
      | status |
      | 200    |
    Then Produce with JSONata
      """
      { "result": steps.query.body.result, "status": steps.query.status }
      """
