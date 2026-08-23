# language: en
@trust-dsl:1 @operation:maven.dependency-verify @version:1.0.0
Feature: Verify one resolved Maven dependency

  Resolves the dependency tree of one runtime project after the changed libraries have been
  installed. The expected dependency is the exact `groupId:artifactId:type:version` produced by the
  corresponding library installation. The Operation reports whether Maven resolved that version.

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input      | type      | cardinality |
      | project    | reference | one         |
      | dependency | reference | one         |
    And Produced fields
      | field            | type      | cardinality | domain                      |
      | project          | reference | one         | any                         |
      | dependency       | reference | one         | any                         |
      | dependencyStatus | string    | one         | enum "aligned", "misaligned" |

  Scenario: Run
    When Shell "dependency" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument             | source                          |
      | -B                   | literal                         |
      | dependency:tree      | literal                         |
      | -Dincludes=          | literal + Input "dependency"    |
      | -Dverbose            | literal                         |
    Then Produce with JSONata
      """
      {
        "project": input.project,
        "dependency": input.dependency,
        "dependencyStatus": $contains(steps.dependency.stdout, input.dependency) ? "aligned" : "misaligned"
      }
      """
