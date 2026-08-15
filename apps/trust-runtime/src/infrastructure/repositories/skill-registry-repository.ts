import type {
  DeploymentAnnouncement,
  DeploymentAuthorization,
  DeploymentSelection,
  RegisteredDeploymentAnnouncement,
  RegisteredSkillRelease,
  ReleaseAuthorization,
  SkillRequirement,
  SkillReleaseClaim,
  VerifiedDistribution,
} from "../../domain/skill-registry.js";
import { SkillRegistryError } from "../../domain/skill-registry.js";
import type { DatabaseDriver, DatabaseRow } from "../../ports/database.js";

interface ReleaseRow extends DatabaseRow {
  release_digest: string;
  skill: string;
  version: string;
  publisher: string;
  claim_json: string;
  registered_at: string;
}

interface DistributionRow extends DatabaseRow {
  distribution_digest: string;
  release_digest: string;
  issuer: string;
  signature: string;
  verified_at: string;
}

interface ReleaseAuthorizationRow extends DatabaseRow {
  environment: string;
  release_digest: string;
  authorized_by: string;
  authorized_at: string;
}

interface DeploymentAuthorizationRow extends DatabaseRow {
  environment: string;
  logical_deployment_key: string;
  release_digest: string;
  envelope: DeploymentAuthorization["envelope"];
  runtime_identity: string;
  authorized_by: string;
  authorized_at: string;
}

interface SelectionRow extends DatabaseRow {
  environment: string;
  capability: string;
  action_contract_digest: string;
  logical_deployment_key: string;
  selected_by: string;
  selected_at: string;
}

interface DeploymentRow extends DatabaseRow {
  environment: string;
  logical_deployment_key: string;
  envelope: RegisteredDeploymentAnnouncement["envelope"];
  runtime_identity: string;
  process_identity: string;
  release_digest: string;
  distribution_digest: string;
  probes_json: string;
  announced_at: string;
  recorded_at: string;
  lease_expires_at: string;
}

export interface SkillRegistryRepositoryDependencies {
  readonly databaseDriver: DatabaseDriver;
}

export class SkillRegistryRepository {
  readonly #database: DatabaseDriver;

  constructor({ databaseDriver }: SkillRegistryRepositoryDependencies) {
    this.#database = databaseDriver;
  }

