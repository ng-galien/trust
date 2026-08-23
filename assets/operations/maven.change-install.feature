# language: en
@trust-dsl:1 @operation:maven.change-install @version:1.0.0
Feature: Install a committed change with Maven

  Observes the committed change and installs it in the local Maven repository, in one Operation.
  In the project below the workspace: reads HEAD, counts the commits ahead of `baseRevision`, reads
  the working tree and the effective Maven coordinates, then runs
  `mvn -B install -Dtrust.ticket=<ticket>`. Exit 0 is the observation `successful`, exit 1 is
  `failed`; any other exit interrupts the Operation. `installedDependency` identifies the exact
  `groupId:artifactId:type:version` made available to dependent runtime builds.

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input        | type      | cardinality |
      | project      | reference | one         |
      | baseRevision | reference | one         |
      | ticket       | reference | one         |
    And Produced fields
      | field                | type      | cardinality | domain                      |
      | installedRevision    | reference | one         | any                         |
      | installedDependency  | reference | one         | any                         |
      | comparedBaseRevision | reference | one         | any                         |
      | commitsAhead         | number    | one         | any                         |
      | workingTree          | string    | one         | enum "clean", "dirty"       |
      | installationStatus   | string    | one         | enum "successful", "failed" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "commits" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument     | source               |
      | rev-list     | literal              |
      | --count      | literal              |
      | HEAD         | literal              |
      | --not        | literal              |
      | baseRevision | Input "baseRevision" |
    And Shell "status" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument       | source  |
      | status         | literal |
      | --porcelain=v1 | literal |
    And Shell "group" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument                     | source  |
      | -B                           | literal |
      | help:evaluate                | literal |
      | -Dexpression=project.groupId | literal |
      | -q                           | literal |
      | -DforceStdout                | literal |
    And Shell "artifact" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument                        | source  |
      | -B                              | literal |
      | help:evaluate                   | literal |
      | -Dexpression=project.artifactId | literal |
      | -q                              | literal |
      | -DforceStdout                   | literal |
    And Shell "version" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument                   | source  |
      | -B                         | literal |
      | help:evaluate              | literal |
      | -Dexpression=project.version | literal |
      | -q                         | literal |
      | -DforceStdout              | literal |
    And Shell "packaging" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument                       | source  |
      | -B                             | literal |
      | help:evaluate                  | literal |
      | -Dexpression=project.packaging | literal |
      | -q                             | literal |
      | -DforceStdout                  | literal |
    And Shell "install" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument        | source                   |
      | -B              | literal                  |
      | install         | literal                  |
      | -Dtrust.ticket= | literal + Input "ticket" |
    And Shell "install" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    Then Produce with JSONata
      """
      {
        "installedRevision": $trim(steps.head.stdout),
        "installedDependency": $trim(steps.group.stdout) & ":" & $trim(steps.artifact.stdout) & ":" & $trim(steps.packaging.stdout) & ":" & $trim(steps.version.stdout),
        "comparedBaseRevision": input.baseRevision,
        "commitsAhead": $number($trim(steps.commits.stdout)),
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty",
        "installationStatus": steps.install.exitCode = 0 ? "successful" : "failed"
      }
      """
