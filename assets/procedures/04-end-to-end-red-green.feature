# language: en
@trust-dsl:1 @procedure:end-to-end-red-green @version:3.2.0
Feature: Validate a multi-project change through a traced Red-Green deployment cycle

  Full delivery loop for a defect that touches one or several projects, driven by one Jira issue.
  The agent declares what it works on (the affected projects, the Karate selection, the images
  and workloads); every other value is observed by a Check. Every project works on a ticket
  branch named after the Jira issue key, cut from its clean `main`, and the Plan ends by merging
  every branch back into `main`, so the operator never branches or merges by hand (local
  repositories only for now: nothing is pushed). Nine Scenarios, each one Check per target:

  - acceptance-baseline: switch the acceptance project to `main`, read its clean HEAD and open the
    ticket branch there.
  - jira-issue: the issue is a defect and ready.
  - code-baselines: the same for every affected project: clean `main` HEAD, ticket branch opened.
  - red: one Operation observes the committed Karate change (ahead of the acceptance baseline,
    clean tree) and runs it in the red phase; the defect must be reproduced. The revision it
    tested becomes the acceptance test revision.
  - fix-verify: one Operation per affected project observes the committed fix (ahead of its code
    baseline, clean tree) and verifies it with Maven. The revision it verified becomes the fix
    revision.
  - deploy: one Operation per affected project builds the image from HEAD, loads it into the Kind
    cluster and rolls it out on the declared workload; the built revision must be the fix revision.
  - green: the same Karate selection, same acceptance test revision, in the green phase against
    the deployment; it must pass.
  - trace: the trace the green run emitted is read back and must carry spans.
  - merge: the committed ticket branch of the acceptance project, then of every affected project,
    is merged into `main` with a merge commit and deleted locally; each merge and deletion must
    succeed and leave a clean tree.

  Every Check runs on the `trust-test` environment: workspace of the projects, jira-mock, Tempo.
  The Plan identifier is passed to Maven as `trust.run` so the Karate traffic of one Plan never
  mixes with another.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Change, build, deploy, and verify only the declared projects and issue. | Alter baselines, cluster evidence, telemetry, or the environment to make a Check pass. |
    Given one reference "jira issue"
    And one reference "acceptance project" fixed as "payment-acceptance"
    And one reference "acceptance baseline revision" for "acceptance project"
    And one reference "acceptance test revision" for "acceptance project"
    And one string "test argument" declared by agent for "acceptance project"
    And many reference "affected project" declared by agent for "jira issue"
    And many reference "code baseline revision" for each "affected project"
    And many reference "fix revision" for each "affected project"
    And many reference "planned image" declared by agent for each "affected project"
    And many reference "workload" declared by agent for each "affected project"
    And one reference "Kind cluster" fixed as "trust-test"
    And one reference "trace" declared by agent

  @scenario:acceptance-baseline
  Scenario: Establish the clean acceptance baseline and open its ticket branch
    Then Check "acceptance baseline" runs Operation "git.change-start"
        on "acceptance project" as Input "project"
        using "jira issue" as Input "branch"
        and materializes "acceptance baseline revision" from field "baseRevision"
        and must establish "the acceptance project starts the ticket branch from its clean baseline"
      """js
      (
        fact.workingTree === "clean" ||
        fail("the acceptance repository has local changes")
      ) &&
      (
        fact.branch === context["jira issue"] ||
        fail("the acceptance repository is not on the ticket branch")
      )
      """

  @scenario:jira-issue
  Scenario: Read the Jira defect
    Given scenario "acceptance-baseline" is validated
    Then Check "issue" runs Operation "jira.issue-read"
        on "jira issue" as Input "issue"
        and must establish "the Jira issue is ready for correction"
      """js
      (
        fact.issueType === "defect" ||
        fail("the Jira issue is not a defect")
      ) &&
      (
        fact.workflowStatus === "todo" ||
        fail("the Jira issue is not ready")
      )
      """

  @scenario:code-baselines
  Scenario: Establish every clean code baseline and open its ticket branch
    Given scenario "jira-issue" is validated
    Then Check "code baseline" runs Operation "git.change-start"
        on each "affected project" as Input "project"
        using "jira issue" as Input "branch"
        and materializes "code baseline revision" from field "baseRevision"
        and must establish "every affected project starts the ticket branch from its clean baseline"
      """js
      (
        fact.workingTree === "clean" ||
        fail("an affected project has local changes")
      ) &&
      (
        fact.branch === context["jira issue"] ||
        fail("an affected project is not on the ticket branch")
      )
      """

  @scenario:red
  Scenario: Reproduce the defect with the committed Karate change
    Given scenario "jira-issue" is validated
    Then Check "red run" runs Operation "karate.change-reproduce"
        on "test argument" as Input "testArgument"
        using "acceptance project" as Input "project"
        using "acceptance baseline revision" as Input "baseRevision"
        using "jira issue" as Input "ticket"
        using plan as Input "run"
        and materializes "acceptance test revision" from field "testedRevision"
        and must establish "the committed Karate change reproduces the defect"
      """js
      (
        fact.comparedBaseRevision === context["acceptance baseline revision"] ||
        fail("the Karate change uses another baseline")
      ) &&
      (
        fact.commitsAhead >= 1 ||
        fail("the Karate change is not committed")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("the acceptance repository has local changes")
      ) &&
      (
        fact.testStatus === "defect-reproduced" ||
        fail("the defect was not reproduced")
      )
      """

  @scenario:fix-verify
  Scenario: Verify every committed fix with Maven
    Given scenario "red" is validated
    And scenario "code-baselines" is validated
    Then Check "fix verification" runs Operation "maven.change-verify"
        on each "affected project" as Input "project"
        using "code baseline revision" as Input "baseRevision"
        using "jira issue" as Input "ticket"
        and materializes "fix revision" from field "verifiedRevision"
        and must establish "every committed fix passes Maven verification"
      """js
      (
        fact.comparedBaseRevision === context["code baseline revision"] ||
        fail("a fix uses another code baseline")
      ) &&
      (
        fact.commitsAhead >= 1 ||
        fail("a fix is not committed")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("an affected project has local changes")
      ) &&
      (
        fact.verificationStatus === "successful" ||
        fail("Maven verification failed")
      )
      """

  @scenario:deploy
  Scenario: Build, load and roll out every fix on Kind
    Given scenario "fix-verify" is validated
    Then Check "deployment" runs Operation "kind.change-deploy"
        on each "affected project" as Input "project"
        using "planned image" as Input "image"
        using "Kind cluster" as Input "cluster"
        using "workload" as Input "workload"
        and must establish "every fix is built, loaded into Kind and rolled out"
      """js
      (
        fact.builtRevision === context["fix revision"] ||
        fail("the image was built from another revision")
      ) &&
      (
        fact.deployStatus === "successful" ||
        fail("the build, the Kind load or the rollout failed")
      )
      """

  @scenario:green
  Scenario: Confirm the Karate change against the deployment
    Given scenario "red" is validated
    And scenario "deploy" is validated
    Then Check "green run" runs Operation "karate.change-verify"
        on "test argument" as Input "testArgument"
        using "acceptance project" as Input "project"
        using "acceptance baseline revision" as Input "baseRevision"
        using "jira issue" as Input "ticket"
        using plan as Input "run"
        and must establish "the Karate change passes against the deployment"
      """js
      (
        fact.testedRevision === context["acceptance test revision"] ||
        fail("the green run used another test revision")
      ) &&
      (
        fact.testStatus === "successful" ||
        fail("the deployed acceptance test failed")
      )
      """

  @scenario:trace
  Scenario: Confirm the green run trace
    Given scenario "green" is validated
    Then Check "green trace" runs Operation "telemetry.trace-read"
        on "trace" as Input "traceId"
        and must establish "the green run trace was recorded"
      """js
      fact.spanCount >= 1 ||
      fail("the green run trace has no span")
      """

  @scenario:merge
  Scenario: Merge every ticket branch into main
    Given scenario "green" is validated
    And scenario "trace" is validated
    Then Check "acceptance merge" runs Operation "git.change-merge"
        on "acceptance project" as Input "project"
        using "jira issue" as Input "branch"
        using "jira issue" as Input "ticket"
        and must establish "the acceptance change is merged into main"
      """js
      (
        fact.mergeStatus === "merged" ||
        fail("the acceptance ticket branch did not merge into main")
      ) &&
      (
        fact.branchStatus === "deleted" ||
        fail("the acceptance ticket branch still exists locally")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("the acceptance repository has local changes")
      )
      """
    And Check "fix merge" runs Operation "git.change-merge"
        on each "affected project" as Input "project"
        using "jira issue" as Input "branch"
        using "jira issue" as Input "ticket"
        and must establish "every fix is merged into main"
      """js
      (
        fact.mergeStatus === "merged" ||
        fail("a fix ticket branch did not merge into main")
      ) &&
      (
        fact.branchStatus === "deleted" ||
        fail("a fix ticket branch still exists locally")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("an affected project has local changes")
      )
      """
