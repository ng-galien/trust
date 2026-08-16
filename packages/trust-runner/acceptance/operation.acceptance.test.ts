import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { compileOperation } from "@trust/operation";
import { OtlpFactExporter, runOperation } from "@trust/runner";
import { afterEach, describe, expect, test } from "vitest";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const httpServers: Server[] = [];
const receivedHttpRequests: Array<{
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}> = [];
let otlpResponse = { status: 200, body: "{}" };

afterEach(async () => {
  await Promise.all([
    ...temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
    ...httpServers.splice(0).map(closeHttpServer),
  ]);
  receivedHttpRequests.splice(0);
  otlpResponse = { status: 200, body: "{}" };
});

describe("Operation runner", () => {
  test("executes the Git Operation in the project named by its Input below the Environment root", async () => {
    const projectsRoot = await temporaryDirectory("trust-runner-git-");
    const workspaceRoot = join(projectsRoot, "trust-example");
    await mkdir(workspaceRoot);
    await execute("git", ["init", "-q"], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, "tracked.txt"), "baseline\n", "utf8");
    await execute("git", ["add", "tracked.txt"], { cwd: workspaceRoot });
    await execute("git", [
      "-c", "user.name=TRUST Acceptance",
      "-c", "user.email=trust@example.invalid",
      "commit", "-qm", "baseline",
    ], { cwd: workspaceRoot });
    const { stdout: revision } = await execute("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, "untracked.txt"), "dirty\n", "utf8");

    const result = await runOperation(
      operation("git.head-read.feature"),
      { project: "trust-example" },
      { workspaceRoot: projectsRoot },
    );

    expect(result.produced).toEqual({
      headRevision: revision.trim(),
      workingTree: "dirty",
    });
  });

  test("refuses a project Input that escapes or leaves the Environment root", async () => {
    const projectsRoot = await temporaryDirectory("trust-runner-git-escape-");
    for (const project of ["../outside", "missing", "a/b"]) {
      await expect(runOperation(operation("git.head-read.feature"), { project }, { workspaceRoot: projectsRoot }))
        .rejects.toThrow(/Input "project"|does not exist/);
    }
  });

  test("resolves a Shell argument from Operation Input", async () => {
    const projectsRoot = await temporaryDirectory("trust-runner-git-compare-");
    const workspaceRoot = join(projectsRoot, "trust-example");
    await mkdir(workspaceRoot);
    await execute("git", ["init", "-q"], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, "tracked.txt"), "baseline\n", "utf8");
    await execute("git", ["add", "tracked.txt"], { cwd: workspaceRoot });
    await execute("git", [
      "-c", "user.name=TRUST Acceptance",
      "-c", "user.email=trust@example.invalid",
      "commit", "-qm", "baseline",
    ], { cwd: workspaceRoot });
    const { stdout: baseline } = await execute("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, "tracked.txt"), "change\n", "utf8");
    await execute("git", ["add", "tracked.txt"], { cwd: workspaceRoot });
    await execute("git", [
      "-c", "user.name=TRUST Acceptance",
      "-c", "user.email=trust@example.invalid",
      "commit", "-qm", "change",
    ], { cwd: workspaceRoot });

    const result = await runOperation(
      operation("git.head-compare.feature"),
      { project: "trust-example", baseRevision: baseline.trim() },
      { workspaceRoot: projectsRoot },
    );

    expect(result.produced).toMatchObject({
      comparedBaseRevision: baseline.trim(),
      commitsAhead: 1,
      workingTree: "clean",
    });
  });

  test("reads and decodes a JSON File inside its declared directory", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-file-");
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "trust-example" }), "utf8");

    const result = await runOperation(operation("file.package-read.feature"), {}, { workspaceRoot });

    expect(result.produced).toEqual({ name: "trust-example" });
    expect(result.steps).toEqual({
      manifest: {
        relativePath: "package.json",
        content: { name: "trust-example" },
      },
    });
  });

  test("reads a Text File inside its declared directory", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-file-text-");
    await writeFile(join(workspaceRoot, "LICENSE"), "TRUST license\n", "utf8");

    const result = await runOperation(operation("file.license-read.feature"), {}, { workspaceRoot });

    expect(result.produced).toEqual({ text: "TRUST license\n" });
  });

  test("fails when a JSON File is invalid", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-file-json-");
    await writeFile(join(workspaceRoot, "package.json"), "not-json", "utf8");

    await expect(runOperation(operation("file.package-read.feature"), {}, { workspaceRoot }))
      .rejects.toThrow('File "package.json" is not valid JSON');
  });

  test("refuses a File resolved outside its declared directory", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-root-");
    const outside = await temporaryDirectory("trust-runner-outside-");
    await writeFile(join(outside, "package.json"), JSON.stringify({ name: "outside" }), "utf8");
    await symlink(join(outside, "package.json"), join(workspaceRoot, "package.json"));

    await expect(runOperation(operation("file.package-read.feature"), {}, { workspaceRoot }))
      .rejects.toThrow("resolves outside Environment");
  });

  test("refuses Environment values before executing a Step", async () => {
    await expect(runOperation(
      operation("git.head-read.feature"),
      { project: "trust-example" },
      { workspaceRoot: "relative" },
    ))
      .rejects.toMatchObject({ values: "environment" });
  });

  test("fails when a Shell exits with a non-zero code", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-shell-");
    await execute("git", ["init", "-q"], { cwd: workspaceRoot });

    await expect(runOperation(
      operation("git.head-read.feature"),
      { project: "trust-example" },
      { workspaceRoot },
    ))
      .rejects.toMatchObject({ name: "ShellError" });
  });

  test("observes an explicitly accepted non-zero Shell exit", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-expected-exit-");

    const result = await runOperation(
      fixtureOperation("shell.expected-exit.feature"),
      {},
      { workspaceRoot },
    );

    expect(result.produced).toEqual({ exitCode: 1 });
  });

  test("interrupts when a Shell exit does not contain its declared output", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-unexpected-output-");
    const source = readFileSync(
      new URL("./fixtures/shell.expected-exit.feature", import.meta.url),
      "utf8",
    ).replace("Tests run: 1", "Compilation failed");

    await expect(runOperation(
      compileOperation({ source, sourceName: "shell.unexpected-output.feature" }),
      {},
      { workspaceRoot },
    )).rejects.toMatchObject({ name: "ShellError" });
  });

  test("gets and decodes JSON from a real HTTP server", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      operation("http.status-read.feature"),
      {},
      { serviceUrl: `${baseUrl}/status` },
    );

    expect(result.produced).toEqual({ service: "ready", status: 200 });
    expect(result.steps.response).toMatchObject({ status: 200, body: { service: "ready" } });
    expect(receivedHttpRequests).toEqual([
      expect.objectContaining({ method: "GET", url: "/status" }),
    ]);
  });

  test("appends one encoded Input as an HTTP path segment", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      operation("jira.issue-read.feature"),
      { issue: "TRUST-1" },
      { jiraIssueUrl: `${baseUrl}/issue/` },
    );

    expect(result.produced).toEqual({
      issue: "TRUST-1",
      summary: "Runner integration",
      issueType: "defect",
      workflowStatus: "todo",
    });
    expect(receivedHttpRequests).toContainEqual(expect.objectContaining({ url: "/issue/TRUST-1" }));
  });

  test("posts the complete typed Input as JSON", async () => {
    const baseUrl = await startHttpServer();
    const input = {
      patient: "PATIENT-1",
      admission: "ADMISSION-1",
      documents: ["DOCUMENT-1", "DOCUMENT-2"],
      documentRecordedAt: ["2026-08-15T11:00:00.000Z", "2026-08-15T11:05:00.000Z"],
    };

    const result = await runOperation(
      operation("healthcare.admission-record.feature"),
      input,
      { admissionUrl: `${baseUrl}/admissions` },
    );

    expect(result.produced).toEqual({
      admission: "ADMISSION-1",
      admissionStatus: "recorded",
      admittedAt: "2026-08-15T12:00:00.000Z",
    });
    expect(receivedHttpRequests).toContainEqual(expect.objectContaining({
      method: "POST",
      url: "/admissions",
      body: JSON.stringify(input),
    }));
  });

  test("does not forward a posted Input through an HTTP redirect", async () => {
    const baseUrl = await startHttpServer();

    await expect(runOperation(
      operation("healthcare.admission-record.feature"),
      {
        patient: "PATIENT-1",
        admission: "ADMISSION-1",
        documents: ["DOCUMENT-1"],
        documentRecordedAt: ["2026-08-15T11:00:00.000Z"],
      },
      { admissionUrl: `${baseUrl}/redirect-admissions` },
    )).rejects.toThrow();

    expect(receivedHttpRequests.some((request) => request.url === "/redirect-target")).toBe(false);
  });

  test("reads one professional document with its recorded instant", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      operation("healthcare.document-read.feature"),
      { document: "DOCUMENT-1" },
      { documentUrl: `${baseUrl}/documents/` },
    );

    expect(result.produced).toEqual({
      document: "DOCUMENT-1",
      documentStatus: "confirmed",
      recordedAt: "2026-08-15T11:00:00.000Z",
    });
  });

  test("gets Text from a real HTTP server", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      operation("http.text-read.feature"),
      {},
      { serviceUrl: `${baseUrl}/text` },
    );

    expect(result.produced).toEqual({ body: "ready", status: 200 });
  });

  test("preserves an empty HTTP Text response", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      operation("http.text-read.feature"),
      {},
      { serviceUrl: `${baseUrl}/empty-text` },
    );

    expect(result.produced).toEqual({ body: "", status: 200 });
  });

  test("fails on a non-success HTTP status", async () => {
    const baseUrl = await startHttpServer();

    await expect(runOperation(
      operation("http.status-read.feature"),
      {},
      { serviceUrl: `${baseUrl}/missing` },
    )).rejects.toMatchObject({
      name: "HttpStatusError",
      status: 404,
    });
  });

  test("fails when an HTTP JSON response is invalid", async () => {
    const baseUrl = await startHttpServer();

    await expect(runOperation(
      operation("http.status-read.feature"),
      {},
      { serviceUrl: `${baseUrl}/invalid-json` },
    )).rejects.toThrow("HTTP response is not valid JSON");
  });

  test("validates values produced from an HTTP response", async () => {
    const baseUrl = await startHttpServer();

    await expect(runOperation(
      operation("http.status-read.feature"),
      {},
      { serviceUrl: `${baseUrl}/missing-service` },
    )).rejects.toMatchObject({ values: "produced" });
  });

  test("exports Facts as an OpenTelemetry trace through HTTP", async () => {
    const baseUrl = await startHttpServer();
    const exporter = new OtlpFactExporter(`${baseUrl}/v1/traces`);

    await exporter.export({
      attemptKey: "attempt-1",
      attemptHandle: "attempt-1",
      checkUri: "trust://local/example@1.0.0/plan/scenario/check/target",
      facts: [{
        kind: "git.head",
        observedAt: "2026-08-15T12:00:00.000Z",
        values: { revision: "abc123" },
      }],
      recordedAt: "2026-08-15T12:00:00.000Z",
    });

    expect(receivedHttpRequests).toHaveLength(1);
    const request = receivedHttpRequests[0];
    expect(request).toMatchObject({
      method: "POST",
      url: "/v1/traces",
      headers: { "content-type": "application/json" },
    });
    const envelope = JSON.parse(request?.body ?? "") as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            name: string;
            attributes: Array<{ key: string; value: { stringValue: string } }>;
            events: Array<{
              name: string;
              attributes: Array<{ key: string; value: { stringValue?: string } }>;
            }>;
          }>;
        }>;
      }>;
    };
    const span = envelope.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(span?.name).toBe("trust.runner.facts");
    expect(span?.attributes).toEqual(expect.arrayContaining([
      { key: "trust.attempt_key", value: { stringValue: "attempt-1" } },
      { key: "trust.attempt_handle", value: { stringValue: "attempt-1" } },
      {
        key: "trust.check_uri",
        value: { stringValue: "trust://local/example@1.0.0/plan/scenario/check/target" },
      },
    ]));
    expect(span?.events[0]).toMatchObject({
      name: "trust.runner.fact",
      attributes: expect.arrayContaining([
        {
          key: "trust.fact.kind",
          value: { stringValue: "git.head" },
        },
        {
          key: "trust.fact.observed_at",
          value: { stringValue: "2026-08-15T12:00:00.000Z" },
        },
        {
          key: "trust.fact.values",
          value: {
            kvlistValue: {
              values: [{ key: "revision", value: { stringValue: "abc123" } }],
            },
          },
        },
      ]),
    });
  });

  test("fails when the OpenTelemetry endpoint rejects the request", async () => {
    otlpResponse = { status: 503, body: "unavailable" };
    const baseUrl = await startHttpServer();
    const exporter = new OtlpFactExporter(`${baseUrl}/v1/traces`);

    await expect(exporter.export(factTrace()))
      .rejects.toThrow("OTLP export failed with HTTP 503");
  });

  test("fails when OpenTelemetry reports rejected Facts", async () => {
    otlpResponse = {
      status: 200,
      body: JSON.stringify({
        partialSuccess: { rejectedSpans: 1, errorMessage: "invalid Fact" },
      }),
    };
    const baseUrl = await startHttpServer();
    const exporter = new OtlpFactExporter(`${baseUrl}/v1/traces`);

    await expect(exporter.export(factTrace()))
      .rejects.toThrow("TRUST rejected the Facts: invalid Fact");
  });
});

