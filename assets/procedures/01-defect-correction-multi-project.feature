# language: en
@trust-dsl:1 @procedure:defect-correction @version:3.0.0
Feature: Fix a Jira defect and deploy the committed fix on Kubernetes

  Background: Procedure interface
    Given Skill capability "jira.issue-read" performs read and is replayable
    And Skill capability "jira.issue-read" accepts
      | input | type      | cardinality |
      | issue | reference | one         |
    And Skill capability "jira.issue-read" reports
      | observation     | type   | cardinality | domain                            |
      | summary         | string | one         | any                               |
      | description     | string | one         | any                               |
      | issue type      | string | one         | enum "defect", "story", "task"    |
      | workflow status | string | one         | enum "todo", "in-progress", "done" |
    And Skill capability "jira.issue-read" exposes outputs
      | output | from observation | parents |

    And Skill capability "git.head-read" performs read and is replayable
    And Skill capability "git.head-read" accepts
      | input      | type      | cardinality |
      | repository | reference | one         |
    And Skill capability "git.head-read" reports
      | observation   | type      | cardinality | domain                |
      | head revision | reference | one         | any                   |
      | working tree  | string    | one         | enum "clean", "dirty" |
    And Skill capability "git.head-read" exposes outputs
      | output        | from observation | parents            |
      | head revision | head revision     | input "repository" |

    And Skill capability "git.head-compare" performs read and is replayable
    And Skill capability "git.head-compare" accepts
      | input         | type      | cardinality |
      | repository    | reference | one         |
      | base revision | reference | one         |
    And Skill capability "git.head-compare" reports
      | observation            | type      | cardinality | domain                |
      | head revision          | reference | one         | any                   |
      | compared base revision | reference | one         | any                   |
      | commits ahead          | number    | one         | any                   |
      | working tree           | string    | one         | enum "clean", "dirty" |
    And Skill capability "git.head-compare" exposes outputs
      | output        | from observation | parents            |
      | head revision | head revision     | input "repository" |

    And Skill capability "git.worktree-inspect" performs read and is replayable
    And Skill capability "git.worktree-inspect" accepts
      | input             | type      | cardinality |
      | repository        | reference | one         |
      | expected revision | reference | one         |
    And Skill capability "git.worktree-inspect" reports
      | observation       | type      | cardinality | domain                |
      | observed revision | reference | one         | any                   |
      | working tree      | string    | one         | enum "clean", "dirty" |
    And Skill capability "git.worktree-inspect" exposes outputs
      | output | from observation | parents |

    And Skill capability "maven.defect-reproduce" performs create and is replayable
    And Skill capability "maven.defect-reproduce" accepts
      | input                | type      | cardinality |
      | acceptance criterion | string    | one         |
      | test project         | reference | one         |
      | test revision        | reference | one         |
      | issue                | reference | one         |
    And Skill capability "maven.defect-reproduce" reports
      | observation         | type   | cardinality | domain                                               |
      | acceptance criterion | string | one         | any                                                  |
      | test result         | string | one         | enum "defect-reproduced", "defect-not-reproduced" |
    And Skill capability "maven.defect-reproduce" exposes outputs
      | output | from observation | parents |

    And Skill capability "maven.fix-confirm" performs create and is replayable
    And Skill capability "maven.fix-confirm" accepts
      | input              | type      | cardinality                             |
      | test project       | reference | one                                    |
      | test revision      | reference | one                                    |
      | issue              | reference | one                                    |
      | acceptance criterion | string  | one                                    |
      | candidate project  | reference | many                                   |
      | candidate revision | reference | one for each input "candidate project" |
    And Skill capability "maven.fix-confirm" reports
      | observation          | type      | cardinality                                | domain                        |
      | acceptance criterion | string    | one                                        | any                           |
      | tested project       | reference | many                                       | any                           |
      | tested revision      | reference | one for each observation "tested project" | any                           |
      | test result          | string    | one                                        | enum "successful", "failed" |
    And Skill capability "maven.fix-confirm" exposes outputs
      | output | from observation | parents |

    And Skill capability "maven.project-verify" performs create and is replayable
    And Skill capability "maven.project-verify" accepts
      | input    | type      | cardinality |
      | project  | reference | one         |
      | revision | reference | one         |
    And Skill capability "maven.project-verify" reports
      | observation        | type      | cardinality | domain                      |
      | verified revision  | reference | one         | any                         |
      | verification status | string   | one         | enum "successful", "failed" |
    And Skill capability "maven.project-verify" exposes outputs
      | output | from observation | parents |

    And Skill capability "docker.image-build" performs create and is replayable
    And Skill capability "docker.image-build" accepts
      | input           | type      | cardinality |
      | project         | reference | one         |
      | source revision | reference | one         |
    And Skill capability "docker.image-build" reports
      | observation   | type      | cardinality | domain                      |
      | image         | reference | one         | any                         |
      | built revision | reference | one         | any                         |
      | build status  | string    | one         | enum "successful", "failed" |
    And Skill capability "docker.image-build" exposes outputs
      | output | from observation | parents         |
      | image  | image            | input "project" |

    And Skill capability "kind.image-load" performs deploy and is replayable
    And Skill capability "kind.image-load" accepts
      | input   | type      | cardinality |
      | project | reference | one         |
      | image   | reference | one         |
    And Skill capability "kind.image-load" reports
      | observation | type      | cardinality | domain                        |
      | target image | reference | one         | any                           |
      | load status | string    | one         | enum "available", "unavailable" |
    And Skill capability "kind.image-load" exposes outputs
      | output | from observation | parents |

    And Skill capability "kubernetes.rollout" performs deploy and is replayable
    And Skill capability "kubernetes.rollout" accepts
      | input    | type      | cardinality |
      | workload | reference | one         |
      | image    | reference | one         |
    And Skill capability "kubernetes.rollout" reports
      | observation    | type      | cardinality | domain                      |
      | deployed image | reference | one         | any                         |
      | rollout status | string    | one         | enum "successful", "failed" |
      | ready replicas | number    | one         | any                         |
      | completed at   | instant   | one         | any                         |
    And Skill capability "kubernetes.rollout" exposes outputs
      | output | from observation | parents |

    And one "jira issue"
    And one "acceptance project" fixed as "payment-acceptance"
    And one "acceptance baseline commit" for "acceptance project"
    And one "acceptance test commit" for "acceptance project"
    And many "acceptance criterion" declared by agent for "acceptance project"
    And many "affected project" declared by agent for "jira issue"
    And one "planned modification" declared by agent for each "affected project"
    And one "code baseline commit" for each "affected project"
    And one "fix commit" for each "affected project"
    And one "docker image" for each "affected project"

  @scenario:jira-issue
  Scenario: Read the Jira defect
    Then Check "issue read" uses Skill capability "jira.issue-read" on "jira issue" as input "issue" and must establish "the Jira issue is ready for work"
      | observation     | relation | expectation      | failure feedback                   |
      | issue type      | equals   | literal "defect" | "the Jira issue is not a defect" |
      | workflow status | equals   | literal "todo"   | "the Jira issue is not To Do"    |
    And the scenario is verified when all Skill actions are validated

  @scenario:acceptance-baseline
  Scenario: Read the acceptance repository HEAD
    Then Check "acceptance baseline" uses Skill capability "git.head-read" on "acceptance project" as input "repository" and materializes "acceptance baseline commit" from output "head revision" and must establish "the acceptance repository HEAD is clean"
      | observation  | relation | expectation | failure feedback                                   |
      | working tree | equals   | literal "clean" | "the acceptance repository has uncommitted changes" |
    And the scenario is verified when all Skill actions are validated

  @scenario:code-baselines
  Scenario: Read every affected repository HEAD
    Given scenario "jira-issue" is validated
    Then Check "code baseline" uses Skill capability "git.head-read" on each "affected project" as input "repository" and materializes "code baseline commit" from output "head revision" and must establish "every affected repository HEAD is clean"
      | observation  | relation | expectation | failure feedback                                  |
      | working tree | equals   | literal "clean" | "an affected repository has uncommitted changes" |
    And the scenario is verified when all Skill actions are validated

  @scenario:acceptance-test-commit
  Scenario: Compare the acceptance test commit with its baseline
    Given scenario "jira-issue" is validated
    And scenario "acceptance-baseline" is validated
    Then Check "acceptance test comparison" uses Skill capability "git.head-compare" on "acceptance project" as input "repository" using "acceptance baseline commit" as input "base revision" and materializes "acceptance test commit" from output "head revision" and must establish "the acceptance test is committed after its baseline"
      | observation            | relation | expectation                          | failure feedback                                   |
      | compared base revision | equals   | context "acceptance baseline commit" | "the test commit has another baseline"            |
      | commits ahead          | at least | number 1                             | "the acceptance test is not committed"            |
      | working tree           | equals   | literal "clean"                     | "the acceptance repository has uncommitted changes" |
    And the scenario is verified when all Skill actions are validated

  @scenario:defect-reproduction
  Scenario: Reproduce every agent-declared acceptance criterion
    Given scenario "acceptance-test-commit" is validated
    Then Check "defect reproduction" uses Skill capability "maven.defect-reproduce" on each "acceptance criterion" as input "acceptance criterion" using "acceptance project" as input "test project" and "acceptance test commit" as input "test revision" and "jira issue" as input "issue" and must establish "every declared acceptance criterion reproduces the Jira defect"
      | observation          | relation | expectation                    | failure feedback                               |
      | acceptance criterion | equals   | context "acceptance criterion" | "another acceptance criterion was executed" |
      | test result          | equals   | literal "defect-reproduced"   | "the Jira defect is not reproduced"         |
    And the scenario is verified when all Skill actions are validated

  @scenario:fix-commits
  Scenario: Compare every fix commit with its code baseline
    Given scenario "defect-reproduction" is validated
    And scenario "code-baselines" is validated
    Then Check "fix comparison" uses Skill capability "git.head-compare" on each "affected project" as input "repository" using "code baseline commit" as input "base revision" and materializes "fix commit" from output "head revision" and must establish "every fix is committed after its code baseline"
      | observation            | relation | expectation                    | failure feedback                                |
      | compared base revision | equals   | context "code baseline commit" | "a fix has another code baseline"              |
      | commits ahead          | at least | number 1                       | "a fix is not committed"                       |
      | working tree           | equals   | literal "clean"               | "an affected repository has uncommitted changes" |
    And the scenario is verified when all Skill actions are validated

  @scenario:maven-verification
  Scenario: Verify every committed fix with Maven
    Given scenario "fix-commits" is validated
    Then Check "fix worktree" uses Skill capability "git.worktree-inspect" on each "affected project" as input "repository" using "fix commit" as input "expected revision" and must establish "every repository is on its clean fix commit"
      | observation      | relation | expectation          | failure feedback                                  |
      | observed revision | equals   | context "fix commit" | "an affected repository is on another commit"   |
      | working tree     | equals   | literal "clean"      | "an affected repository has uncommitted changes" |
    And Check "maven verification" uses Skill capability "maven.project-verify" on each "affected project" as input "project" using "fix commit" as input "revision" and must establish "every committed fix passes Maven verification"
      | observation         | relation | expectation          | failure feedback                    |
      | verified revision   | equals   | context "fix commit" | "Maven verified another revision"  |
      | verification status | equals   | literal "successful"  | "Maven verification failed"        |
    And the scenario is verified when all Skill actions are validated

  @scenario:docker-images
  Scenario: Build a Docker image from every committed fix
    Given scenario "maven-verification" is validated
    Then Check "docker build" uses Skill capability "docker.image-build" on each "affected project" as input "project" using "fix commit" as input "source revision" and materializes "docker image" from output "image" and must establish "every Docker image was built from its fix commit"
      | observation    | relation | expectation          | failure feedback                 |
      | built revision | equals   | context "fix commit" | "Docker built another revision" |
      | build status   | equals   | literal "successful"  | "the Docker image build failed" |
    And the scenario is verified when all Skill actions are validated

  @scenario:kind-images
  Scenario: Load every Docker image into Kind
    Given scenario "docker-images" is validated
    Then Check "kind image load" uses Skill capability "kind.image-load" on each "affected project" as input "project" using "docker image" as input "image" and must establish "every Docker image is available on every Kind node"
      | observation | relation | expectation            | failure feedback                           |
      | target image | equals   | context "docker image" | "Kind targeted another image"             |
      | load status | equals   | literal "available"     | "the Docker image is unavailable in Kind" |
    And the scenario is verified when all Skill actions are validated

  @scenario:kubernetes-rollouts
  Scenario: Deploy every Docker image on Kubernetes
    Given scenario "kind-images" is validated
    Then Check "kubernetes rollout" uses Skill capability "kubernetes.rollout" on each "affected project" as input "workload" using "docker image" as input "image" and must establish "every workload runs its Docker image with ready replicas"
      | observation    | relation | expectation            | failure feedback                              |
      | deployed image | equals   | context "docker image" | "Kubernetes deployed another image"          |
      | rollout status | equals   | literal "successful"    | "the Kubernetes rollout failed"              |
      | ready replicas | at least | number 1                 | "the Kubernetes workload has no ready replica" |
      | completed at   | equals   | valid rfc3339           | "the Kubernetes rollout completion is missing" |
    And the scenario is verified when all Skill actions are validated

  @scenario:fix-confirmation
  Scenario: Confirm every declared acceptance criterion against the deployed fixes
    Given scenario "defect-reproduction" is validated
    And scenario "kubernetes-rollouts" is validated
    Then Check "fix confirmation" uses Skill capability "maven.fix-confirm" on each "acceptance criterion" as input "acceptance criterion" using "acceptance project" as input "test project" and "acceptance test commit" as input "test revision" and "jira issue" as input "issue" and all "affected project" as input "candidate project" and all "fix commit" as input "candidate revision" and must establish "the declared acceptance criterion passes against every deployed fix"
      | observation          | relation | expectation                    | failure feedback                                  |
      | acceptance criterion | equals   | context "acceptance criterion" | "another acceptance criterion was executed"    |
      | tested project       | equals   | context "affected project"     | "the test did not cover every affected project" |
      | tested revision      | equals   | context "fix commit"           | "the test did not use every committed fix"      |
      | test result          | equals   | literal "successful"           | "the deployed fix failed the acceptance test"   |
    And the scenario is verified when all Skill actions are validated
