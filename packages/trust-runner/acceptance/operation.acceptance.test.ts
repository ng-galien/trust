import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { gzipSync } from "node:zlib";

import { compileOperation } from "@trust/operation";
import { CheckClient, CheckClientError, createCheckRunner, createRunnerLogging, OtlpFactExporter, runOperation, type FactExporter } from "@trust/runner";
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
let jiraWorkflowStatus = "To Do";

afterEach(async () => {
  await Promise.all([
    ...temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
    ...httpServers.splice(0).map(closeHttpServer),
  ]);
  receivedHttpRequests.splice(0);
  otlpResponse = { status: 200, body: "{}" };
  jiraWorkflowStatus = "To Do";
});

describe("Operation runner", () => {
  test("keeps the opaque Check URI separate from rotating intent query parameters", async () => {
    const admissions: unknown[][] = [];
    const runner = createCheckRunner({
      checkClient: {
        admit: async (...arguments_: unknown[]) => {
          admissions.push(arguments_);
          return {
            status: "REFUSED" as const,
            attemptKey: "intent-attempt",
            reasonCode: "test-refusal",
            reason: "Admission was observed",
          };
        },
      } as unknown as CheckClient,
      facts: { export: async () => undefined } as FactExporter,
      attemptKey: () => "intent-attempt",
    });

    const result = await runner.run(
      "trust://local/example@1.0.0/plan/scenario/check/domain-action"
      + "?intent=Inspect%20the%20current%20state&nextIntent=Prepare%20the%20next%20state",
    );

    expect(result).toMatchObject({
      status: "REFUSED",
      checkUri: "trust://local/example@1.0.0/plan/scenario/check/domain-action",
    });
    expect(admissions).toEqual([[
      "intent-attempt",
      "trust://local/example@1.0.0/plan/scenario/check/domain-action",
      "Inspect the current state",
      "Prepare the next state",
    ]]);
    await runner.run(
      "trust://local/example@1.0.0/plan/scenario/check/domain-action"
      + "?intent=Document%20the%20%7Bintent%7D%20field&nextIntent=Continue%20the%20documentation",
    );
    expect(admissions[1]).toEqual([
      "intent-attempt",
      "trust://local/example@1.0.0/plan/scenario/check/domain-action",
      "Document the {intent} field",
      "Continue the documentation",
    ]);
    await expect(runner.run(
      "trust://local/example@1.0.0/plan/scenario/check/domain-action"
      + "?intent={intent}&nextIntent={nextIntent}",
    )).rejects.toThrow("Replace the intent URI template placeholders");
  });

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

  test("passes one stable TRUST execution identifier to the Operation and its Facts", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-execution-id-");
    const executionId = "01924f0e-6f6e-4d8e-8fe8-3d2a246f177c";
    const exported: unknown[] = [];
    const runner = createCheckRunner({
      checkClient: {
        admit: async () => ({
          status: "ADMITTED" as const,
          attemptKey: "execution-attempt",
          attemptHandle: "opaque-attempt-handle",
          executionId,
          checkUri: "trust://local/example@1.0.0/plan/scenario/check/execution",
          actionInput: {},
          operation: fixtureOperation("shell.execution-id.feature"),
          environment: { workspaceRoot },
          expiresAt: "2026-08-15T13:00:00.000Z",
        }),
        finalize: async () => ({
          verdict: "VALIDATED" as const,
          reasonCode: "validated",
          reason: "The Check is validated.",
          checklistDelta: { newlySatisfied: [], newlyOpened: [], unchanged: [] },
        }),
      } as unknown as CheckClient,
      facts: { export: async (trace: unknown) => { exported.push(trace); } } as FactExporter,
      attemptKey: () => "execution-attempt",
      clock: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    const result = await runner.run("trust://local/example@1.0.0/plan/scenario/check/execution");

    expect(result).toMatchObject({
      status: "COMPLETED",
      actionOutcome: { execution: { stdout: executionId } },
    });
    expect(exported).toEqual([
      expect.objectContaining({
        attemptKey: "execution-attempt",
        attemptHandle: "opaque-attempt-handle",
        executionId,
        facts: [expect.objectContaining({ values: { executionId } })],
      }),
    ]);
  });

  test("interrupts an admitted Attempt when the Operation fails before Facts are exported", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-interruption-");
    const source = readFileSync(
      new URL("./fixtures/shell.expected-exit.feature", import.meta.url),
      "utf8",
    ).replace("| 1         | Tests run:", "| 0         | Tests run:");
    const interrupted: string[] = [];
    const runner = createCheckRunner({
      checkClient: {
        admit: async () => ({
          status: "ADMITTED" as const,
          attemptKey: "failed-operation-attempt",
          attemptHandle: "failed-operation-handle",
          executionId: "01924f0e-6f6e-4d8e-8fe8-3d2a246f177c",
          checkUri: "trust://local/example@1.0.0/plan/scenario/check/failure",
          actionInput: {},
          operation: compileOperation({ source, sourceName: "shell.failed-operation.feature" }),
          environment: { workspaceRoot },
          expiresAt: "2026-08-15T13:00:00.000Z",
        }),
        interrupt: async (attemptHandle: string) => {
          interrupted.push(attemptHandle);
          return { status: "INTERRUPTED" as const };
        },
        finalize: async () => {
          throw new Error("Finalization must not be called after an Operation failure.");
        },
      } as unknown as CheckClient,
      facts: {
        export: async () => {
          throw new Error("Facts must not be exported after an Operation failure.");
        },
      } as FactExporter,
      attemptKey: () => "failed-operation-attempt",
      clock: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    await expect(runner.run("trust://local/example@1.0.0/plan/scenario/check/failure"))
      .rejects.toThrow(/unexpected exit/);
    expect(interrupted).toEqual(["failed-operation-handle"]);
  });

  test("interrupts an admitted Attempt when Fact export fails before acceptance", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-fact-export-interruption-");
    const interrupted: string[] = [];
    const runner = createCheckRunner({
      checkClient: {
        admit: async () => ({
          status: "ADMITTED" as const,
          attemptKey: "failed-export-attempt",
          attemptHandle: "failed-export-handle",
          executionId: "01924f0e-6f6e-4d8e-8fe8-3d2a246f177c",
          checkUri: "trust://local/example@1.0.0/plan/scenario/check/export-failure",
          actionInput: {},
          operation: fixtureOperation("shell.execution-id.feature"),
          environment: { workspaceRoot },
          expiresAt: "2026-08-15T13:00:00.000Z",
        }),
        interrupt: async (attemptHandle: string) => {
          interrupted.push(attemptHandle);
          return { status: "INTERRUPTED" as const };
        },
        finalize: async () => {
          throw new Error("Finalization must not be called after Fact export failure.");
        },
      } as unknown as CheckClient,
      facts: {
        export: async () => {
          throw new Error("OTLP transport failed before acceptance.");
        },
      } as FactExporter,
      attemptKey: () => "failed-export-attempt",
      clock: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    await expect(runner.run("trust://local/example@1.0.0/plan/scenario/check/export-failure"))
      .rejects.toThrow("OTLP transport failed before acceptance");
    expect(interrupted).toEqual(["failed-export-handle"]);
  });

  test("finalizes the admitted Attempt when the Fact export response is lost after acceptance", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-lost-fact-response-");
    const finalized: string[] = [];
    const runner = createCheckRunner({
      checkClient: {
        admit: async () => ({
          status: "ADMITTED" as const,
          attemptKey: "lost-response-attempt",
          attemptHandle: "lost-response-handle",
          executionId: "01924f0e-6f6e-4d8e-8fe8-3d2a246f177c",
          checkUri: "trust://local/example@1.0.0/plan/scenario/check/lost-response",
          actionInput: {},
          operation: fixtureOperation("shell.execution-id.feature"),
          environment: { workspaceRoot },
          expiresAt: "2026-08-15T13:00:00.000Z",
        }),
        interrupt: async () => {
          throw new CheckClientError(
            "check.attempt.interrupt",
            "facts-present",
            "An Attempt with accepted Facts cannot be interrupted",
          );
        },
        finalize: async (attemptHandle: string) => {
          finalized.push(attemptHandle);
          return {
            verdict: "VALIDATED" as const,
            reasonCode: "check-qualified",
            reason: "The accepted Facts satisfy the Check",
            checklistDelta: {
              newlySatisfied: ["lost-response"],
              newlyOpened: [],
              unchanged: [],
            },
          };
        },
      } as unknown as CheckClient,
      facts: {
        export: async () => {
          throw new Error("OTLP response was lost after acceptance.");
        },
      } as FactExporter,
      attemptKey: () => "lost-response-attempt",
      clock: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    await expect(runner.run("trust://local/example@1.0.0/plan/scenario/check/lost-response"))
      .resolves.toMatchObject({ status: "COMPLETED", verdict: "VALIDATED" });
    expect(finalized).toEqual(["lost-response-handle"]);
  });

  test("preserves the runtime reason on a rejected Check RPC call", async () => {
    const baseUrl = await startHttpServer();
    const client = new CheckClient(`${baseUrl}/rpc`);

    await expect(client.interrupt("facts-present-handle")).rejects.toMatchObject({
      name: "CheckClientError",
      method: "check.attempt.interrupt",
      reason: "facts-present",
    });
  });

  test("merges a committed ticket branch into main and deletes it locally", async () => {
    const projectsRoot = await temporaryDirectory("trust-runner-git-merge-");
    const workspaceRoot = join(projectsRoot, "trust-example");
    await mkdir(workspaceRoot);
    await execute("git", ["init", "-q", "--initial-branch=main"], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, "tracked.txt"), "baseline\n", "utf8");
    await execute("git", ["add", "tracked.txt"], { cwd: workspaceRoot });
    await execute("git", [
      "-c", "user.name=TRUST Acceptance",
      "-c", "user.email=trust@example.invalid",
      "commit", "-qm", "baseline",
    ], { cwd: workspaceRoot });
    await execute("git", ["switch", "-qc", "TK-00012"], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, "tracked.txt"), "change\n", "utf8");
    await execute("git", ["add", "tracked.txt"], { cwd: workspaceRoot });
    await execute("git", [
      "-c", "user.name=TRUST Acceptance",
      "-c", "user.email=trust@example.invalid",
      "commit", "-qm", "change",
    ], { cwd: workspaceRoot });

    const result = await runOperation(
      operation("git.change-merge.feature"),
      { project: "trust-example", branch: "TK-00012", ticket: "TK-00012" },
      { workspaceRoot: projectsRoot },
    );

    expect(result.produced).toMatchObject({
      mergeStatus: "merged",
      branchStatus: "deleted",
      workingTree: "clean",
    });
    expect((await execute("git", ["branch", "--show-current"], { cwd: workspaceRoot })).stdout.trim())
      .toBe("main");
    await expect(execute("git", ["show-ref", "--verify", "refs/heads/TK-00012"], { cwd: workspaceRoot }))
      .rejects.toMatchObject({ code: 128 });
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

  test("persists a failed Shell step in the runner diagnostic log", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-shell-log-");
    const logPath = join(workspaceRoot, "runner.log");
    const source = readFileSync(
      new URL("./fixtures/shell.expected-exit.feature", import.meta.url),
      "utf8",
    ).replace("| 1         | Tests run:", "| 0         | Tests run:");
    const failedOperation = compileOperation({
      source,
      sourceName: "shell.failed-log.feature",
    });
    const logging = createRunnerLogging({ TRUST_RUNNER_LOG_PATH: logPath });
    try {
      await expect(runOperation(failedOperation, {}, { workspaceRoot }, logging.diagnostics))
        .rejects.toThrow(/unexpected exit/);
    } finally {
      logging.close();
    }

    const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      readonly level?: number;
      readonly event?: string;
      readonly error?: string;
    }>;
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 50, event: "runner.step.end" }),
      expect.objectContaining({ level: 50, event: "runner.operation.end" }),
    ]));
    expect(records.find(({ event }) => event === "runner.step.end")?.error)
      .toMatch(/unexpected exit/);
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

  test("glues a literal prefix to an Input value inside one Shell argument token", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-prefixed-argument-");

    const result = await runOperation(
      fixtureOperation("shell.prefixed-argument.feature"),
      { issue: "TK-1" },
      { workspaceRoot },
    );

    // printf "%s" received exactly one token: the prefix and the Input value, no separator.
    expect(result.produced).toEqual({ argument: "-Dtrust.ticket=TK-1" });
  });

  test("finds a Shell executable through the runner additional path configuration", async () => {
    const workspaceRoot = await temporaryDirectory("trust-runner-path-workspace-");
    const executableRoot = await temporaryDirectory("trust-runner-path-bin-");
    await symlink("/bin/echo", join(executableRoot, "trust-path-probe"));

    const result = await runOperation(
      fixtureOperation("shell.additional-path.feature"),
      {},
      { workspaceRoot },
      undefined,
      {},
      { shell: { additionalPath: [executableRoot] } },
    );

    expect(result.produced).toEqual({ output: "ready" });
  });

  test("appends several encoded path segments and a query string to an HTTP GET", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      fixtureOperation("http.segments-query.feature"),
      { issue: "PAY-1", resource: "comments", run: "r1" },
      { issuesUrl: `${baseUrl}/issues` },
    );

    expect(result.produced).toEqual({ total: 2 });
    expect(receivedHttpRequests).toContainEqual(expect.objectContaining({
      method: "GET",
      url: "/issues/PAY-1/comments?limit=5&run=r1",
    }));
  });

  test("refuses to add a query to an Environment URL that already carries one", async () => {
    const baseUrl = await startHttpServer();

    await expect(runOperation(
      fixtureOperation("http.segments-query.feature"),
      { issue: "PAY-1", resource: "comments", run: "r1" },
      { issuesUrl: `${baseUrl}/issues?page=2` },
    )).rejects.toThrow("already carries a query string");
    expect(receivedHttpRequests).toEqual([]);
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

  test("sends the standardized HTTP QUERY method with path, query, header and JSONata content", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      fixtureOperation("http.query.feature"),
      { query: "status = 'open'" },
      { serviceUrl: baseUrl, apiMode: "acceptance" },
    );

    expect(result.produced).toEqual({ result: "matched", status: 200 });
    expect(receivedHttpRequests).toContainEqual(expect.objectContaining({
      method: "QUERY",
      url: "/search?limit=5",
      headers: expect.objectContaining({ "x-api-mode": "acceptance", "content-type": "application/json" }),
      body: JSON.stringify({ query: "status = 'open'" }),
    }));
  });

  test("does not decode representation metadata on a HEAD response without content", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      fixtureOperation("http.head.feature"),
      {},
      { serviceUrl: `${baseUrl}/compressed-head` },
    );

    expect(result.produced).toEqual({ status: 200 });
    expect(result.steps.metadata).toMatchObject({ status: 200, body: "" });
  });

  test("closes an HTTP response that declares an unsupported content encoding", async () => {
    const baseUrl = await startHttpServer();
    const server = httpServers.at(-1)!;

    await expect(runOperation(
      operation("http.status-read.feature"),
      {},
      { serviceUrl: `${baseUrl}/unsupported-encoding` },
    )).rejects.toThrow('unsupported content encoding "zstd"');

    await expect.poll(() => serverConnectionCount(server)).toBe(0);
  });

  test("sends CONNECT with the destination authority as its request target", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      fixtureOperation("http.connect.feature"),
      {},
      { serviceUrl: baseUrl },
    );

    expect(result.produced).toEqual({ status: 200 });
    expect(receivedHttpRequests).toContainEqual(expect.objectContaining({
      method: "CONNECT",
      url: new URL(baseUrl).host,
    }));
  });

  test("encodes multiline query values and preserves multiline Text bodies", async () => {
    const baseUrl = await startHttpServer();
    const payload = "line one\r\nline two\n";

    const result = await runOperation(
      fixtureOperation("http.text-content.feature"),
      { query: "line one\r\nline two", payload },
      { serviceUrl: `${baseUrl}/text-content` },
    );

    expect(result.produced).toEqual({ result: "accepted" });
    expect(receivedHttpRequests).toContainEqual(expect.objectContaining({
      method: "PUT",
      url: "/text-content?q=line+one%0D%0Aline+two",
      body: payload,
    }));
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

  test("transitions a Jira issue only from the declared source workflow status", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      operation("jira.issue-transition.feature"),
      { issue: "TRUST-2", fromWorkflowStatus: "todo", toWorkflowStatus: "in-progress" },
      { jiraIssueUrl: `${baseUrl}/issue/` },
    );

    expect(result.produced).toEqual({
      issue: "TRUST-2",
      fromWorkflowStatus: "todo",
      toWorkflowStatus: "in-progress",
    });
    expect(receivedHttpRequests).toContainEqual(expect.objectContaining({
      method: "POST",
      url: "/issue/TRUST-2/transitions",
      body: JSON.stringify({ transition: { id: "11" } }),
    }));
  });

  test("reconciles a Jira transition replay when the first attempt already reached the target", async () => {
    const baseUrl = await startHttpServer();
    const input = { issue: "TRUST-2", fromWorkflowStatus: "todo", toWorkflowStatus: "in-progress" };
    const environment = { jiraIssueUrl: `${baseUrl}/issue/` };

    await runOperation(operation("jira.issue-transition.feature"), input, environment);
    const replay = await runOperation(operation("jira.issue-transition.feature"), input, environment);

    expect(replay.produced).toEqual({
      issue: "TRUST-2",
      fromWorkflowStatus: "todo",
      toWorkflowStatus: "in-progress",
    });
    expect(receivedHttpRequests).toContainEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ transition: { id: "__trust_already_applied__" } }),
    }));
  });

  test("does not mutate Jira when the declared source workflow status is not current", async () => {
    const baseUrl = await startHttpServer();

    await expect(runOperation(
      operation("jira.issue-transition.feature"),
      { issue: "TRUST-2", fromWorkflowStatus: "in-progress", toWorkflowStatus: "done" },
      { jiraIssueUrl: `${baseUrl}/issue/` },
    )).rejects.toThrow("Jira issue has neither the expected source nor target workflow status");

    expect(receivedHttpRequests.some((request) => request.method === "POST")).toBe(false);
    expect(jiraWorkflowStatus).toBe("To Do");
  });

  test("counts only spans carrying the declared project and execution id", async () => {
    const baseUrl = await startHttpServer();

    const result = await runOperation(
      operation("telemetry.project-trace-read.feature"),
      { traceId: "trace-1", project: "payment-api", executionId: "execution-green" },
      { traceUrl: `${baseUrl}/traces/` },
    );

    expect(result.produced).toEqual({
      traceId: "trace-1",
      project: "payment-api",
      executionId: "execution-green",
      spanCount: 3,
      matchingSpanCount: 1,
    });
    expect(receivedHttpRequests).toContainEqual(expect.objectContaining({ url: "/traces/trace-1" }));
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
      executionId: "01924f0e-6f6e-4d8e-8fe8-3d2a246f177c",
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
        key: "trust.execution_id",
        value: { stringValue: "01924f0e-6f6e-4d8e-8fe8-3d2a246f177c" },
      },
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
  server.on("connect", (request, socket) => {
    receivedHttpRequests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: "",
    });
    socket.end("HTTP/1.1 200 Connection Established\r\ncontent-length: 0\r\n\r\n");
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
  if (request.method === "HEAD" && request.url === "/compressed-head") {
    receivedHttpRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: "",
    });
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/unsupported-encoding") {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "zstd" });
    response.write("still open");
    return;
  }
  if (request.method === "PUT" && request.url === "/text-content?q=line+one%0D%0Aline+two") {
    receivedHttpRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readRequest(request),
    });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("accepted");
    return;
  }
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
  if (request.method === "POST" && request.url === "/rpc") {
    const body = await readRequest(request);
    receivedHttpRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    const envelope = JSON.parse(body) as { id: string | number | null };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: envelope.id,
      error: {
        code: -32_010,
        message: "Plan runtime rejected",
        data: {
          contract: "trust.plan-runtime-error@1",
          reason: "facts-present",
          message: "An Attempt with accepted Facts cannot be interrupted",
        },
      },
    }));
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
  if (request.method === "QUERY" && request.url === "/search?limit=5") {
    const body = await readRequest(request);
    receivedHttpRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.end(gzipSync(JSON.stringify({ result: "matched" })));
    return;
  }
  if (request.method === "POST" && request.url === "/issue/TRUST-2/transitions") {
    const body = await readRequest(request);
    receivedHttpRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    const transition = (JSON.parse(body) as { transition?: { id?: string } }).transition?.id;
    if (jiraWorkflowStatus === "To Do" && transition === "11") jiraWorkflowStatus = "In Progress";
    else if (jiraWorkflowStatus === "In Progress" && transition === "31") jiraWorkflowStatus = "Done";
    else {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("transition is not available");
      return;
    }
    response.writeHead(204);
    response.end();
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
      // The real Jira payload shape (also served by environments/trust-test/connectors/jira-mock).
      response.end(JSON.stringify({
        key: "TRUST-1",
        fields: { summary: "Runner integration", issuetype: { name: "Defect" }, status: { name: "To Do" } },
      }));
      return;
    }
    if (request.url === "/issue/TRUST-2") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        key: "TRUST-2",
        fields: { summary: "Workflow acceptance", issuetype: { name: "Defect" }, status: { name: jiraWorkflowStatus } },
      }));
      return;
    }
    if (request.url === "/issue/TRUST-2/transitions") {
      const transitions = jiraWorkflowStatus === "To Do"
        ? [{ id: "11", name: "Start Progress", to: { name: "In Progress" } }]
        : jiraWorkflowStatus === "In Progress"
          ? [{ id: "31", name: "Done", to: { name: "Done" } }]
          : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ transitions }));
      return;
    }
    if (request.url === "/traces/trace-1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        batches: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "payment-api" } }] },
            scopeSpans: [{ spans: [
              { attributes: [{ key: "trust.execution.id", value: { stringValue: "execution-green" } }] },
              { attributes: [{ key: "trust.execution.id", value: { stringValue: "another-execution" } }] },
            ] }],
          },
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "payment-worker" } }] },
            scopeSpans: [{ spans: [
              { attributes: [{ key: "trust.execution.id", value: { stringValue: "execution-green" } }] },
            ] }],
          },
        ],
      }));
      return;
    }
    if (request.url === "/issues/PAY-1/comments?limit=5&run=r1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ total: 2, comments: ["first", "second"] }));
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
    executionId: "01924f0e-6f6e-4d8e-8fe8-3d2a246f177c",
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

async function serverConnectionCount(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.getConnections((error, count) => error ? reject(error) : resolve(count));
  });
}
