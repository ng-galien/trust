import { readFile } from "node:fs/promises";
import pg from "pg";
import { postgresOptionsWithPassword } from "../postgres-db.mjs";

const [appUrl, appPasswordFile] = process.argv.slice(2);
if (!appUrl || !appPasswordFile) throw new Error("Usage: node grant-workbench-readonly.mjs APP_URL APP_PASSWORD_FILE");
const password = (await readFile(appPasswordFile, "utf8")).trim();
const client = new pg.Client(postgresOptionsWithPassword(appUrl, password));
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("REVOKE ALL ON SCHEMA trust_mobile_companion FROM PUBLIC");
  await client.query("REVOKE ALL ON ALL TABLES IN SCHEMA trust_mobile_companion FROM trust_mobile_reader");
  await client.query("GRANT USAGE ON SCHEMA trust_mobile_companion TO trust_mobile_reader");
  await client.query(`GRANT SELECT ON
    trust_mobile_companion.schema_version,
    trust_mobile_companion.projects,
    trust_mobile_companion.conversations,
    trust_mobile_companion.subjects,
    trust_mobile_companion.subject_links,
    trust_mobile_companion.post_templates,
    trust_mobile_companion.items,
    trust_mobile_companion.article_versions,
    trust_mobile_companion.article_aliases,
    trust_mobile_companion.forms,
    trust_mobile_companion.form_fields,
    trust_mobile_companion.form_options,
    trust_mobile_companion.responses,
    trust_mobile_companion.response_values
    TO trust_mobile_reader`);
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      role: "trust_mobile_reader",
      selectTables: 14,
      excluded: ["push_keys", "push_subscriptions", "push_deliveries"],
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