function operation(name: string) {
  const source = readOperation(name);
  return compileOperation({ source, sourceName: name });
}

function fixtureOperation(name: string) {
  const source = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return compileOperation({ source, sourceName: name });
}

function readOperation(name: string): string {
  return readFileSync(new URL(`../../../assets/operations/${name}`, import.meta.url), "utf8");
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function startHttpServer(): Promise<string> {
  const server = createServer((request, response) => {
    void respond(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  httpServers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "POST" && request.url === "/v1/traces") {
    receivedHttpRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readRequest(request),
    });
    response.writeHead(otlpResponse.status, { "content-type": "application/json" });
    response.end(otlpResponse.body);
    return;
  }
  if (request.method === "POST" && request.url === "/admissions") {
    receivedHttpRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readRequest(request),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      admissionStatus: "recorded",
      admittedAt: "2026-08-15T12:00:00.000Z",
    }));
    return;
  }
  if (request.method === "POST" && request.url === "/redirect-admissions") {
    receivedHttpRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readRequest(request),
    });
    response.writeHead(307, { location: "/redirect-target" });
    response.end();
    return;
  }
  if (request.method === "POST" && request.url === "/redirect-target") {
    receivedHttpRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readRequest(request),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      admissionStatus: "recorded",
      admittedAt: "2026-08-15T12:00:00.000Z",
    }));
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { "content-type": "text/plain" });
    response.end("method not allowed");
    return;
  }
    receivedHttpRequests.push({
      method: request.method,
      url: request.url ?? "",
      headers: request.headers,
      body: "",
    });
    if (request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ service: "ready" }));
      return;
    }
    if (request.url === "/issue/TRUST-1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        summary: "Runner integration",
        issueType: "defect",
        workflowStatus: "todo",
      }));
      return;
    }
    if (request.url === "/documents/DOCUMENT-1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        documentStatus: "confirmed",
        recordedAt: "2026-08-15T11:00:00.000Z",
      }));
      return;
    }
    if (request.url === "/text") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ready");
      return;
    }
    if (request.url === "/empty-text") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("");
      return;
    }
    if (request.url === "/invalid-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json");
      return;
    }
    if (request.url === "/missing-service") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<h1>missing</h1>");
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

function factTrace() {
  return {
    attemptKey: "attempt-1",
    attemptHandle: "attempt-1",
    checkUri: "trust://local/example@1.0.0/plan/scenario/check/target",
    facts: [{
      kind: "git.head",
      observedAt: "2026-08-15T12:00:00.000Z",
      values: { revision: "abc123" },
    }],
    recordedAt: "2026-08-15T12:00:00.000Z",
  };
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
