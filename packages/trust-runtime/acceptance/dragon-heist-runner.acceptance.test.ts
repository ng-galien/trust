import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const execute = promisify(execFile);

for (const selection of [
  { tool: "pick", tactic: "listen", distraction: "song" },
  { tool: "charm", tactic: "force", distraction: "lure" },
])
  test(`Dragon Heist plays four real nested Plans through HTTP Runner and OTLP without rerolling (${selection.tool}/${selection.tactic}/${selection.distraction})`, {
    timeout: 120_000,
  }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "trust-dragon-runner-"));
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    const endpoint = `http://127.0.0.1:${port}`;
    const token = randomBytes(32).toString("hex");
    const registry = path.join(directory, "extensions.json");
    await writeFile(
      registry,
      JSON.stringify({
        extensions: [
          {
            manifest: path.join(root, "extensions/dragon-heist/extension.json"),
            configuration: {
              dataDirectory: path.join(directory, "game"),
              trustBaseUrl: `${endpoint}/extensions/dragon-heist/trust`,
            },
            environment: "dragon-heist",
            grants: ["plans.read", "plans.subscribe"],
            credentialEnvironment: ["DRAGON_HEIST_TOKEN"],
            autoStart: false,
          },
        ],
      }),
    );
    const runtime = await startPublicRuntime("trust-dragon-runtime-", {
      port,
      extensionsFile: registry,
      processEnvironment: { DRAGON_HEIST_TOKEN: token },
      operationsDirectory: path.join(root, "assets/operations"),
      environments: { "dragon-heist": { gameUrl: `${endpoint}/extensions/dragon-heist/commands`, gameToken: token } },
    });
    const rpc = async (method: string, params: unknown): Promise<any> => {
      const response = await fetch(`${endpoint}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const envelope = (await response.json()) as any;
      assert.equal(envelope.error, undefined, `${method} refused`);
      return envelope.result;
    };
    const read = (plan: string) => rpc("plan.read", { plan });
    const game = async (): Promise<any> =>
      (await fetch(`${endpoint}/extensions/dragon-heist/api/games/tutorial`)).json();
    const declare = async (plan: string, declarations: object) =>
      rpc("plan.declarations.replace", {
        contract: "trust.plan-declaration-replacement-request@1",
        plan,
        expectedRevision: (await read(plan)).revision,
        declarations,
      });
    const initializeIntent = async (plan: string) => {
      const response = await fetch(`${endpoint}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "trust_plan_read", arguments: { plan } },
        }),
      });
      const envelope = (await response.json()) as any;
      assert.ok(!envelope.result.isError);
    };
    let actions = 0;
    const run = async (plan: string, move: string, verdict = "VALIDATED", refused = false) => {
      await initializeIntent(plan);
      const view = await read(plan);
      const check = view.checks.find((value: any) => value.operation === `dragon-heist.${move}`);
      assert.ok(check, `Missing ${move}`);
      const uri = new URL(check.checkUri);
      uri.searchParams.set("intent", view.currentIntent);
      if (!check.completesPlan) uri.searchParams.set("nextIntent", `Continue ${plan} after ${move}`);
      const execution = await execute(
        process.execPath,
        [path.join(directory, "skill/scripts/run.js"), uri.href, "--json"],
        {
          cwd: directory,
          env: { ...process.env, TRUST_RPC_ENDPOINT: `${endpoint}/rpc`, TRUST_OTLP_ENDPOINT: `${endpoint}/v1/traces` },
        },
      );
      assert.ok(!execution.stdout.includes(token), "Runner output must not expose its move credential");
      const output = JSON.parse(execution.stdout);
      if (refused) {
        assert.equal(output.result.status, "REFUSED");
        return output;
      }
      assert.equal(output.result.status, "COMPLETED", JSON.stringify(output));
      assert.equal(output.result.qualification.verdict, verdict, JSON.stringify(output));
      actions++;
      const observed = await rpc("check.read", { contract: "trust.check-read-request@1", checkUri: check.checkUri });
      const attempt = observed.attempts[0];
      assert.equal(attempt.facts.length, 1, "the real Runner exported its HTTP observation through OTLP");
      assert.equal(attempt.facts[0].values.plan, plan);
      assert.equal(attempt.facts[0].values.move, move);
      return { ...output, attempt, check };
    };
    try {
      await execute(
        process.execPath,
        [path.join(root, "packages/trust-runner/scripts/package-skill.ts"), "--output", path.join(directory, "skill")],
        { cwd: root },
      );
      for (const transition of ["prepare", "start"])
        assert.equal(
          (
            await fetch(`${endpoint}/extensions/dragon-heist/${transition}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          ).status,
          200,
        );
      const catalog = path.join(root, "assets/procedures/dragon-heist");
      for (const file of (await readdir(catalog)).filter((value) => value.endsWith(".feature")).sort())
        await rpc("procedure.publish", { source: await readFile(path.join(catalog, file), "utf8"), sourceName: file });
      await rpc("plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: "dragon-heist-game",
        procedureVersion: "1.0.0",
        plan: "tutorial-root",
        environment: "dragon-heist",
        rootInputs: { game: "tutorial" },
      });
      assert.equal(
        (
          await fetch(`${endpoint}/extensions/dragon-heist/commands`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ command: "game.create", arguments: { game: "tutorial", plan: "tutorial-root" } }),
          })
        ).status,
        200,
      );
      await run("tutorial-root", "scout");
      const rootView = await read("tutorial-root");
      const heist = rootView.invocations.find((value: any) => value.name === "execute the heist").childPlan;
      const distraction = rootView.invocations.find((value: any) => value.name === "distract the dragon").childPlan;
      await declare(heist, { tool: selection.tool });
      await declare(distraction, { distraction: selection.distraction });
      await run(heist, "equip");
      const vault = (await read(heist)).invocations[0].childPlan;
      await run(vault, "inspect-vault");
      const lock = (await read(vault)).invocations[0].childPlan;
      await declare(lock, { tactic: selection.tactic });
      await Promise.all(["tutorial-root", heist, vault, lock, distraction].map(initializeIntent));
      const intentions = await Promise.all(
        ["tutorial-root", heist, vault, lock, distraction].map(async (plan) => (await read(plan)).currentIntent),
      );
      assert.equal(new Set(intentions).size, 5);
      const alarm = await run(lock, "turn-runes", "NOT_VALIDATED");
      const die = (await game()).moves.find((value: any) => value.move === "turn-runes").die;
      assert.ok(Number.isInteger(die) && die >= 1 && die <= 6);
      const repeated = await run(lock, "turn-runes", "NOT_VALIDATED");
      assert.equal(
        (await game()).moves.find((value: any) => value.move === "turn-runes").die,
        die,
        "retry never rerolls",
      );
      assert.equal((await game()).moves.length, 4);
      await rpc("check.escalate", {
        contract: "trust.check-escalation-request@1",
        checkUri: repeated.check.checkUri,
        attemptHandle: repeated.attempt.handle,
        blockingReason:
          "The recorded rune roll triggered the tutorial alarm; an operator must authorize continuing with the score concession.",
        forbiddenFurtherAction:
          "Do not reroll, change the selected tactic, or clear the alarm without operator resumption.",
      });
      const escalated = (await read(lock)).activeEscalation;
      assert.equal((await read("tutorial-root")).descendantEscalations[0].path.length, 3);
      await run("tutorial-root", "score", "VALIDATED", true);
      await run(lock, "turn-runes", "VALIDATED", true);
      assert.equal((await game()).moves.length, 4, "refused Runner calls cause no external move");
      await run(distraction, "distract");
      assert.equal((await read("tutorial-root")).currentIntent, intentions[0]);
      assert.equal((await read(heist)).currentIntent, intentions[1]);
      // The operator boundary used by the IHM: only this explicit resume can clear the tutorial alarm.
      await rpc("plan.resume", {
        plan: lock,
        escalationId: escalated.escalationId,
        resumeReason: "Accept the tutorial score concession and continue using the recorded die.",
      });
      await run(lock, "turn-runes");
      assert.equal((await game()).alarm, false);
      assert.equal((await game()).moves.find((value: any) => value.move === "turn-runes").die, die);
      assert.equal((await game()).concession.escalationId, escalated.escalationId);
      await run(lock, "open-lock");
      await run(vault, "open-vault");
      await run(vault, "take-hoard");
      await run(heist, "escape");
      assert.equal((await read("tutorial-root")).workState, "IN_PROGRESS");
      await run("tutorial-root", "score");
      assert.equal(actions, 12, "ten moves plus two observations of the same alarmed move");
      assert.equal((await game()).moves.length, 10);
      assert.equal((await game()).completed, true);
      const played = await game();
      assert.equal(played.tool, selection.tool);
      assert.equal(played.tactic, selection.tactic);
      assert.equal(played.moves.find((value: any) => value.move === "distract").choice, selection.distraction);
      assert.equal(
        played.score,
        played.moves.reduce((sum: number, value: any) => sum + value.score, 0) - 2,
        "recorded moves and the explicit concession determine the score",
      );
      assert.equal((await read("tutorial-root")).workState, "COMPLETE");
      assert.equal(alarm.attempt.facts[0].values.alarm, "true");
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
