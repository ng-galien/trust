import pg from "pg";

export function postgresOptions(databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.port ||
    !url.username ||
    !url.pathname.slice(1) ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use a loopback PostgreSQL URL with a database and user, without a password; supply PGPASSWORD to the server process.",
    );
  return {
    connectionString: url.href,
    max: 4,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    application_name: "trust-mobile-companion",
    ssl: false,
  };
}

export function postgresOptionsWithPassword(databaseUrl, password) {
  const { connectionString, ...options } = postgresOptions(databaseUrl);
  const url = new URL(connectionString);
  return {
    ...options,
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.slice(1)),
    password,
  };
}

export function createPostgresDatabase(databaseUrl) {
  const pool = new pg.Pool(postgresOptions(databaseUrl));
  pool.on("error", () => {});
  return {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async listen(channel, onChanged) {
      if (channel !== "trust_mobile_companion_feed_changed") throw new Error("Unknown mobile notification channel.");
      const client = await pool.connect();
      try {
        await client.query(`LISTEN ${channel}`);
        client.on("notification", onChanged);
      } catch (error) {
        client.release();
        throw error;
      }
      return async () => {
        client.off("notification", onChanged);
        await client.query(`UNLISTEN ${channel}`).catch(() => {});
        client.release();
      };
    },
    close: () => pool.end(),
  };
}
