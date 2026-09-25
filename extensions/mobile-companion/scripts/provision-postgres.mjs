import { readFile } from "node:fs/promises";
import pg from "pg";
import { postgresOptionsWithPassword } from "../postgres-db.mjs";

const [adminUrl, adminPasswordFile, appPasswordFile, readerPasswordFile, databaseName = "trust_mobile_companion"] =
  process.argv.slice(2);
if (
  !adminUrl ||
  !adminPasswordFile ||
  !appPasswordFile ||
  !readerPasswordFile ||
  !/^[a-z][a-z0-9_]*$/.test(databaseName)
)
  throw new Error(
    "Usage: node provision-postgres.mjs ADMIN_URL ADMIN_PASSWORD_FILE APP_PASSWORD_FILE READER_PASSWORD_FILE [DATABASE_NAME]",
  );

const passwords = await Promise.all(
  [adminPasswordFile, appPasswordFile, readerPasswordFile].map(async (file) => (await readFile(file, "utf8")).trim()),
);
if (passwords.some((value) => value.length < 24))
  throw new Error("Each private password file must contain at least 24 characters.");
const admin = new pg.Client(postgresOptionsWithPassword(adminUrl, passwords[0]));
try {
  await admin.connect();
  const existingRoles = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [
    ["trust_mobile_app", "trust_mobile_reader"],
  ]);
  if (existingRoles.rowCount)
    throw new Error("Mobile database roles already exist; review the target before provisioning.");
  const existingDatabase = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName]);
  if (existingDatabase.rowCount)
    throw new Error("Mobile database already exists; review the target before provisioning.");
  await admin.query(`CREATE ROLE trust_mobile_app LOGIN PASSWORD ${admin.escapeLiteral(passwords[1])}`);
  await admin.query(`CREATE ROLE trust_mobile_reader LOGIN PASSWORD ${admin.escapeLiteral(passwords[2])}`);
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER trust_mobile_app`);
  await admin.query(`REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO trust_mobile_reader`);
  console.log(
    JSON.stringify({ database: databaseName, appRole: "trust_mobile_app", readerRole: "trust_mobile_reader" }),
  );
} finally {
  await admin.end();
}
