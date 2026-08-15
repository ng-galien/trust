# language: en
@trust-dsl:1 @operation:food.cold-chain-read @version:1.0.0
Feature: Read simulated cold-chain data for one food batch

  Background: Operation interface
    Given Environment
      | name         | type |
      | coldChainUrl | url  |
    And Input
      | input | type      | cardinality |
      | batch | reference | one         |
    And Produced fields
      | field           | type      | cardinality | domain                            |
      | batch           | reference | one         | any                               |
      | coldChainStatus | string    | one         | enum "maintained", "interrupted"   |

  Scenario: Run
    When HTTP "coldChain" gets Environment "coldChainUrl" appending Input "batch" as JSON
    Then Produce with JSONata
      """
      { "batch": input.batch, "coldChainStatus": steps.coldChain.body.coldChainStatus }
      """
