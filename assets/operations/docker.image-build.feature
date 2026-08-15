# language: en
@trust-dsl:1 @operation:docker.image-build @version:1.0.0
Feature: Build one Docker image from a project revision

  Background: Operation interface
    Given Environment
      | name        | type      |
      | projectRoot | directory |
    And Input
      | input         | type      | cardinality |
      | project       | reference | one         |
      | sourceRevision | reference | one         |
      | image         | reference | one         |
      | containerName | string    | one         |
    And Produced fields
      | field          | type      | cardinality | domain                      |
      | image          | reference | one         | any                         |
      | builtRevision  | reference | one         | any                         |
      | containerImage | reference | one         | any                         |
      | buildStatus    | string    | one         | enum "successful", "failed" |

  Scenario: Run
    When Shell "build" runs "docker" with cwd from Environment "projectRoot"
      | argument | source        |
      | build    | literal       |
      | --tag    | literal       |
      | image    | Input "image" |
      | .        | literal       |
    And Shell "build" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    Then Produce with JSONata
      """
      {
        "image": input.image,
        "builtRevision": input.sourceRevision,
        "containerImage": input.containerName & "=" & input.image,
        "buildStatus": steps.build.exitCode = 0 ? "successful" : "failed"
      }
      """
