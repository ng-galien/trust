# language: en
@trust-dsl:1 @operation:trust.execution-id-read @version:1.0.0
Feature: Make the TRUST execution identifier available to an Operation

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Produced fields
      | field       | type   | cardinality | domain |
      | executionId | string | one         | any    |

  Scenario: Run
    When Shell "execution" runs "node" with cwd from Environment "workspaceRoot"
      | argument                                      | source          |
      | -e                                            | literal         |
      | process.stdout.write(process.argv[1] ?? "") | literal         |
      | executionId                                   | Execution "id" |
    Then Produce with JSONata
      """
      {
        "executionId": execution.id
      }
      """
