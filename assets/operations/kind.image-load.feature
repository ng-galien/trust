# language: en
@trust-dsl:1 @operation:kind.image-load @version:1.0.0
Feature: Load one Docker image into Kind

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input   | type      | cardinality |
      | image   | reference | one         |
      | cluster | reference | one         |
    And Produced fields
      | field       | type      | cardinality | domain                          |
      | loadedImage | reference | one         | any                             |
      | cluster     | reference | one         | any                             |
      | loadStatus  | string    | one         | enum "available", "unavailable" |

  Scenario: Run
    When Shell "load" runs "kind" with cwd from Environment "workspaceRoot"
      | argument | source          |
      | load     | literal         |
      | docker-image | literal     |
      | image    | Input "image"   |
      | --name   | literal         |
      | cluster  | Input "cluster" |
    And Shell "load" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    Then Produce with JSONata
      """
      {
        "loadedImage": input.image,
        "cluster": input.cluster,
        "loadStatus": steps.load.exitCode = 0 ? "available" : "unavailable"
      }
      """
