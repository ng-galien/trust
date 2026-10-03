@trust-dsl:1 @operation:agent.response-read @version:1.0.0
Feature: Observe the response already declared in a TRUST Plan
  Reads persisted declarations through public RPC. An agent statement is not proof of delivery;
  the Procedure qualifies this observation after its required verification Checks.
  Background: Operation interface
    Given Environment
      | name | type |
      | trustRpcUrl | url |
    And Input
      | input | type | cardinality |
      | plan | string | one |
      | response | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | plan | string | one | any |
      | assignee | string | one | any |
      | response | string | one | any |
      | outcome | string | one | any |
  Scenario: Run
    When HTTP "plan" sends "POST" to Environment "trustRpcUrl" with JSONata body and reads JSON
      """
      {"jsonrpc":"2.0","id":"response-read","method":"plan.read","params":{"plan":input.plan}}
      """
    Then Produce with JSONata
      """
      {
        "plan": steps.plan.body.result.plan,
        "assignee": steps.plan.body.result.rootInputs.assignee,
        "response": steps.plan.body.result.declarations.response,
        "outcome": steps.plan.body.result.declarations.outcome
      }
      """
