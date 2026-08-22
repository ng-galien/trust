import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

test("the runtime keeps request query values out of diagnostics and bounds repeated failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-runtime-http-log-"));
  const logPath = path.join(directory, "runtime.log");
  const runtime = spawn(
    process.execPath,
    [path.join(repositoryRoot, "packages/trust-runtime/dist/src/index.js")],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        TRUST_HOST: "127.0.0.1",
        TRUST_PORT: "0",
        TRUST_DATABASE_PATH: path.join(directory, "runtime.sqlite"),
        TRUST_OPERATIONS_DIRECTORY: path.join(repositoryRoot, "assets/operations"),
        TRUST_RUNTIME_LOG_PATH: logPath,
      },
      stdio: "pipe",
    },
  );
  runtime.stdout.setEncoding("utf8");
  runtime.stderr.setEncoding("utf8");
  try {
    const endpoint = await listeningEndpoint(runtime);
    const secret = "must-not-enter-the-log";
    assert.equal((await fetch(`${endpoint}/missing?token=${secret}`)).status, 404);
    assert.equal((await fetch(`${endpoint}/missing?token=${secret}`)).status, 404);
    runtime.kill("SIGTERM");
    const [code] = await once(runtime, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0);

    const text = await readFile(logPath, "utf8");
    assert.equal(text.includes(secret), false);
    const failures = (await logRecords(logPath)).filter(({ event, path: requestPath }) => (
      event === "http.request.completed" && requestPath === "/missing"
    ));
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.level, 40);
  } finally {
    if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("the runtime persists the stack of an uncaught process crash without hiding the failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-runtime-crash-log-"));
  const logPath = path.join(directory, "runtime.log");
  const crashHook = path.join(directory, "controlled-crash.cjs");
  await writeFile(
    crashHook,
    [
      "const write = process.stdout.write.bind(process.stdout);",
      "process.stdout.write = (chunk, ...args) => {",
      "  const result = write(chunk, ...args);",
      '  if (String(chunk).includes("TRUST runtime listening on")) {',
      '    setImmediate(() => { throw new Error("controlled runtime crash"); });',
      "  }",
      "  return result;",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  const runtime = spawn(
    process.execPath,
    [path.join(repositoryRoot, "packages/trust-runtime/dist/src/index.js")],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${crashHook}`].filter(Boolean).join(" "),
        TRUST_HOST: "127.0.0.1",
        TRUST_PORT: "0",
        TRUST_DATABASE_PATH: path.join(directory, "runtime.sqlite"),
        TRUST_OPERATIONS_DIRECTORY: path.join(repositoryRoot, "assets/operations"),
        TRUST_RUNTIME_LOG_PATH: logPath,
      },
      stdio: "pipe",
    },
  );
  runtime.stdout.setEncoding("utf8");
  runtime.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  runtime.stdout.on("data", (chunk: string) => { stdout += chunk; });
  runtime.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const [code, signal] = await once(runtime, "exit") as [number | null, NodeJS.Signals | null];
    assert.notEqual(code, 0, `runtime unexpectedly succeeded with signal ${String(signal)}`);
    assert.match(stdout, /TRUST runtime listening on 127\.0\.0\.1:\d+/);
    assert.match(stderr, /controlled runtime crash/);

    const records = await logRecords(logPath);
    assert.ok(records.some(({ event }) => event === "runtime.started"));
    const crash = records.find(({ event }) => event === "process.uncaught_exception");
    assert.equal(crash?.level, 60);
    assert.equal((crash?.err as { message?: unknown } | undefined)?.message, "controlled runtime crash");
    assert.match(String((crash?.err as { stack?: unknown } | undefined)?.stack), /controlled-crash\.cjs/);
  } finally {
    if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("the packaged runner persists a TRUST connection failure with its stack", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-runner-failure-log-"));
  const skill = path.join(directory, "trust-skill");
  const logPath = path.join(directory, "runner.log");
  try {
    await execute(process.execPath, [
      path.join(repositoryRoot, "packages/trust-runner/scripts/package-skill.ts"),
      "--output",
      skill,
    ], { cwd: repositoryRoot });
    await assert.rejects(
      execute(
        process.execPath,
        [path.join(skill, "scripts/run.js"), "trust://local/example@1.0.0/plan/scenario/check/action", "--json"],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            TRUST_RPC_ENDPOINT: "http://127.0.0.1:1/rpc",
            TRUST_OTLP_ENDPOINT: "http://127.0.0.1:1/v1/traces",
            TRUST_RUNNER_LOG_PATH: logPath,
          },
        },
      ),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, 1);
        return true;
      },
    );

    const records = await logRecords(logPath);
    assert.ok(records.some(({ event, level }) => event === "runner.message" && level === 50));
    const failure = records.find(({ event }) => event === "runner.invocation.failed");
    assert.equal(failure?.level, 50);
    assert.match(String((failure?.err as { stack?: unknown } | undefined)?.stack), /requestHttp|fetch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the trust-test server manager clears only the diagnostic log contents", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "trust-clear-logs-"));
  const runtimeLog = path.join(stateDirectory, "runtime.log");
  const runnerLog = path.join(stateDirectory, "runner.log");
  await Promise.all([
    writeFile(runtimeLog, "runtime diagnostic\n", "utf8"),
    writeFile(runnerLog, "runner diagnostic\n", "utf8"),
  ]);
  try {
    const result = await execute(
      process.execPath,
      [path.join(repositoryRoot, "environments/trust-test/scripts/server.ts"), "logs", "clear"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, TRUST_SERVER_STATE_DIRECTORY: stateDirectory },
      },
    );
    assert.match(result.stdout, /TRUST logs: cleared/);
    assert.equal(await readFile(runtimeLog, "utf8"), "");
    assert.equal(await readFile(runnerLog, "utf8"), "");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

async function logRecords(logPath: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function listeningEndpoint(runtime: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`runtime did not listen: ${stderr}`));
    }, 15_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      runtime.stdout?.off("data", onStdout);
      runtime.stderr?.off("data", onStderr);
      runtime.off("error", onError);
      runtime.off("exit", onExit);
    };
    const onStdout = (chunk: Buffer | string): void => {
      stdout += chunk.toString();
      const match = stdout.match(/TRUST runtime listening on (127\.0\.0\.1):(\d+)/);
      if (!match?.[1] || !match[2]) return;
      cleanup();
      resolve(`http://${match[1]}:${match[2]}`);
    };
    const onStderr = (chunk: Buffer | string): void => { stderr += chunk.toString(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`runtime stopped before listening (code=${String(code)}, signal=${String(signal)}): ${stderr}`));
    };
    runtime.stdout?.on("data", onStdout);
    runtime.stderr?.on("data", onStderr);
    runtime.once("error", onError);
    runtime.once("exit", onExit);
  });
}
