import { readFile } from "node:fs/promises";
import pg from "pg";
import { createCommands } from "./commands.mjs";

const expectedColumns = {
  missions: {
    mission: "text",
    request: "jsonb",
    owner: "text",
    state: "text",
    response: "text",
    created_at: "timestamptz",
    updated_at: "timestamptz",
  },
  mission_events: { sequence: "int8", mission: "text", event: "text", actor: "text", occurred_at: "timestamptz" },
};

/**
 * Trusted integration code; no TRUST database, qualification or container dependency.
 * @param {import('@trust/extension-sdk').ExtensionContext} context
 * @returns {import('@trust/extension-sdk').ExtensionLifecycle}
 */
export function createExtension({ configuration, publishChanged }) {
  const url = new URL(configuration.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.password) {
    throw new Error("Use a PostgreSQL URL without a password; configure the server credential environment.");
  }
  const options = {
    connectionString: url.href,
    max: 3,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 3000,
    application_name: "trust-extension-coordination",
  };
  let pool;
  let timer;
  let polling;
  let sequence;
  let stopped = true;
  let unavailable = false;
  const command = createCommands(() => pool, publishChanged);

  async function verifyClassification(client) {
    const { rows } = await client.query(
      "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='trust_coordination' AND table_name='tags'",
    );
    for (const [column, type] of Object.entries({
      mission: "text",
      tags: "_text",
      revision: "int4",
      change_id: "int8",
      updated_at: "timestamptz",
    })) {
      if (!rows.some((row) => row.column_name === column && row.udt_name === type))
        throw new Error("Coordination tags require explicit preparation.");
    }
    await client.query("SELECT mission,tags,revision,change_id,updated_at FROM trust_coordination.tags LIMIT 0");
  }

  async function verifyReadSchema(client) {
    const { rows } = await client.query(
      "SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[])",
      ["trust_coordination", Object.keys(expectedColumns)],
    );
    for (const [table, columns] of Object.entries(expectedColumns)) {
      for (const [column, type] of Object.entries(columns)) {
        if (!rows.some((row) => row.table_name === table && row.column_name === column && row.udt_name === type)) {
          throw new Error("Coordination read schema is absent or incompatible; explicit preparation is required.");
        }
      }
    }
    // Verify actual SELECT privileges as well as catalog shape. This read extension does not
    // certify the independent Runner's write-function contract.
    await client.query(
      "SELECT mission, request, owner, state, response, created_at, updated_at FROM trust_coordination.missions LIMIT 0",
    );
    await client.query(
      "SELECT sequence, mission, event, actor, occurred_at FROM trust_coordination.mission_events LIMIT 0",
    );
  }

  async function latestSequence(connection) {
    // Committed counts/revisions detect out-of-order commits; a maximum sequence can miss
    // an earlier allocated identifier whose transaction commits after a later identifier.
    return (
      await connection.query(
        "SELECT concat((SELECT count(*) FROM trust_coordination.mission_events), ':', (SELECT coalesce(sum(revision),0) FROM trust_coordination.tags)) AS sequence",
      )
    ).rows[0].sequence;
  }

  function schedulePoll() {
    if (stopped) return;
    timer = setTimeout(() => {
      polling = (async () => {
        try {
          const next = await latestSequence(pool);
          if (!stopped && (next !== sequence || unavailable)) publishChanged();
          sequence = next;
          unavailable = false;
        } catch {
          if (!stopped && !unavailable) publishChanged();
          unavailable = true;
        } finally {
          polling = undefined;
          schedulePoll();
        }
      })();
    }, 2000);
    timer.unref();
  }

  return {
    async prepare() {
      if (!stopped || pool) throw new Error("Stop coordination before preparation.");
      const preparation = new pg.Pool(options);
      let client;
      try {
        client = await preparation.connect();
        await client.query("BEGIN");
        // Serializes cooperating preparations in this database, not independent Runner work.
        await client.query("SELECT pg_advisory_xact_lock(746278, 1)");
        const existing = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", ["trust_coordination"]);
        if (existing.rowCount === 0) {
          const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
          await client.query(schema);
        }
        await verifyReadSchema(client);
        const {
          rows: [tags],
        } = await client.query(`
          SELECT to_regclass('trust_coordination.tags') AS current_tags,
                 to_regnamespace('trust_coordination_classification') AS legacy_schema,
                 to_regclass('trust_coordination_classification.tags') AS legacy_tags
        `);
        if (tags.legacy_schema && (!tags.legacy_tags || tags.current_tags)) {
          throw new Error("Coordination has conflicting tag schemas; inspect them before preparation.");
        }
        if (tags.legacy_tags) {
          // Explicit stopped preparation moves the existing rows and sequence atomically.
          await client.query("ALTER SEQUENCE trust_coordination_classification.changes SET SCHEMA trust_coordination");
          await client.query("ALTER TABLE trust_coordination_classification.tags SET SCHEMA trust_coordination");
          await client.query("DROP SCHEMA trust_coordination_classification");
        } else if (!tags.current_tags) {
          await client.query(await readFile(new URL("./classification.sql", import.meta.url), "utf8"));
        }
        await verifyClassification(client);
        await client.query("COMMIT");
      } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client?.release();
        await preparation.end();
      }
    },
    async start() {
      if (pool) return;
      const candidate = new pg.Pool(options);
      // Idle connection failure must not become an unhandled EventEmitter error.
      candidate.on("error", () => {
        if (!stopped && !unavailable) publishChanged();
        unavailable = true;
      });
      try {
        await verifyReadSchema(candidate);
        await verifyClassification(candidate);
        sequence = await latestSequence(candidate);
      } catch (error) {
        await candidate.end();
        throw error;
      }
      pool = candidate;
      stopped = false;
      unavailable = false;
      schedulePoll();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await polling;
      const running = pool;
      pool = undefined;
      if (running) await running.end();
    },
    async read({ path, query }) {
      if (stopped || !pool) return { status: 503, body: { error: "Coordination is stopped." } };
      if (path !== "/missions") return { status: 404, body: { error: "Unknown coordination resource." } };
      if (Object.keys(query).some((key) => key !== "limit"))
        return { status: 400, body: { error: "Unknown mission query field." } };
      const rawLimit = query.limit ?? "50";
      if (!/^[1-9][0-9]?$|^100$/.test(rawLimit))
        return { status: 400, body: { error: "Limit must be an integer from 1 to 100." } };
      return command({ command: "missions.list", arguments: { limit: Number(rawLimit) } });
    },
    command,
  };
}
