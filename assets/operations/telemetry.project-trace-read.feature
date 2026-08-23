# language: en
@trust-dsl:1 @operation:telemetry.project-trace-read @version:1.0.0
Feature: Read one OpenTelemetry trace for a project execution

  Reads one trace by id from a Tempo-compatible endpoint (`traceUrl` + traceId) and counts the
  spans that belong to the declared project and carry the declared TRUST execution id. The agent
  locates the trace, including across asynchronous trace links; this Operation independently reads
  the selected trace and exposes the exact match as Facts for Procedure qualification.

  Background: Operation interface
    Given Environment
      | name     | type |
      | traceUrl | url  |
    And Input
      | input       | type      | cardinality |
      | traceId     | reference | one         |
      | project     | reference | one         |
      | executionId | reference | one         |
    And Produced fields
      | field             | type      | cardinality | domain |
      | traceId           | reference | one         | any    |
      | project           | reference | one         | any    |
      | executionId       | reference | one         | any    |
      | spanCount         | number    | one         | any    |
      | matchingSpanCount | number    | one         | any    |

  Scenario: Run
    When HTTP "trace" gets Environment "traceUrl" appending Input "traceId" as JSON
    Then Produce with JSONata
      """
      {
        "traceId": input.traceId,
        "project": input.project,
        "executionId": input.executionId,
        "spanCount": $count(steps.trace.body.batches.scopeSpans.spans),
        "matchingSpanCount": $count(
          steps.trace.body.batches[
            resource.attributes[key = "service.name"].value.stringValue = $$.input.project
          ].scopeSpans.spans[
            attributes[key = "trust.execution.id"].value.stringValue = $$.input.executionId
          ]
        )
      }
      """
