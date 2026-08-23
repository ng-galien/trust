# language: en
@trust-dsl:1 @operation:http.segments-query @version:1.0.0
Feature: Read the comments of one issue with a bounded page

  Background: Operation interface
    Given Environment
      | name      | type |
      | issuesUrl | url  |
    And Input
      | input    | type      | cardinality |
      | issue    | reference | one         |
      | resource | string    | one         |
      | run      | string    | one         |
    And Produced fields
      | field | type   | cardinality | domain |
      | total | number | one         | any    |

  Scenario: Run
    When HTTP "comments" sends "GET" to Environment "issuesUrl" appending Input "issue" and Input "resource" with query "limit" as "5" with query "run" from Input "run" and reads JSON
    Then Produce with JSONata
      """
      { "total": steps.comments.body.total }
      """
