@trust-dsl:1 @operation:templates-ui.review @version:1.0.0
Feature: Observe template UI review verification on the actual checkout
  Background: Operation interface
    Given Environment
      | name | type |
      | workspaceRoot | directory |
      | reportRoot | directory |
    And Input
      | input | type | cardinality |
      | request | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | mode | string | one | any |
      | reviewDecision | string | one | any |
      | beforeHead | reference | one | any |
      | afterHead | reference | one | any |
      | beforeDigest | string | one | any |
      | afterDigest | string | one | any |
      | total | number | one | any |
      | passed | number | one | any |
      | failed | number | one | any |
      | skipped | number | one | any |
      | reportParsed | string | one | any |
      | commandsSucceeded | string | one | any |

  Scenario: Run
    When Shell "verify" runs "node" with cwd from Environment "workspaceRoot"
      | argument | source |
      | scripts/templates-ui-check.mjs | literal |
      | review | literal |
      | request | Input "request" |
    And File "report" reads "templates-ui-review.json" as JSON from Environment "reportRoot"
    Then Produce with JSONata
      """
      {
        "mode": steps.report.content.mode,
        "reviewDecision": steps.report.content.reviewDecision,
        "beforeHead": steps.report.content.beforeHead,
        "afterHead": steps.report.content.afterHead,
        "beforeDigest": steps.report.content.beforeDigest,
        "afterDigest": steps.report.content.afterDigest,
        "total": steps.report.content.total,
        "passed": steps.report.content.passed,
        "failed": steps.report.content.failed,
        "skipped": steps.report.content.skipped,
        "reportParsed": steps.report.content.reportParsed,
        "commandsSucceeded": steps.report.content.commandsSucceeded
      }
      """

