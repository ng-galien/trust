import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { postgresOptionsWithPassword } from "../postgres-db.mjs";

const databaseUrl = process.env.TRUST_MOBILE_TEST_READER_URL;

test("Workbench role reads mobile data but cannot change it or read push secrets", {
  skip: !databaseUrl || !process.env.TRUST_MOBILE_TEST_READER_PASSWORD_FILE,
  timeout: 30000,
}, async () => {
  const password = (await readFile(process.env.TRUST_MOBILE_TEST_READER_PASSWORD_FILE, "utf8")).trim();
  const client = new pg.Client(postgresOptionsWithPassword(databaseUrl, password));
  try {
    await client.connect();
    assert.equal(
      (await client.query("SELECT title FROM trust_mobile_companion.projects WHERE id='trust'")).rows[0].title,
      "TRUST",
    );
    assert.equal(
      (await client.query("SELECT count(*)::integer AS n FROM trust_mobile_companion.article_versions")).rows[0].n,
      2,
    );
    for (const sql of [
      "INSERT INTO trust_mobile_companion.projects(id,title,description,status) VALUES('forbidden','Forbidden','','active')",
      "UPDATE trust_mobile_companion.projects SET title='Changed' WHERE id='trust'",
      "DELETE FROM trust_mobile_companion.projects WHERE id='trust'",
      "CREATE TABLE trust_mobile_companion.forbidden(id integer)",
      "SELECT private_key FROM trust_mobile_companion.push_keys",
      "SELECT endpoint FROM trust_mobile_companion.push_subscriptions",
    ]) {
      await assert.rejects(client.query(sql), (error) => error.code === "42501");
    }
  } finally {
    await client.end();
  }
});
