# language: en
@trust-dsl:1 @operation:kubernetes.rollout @version:1.0.0
Feature: Deploy one container image and wait for its Kubernetes rollout

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input          | type      | cardinality |
      | workload       | reference | one         |
      | image          | reference | one         |
      | containerImage | reference | one         |
    And Produced fields
      | field         | type      | cardinality | domain                      |
      | workload      | reference | one         | any                         |
      | deployedImage | reference | one         | any                         |
      | rolloutStatus | string    | one         | enum "successful", "failed" |

  Scenario: Run
    When Shell "deploy" runs "kubectl" with cwd from Environment "workspaceRoot"
      | argument       | source                   |
      | set            | literal                  |
      | image          | literal                  |
      | workload       | Input "workload"         |
      | containerImage | Input "containerImage"   |
    And Shell "rollout" runs "kubectl" with cwd from Environment "workspaceRoot"
      | argument | source           |
      | rollout  | literal          |
      | status   | literal          |
      | workload | Input "workload" |
    And Shell "rollout" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    Then Produce with JSONata
      """
      {
        "workload": input.workload,
        "deployedImage": input.image,
        "rolloutStatus": steps.rollout.exitCode = 0 ? "successful" : "failed"
      }
      """
