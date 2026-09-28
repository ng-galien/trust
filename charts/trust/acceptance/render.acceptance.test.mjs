import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TRUST_CONFIGURATION_SCHEMA } from "../../../packages/trust-extension-sdk/dist/configuration.js";
import { chart, temporary, helmEnvironment, render, rm } from "./support.mjs";

test("HELM-CONTRACT chart validates and renders supported configuration", async () => {
  const directory = await temporary();
  try {
    const schema = JSON.parse(await readFile(path.join(chart, "values.schema.json"), "utf8"));
    assert.deepEqual(
      schema.properties.config,
      TRUST_CONFIGURATION_SCHEMA,
      "Chart embeds the actual canonical SDK file-input schema",
    );
    execFileSync("helm", ["lint", chart, "--strict", "-f", path.join(chart, "examples/oidc-values.yaml")], { env: await helmEnvironment(directory), stdio: "pipe" });
    const defaults = await render(directory);
    const deployment = defaults.find((value) => value.kind === "Deployment");
    assert.equal(deployment.spec.replicas, 1);
    assert.equal(deployment.spec.strategy.type, "Recreate");
    assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
    const container = deployment.spec.template.spec.containers[0];
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(container.startupProbe.httpGet.path, "/health");
    assert.equal(
      container.env.find((value) => value.name === "TRUST_DATABASE_URL").valueFrom.secretKeyRef.name,
      "trust-database",
    );
    assert.equal(
      defaults.find((value) => value.kind === "PersistentVolumeClaim").metadata.annotations["helm.sh/resource-policy"],
      "keep",
    );
    const configured = await render(directory, {
      config: {
        server: { extensionTimeoutMs: 12000, sessionDurationMs: 3600000 },
        logging: { level: "warn" },
        runner: { shellTimeoutMs: 30000, additionalPath: ["/usr/local/bin"] },
      },
      environment: { TRUST_LOG_LEVEL: "error" },
      configurationMounts: [{ name: "ca", kind: "Secret", resourceName: "private-ca" }],
      ingress: {
        enabled: true,
        host: "trust.company.example",
        className: "nginx",
        tls: [{ secretName: "trust-tls", hosts: ["trust.company.example"] }],
      },
    });
    const file = JSON.parse(configured.find((value) => value.kind === "ConfigMap").data["trust.json"]);
    assert.equal(file.server.extensionTimeoutMs, 12000);
    assert.equal(file.runner.shellTimeoutMs, 30000);
    assert.equal(configured.find((value) => value.kind === "Ingress").spec.tls[0].secretName, "trust-tls");
    const embedded = await render(directory, {
      config: { storage: { kind: "pglite", directory: "/var/lib/trust/pglite" } },
      secretEnvironment: [],
      persistence: { existingClaim: "retained-state" },
    });
    assert.ok(!embedded.some((value) => value.kind === "PersistentVolumeClaim"));
    assert.equal(
      embedded
        .find((value) => value.kind === "Deployment")
        .spec.template.spec.volumes.find((value) => value.name === "state").persistentVolumeClaim.claimName,
      "retained-state",
    );
    const introspection = await render(directory, {
      config: {
        authentication: {
          profile: "shared",
          resourceUrl: "https://trust.example.com/mcp",
          access: {
            mode: "introspection",
            issuer: "https://issuer.example.com",
            audience: "urn:trust:runtime",
            introspection: {
              clientId: "trust-introspection",
              clientSecretReference: { environment: "production", name: "issuer-introspection" },
              authenticationMethod: "client_secret_basic",
            },
          },
        },
      },
    });
    assert.equal(
      JSON.parse(introspection.find((value) => value.kind === "ConfigMap").data["trust.json"]).authentication.access
        .introspection.clientSecretReference.environment,
      "production",
    );
    for (const invalid of [
      { replicaCount: 2 },
      { config: { server: { unknownParameter: true } } },
      { config: { storage: { connectionString: "postgresql://private:never-store@db/trust" } } },
      { config: { authentication: { profile: "local" } } },
      { environment: { TRUST_PORT: "4444" } },
      { secretEnvironment: [] },
      { config: { storage: { kind: "pglite", directory: "/tmp/ephemeral" } }, secretEnvironment: [] },
    ])
      await assert.rejects(render(directory, invalid));
    for (const invalid of [
      { access: { clientSecret: "must-not-enter-release" } },
      { access: { unknownParameter: true } },
      {
        access: {
          mode: "introspection",
          tokenProfile: null,
          algorithms: null,
          introspection: {
            clientId: "trust-introspection",
            clientSecretReference: { environment: "production", name: "issuer-introspection" },
            authenticationMethod: "client_secret_basic",
            clientSecret: "must-not-enter-release",
          },
        },
      },
      { browser: { clientSecret: "must-not-enter-release" } },
      { browser: { unknownParameter: true } },
    ])
      await assert.rejects(render(directory, { config: { authentication: invalid } }));
    execFileSync("helm", ["package", chart, "--destination", directory], {
      env: await helmEnvironment(directory),
      stdio: "pipe",
    });
    const archive = path.join(directory, "trust-0.1.0.tgz");
    const packaged = execFileSync("helm", ["show", "chart", archive], {
      env: await helmEnvironment(directory),
      encoding: "utf8",
    });
    assert.match(packaged, /name: trust/);
    assert.match(packaged, /version: 0.1.0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
