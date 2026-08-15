# language: en
@trust-dsl:1 @procedure:end-to-end-red-green @version:2.0.0
Feature: Validate a multi-project change through a traced Red-Green deployment cycle

  Background: Plan context
    Given one reference "jira issue"
    And one reference "acceptance project" fixed as "payment-acceptance"
    And one reference "acceptance baseline revision" for "acceptance project"
    And one reference "acceptance test revision" for "acceptance project"
    And many string "test argument" declared by agent for "acceptance project"
    And many reference "affected project" declared by agent for "jira issue"
    And many reference "code baseline revision" for each "affected project"
    And many reference "fix revision" for each "affected project"
    And many reference "planned image" declared by agent for each "affected project"
    And many string "container name" declared by agent for each "affected project"
    And many reference "built image" for each "affected project"
    And many reference "container image" for each "affected project"
    And many reference "workload" declared by agent for each "affected project"
    And one reference "Kind cluster" fixed as "trust"
    And one reference "trace"

  @scenario:acceptance-baseline
  Scenario: Establish the clean acceptance baseline before reading the ticket
    Then Check "acceptance baseline" runs Operation "git.head-read" on "acceptance project" as Input "project" and materializes "acceptance baseline revision" from field "headRevision" and must establish "the clean acceptance baseline is established"
      | field       | relation | expectation   | failure reason                                  |
      | workingTree | equals   | value "clean" | "the acceptance repository has local changes"   |
    And the Scenario is satisfied when every Check is validated

  @scenario:jira-issue
  Scenario: Read the Jira defect
    Given scenario "acceptance-baseline" is validated
    Then Check "issue" runs Operation "jira.issue-read" on "jira issue" as Input "issue" and must establish "the Jira issue is ready for correction"
      | field          | relation | expectation    | failure reason                  |
      | issueType      | equals   | value "defect" | "the Jira issue is not a defect" |
      | workflowStatus | equals   | value "todo"   | "the Jira issue is not ready"    |
    And the Scenario is satisfied when every Check is validated

  @scenario:code-baselines
  Scenario: Establish every clean code baseline
    Given scenario "jira-issue" is validated
    Then Check "code baseline" runs Operation "git.head-read" on each "affected project" as Input "project" and materializes "code baseline revision" from field "headRevision" and must establish "every affected project has a clean baseline"
      | field       | relation | expectation   | failure reason                             |
      | workingTree | equals   | value "clean" | "an affected project has local changes"     |
    And the Scenario is satisfied when every Check is validated

  @scenario:acceptance-test-commit
  Scenario: Establish the committed acceptance test
    Given scenario "jira-issue" is validated
    Then Check "acceptance test revision" runs Operation "git.head-compare" on "acceptance project" as Input "project" using "acceptance baseline revision" as Input "baseRevision" and materializes "acceptance test revision" from field "headRevision" and must establish "the acceptance test is committed after its baseline"
      | field                | relation | expectation                            | failure reason                                |
      | comparedBaseRevision | equals   | context "acceptance baseline revision" | "the acceptance test uses another baseline"    |
      | commitsAhead         | at least | number 1                               | "the acceptance test is not committed"          |
      | workingTree          | equals   | value "clean"                          | "the acceptance repository has local changes"   |
    And the Scenario is satisfied when every Check is validated

  @scenario:red
  Scenario: Reproduce the defect with every declared Karate test
    Given scenario "acceptance-test-commit" is validated
    Then Check "Red Karate test" runs Operation "karate.defect-reproduce" on each "test argument" as Input "testArgument" using "acceptance project" as Input "project" using "acceptance test revision" as Input "revision" and must establish "every declared Karate test reproduces the defect"
      | field          | relation | expectation                         | failure reason                         |
      | testedRevision | equals   | context "acceptance test revision" | "Karate used another test revision"     |
      | testStatus     | equals   | value "defect-reproduced"           | "the defect was not reproduced"         |
    And the Scenario is satisfied when every Check is validated

  @scenario:fix-commits
  Scenario: Establish every committed fix
    Given scenario "red" is validated
    And scenario "code-baselines" is validated
    Then Check "fix revision" runs Operation "git.head-compare" on each "affected project" as Input "project" using "code baseline revision" as Input "baseRevision" and materializes "fix revision" from field "headRevision" and must establish "every fix is committed after its code baseline"
      | field                | relation | expectation                      | failure reason                           |
      | comparedBaseRevision | equals   | context "code baseline revision" | "a fix uses another code baseline"        |
      | commitsAhead         | at least | number 1                         | "a fix is not committed"                  |
      | workingTree          | equals   | value "clean"                    | "an affected project has local changes"    |
    And the Scenario is satisfied when every Check is validated

  @scenario:maven-verification
  Scenario: Verify every committed fix with Maven
    Given scenario "fix-commits" is validated
    Then Check "Maven verification" runs Operation "maven.project-verify" on each "affected project" as Input "project" using "fix revision" as Input "revision" and must establish "every committed fix passes Maven verification"
      | field              | relation | expectation            | failure reason                   |
      | verifiedRevision   | equals   | context "fix revision" | "Maven verified another revision" |
      | verificationStatus | equals   | value "successful"      | "Maven verification failed"       |
    And the Scenario is satisfied when every Check is validated

  @scenario:images
  Scenario: Build every deployment image
    Given scenario "maven-verification" is validated
    Then Check "Docker image" runs Operation "docker.image-build" on each "affected project" as Input "project" using "fix revision" as Input "sourceRevision" using "planned image" as Input "image" using "container name" as Input "containerName" and materializes "built image" from field "image" and materializes "container image" from field "containerImage" and must establish "every image is built from its committed fix"
      | field         | relation | expectation            | failure reason                      |
      | builtRevision | equals   | context "fix revision" | "Docker built another revision"      |
      | buildStatus   | equals   | value "successful"      | "the Docker image build failed"       |
    And the Scenario is satisfied when every Check is validated

  @scenario:kind
  Scenario: Load every image into Kind
    Given scenario "images" is validated
    Then Check "Kind image" runs Operation "kind.image-load" on each "built image" as Input "image" using "Kind cluster" as Input "cluster" and must establish "every image is available in Kind"
      | field       | relation | expectation           | failure reason                      |
      | loadedImage | equals   | context "built image" | "Kind loaded another image"          |
      | loadStatus  | equals   | value "available"      | "an image is unavailable in Kind"    |
    And the Scenario is satisfied when every Check is validated

  @scenario:kubernetes
  Scenario: Deploy every image on Kubernetes
    Given scenario "kind" is validated
    Then Check "Kubernetes rollout" runs Operation "kubernetes.rollout" on each "workload" as Input "workload" using "built image" as Input "image" using "container image" as Input "containerImage" and must establish "every workload runs its built image"
      | field         | relation | expectation           | failure reason                       |
      | deployedImage | equals   | context "built image" | "Kubernetes deployed another image"  |
      | rolloutStatus | equals   | value "successful"     | "the Kubernetes rollout failed"       |
    And the Scenario is satisfied when every Check is validated

  @scenario:green
  Scenario: Confirm every Karate test against the deployed change
    Given scenario "red" is validated
    And scenario "kubernetes" is validated
    Then Check "Green Karate test" runs Operation "karate.test-run" on each "test argument" as Input "testArgument" using "acceptance project" as Input "project" using "acceptance test revision" as Input "revision" and must establish "every declared Karate test passes against the deployment"
      | field          | relation | expectation                         | failure reason                         |
      | testedRevision | equals   | context "acceptance test revision" | "Karate used another test revision"     |
      | testStatus     | equals   | value "successful"                  | "a deployed acceptance test failed"     |
    And the Scenario is satisfied when every Check is validated

  @scenario:trace
  Scenario: Confirm the deployment trace marker
    Given scenario "green" is validated
    Then Check "deployment trace" runs Operation "telemetry.trace-read" on "trace" as Input "traceId" and must establish "the deployment trace contains the expected markers"
      | field       | relation | expectation | failure reason                     |
      | markerCount | at least | number 1    | "the deployment trace has no marker" |
    And the Scenario is satisfied when every Check is validated