  saveReleaseClaim(claim: SkillReleaseClaim, registeredAt: string): RegisteredSkillRelease {
    return this.#database.transaction(() => {
      const existingByDigest = this.findReleaseClaim(claim.releaseDigest);
      if (existingByDigest) {
        if (JSON.stringify(existingByDigest.claim) !== JSON.stringify(claim)) {
          throw new SkillRegistryError(
            "release-digest-collision",
            `release digest ${claim.releaseDigest} is already registered with different data`,
          );
        }
        return existingByDigest;
      }

      const existingByVersion = this.findReleaseClaimByVersion(claim.skill, claim.version);
      if (existingByVersion) {
        throw new SkillRegistryError(
          "release-version-collision",
          `Skill ${claim.skill}@${claim.version} is already bound to ${existingByVersion.claim.releaseDigest}`,
        );
      }

      this.#database
        .prepare(
          `INSERT INTO skill_release_claims (
             release_digest, skill, version, publisher, claim_json, registered_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claim.releaseDigest,
          claim.skill,
          claim.version,
          claim.publisher,
          JSON.stringify(claim),
          registeredAt,
        );
      return { claim, registeredAt };
    });
  }

  findReleaseClaim(releaseDigest: string): RegisteredSkillRelease | undefined {
    const row = this.#database
      .prepare(
        `SELECT release_digest, skill, version, publisher, claim_json, registered_at
           FROM skill_release_claims
          WHERE release_digest = ?`,
      )
      .get<ReleaseRow>(releaseDigest);
    return row ? toRelease(row) : undefined;
  }

  findReleaseClaimByVersion(skill: string, version: string): RegisteredSkillRelease | undefined {
    const row = this.#database
      .prepare(
        `SELECT release_digest, skill, version, publisher, claim_json, registered_at
           FROM skill_release_claims
          WHERE skill = ? AND version = ?`,
      )
      .get<ReleaseRow>(skill, version);
    return row ? toRelease(row) : undefined;
  }

  saveVerifiedDistribution(distribution: VerifiedDistribution): VerifiedDistribution {
    return this.#database.transaction(() => {
      const existing = this.findVerifiedDistribution(distribution.distributionDigest);
      if (existing) {
        if (
          existing.releaseDigest !== distribution.releaseDigest ||
          existing.issuer !== distribution.issuer
        ) {
          throw new SkillRegistryError(
            "distribution-digest-collision",
            `distribution digest ${distribution.distributionDigest} already has another verified provenance`,
          );
        }
        // The semantic link is the exact distribution digest, release digest and
        // independent issuer. A later, validly signed replay must return the
        // immutable receipt already stored instead of colliding on its new
        // timestamp and signature.
        return existing;
      }

      this.#database
        .prepare(
          `INSERT INTO skill_verified_distributions (
             distribution_digest, release_digest, issuer, signature, verified_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          distribution.distributionDigest,
          distribution.releaseDigest,
          distribution.issuer,
          distribution.signature,
          distribution.verifiedAt,
        );
      return distribution;
    });
  }

  findVerifiedDistribution(distributionDigest: string): VerifiedDistribution | undefined {
    const row = this.#database
      .prepare(
        `SELECT distribution_digest, release_digest, issuer, signature, verified_at
           FROM skill_verified_distributions
          WHERE distribution_digest = ?`,
      )
      .get<DistributionRow>(distributionDigest);
    return row ? toDistribution(row) : undefined;
  }

  saveReleaseAuthorization(authorization: ReleaseAuthorization): ReleaseAuthorization {
    this.#database
      .prepare(
        `INSERT INTO skill_release_authorizations (
           environment, release_digest, authorized_by, authorized_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT (environment, release_digest) DO UPDATE SET
           authorized_by = excluded.authorized_by,
           authorized_at = excluded.authorized_at`,
      )
      .run(
        authorization.environment,
        authorization.releaseDigest,
        authorization.authorizedBy,
        authorization.authorizedAt,
      );
    return authorization;
  }

  findReleaseAuthorization(
    environment: string,
    releaseDigest: string,
  ): ReleaseAuthorization | undefined {
    const row = this.#database
      .prepare(
        `SELECT environment, release_digest, authorized_by, authorized_at
           FROM skill_release_authorizations
          WHERE environment = ? AND release_digest = ?`,
      )
      .get<ReleaseAuthorizationRow>(environment, releaseDigest);
    return row ? toReleaseAuthorization(row) : undefined;
  }

  removeReleaseAuthorization(environment: string, releaseDigest: string): boolean {
    const result = this.#database
      .prepare(
        `DELETE FROM skill_release_authorizations
          WHERE environment = ? AND release_digest = ?`,
      )
      .run(environment, releaseDigest);
    return Number(result.changes) > 0;
  }

  saveDeploymentAuthorization(
    authorization: DeploymentAuthorization,
  ): DeploymentAuthorization {
    this.#database
      .prepare(
        `INSERT INTO skill_deployment_authorizations (
           environment, logical_deployment_key, release_digest, envelope, runtime_identity,
           authorized_by, authorized_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (
           environment, logical_deployment_key, release_digest, envelope, runtime_identity
         ) DO UPDATE SET
           authorized_by = excluded.authorized_by,
           authorized_at = excluded.authorized_at`,
      )
      .run(
        authorization.environment,
        authorization.logicalDeploymentKey,
        authorization.releaseDigest,
        authorization.envelope,
        authorization.runtimeIdentity,
        authorization.authorizedBy,
        authorization.authorizedAt,
      );
    return authorization;
  }

  findDeploymentAuthorization(
    environment: string,
    logicalDeploymentKey: string,
    releaseDigest: string,
    envelope: DeploymentAuthorization["envelope"],
    runtimeIdentity: string,
  ): DeploymentAuthorization | undefined {
    const row = this.#database
      .prepare(
        `SELECT environment, logical_deployment_key, release_digest, envelope, runtime_identity,
                authorized_by, authorized_at
           FROM skill_deployment_authorizations
          WHERE environment = ?
            AND logical_deployment_key = ?
            AND release_digest = ?
            AND envelope = ?
            AND runtime_identity = ?`,
      )
      .get<DeploymentAuthorizationRow>(
        environment,
        logicalDeploymentKey,
        releaseDigest,
        envelope,
        runtimeIdentity,
      );
    return row ? toDeploymentAuthorization(row) : undefined;
  }

  removeDeploymentAuthorization(
    environment: string,
    logicalDeploymentKey: string,
    releaseDigest: string,
    envelope: DeploymentAuthorization["envelope"],
    runtimeIdentity: string,
  ): boolean {
    const result = this.#database
      .prepare(
        `DELETE FROM skill_deployment_authorizations
          WHERE environment = ?
            AND logical_deployment_key = ?
            AND release_digest = ?
            AND envelope = ?
            AND runtime_identity = ?`,
      )
      .run(environment, logicalDeploymentKey, releaseDigest, envelope, runtimeIdentity);
    return Number(result.changes) > 0;
  }

  saveSelection(selection: DeploymentSelection): DeploymentSelection {
    this.#database
      .prepare(
        `INSERT INTO skill_deployment_selections (
           environment, capability, action_contract_digest,
           logical_deployment_key, selected_by, selected_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (
           environment, capability, action_contract_digest
         ) DO UPDATE SET
           logical_deployment_key = excluded.logical_deployment_key,
           selected_by = excluded.selected_by,
           selected_at = excluded.selected_at`,
      )
      .run(
        selection.environment,
        selection.capability,
        selection.actionContractDigest,
        selection.logicalDeploymentKey,
        selection.selectedBy,
        selection.selectedAt,
      );
    return selection;
  }

  findSelection(
    environment: string,
    requirement: SkillRequirement,
  ): DeploymentSelection | undefined {
    const row = this.#database
      .prepare(
        `SELECT environment, capability, action_contract_digest,
                logical_deployment_key, selected_by, selected_at
           FROM skill_deployment_selections
          WHERE environment = ?
            AND capability = ?
            AND action_contract_digest = ?`,
      )
      .get<SelectionRow>(
        environment,
        requirement.capability,
        requirement.actionContractDigest,
      );
    return row ? toSelection(row) : undefined;
  }

  findSelectionsForActionContract(
    environment: string,
    capability: string,
    actionContractDigest: string,
  ): DeploymentSelection[] {
    return this.#database
      .prepare(
        `SELECT environment, capability, action_contract_digest,
                logical_deployment_key, selected_by, selected_at
           FROM skill_deployment_selections
          WHERE environment = ?
            AND capability = ?
            AND action_contract_digest = ?
          ORDER BY logical_deployment_key`,
      )
      .all<SelectionRow>(environment, capability, actionContractDigest)
      .map(toSelection);
  }

  removeSelection(environment: string, requirement: SkillRequirement): boolean {
    const result = this.#database
      .prepare(
        `DELETE FROM skill_deployment_selections
          WHERE environment = ?
            AND capability = ?
            AND action_contract_digest = ?`,
      )
      .run(
        environment,
        requirement.capability,
        requirement.actionContractDigest,
      );
    return Number(result.changes) > 0;
  }

  saveDeploymentAnnouncement(
    announcement: RegisteredDeploymentAnnouncement,
    currentTime: string,
  ): RegisteredDeploymentAnnouncement {
    return this.#database.transaction(() => {
      const existing = this.findDeploymentAnnouncement(
        announcement.environment,
        announcement.logicalDeploymentKey,
      );
      if (existing) {
        if (
          Date.parse(existing.leaseExpiresAt) > Date.parse(currentTime) &&
          existing.processIdentity !== announcement.processIdentity
        ) {
          throw new SkillRegistryError(
            "deployment-already-active",
            `deployment ${announcement.environment}/${announcement.logicalDeploymentKey} already has an active process`,
          );
        }
        if (
          Date.parse(existing.leaseExpiresAt) > Date.parse(currentTime) &&
          !hasSameActiveIdentity(existing, announcement)
        ) {
          throw new SkillRegistryError(
            "deployment-already-active",
            `active deployment ${announcement.environment}/${announcement.logicalDeploymentKey} cannot change release or runtime identity`,
          );
        }
        if (Date.parse(announcement.announcedAt) <= Date.parse(existing.announcedAt)) {
          throw new SkillRegistryError(
            "deployment-announcement-non-monotonic",
            `deployment ${announcement.environment}/${announcement.logicalDeploymentKey} announcedAt must advance strictly`,
          );
        }
      }

      this.#database
        .prepare(
          `INSERT INTO skill_deployment_announcements (
             environment, logical_deployment_key, envelope, runtime_identity,
             process_identity, release_digest, distribution_digest,
             probes_json, announced_at, recorded_at, lease_expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (environment, logical_deployment_key) DO UPDATE SET
             envelope = excluded.envelope,
             runtime_identity = excluded.runtime_identity,
             process_identity = excluded.process_identity,
             release_digest = excluded.release_digest,
             distribution_digest = excluded.distribution_digest,
             probes_json = excluded.probes_json,
             announced_at = excluded.announced_at,
             recorded_at = excluded.recorded_at,
             lease_expires_at = excluded.lease_expires_at`,
        )
        .run(
          announcement.environment,
          announcement.logicalDeploymentKey,
          announcement.envelope,
          announcement.runtimeIdentity,
          announcement.processIdentity,
          announcement.releaseDigest,
          announcement.distributionDigest,
          JSON.stringify(announcement.probes),
          announcement.announcedAt,
          announcement.recordedAt,
          announcement.leaseExpiresAt,
        );
      return announcement;
    });
  }

  findDeploymentAnnouncement(
    environment: string,
    logicalDeploymentKey: string,
  ): RegisteredDeploymentAnnouncement | undefined {
    const row = this.#database
      .prepare(
        `SELECT environment, logical_deployment_key, envelope, runtime_identity,
                process_identity, release_digest, distribution_digest,
                probes_json, announced_at, recorded_at, lease_expires_at
           FROM skill_deployment_announcements
          WHERE environment = ? AND logical_deployment_key = ?`,
      )
      .get<DeploymentRow>(environment, logicalDeploymentKey);
    return row ? toDeployment(row) : undefined;
  }

}

