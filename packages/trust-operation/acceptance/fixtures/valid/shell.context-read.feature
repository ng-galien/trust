# language: en
@trust-dsl:1 @operation:shell.context-read @version:1.0.0
Feature: Read execution context

  Background: Operation interface
    Given Environment
      | name             | type      |
      | workingDirectory | directory |
      | serviceUrl       | url       |
    And Input
      | input      | type      | cardinality |
      | argument   | string    | one         |
      | tags       | string    | many        |
      | count      | number    | one         |
      | occurredAt | instant   | one         |
      | revision   | reference | one         |
    And Produced fields
      | field       | type      | cardinality | domain                |
      | argument    | string    | one         | any                   |
      | tags        | string    | many        | any                   |
      | count       | number    | one         | any                   |
      | occurredAt  | instant   | one         | any                   |
      | revision    | reference | one         | any                   |
      | serviceUrl  | string    | one         | any                   |
      | workingTree | string    | one         | enum "clean", "dirty" |

  Scenario: Run
    When Shell "currentDirectory" runs "pwd" with cwd from Environment "workingDirectory"
      | argument |
      | -P       |
    Then Produce with JSONata
      """
      {
        "argument": input.argument,
        "tags": input.tags,
        "count": input.count,
        "occurredAt": input.occurredAt,
        "revision": input.revision,
        "serviceUrl": environment.serviceUrl,
        "workingTree": "clean"
      }
      """
