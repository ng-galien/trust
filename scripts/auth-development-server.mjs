#!/usr/bin/env node
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEVELOPMENT_RESOURCE,
  DEVELOPMENT_SCOPES,
  startDevelopmentProvider,
} from "../environments/trust-test/auth/provider.mjs";

const args = process.argv.slice(2);
if (args[0] !== "--enable-development" || args[1] !== "--directory" || !args[2] || args.length !== 3) {
  process.stderr.write("usage: auth-development-server.mjs --enable-development --directory <private-directory>\n");
  process.exitCode = 2;
} else {
  let provider;
  try {
    const directory = args[2];
    const stat = await lstat(directory);
    if (
      !path.isAbsolute(directory) ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Private directory required.");
    provider = await startDevelopmentProvider({ enabled: true, port: 4521 });
    const save = (name, value) =>
      writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    const browser = {
      issuer: provider.issuer,
      clientId: "trust-browser",
      redirectUri: provider.browserRedirectUri,
      postLogoutRedirectUri: "http://127.0.0.1:4181/",
      scope: [
        "openid",
        "offline_access",
        ...DEVELOPMENT_SCOPES.filter(
          (scope) =>
            scope.endsWith(".own") ||
            /\.(read|list)$/.test(scope) ||
            /^trust\.extension\.[a-z][a-z0-9-]*\.use$/.test(scope),
        ),
      ].join(" "),
      resource: DEVELOPMENT_RESOURCE,
    };
    await save("runtime-configuration.json", {
      authentication: {
        profile: "development",
        access: provider.configuration,
        resourceUrl: "http://127.0.0.1:4530/mcp",
        browser,
      },
    });
    await save("runner-login.json", {
      issuer: provider.issuer,
      clientId: "trust-runner",
      origin: "http://127.0.0.1:4530",
      resource: DEVELOPMENT_RESOURCE,
      scope:
        "trust.plan.list.own trust.plan.read.own trust.check.read.own trust.check.attempt.admit.own trust.check.attempt.facts.own trust.check.attempt.finalize.own trust.check.attempt.interrupt.own",
      redirectUri: provider.runnerRedirectUri,
    });
    await save("clients-private.json", provider.secrets);
    await save("browser-public.json", browser);
    process.stdout.write(
      `Development OIDC issuer: ${provider.issuer}\nFixed accounts: alice, bob, admin. Enter any non-empty development password; the provider ignores it.\nEphemeral keys and sessions are discarded when this process stops. Private configuration files created.\n`,
    );
    const shutdown = async () => {
      await provider.close();
      process.exitCode = 0;
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    await provider?.close();
    process.stderr.write(
      "Development provider failed. Check loopback port availability and an empty private directory. No credentials were printed.\n",
    );
    process.exitCode = 1;
  }
}
