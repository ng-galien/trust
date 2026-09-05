import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startPublicRuntime } from "../../../packages/trust-runtime/dist/acceptance/support/runtime-process.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);

for (const tactic of ["listen", "force"]) {
  test(`the HTTP ${tactic} game records one die per move, enforces owning Plans and keeps the alarm until actual resumption`, {
    timeout: 60000,
  }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dragon-heist-http-"));
    const token = `test-${randomUUID()}`;
    let runtime;
    // The known proxy address forwards to the real runtime's ephemeral port; no Plan response is fabricated.
    const proxy = createServer((request, response) => {
      void (async () => {
        if (!runtime) {
          response.writeHead(503).end();
          return;
        }
        const incoming = [];
        for await (const chunk of request) incoming.push(chunk);
        const upstream = await fetch(runtime.endpoint + request.url, {
          method: request.method,
          headers: { "content-type": "application/json" },
          ...(request.method === "GET" ? {} : { body: Buffer.concat(incoming) }),
          signal: AbortSignal.timeout(10000),
        });
        response.writeHead(upstream.status, { "content-type": "application/json" }).end(await upstream.text());
      })().catch(() => response.writeHead(503).end());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const base = `http://127.0.0.1:${proxy.address().port}/extensions/dragon-heist`;
    const previousToken = process.env.DRAGON_HEIST_TOKEN;
    try {
      const manifest = JSON.parse(await readFile(path.join(root, "extensions/dragon-heist/extension.json"), "utf8"));
      delete manifest.ui;
      manifest.server = "./server.mjs";
      await copyFile(path.join(root, "extensions/dragon-heist/bundle/server.mjs"), path.join(directory, "server.mjs"));
      await copyFile(
        path.join(root, "extensions/dragon-heist/bundle/catalog.json"),
        path.join(directory, "catalog.json"),
      );
      await writeFile(path.join(directory, "extension.json"), JSON.stringify(manifest));
      const config = path.join(directory, "extensions.json");
      await writeFile(
        config,
        JSON.stringify({
          extensions: [
            {
              manifest: path.join(directory, "extension.json"),
              environment: "game",
              grants: ["plans.read", "plans.subscribe"],
              credentialEnvironment: ["DRAGON_HEIST_TOKEN"],
              configuration: { dataDirectory: path.join(directory, "game-data"), trustBaseUrl: `${base}/trust` },
            },
          ],
        }),
      );
      process.env.DRAGON_HEIST_TOKEN = token;
      runtime = await startPublicRuntime("dragon-http-process-", {
        extensionsFile: config,
        operationsDirectory: path.join(root, "assets/operations"),
        environments: { game: { gameUrl: `${base}/commands`, gameToken: token } },
      });
      const rpc = async (method, params) => {
        const response = await fetch(`${runtime.endpoint}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
        });
        const envelope = await response.json();
        assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
        return envelope.result;
      };
      const lifecycle = (action) =>
        fetch(`${base}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const command = (command, args) =>
        fetch(`${base}/commands`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command, arguments: args }),
        });
      const read = (plan) => rpc("plan.read", { plan });
      assert.equal((await lifecycle("start")).ok, false, "prepare owns schema creation");
      assert.equal((await lifecycle("prepare")).status, 200);
      assert.equal((await lifecycle("prepare")).status, 200);
      assert.equal((await lifecycle("start")).status, 200);
      const catalog = await (await fetch(`${base}/api/catalog`)).json();
      assert.equal(catalog.sourceKind, "bundled");
      assert.equal(catalog.concessionPenalty, 2);
      assert.deepEqual(catalog.scoring, {
        riskThreshold: 4,
        safeBonus: 2,
        riskyBonus: 4,
        synergyBonus: 1,
        hoardBonus: 5,
        concessionPenalty: 2,
      });
      assert.equal(catalog.procedures.length, 5);
      assert.equal(catalog.operations.length, 10);
      assert.equal(
        catalog.operations.find((value) => value.id === "dragon-heist.scout").source,
        await readFile(path.join(root, "assets/operations/dragon-heist.scout.feature"), "utf8"),
      );
      assert.equal(catalog.rules.find((value) => value.move === "turn-runes").tutorialAlarm, true);
      for (const filename of ["01-lock", "02-vault", "03-heist", "04-distraction", "05-game"])
        await rpc("procedure.publish", {
          source: await readFile(path.join(root, `assets/procedures/dragon-heist/${filename}.feature`), "utf8"),
        });
      await rpc("plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: "dragon-heist-game",
        procedureVersion: "1.0.0",
        plan: "dragon-http-root",
        environment: "game",
        rootInputs: { game: "table-one" },
      });
      assert.equal((await command("game.create", { game: "table-one", plan: "dragon-http-root" })).status, 200);
      const initial = await (await command("game.read", { game: "table-one" })).json();
      assert.deepEqual(
        await (await command("game.create", { game: "table-one", plan: "dragon-http-root" })).json(),
        initial,
      );
      assert.equal((await command("game.create", { game: "wrong-table", plan: "dragon-http-root" })).status, 403);
      assert.equal(
        (
          await command("game.move", {
            game: "table-one",
            move: "scout",
            plan: "dragon-http-root",
            choice: "",
            token: "incorrect-test-token",
          })
        ).status,
        403,
      );
      assert.equal(
        (await command("game.move", { game: "table-one", move: "scout", plan: "dragon-http-root", choice: "", token }))
          .status,
        409,
        "secret alone is not an admitted Check",
      );
      await rpc("plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: "dragon-heist-game",
        procedureVersion: "1.0.0",
        plan: "other-dragon-root",
        environment: "game",
        rootInputs: { game: "table-one" },
      });
      const other = await read("other-dragon-root");
      const otherAttempt = await rpc("check.attempt.admit", {
        contract: "trust.check-admission-request@1",
        attemptKey: "wrong-game-tree",
        checkUri: other.checks.find((value) => value.operation === "dragon-heist.scout").checkUri,
        intent: other.currentIntent,
        nextIntent: "Read the other game",
      });
      assert.equal(otherAttempt.status, "ADMITTED");
      assert.equal(
        (await command("game.move", { game: "table-one", move: "scout", plan: other.plan, choice: "", token })).status,
        403,
        "an admitted Check in another root tree cannot alter this game",
      );
      await rpc("check.attempt.interrupt", {
        contract: "trust.attempt-interruption-request@1",
        attemptHandle: otherAttempt.attemptHandle,
      });
      assert.deepEqual(await (await command("game.read", { game: "table-one" })).json(), initial);
      const play = async (plan, move, nextIntent) => {
        const view = await read(plan);
        const check = view.checks.find((value) => value.operation === `dragon-heist.${move}`);
        assert.ok(check?.actionable, JSON.stringify(view));
        const uri = new URL(check.checkUri);
        uri.searchParams.set("intent", view.currentIntent);
        if (nextIntent) uri.searchParams.set("nextIntent", nextIntent);
        const { stdout } = await execute(
          process.execPath,
          [path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"), uri.href, "--json"],
          {
            env: {
              ...process.env,
              TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
              TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
            },
            timeout: 20000,
          },
        );
        return JSON.parse(stdout);
      };
      assert.equal(
        (await play("dragon-http-root", "scout", "Count the heist after both players return")).result.qualification
          .verdict,
        "VALIDATED",
      );
      const heist = (await read("dragon-http-root")).invocations.find(
        (value) => value.name === "execute the heist",
      ).childPlan;
      const declare = async (plan, declarations) =>
        rpc("plan.declarations.replace", {
          contract: "trust.plan-declaration-replacement-request@1",
          plan,
          expectedRevision: (await read(plan)).revision,
          declarations,
        });
      const distraction = (await read("dragon-http-root")).invocations.find(
        (value) => value.name === "distract the dragon",
      ).childPlan;
      const distractionChoice = tactic === "listen" ? "song" : "lure";
      await declare(distraction, { distraction: distractionChoice });
      assert.equal((await play(distraction, "distract")).result.qualification.verdict, "VALIDATED");
      await declare(heist, { tool: "pick" });
      assert.equal(
        (await play(heist, "equip", "Escape after the vault is empty")).result.qualification.verdict,
        "VALIDATED",
      );
      const vault = (await read(heist)).invocations[0].childPlan;
      assert.equal(
        (await play(vault, "inspect-vault", "Open the vault after its lock")).result.qualification.verdict,
        "VALIDATED",
      );
      const lock = (await read(vault)).invocations[0].childPlan;
      await declare(lock, { tactic });
      const declaredLock = await read(lock);
      const choiceAttempt = await rpc("check.attempt.admit", {
        contract: "trust.check-admission-request@1",
        attemptKey: "wrong-declared-choice",
        checkUri: declaredLock.checks.find((value) => value.operation === "dragon-heist.turn-runes").checkUri,
        intent: declaredLock.currentIntent,
        nextIntent: "Open the prepared lock",
      });
      assert.equal(choiceAttempt.status, "ADMITTED");
      assert.equal(
        (
          await command("game.move", {
            game: "table-one",
            move: "turn-runes",
            plan: lock,
            choice: tactic === "listen" ? "force" : "listen",
            token,
          })
        ).status,
        403,
        "the configured token cannot override the owning agent's declaration",
      );
      await rpc("check.attempt.interrupt", {
        contract: "trust.attempt-interruption-request@1",
        attemptHandle: choiceAttempt.attemptHandle,
      });
      const blocked = await play(lock, "turn-runes", "Open the prepared lock");
      assert.equal(blocked.result.qualification.verdict, "NOT_VALIDATED");
      const alarmed = await (await command("game.read", { game: "table-one" })).json();
      const firstDie = alarmed.moves.find((value) => value.move === "turn-runes").die;
      assert.ok(Number.isInteger(firstDie) && firstDie >= 1 && firstDie <= 6);
      const distractionMove = alarmed.moves.find((value) => value.move === "distract");
      const expectedDistraction =
        distractionMove.die + (distractionChoice === "song" ? 2 : distractionMove.die >= 4 ? 4 : 0);
      const expectedLock = firstDie + (tactic === "listen" ? 2 : firstDie >= 4 ? 4 : 0) + (tactic === "force" ? 1 : 0);
      assert.equal(distractionMove.score, expectedDistraction);
      assert.equal(alarmed.moves.find((value) => value.move === "turn-runes").score, expectedLock);
      assert.equal(
        alarmed.score,
        expectedDistraction + expectedLock,
        "score follows the actual recorded safe or risky dice choices",
      );
      assert.equal(alarmed.alarm, true);
      assert.equal(alarmed.concession, null);
      assert.equal(
        (
          await command("game.move", {
            game: "table-one",
            move: "turn-runes",
            plan: "dragon-http-root",
            choice: "listen",
            token,
          })
        ).status,
        403,
      );
      assert.equal((await lifecycle("stop")).status, 200);
      assert.equal((await lifecycle("start")).status, 200);
      assert.deepEqual(
        await (await command("game.read", { game: "table-one" })).json(),
        alarmed,
        "stop/start preserves recorded actions and die",
      );
      const retry = await play(lock, "turn-runes", "Open the prepared lock");
      assert.equal(retry.result.qualification.verdict, "NOT_VALIDATED", "retry alone cannot clear the tutorial alarm");
      assert.deepEqual(
        await (await command("game.read", { game: "table-one" })).json(),
        alarmed,
        "retry cannot reroll, append or mutate the game",
      );
      const lockView = await read(lock);
      const escalation = await rpc("check.escalate", {
        contract: "trust.check-escalation-request@1",
        checkUri: lockView.checks.find((value) => value.operation === "dragon-heist.turn-runes").checkUri,
        attemptHandle: retry.result.attemptHandle,
        blockingReason: "The tutorial ward blocks the lock.",
        forbiddenFurtherAction: "Do not force the ward without an operator concession.",
      });
      assert.equal(escalation.status, "ESCALATED");
      const active = (await read(lock)).activeEscalation;
      await rpc("plan.resume", {
        plan: lock,
        escalationId: active.escalationId,
        resumeReason: "Authorize a two-point ward concession.",
      });
      assert.equal(
        (await play(lock, "turn-runes", "Open the prepared lock")).result.qualification.verdict,
        "VALIDATED",
      );
      const resolved = await (await command("game.read", { game: "table-one" })).json();
      assert.equal(resolved.alarm, false);
      assert.equal(resolved.moves.find((value) => value.move === "turn-runes").die, firstDie);
      assert.equal(resolved.moves.filter((value) => value.move === "turn-runes").length, 1);
      assert.equal(resolved.concession.escalationId, active.escalationId);
      assert.equal(resolved.score, Math.max(0, alarmed.score - 2));
      assert.ok(!JSON.stringify(resolved).includes(token));
      assert.ok(!JSON.stringify(await (await fetch(`${runtime.endpoint}/extensions`)).json()).includes(token));
      assert.equal((await fetch(`${base}/api/games/table-one?sql=select`)).status, 400);
      assert.equal((await lifecycle("stop")).status, 200);
    } finally {
      if (runtime) await runtime.close();
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
      if (previousToken === undefined) delete process.env.DRAGON_HEIST_TOKEN;
      else process.env.DRAGON_HEIST_TOKEN = previousToken;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