function toRelease(row: ReleaseRow): RegisteredSkillRelease {
  return {
    claim: JSON.parse(row.claim_json) as SkillReleaseClaim,
    registeredAt: row.registered_at,
  };
}


function toDistribution(row: DistributionRow): VerifiedDistribution {
  return {
    distributionDigest: row.distribution_digest,
    releaseDigest: row.release_digest,
    issuer: row.issuer,
    signature: row.signature,
    verifiedAt: row.verified_at,
  };
}

function toReleaseAuthorization(row: ReleaseAuthorizationRow): ReleaseAuthorization {
  return {
    environment: row.environment,
    releaseDigest: row.release_digest,
    authorizedBy: row.authorized_by,
    authorizedAt: row.authorized_at,
  };
}

function toDeploymentAuthorization(row: DeploymentAuthorizationRow): DeploymentAuthorization {
  return {
    environment: row.environment,
    logicalDeploymentKey: row.logical_deployment_key,
    releaseDigest: row.release_digest,
    envelope: row.envelope,
    runtimeIdentity: row.runtime_identity,
    authorizedBy: row.authorized_by,
    authorizedAt: row.authorized_at,
  };
}

function toSelection(row: SelectionRow): DeploymentSelection {
  return {
    environment: row.environment,
    capability: row.capability,
    actionContractDigest: row.action_contract_digest,
    logicalDeploymentKey: row.logical_deployment_key,
    selectedBy: row.selected_by,
    selectedAt: row.selected_at,
  };
}

function toDeployment(row: DeploymentRow): RegisteredDeploymentAnnouncement {
  const base: DeploymentAnnouncement = {
    environment: row.environment,
    logicalDeploymentKey: row.logical_deployment_key,
    envelope: row.envelope,
    runtimeIdentity: row.runtime_identity,
    processIdentity: row.process_identity,
    releaseDigest: row.release_digest,
    distributionDigest: row.distribution_digest,
    probes: JSON.parse(row.probes_json) as RegisteredDeploymentAnnouncement["probes"],
    announcedAt: row.announced_at,
    leaseExpiresAt: row.lease_expires_at,
  };
  return { ...base, recordedAt: row.recorded_at };
}

function hasSameActiveIdentity(
  existing: RegisteredDeploymentAnnouncement,
  incoming: RegisteredDeploymentAnnouncement,
): boolean {
  return (
    existing.envelope === incoming.envelope &&
    existing.runtimeIdentity === incoming.runtimeIdentity &&
    existing.processIdentity === incoming.processIdentity &&
    existing.releaseDigest === incoming.releaseDigest &&
    existing.distributionDigest === incoming.distributionDigest
  );
}
