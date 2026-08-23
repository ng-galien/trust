# language: en
@trust-dsl:1 @operation:telemetry.trace-read @version:1.0.0
Feature: Read one OpenTelemetry trace

  Reads one trace by id from a Tempo-compatible endpoint (`traceUrl` + traceId, for example
  `http://tempo/api/traces/`) and counts the spans found in every resource batch.

  Background: Operation interface
    Given Environment
      | name     | type |
      | traceUrl | url  |
    And Input
      | input   | type      | cardinality |
      | traceId | reference | one         |
    And Produced fields
      | field       | type      | cardinality | domain |
      | traceId     | reference | one         | any    |
      | spanCount   | number    | one         | any    |

  Scenario: Run
    When HTTP "trace" sends "GET" to Environment "traceUrl" appending Input "traceId" and reads JSON
    Then Produce with JSONata
      """
      { "traceId": input.traceId, "spanCount": $count(steps.trace.body.batches.scopeSpans.spans) }
      """
