export function createCommands(getPool, publishChanged) {
  const result = (status, body, text) => ({ status, body, text });
  const invalid = () =>
    result(
      400,
      { error: "Invalid command arguments." },
      "The command arguments do not match the coordination contract.",
    );
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function tags(value) {
    if (
      !Array.isArray(value) ||
      value.length > 32 ||
      value.some(
        (tag) =>
          typeof tag !== "string" ||
          !tag.trim() ||
          tag.trim().length > 64 ||
          Array.from(tag).some((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f;
          }),
      )
    )
      return null;
    const normalized = value.map((tag) => tag.trim());
    return new Set(normalized).size === normalized.length ? normalized : null;
  }
  function missionFilters(args) {
    if (
      ["search", "project", "assignee"].some(
        (key) =>
          args[key] !== undefined &&
          (typeof args[key] !== "string" || args[key].length > 1024 || args[key].includes("\0")),
      )
    )
      return null;
    if (args.state !== undefined && !["pending", "claimed", "blocked", "completed"].includes(args.state)) return null;
    const filterTags = args.tags === undefined ? [] : tags(args.tags);
    if (!filterTags) return null;
    const values = [],
      predicates = [];
    const bind = (value) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (args.state) predicates.push(`m.state = ${bind(args.state)}`);
    if (args.project) predicates.push(`m.request->>'project' = ${bind(args.project)}`);
    if (args.assignee) predicates.push(`m.request->>'assignee' = ${bind(args.assignee)}`);
    if (args.search)
      predicates.push(
        `strpos(lower(concat_ws(' ', m.mission, m.request::text, m.response)), lower(${bind(args.search)})) > 0`,
      );
    if (filterTags.length) predicates.push(`coalesce(t.tags, '{}'::text[]) @> ${bind(filterTags)}::text[]`);
    return { values, predicates, bind };
  }
  const missionFrom =
    "FROM trust_coordination.missions m LEFT JOIN trust_coordination_classification.tags t ON t.mission = m.mission";
  return async ({ command, arguments: args }) => {
    const pool = getPool();
    if (!pool)
      return result(409, { error: "Coordination is stopped." }, "Start coordination before calling its commands.");
    if (!record(args)) return invalid();
    if (command === "missions.suggest") {
      if (
        Object.keys(args).some(
          (key) => !["field", "query", "limit", "search", "state", "project", "assignee", "tags"].includes(key),
        ) ||
        !["project", "assignee", "tags"].includes(args.field)
      )
        return invalid();
      const query = args.query === undefined ? "" : args.query,
        limit = args.limit === undefined ? 10 : args.limit;
      if (
        typeof query !== "string" ||
        query.length > 1024 ||
        query.includes("\0") ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20
      )
        return invalid();
      const filters = missionFilters(args);
      if (!filters) return invalid();
      const { values, predicates, bind } = filters;
      const value =
        args.field === "tags"
          ? "suggestion.value"
          : args.field === "project"
            ? "m.request->>'project'"
            : "m.request->>'assignee'";
      const source =
        args.field === "tags"
          ? `${missionFrom} CROSS JOIN LATERAL unnest(coalesce(t.tags, '{}'::text[])) AS suggestion(value)`
          : missionFrom;
      predicates.push(`length(btrim(${value})) > 0`, `strpos(lower(${value}), lower(${bind(query)})) > 0`);
      const { rows } = await pool.query(
        `SELECT DISTINCT (${value}) COLLATE "C" AS value ${source} WHERE ${predicates.join(" AND ")} ORDER BY value LIMIT ${bind(limit + 1)}`,
        values,
      );
      const suggestions = rows.slice(0, limit).map((row) => row.value);
      const hasMore = rows.length > limit;
      return result(
        200,
        { field: args.field, query, values: suggestions, hasMore, limit },
        `${suggestions.length} ${args.field} suggestions from matching missions${hasMore ? "; more values match, refine the query" : ""}.\n${suggestions.map((value) => `- ${value}`).join("\n")}`,
      );
    }
    if (command === "missions.list") {
      if (
        Object.keys(args).some(
          (key) => !["limit", "offset", "search", "state", "project", "assignee", "tags"].includes(key),
        )
      )
        return invalid();
      const limit = args.limit ?? 50,
        offset = args.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
        return invalid();
      const filters = missionFilters(args);
      if (!filters) return invalid();
      const { values, predicates } = filters;
      const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
      const from = `${missionFrom} ${where}`;
      const client = await pool.connect();
      try {
        // Count and page describe the same snapshot, even if another agent updates a mission.
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const total = Number((await client.query(`SELECT count(*)::text AS total ${from}`, values)).rows[0].total);
        const { rows } = await client.query(
          `SELECT m.mission, m.request->>'plan' AS plan, m.request->>'project' AS project,
          m.request->>'assignee' AS assignee, m.owner, m.state, m.request, m.response,
          m.created_at AS "createdAt", m.updated_at AS "updatedAt", coalesce(t.tags, '{}'::text[]) AS tags,
          coalesce(t.revision, 0) AS "tagRevision" ${from}
          ORDER BY m.updated_at DESC, m.mission ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, limit, offset],
        );
        await client.query("COMMIT");
        return result(
          200,
          { missions: rows, total, limit, offset },
          `Missions ${offset + (rows.length ? 1 : 0)}–${offset + rows.length} of ${total}.\n${rows.map((row) => `- ${row.mission}: ${row.state}; assigned to ${row.assignee}; tags: ${row.tags.join(", ") || "none"}`).join("\n")}`,
        );
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    if (command === "tags.replace") {
      if (
        Object.keys(args).some((key) => !["mission", "expectedRevision", "tags"].includes(key)) ||
        typeof args.mission !== "string" ||
        !args.mission.trim() ||
        args.mission.length > 1024 ||
        args.mission.includes("\0") ||
        !Number.isInteger(args.expectedRevision) ||
        args.expectedRevision < 0 ||
        args.expectedRevision >= 2147483647
      )
        return invalid();
      const normalized = tags(args.tags);
      if (!normalized) return invalid();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 746279))", [args.mission]);
        if (
          !(await client.query("SELECT 1 FROM trust_coordination.missions WHERE mission=$1", [args.mission])).rowCount
        ) {
          await client.query("ROLLBACK");
          return result(404, { error: "Mission not found." }, "The requested mission does not exist.");
        }
        const previous = (
          await client.query(
            "SELECT revision FROM trust_coordination_classification.tags WHERE mission=$1 FOR UPDATE",
            [args.mission],
          )
        ).rows[0];
        if ((previous?.revision ?? 0) !== args.expectedRevision) {
          await client.query("ROLLBACK");
          return result(
            409,
            { error: "Tags changed. Refresh before retrying." },
            "Another edit changed these tags. Read the mission again before replacing its tags.",
          );
        }
        const { rows } = await client.query(
          `INSERT INTO trust_coordination_classification.tags(mission,tags,revision) VALUES($1,$2,1)
          ON CONFLICT(mission) DO UPDATE SET tags=excluded.tags, revision=trust_coordination_classification.tags.revision+1,
          change_id=nextval('trust_coordination_classification.changes'), updated_at=clock_timestamp()
          RETURNING mission,tags,revision AS "tagRevision"`,
          [args.mission, normalized],
        );
        await client.query("COMMIT");
        publishChanged();
        return result(
          200,
          rows[0],
          `Mission ${args.mission} reclassified. Tags: ${normalized.join(", ") || "none"}. Revision ${rows[0].tagRevision}.`,
        );
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    return result(400, { error: "Unknown command." }, "Unknown coordination command.");
  };
}
