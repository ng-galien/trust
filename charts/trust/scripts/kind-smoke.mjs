import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { chart, root, temporary, freePort, helmEnvironment } from "../acceptance/support.mjs";

const execute = promisify(execFile);
const [image, reportFile] = process.argv.slice(2);
if (!image || !reportFile || !path.isAbsolute(reportFile))
  throw new Error("usage: kind-smoke.mjs <local-image:tag> <absolute-report.json>");
if (!/^[a-zA-Z0-9./_-]+:[a-zA-Z0-9._-]+$/u.test(image)) throw new Error("Use an explicit local image tag");
const directory = await temporary();
const name = `trust-helm-${randomUUID().slice(0, 8)}`;
const kubeconfig = path.join(directory, "kubeconfig");
const environment = await helmEnvironment(directory);
const kubectl = (args) =>
  execFileSync("kubectl", ["--kubeconfig", kubeconfig, "--context", `kind-${name}`, ...args], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
const helm = (args) =>
  execFileSync("helm", [...args, "--kubeconfig", kubeconfig, "--kube-context", `kind-${name}`], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
let created = false,
  forward;
const report = {
  startedAt: new Date().toISOString(),
  cluster: name,
  image,
  commands: [],
  checks: [],
  published: false,
};
try {
  const inspected = JSON.parse(execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }))[0];
  report.imageId = inspected.Id;
  report.sourceRevision = inspected.Config.Labels?.["org.opencontainers.image.revision"];
  report.architecture = inspected.Architecture;
  report.commands.push(`kind create cluster --name ${name} --kubeconfig <temporary> --wait 120s`);
  created = true;
  await execute("kind", ["create", "cluster", "--name", name, "--kubeconfig", kubeconfig, "--wait", "120s"], {
    env: environment,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await execute("kind", ["load", "docker-image", image, "--name", name], {
    env: environment,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const colon = image.lastIndexOf(":");
  const values = path.join(directory, "values.yaml");
  await writeFile(
    values,
    stringify({
      image: { repository: image.slice(0, colon), tag: image.slice(colon + 1), pullPolicy: "Never" },
      config: { storage: { kind: "pglite", directory: "/var/lib/trust/pglite" } },
      secretEnvironment: [],
      persistence: { size: "256Mi" },
    }),
  );
  report.commands.push(
    "helm install smoke charts/trust --namespace trust --create-namespace -f <temporary-values> --wait --timeout 180s",
  );
  helm([
    "install",
    "smoke",
    chart,
    "--namespace",
    "trust",
    "--create-namespace",
    "-f",
    values,
    "--wait",
    "--timeout",
    "180s",
  ]);
  const pods = () =>
    JSON.parse(kubectl(["-n", "trust", "get", "pods", "-l", "app.kubernetes.io/instance=smoke", "-o", "json"])).items;
  const first = pods();
  assert.equal(first.length, 1);
  assert.equal(first[0].status.containerStatuses[0].ready, true);
  report.checks.push("One ready non-root TRUST Pod installed from the actual local image");
  const port = await freePort();
  forward = spawn(
    "kubectl",
    [
      "--kubeconfig",
      kubeconfig,
      "--context",
      `kind-${name}`,
      "-n",
      "trust",
      "port-forward",
      "service/smoke-trust",
      `${port}:80`,
      "--address",
      "127.0.0.1",
    ],
    { env: environment, stdio: "ignore" },
  );
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + "/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Actual Kubernetes service becomes reachable");
  assert.equal((await (await fetch(origin + "/health")).json()).service, "trust-runtime");
  const html = await (await fetch(origin)).text();
  assert.match(html, /<title>TRUST<\/title>/u);
  const entry = html.match(/<script[^>]+src="([^"]+)"/u)?.[1];
  assert.ok(entry);
  assert.equal((await fetch(new URL(entry, origin))).status, 200);
  const refused = await fetch(origin + "/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plan.list", params: {} }),
  });
  assert.equal(refused.status, 401);
  report.checks.push("Actual Service serves health, built browser entry and anonymous RPC refusal");
  const marker = randomUUID();
  kubectl([
    "-n",
    "trust",
    "exec",
    first[0].metadata.name,
    "--",
    "node",
    "-e",
    "require('node:fs').writeFileSync('/var/lib/trust/helm-smoke-marker',process.argv[1])",
    marker,
  ]);
  forward.kill("SIGTERM");
  forward = undefined;
  report.commands.push(
    "helm upgrade smoke charts/trust --namespace trust -f <temporary-values> --set environment.TRUST_LOG_LEVEL=warn --wait --timeout 180s",
  );
  helm([
    "upgrade",
    "smoke",
    chart,
    "--namespace",
    "trust",
    "-f",
    values,
    "--set",
    "environment.TRUST_LOG_LEVEL=warn",
    "--wait",
    "--timeout",
    "180s",
  ]);
  const second = pods();
  assert.equal(second.length, 1);
  assert.notEqual(second[0].metadata.uid, first[0].metadata.uid);
  assert.equal(second[0].status.containerStatuses[0].ready, true);
  assert.equal(
    kubectl([
      "-n",
      "trust",
      "exec",
      second[0].metadata.name,
      "--",
      "node",
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('/var/lib/trust/helm-smoke-marker','utf8'))",
    ]),
    marker,
  );
  report.checks.push("Recreate upgrade produces one new ready Pod and preserves its PVC marker");
  helm(["uninstall", "smoke", "--namespace", "trust", "--wait", "--timeout", "120s"]);
  assert.equal(
    JSON.parse(kubectl(["-n", "trust", "get", "pvc", "smoke-trust-state", "-o", "json"])).kind,
    "PersistentVolumeClaim",
  );
  report.checks.push("Uninstall retains the state PVC before disposable cluster removal");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  forward?.kill("SIGTERM");
  if (created) {
    try {
      await execute("kind", ["delete", "cluster", "--name", name], {
        env: environment,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
      report.clusterRemoved = true;
    } catch (error) {
      report.clusterRemoved = false;
      report.cleanupError = error instanceof Error ? error.message : String(error);
      report.status = "failed";
      process.exitCode = 1;
    }
  }
  report.endedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: report.status, imageId: report.imageId, checks: report.checks, reportFile }));
