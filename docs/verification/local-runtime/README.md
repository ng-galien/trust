# Retained local runtime maintenance

A development runtime may hold useful Plans, published Procedures, credentials
and execution history. Treat its database as retained unless the owner explicitly
designates it disposable. A schema mismatch does not authorize resetting it.

Before changing an installation:

1. Inspect the actual launcher, selected configuration, active listener and storage
   target. Do not infer the database from an old filename or port inventory.
2. Identify the owning process and its restart mechanism. Preserve unrelated
   installations, databases and private reverse-proxy mappings.
3. Make a consistent backup and verify restoration into a separate disposable
   target. Retain the original and existing backups until the owner explicitly
   authorizes their removal.
4. Use a data-preserving change and controlled restart when required. Compare
   retained data and exercise public RPC/MCP and the actual UI afterward.
5. Report local service verification separately from remote-device access,
   publication and deployment.

Keep instance addresses, database inventories, backup hashes, credentials,
process manifests and execution reports in private installation records outside
version control. The repository contains the reusable procedure, not a live
inventory or a substitute for the runtime's durable history.

See [server configuration](../../reference/server-configuration.md) and
[conservative SQLite import](../storage-import.md). Never replace a retained
store with an empty test database to make a service start.
