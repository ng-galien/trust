# language: en
@trust-dsl:1 @operation:kind.change-deploy @version:1.0.0
Feature: Build a project image, load it into Kind and roll it out on one workload

  Deploys the project HEAD on a Kind cluster, in one Operation: reads HEAD in the project below
  the workspace, runs `docker build --tag <image> .` there, `kind load docker-image <image>
  --name <cluster>`, `kubectl set image <workload> *=<image>` (every container of the workload)
  and `kubectl rollout status <workload> --timeout=180s`. A build or load that fails interrupts
  the Operation before the workload is touched (no field, the agent reads the Runner error and
  retries). Exit 1 of the set or rollout step is an observation: `deployStatus` is `successful`
  only when both exited 0, otherwise `failed`. `builtRevision` is the HEAD that was built, so a
  Procedure can require it to be the verified fix revision. The image is only tagged and loaded
  from the local Docker daemon; nothing is pushed.

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input    | type      | cardinality |
      | project  | reference | one         |
      | image    | reference | one         |
      | cluster  | reference | one         |
      | workload | reference | one         |
    And Produced fields
      | field         | type      | cardinality | domain                      |
      | builtRevision | reference | one         | any                         |
      | deployedImage | reference | one         | any                         |
      | deployStatus  | string    | one         | enum "successful", "failed" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "build" runs "docker" with cwd from Environment "workspaceRoot" and Input "project"
      | argument | source        |
      | build    | literal       |
      | --tag    | literal       |
      | image    | Input "image" |
      | .        | literal       |
    And Shell "load" runs "kind" with cwd from Environment "workspaceRoot"
      | argument     | source          |
      | load         | literal         |
      | docker-image | literal         |
      | image        | Input "image"   |
      | --name       | literal         |
      | cluster      | Input "cluster" |
    And Shell "set" runs "kubectl" with cwd from Environment "workspaceRoot"
      | argument | source                  |
      | set      | literal                 |
      | image    | literal                 |
      | workload | Input "workload"        |
      | *=       | literal + Input "image" |
    And Shell "set" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    And Shell "rollout" runs "kubectl" with cwd from Environment "workspaceRoot"
      | argument       | source           |
      | rollout        | literal          |
      | status         | literal          |
      | workload       | Input "workload" |
      | --timeout=180s | literal          |
    And Shell "rollout" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    Then Produce with JSONata
      """
      {
        "builtRevision": $trim(steps.head.stdout),
        "deployedImage": input.image,
        "deployStatus": (steps.set.exitCode = 0 and steps.rollout.exitCode = 0) ? "successful" : "failed"
      }
      """
