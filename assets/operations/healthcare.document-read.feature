# language: en
@trust-dsl:1 @operation:healthcare.document-read @version:1.0.0
Feature: Read one simulated admission document

  Background: Operation interface
    Given Environment
      | name        | type |
      | documentUrl | url  |
    And Input
      | input    | type      | cardinality |
      | document | reference | one         |
    And Produced fields
      | field          | type      | cardinality | domain                       |
      | document       | reference | one         | any                          |
      | documentStatus | string    | one         | enum "confirmed", "rejected" |
      | recordedAt     | instant   | one         | any                          |

  Scenario: Run
    When HTTP "document" sends "GET" to Environment "documentUrl" appending Input "document" and reads JSON
    Then Produce with JSONata
      """
      {
        "document": input.document,
        "documentStatus": steps.document.body.documentStatus,
        "recordedAt": steps.document.body.recordedAt
      }
      """
