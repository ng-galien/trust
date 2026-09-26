# Disposable deployment capacity diagnosis

## Current follow-up — 2026-09-26T10:39Z

The coordination task reported owner-authorized removal of `shadok-go-e2e`, `shadok-release-smoke` and their associated volumes. This task verified no Kind clusters and 11.2 GiB available before retrying, with Docker's filesystem still 62.7 GiB total and 48.3 GiB used. The [unchanged third smoke](helm-kind-smoke-attempt-3.json) passed and removed its disposable cluster; afterward no Kind clusters remained and the same 11.2 GiB was available. [Live readbacks and source/image comparisons](helm-retry-source-check.json) record the recovery. No additional cleanup, limit increase or Docker restart was performed by this task. The historical 96 GiB proposal below was not applied and is no longer a prerequisite for this completed smoke; it is not a current requested action.

## Historical diagnosis after the first two failed attempts

Read-only observations on 2026-09-26 after both owned Kind clusters were removed:

| Boundary | Observed capacity |
| --- | --- |
| Docker Desktop configured disk limit | `DiskSizeMiB: 65536` (64 GiB) |
| Docker Linux filesystem, read from existing PostgreSQL container | 62.7 GiB total, 56.8 GiB used, 2.7 GiB available |
| macOS Data filesystem containing the checkout | 460 GiB total, 362 GiB used, 68 GiB available |

Both disposable Kind installations reached a TRUST Pod but failed with `ENOSPC` while creating the Operations directory. During the second attempt the independent governed database replay was `NOT_VALIDATED` without a retained error detail; a subsequent direct public lifecycle diagnostic failed PostgreSQL `CREATE DATABASE` with SQLSTATE `53100`. After cluster cleanup restored available space, the same frozen Check was replayed and validated. Neither failed Kind run completed its installation/upgrade assertions. The retained clusters and database services were not restarted or reconfigured.

Only two independently approved private cache records from this task's failed image builds were deleted, reclaiming 788.1 MB each; [exact ownership and removal records](helm-cache-cleanup.json) preserve their IDs, timestamps and parents. The final image remains unchanged. [Capacity inventory](helm-capacity.json) lists remaining private, reclaimable records created during the three task build windows: approximately 788 MB of successful dependency-install cache, 60 MB of compiled output, and several 23 MB context/COPY records. They were inspected only. Shared base/final-image layers and unrelated cache, containers and volumes are excluded from any cleanup proposal. Cache sizes are reported values and must not be assumed fully additive or sufficient to make Kubernetes safe.

The concrete capacity proposal is to raise Docker Desktop **Settings → Resources → Advanced → Disk usage limit** from 64 GiB to 96 GiB, subject to the owner's approval and a fresh host-space check. This adds 32 GiB of maximum Docker capacity while the host currently has 68 GiB available. Docker documents that setting as the engine's maximum disk space, and recommends increasing disk allocation for multi-container workloads. [Official Docker Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/#advanced)

Treat applying that change as a maintenance operation: if Docker Desktop requests Apply/Restart, all Docker-hosted services can be interrupted, including the retained PostgreSQL containers and both retained Kind clusters. Stop dependent TRUST work, establish current database backups and planned service recovery, then verify database and runtime health afterward. No settings change, restart, broader purge or new Kind attempt has been performed. The 96 GiB value is an operational recommendation, not a tested guarantee of sufficient capacity.
