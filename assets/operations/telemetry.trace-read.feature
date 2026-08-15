# language: en
@trust-dsl:1 @operation:telemetry.trace-read @version:1.0.0
Feature: Read one OpenTelemetry trace

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
      | markerCount | number    | one         | any    |

  Scenario: Run
    When HTTP "trace" gets Environment "traceUrl" appending Input "traceId" as JSON
    Then Produce with JSONata
      """
      { "traceId": input.traceId, "markerCount": steps.trace.body.markerCount }
      """
