# language: en
@trust-dsl:1 @operation:acceptance.selection-check @version:1.0.0
Feature: Observe which test files a mapping selects for the files changed since a Git base
  Runs the fixed selection helper; it runs no test and imports no agent-authored list. The changed files are read
  from Git: the working tree, untracked files included, compared with the merge base of the base ref and HEAD.

  Background: Operation interface
    Given Environment
      | name | type |
      | workspaceRoot | directory |
    And Input
      | input | type | cardinality |
      | mapping | string | one |
      | base | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | mapping | string | one | any |
      | mappingDigest | string | one | any |
      | base | string | one | any |
      | baseCommit | string | one | any |
      | changedFiles | number | one | any |
      | selectedTestFiles | number | one | any |
      | totalTestFiles | number | one | any |
      | unmappedChangedFiles | number | one | any |
      | missingTestFiles | number | one | any |
      | report | string | one | any |

  Scenario: Run
    When Shell "selection" runs "node" with cwd from Environment "workspaceRoot"
      | argument | source |
      | scripts/acceptance-selection.mjs | literal |
      | observe | literal |
      | mapping | Input "mapping" |
      | base | Input "base" |
    Then Produce with JSONata
      """
      {
        "mapping": $split(steps.selection.stdout, "\n")[0],
        "mappingDigest": $split(steps.selection.stdout, "\n")[1],
        "base": $split(steps.selection.stdout, "\n")[2],
        "baseCommit": $split(steps.selection.stdout, "\n")[3],
        "changedFiles": $number($split(steps.selection.stdout, "\n")[4]),
        "selectedTestFiles": $number($split(steps.selection.stdout, "\n")[5]),
        "totalTestFiles": $number($split(steps.selection.stdout, "\n")[6]),
        "unmappedChangedFiles": $number($split(steps.selection.stdout, "\n")[7]),
        "missingTestFiles": $number($split(steps.selection.stdout, "\n")[8]),
        "report": $split(steps.selection.stdout, "\n")[9]
      }
      """
