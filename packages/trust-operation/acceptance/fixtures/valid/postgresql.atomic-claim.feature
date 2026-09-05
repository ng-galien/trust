# language: en
@trust-dsl:1 @operation:postgresql.atomic-claim @version:1.0.0
Feature: Claim one coordination key atomically

  Background: Operation interface
    Given Environment
      | name        | type   |
      | databaseUrl | string |
    And Input
      | input    | type      | cardinality |
      | resource | reference | one         |
      | owner    | reference | one         |
    And Produced fields
      | field    | type      | cardinality | domain                |
      | resource | reference | one         | any                   |
      | owner    | reference | one         | any                   |
      | state    | string    | one         | enum "claimed", "busy" |

  Scenario: Run
    When PostgreSQL "claim" executes SQL on Environment "databaseUrl" with Input as JSONB parameter $1
      """
      WITH inserted AS (
        INSERT INTO trust_connector_claims (resource, owner)
        VALUES (($1::jsonb)->>'resource', ($1::jsonb)->>'owner')
        ON CONFLICT (resource) DO NOTHING
        RETURNING resource, owner
      )
      SELECT jsonb_build_object(
        'resource', ($1::jsonb)->>'resource',
        'owner', COALESCE(
          (SELECT owner FROM inserted),
          (SELECT owner FROM trust_connector_claims WHERE resource = ($1::jsonb)->>'resource')
        ),
        'state', CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN 'claimed' ELSE 'busy' END
      ) AS result
      """
    Then Produce with JSONata
      """
      {
        "resource": steps.claim.result.resource,
        "owner": steps.claim.result.owner,
        "state": steps.claim.result.state
      }
      """
