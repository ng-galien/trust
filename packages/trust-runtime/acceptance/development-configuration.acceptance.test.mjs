import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

test("server configuration accepts the embedded authority and the local code helper consumes its declared path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-dev-config-"));
  const configFile = path.join(directory, "config.json");
  const codeFile = path.join(directory, "code.json");
  try {
    await writeFile(
      configFile,
      JSON.stringify({
        authentication: {
          profile: "development",
          access: {
            mode: "local-jwt",
            issuer: "https://trust-dev.example.ts.net:18447/auth/dev",
            audience: "urn:trust:runtime",
            algorithms: ["RS256"],
            maxTokenAgeSeconds: 120,
          },
          resourceUrl: "http://127.0.0.1:4498/mcp",
          development: {
            tailnetOrigin: "https://trust-dev.example.ts.net:18447",
            users: [{ login: "alice@example.com", subject: "alice-dev", scopes: ["trust.plan.list.own"] }],
            local: { subject: "alice-dev", scopes: ["trust.plan.list.own"], codeFile },
            services: [],
          },
        },
      }),
    );
    const printed = execFileSync(process.execPath, ["packages/trust-runtime/dist/src/index.js", "--print-config"], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, TRUST_CONFIG_FILE: configFile },
    });
    const publicConfig = JSON.parse(printed);
    assert.equal(publicConfig.configuration.authentication.profile, "development");
    assert.equal(
      publicConfig.configuration.authentication.development.tailnetOrigin,
      "https://trust-dev.example.ts.net:18447",
    );
    const output = execFileSync(process.execPath, ["scripts/create-development-code.mjs", configFile], {
      cwd: root,
      encoding: "utf8",
    });
    const code = output.match(/: ([A-Za-z0-9_-]+)\n$/)?.[1];
    assert.ok(code && code.length >= 24);
    assert.ok(existsSync(codeFile));
    assert.equal((await stat(codeFile)).mode & 0o077, 0);
    const content = JSON.parse(await readFile(codeFile, "utf8"));
    assert.equal(typeof content.codeHash, "string");
    assert.ok(content.expiresAt > Date.now());
    assert.ok(!JSON.stringify(content).includes(code));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
