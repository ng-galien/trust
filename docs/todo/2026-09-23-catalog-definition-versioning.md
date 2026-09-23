# Catalog discovery metadata

Date: 2026-09-23
Status: first local implementation, not published

## Product purpose

People need to find and choose the right published Operation or Procedure. They can correct the display title and existing human description, and add or remove classification tags, without publishing a new executable version. These fields describe a catalog identity; they do not define the Runner action or a Procedure's Checks. The exact published source and every engaged Plan's pinned composition remain unchanged.

Changing an executable definition still requires a new SemVer version. Canonical names remain stable identities; a rename creates a different identity.

## Implemented locally

- Each published identity has current catalog metadata: display title, description, and free-form tags. Its initial values come from the newest published definition. Later edits create numbered editorial revisions in SQLite, with optimistic conflict checking and revision history. They never rewrite a published Operation file or Procedure record.
- Both catalog pages show the current title and description. Their text search covers canonical name, current title, current description, tags, and the existing executable fields. A tag facet filters entries in each catalog.
- A published entry's overview has a form to edit its catalog details. The source view remains the immutable published snapshot; authors still create a new version for any executable change.
- The runtime exposes the editorial list, revision history, and save operation through RPC. Existing MCP catalog list/read tools show current editorial text and tags while retaining the published source snapshot. Public acceptance verifies edits to both resource kinds survive restart while their compiled catalog records remain byte-for-byte equivalent. Browser acceptance verifies the edit and discovery journey.

The metadata applies to a catalog identity across versions. This matches the catalog's identity grouping; the selected exact version remains visible and executable through the existing version selector. The historical source still contains the description present when that version was published. The overview shows the current editorial description.

## Deliberately unresolved catalog content

A short selection aid such as “when to use this” and “result produced” was discussed but not approved as a required field. The first implementation uses the existing description and tags. Tags are free-form. A controlled taxonomy, semantic similarity ranking, registry synchronization of editorial revisions, and a dedicated agent-facing MCP search tool need separate product and integration decisions. Current search is textual; it does not claim semantic similarity.

## Validation

- TypeScript project build and web build passed locally.
- Runtime public-process acceptance passed for both kinds, persistence across restart, and unchanged published definitions.
- Browser acceptance passed for editing, text search, and tag filtering in both catalog pages.
- Full Code Moniker architecture check reported zero violations.

No commit, publication, registry synchronization, or production data change was performed.
