# language: en
@trust-dsl:1 @operation:http.invalid @version:1.0.0
Feature: Invalid HTTP GET sentence

  Background: Operation interface
    Given Environment
      | name      | type |
      | issuesUrl | url  |
    And Input
      | input | type      | cardinality |
      | issue | reference | one         |
      | tags  | string    | many        |
      | count | number    | one         |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "comments" posts Input as JSON to Environment "issuesUrl" with query "limit" as "5" and reads JSON
    Then Produce with JSONata
      """
      { "status": steps.comments.status }
      """
