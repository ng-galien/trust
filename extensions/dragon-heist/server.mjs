import { randomInt, timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const stages = {
  scout: "game",
  equip: "heist",
  "inspect-vault": "vault",
  "turn-runes": "lock",
  "open-lock": "lock",
  "open-vault": "vault",
  "take-hoard": "vault",
  escape: "heist",
  distract: "distraction",
  score: "game",
};
const prerequisites = {
  scout: [],
  equip: ["scout"],
  "inspect-vault": ["equip"],
  "turn-runes": ["inspect-vault"],
  "open-lock": ["turn-runes"],
  "open-vault": ["open-lock"],
  "take-hoard": ["open-vault"],
  escape: ["take-hoard"],
  distract: ["scout"],
  score: ["escape", "distract"],
};
const choices = { equip: ["pick", "charm"], "turn-runes": ["force", "listen"], distract: ["song", "lure"] };
const scoring = { riskThreshold: 4, safeBonus: 2, riskyBonus: 4, synergyBonus: 1, hoardBonus: 5, concessionPenalty: 2 };
const descriptions = {
  scout: "Scout the lair before the thief and distraction act independently.",
  equip: `Choose pick to favor force, or charm to favor listening: a matching pair adds ${scoring.synergyBonus} point.`,
  "inspect-vault": "Inspect the vault before delegating its lock.",
  "turn-runes": `Record one d6. Listen adds ${scoring.safeBonus}; force adds ${scoring.riskyBonus} only on ${scoring.riskThreshold}–6. Add the matching tool bonus. The tutorial ward always requires an operator concession; retry never rerolls.`,
  "open-lock": "Open the prepared lock after the ward concession has been recorded.",
  "open-vault": "Open the vault after its lock is ready.",
  "take-hoard": `Take the treasure for ${scoring.hoardBonus} points.`,
  escape: "Escape with the treasure after the vault work is complete.",
  distract: `Record one d6. Song adds ${scoring.safeBonus}; lure adds ${scoring.riskyBonus} only on ${scoring.riskThreshold}–6. This player acts independently after scouting.`,
  score: "Count the recorded score after both the heist and distraction are complete.",
};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value, max) =>
  typeof value === "string" && value.length <= max && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
class GameError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new GameError(status, message);
};

/** External game rules and observations. No TRUST storage or qualification imports. */
/**
 * @param {import('@trust/extension-sdk').ExtensionContext} context
 * @returns {import('@trust/extension-sdk').ExtensionLifecycle}
 */
export function createExtension({ configuration, environment, publishChanged }) {
  if (!path.isAbsolute(configuration.dataDirectory))
    throw new Error("Dragon Heist requires an absolute dataDirectory.");
  const trust = new URL(configuration.trustBaseUrl);
  if (
    trust.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(trust.hostname) ||
    trust.username ||
    trust.password ||
    trust.search ||
    trust.hash ||
    !trust.pathname.endsWith("/extensions/dragon-heist/trust")
  ) {
    throw new Error("Dragon Heist requires its loopback host-granted Plan URL.");
  }
  const token = process.env.DRAGON_HEIST_TOKEN;
  if (typeof token !== "string" || token.length < 16 || token.length > 256)
    throw new Error("Configure DRAGON_HEIST_TOKEN in the extension credential environment.");
  const filename = path.join(configuration.dataDirectory, "dragon-heist.sqlite");
  let database;
  let queue = Promise.resolve();
  const readGame = (game) => {
    const row = database.prepare("SELECT state_json FROM games WHERE game = ?").get(game);
    if (!row) fail(404, "Game not found.");
    return JSON.parse(row.state_json);
  };
  const result = (body, text = "Dragon Heist observation.") => ({ status: 200, body, text });
  async function readPlan(plan) {
    const response = await fetch(`${trust.href}/plans/${encodeURIComponent(plan)}`, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) fail(409, "The host could not authorize this Plan.");
    const view = await response.json();
    if (view.plan !== plan || view.environment !== environment)
      fail(403, "The Plan is outside this game's Environment.");
    return view;
  }
  async function authorize(game, move, plan) {
    const own = await readPlan(plan);
    if (own.procedure !== `dragon-heist-${stages[move]}` || own.rootInputs?.game !== game.game)
      fail(403, "This Plan does not own the requested move.");
    const check = own.checks.find((value) => value.operation === `dragon-heist.${move}`);
    if (
      !check ||
      own.currentIntentCheckUri !== check.checkUri ||
      own.activeEscalation ||
      own.sessionState !== "OPEN" ||
      !check.actionable
    )
      fail(409, "The move requires its own admitted Check.");
    let ancestor = own;
    const seen = new Set();
    while (ancestor.plan !== game.plan) {
      if (seen.has(ancestor.plan) || seen.size >= 8 || !ancestor.parent?.current)
        fail(403, "The Plan is outside the current game tree.");
      seen.add(ancestor.plan);
      ancestor = await readPlan(ancestor.parent.plan);
      if (ancestor.activeEscalation || ancestor.rootInputs?.game !== game.game) fail(409, "The game tree is blocked.");
    }
    if (ancestor.parent || ancestor.procedure !== "dragon-heist-game") fail(403, "The game root is not authoritative.");
    return { own, check };
  }
  function save(game, event) {
    const previousRevision = game.revision;
    game.revision++;
    game.updatedAt = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const updated = database
        .prepare("UPDATE games SET state_json = ?, revision = ?, updated_at = ? WHERE game = ? AND revision = ?")
        .run(JSON.stringify(game), game.revision, game.updatedAt, game.game, previousRevision);
      if (updated.changes !== 1) fail(409, "The game changed. Read it before retrying.");
      database
        .prepare("INSERT INTO game_events(game, event_json) VALUES(?, ?)")
        .run(game.game, JSON.stringify({ ...event, at: game.updatedAt, revision: game.revision }));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    publishChanged();
  }
  const observation = (game, move) => ({
    game: game.game,
    move: move.move,
    plan: move.plan,
    recorded: true,
    ready: move.ready,
    die: move.die,
    score: game.score,
    alarm: game.alarm,
    tool: game.tool,
    tactic: game.tactic,
    dragon: game.dragon,
    chest: game.chest,
    completed: game.completed,
  });
  async function move(args) {
    if (
      !identifier(args.game, 80) ||
      !identifier(args.plan, 200) ||
      !Object.hasOwn(stages, args.move) ||
      typeof args.choice !== "string" ||
      !(choices[args.move] ?? [""]).includes(args.choice) ||
      Object.keys(args).some((key) => !["game", "move", "plan", "choice", "token"].includes(key))
    )
      fail(400, "Invalid game move.");
    if (
      typeof args.token !== "string" ||
      Buffer.byteLength(args.token) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(args.token), Buffer.from(token))
    )
      fail(403, "The game move credential was refused.");
    const game = readGame(args.game);
    const { own, check } = await authorize(game, args.move, args.plan);
    if (
      check.inputs?.game !== args.game ||
      check.inputs?.plan !== args.plan ||
      (choices[args.move] && check.inputs?.choice !== args.choice)
    )
      fail(403, "The move does not match the admitted Check inputs.");
    const previous = game.moves.find((value) => value.move === args.move);
    if (previous) {
      if (previous.plan !== args.plan || previous.choice !== args.choice)
        fail(409, "A recorded move cannot change its Plan or choice.");
      if (args.move === "turn-runes" && !previous.ready) {
        const concession = own.escalations.find(
          (value) =>
            value.checkUri === game.alarmCheckUri &&
            value.resumedAt &&
            Date.parse(value.escalatedAt) >= Date.parse(previous.recordedAt) &&
            Date.parse(value.resumedAt) >= Date.parse(value.escalatedAt),
        );
        if (concession) {
          previous.ready = true;
          game.alarm = false;
          game.dragon = game.moves.some((value) => value.move === "distract") ? "distracted" : "sleeping";
          game.score = Math.max(0, game.score - scoring.concessionPenalty);
          game.concession = {
            plan: own.plan,
            checkUri: game.alarmCheckUri,
            escalationId: concession.escalationId,
            resumedAt: concession.resumedAt,
          };
          save(game, { type: "alarm.resolved", move: args.move, ...game.concession });
        }
      }
      return result(observation(game, previous));
    }
    if (
      game.completed ||
      prerequisites[args.move].some((name) => !game.moves.some((value) => value.move === name && value.ready))
    )
      fail(409, "The game move prerequisites are not complete.");
    const die = ["turn-runes", "distract"].includes(args.move) ? randomInt(1, 7) : 0;
    const entry = {
      move: args.move,
      plan: args.plan,
      choice: args.choice,
      die,
      score: 0,
      ready: true,
      recordedAt: new Date().toISOString(),
    };
    if (args.move === "equip") game.tool = args.choice;
    if (args.move === "turn-runes") {
      game.tactic = args.choice;
      const bonus =
        args.choice === "listen" ? scoring.safeBonus : die >= scoring.riskThreshold ? scoring.riskyBonus : 0;
      const synergy =
        (game.tool === "pick" && args.choice === "force") || (game.tool === "charm" && args.choice === "listen");
      entry.score = die + bonus + (synergy ? scoring.synergyBonus : 0);
      entry.ready = false;
      game.alarm = true;
      game.alarmCheckUri = check.checkUri;
      game.dragon = "alert";
    }
    if (args.move === "distract") {
      entry.score =
        die + (args.choice === "song" ? scoring.safeBonus : die >= scoring.riskThreshold ? scoring.riskyBonus : 0);
      game.dragon = game.alarm ? "alert" : "distracted";
    }
    if (args.move === "open-lock") game.chest = "unlocked";
    if (args.move === "open-vault") game.chest = "open";
    if (args.move === "take-hoard") {
      game.chest = "empty";
      entry.score = scoring.hoardBonus;
    }
    if (args.move === "score") game.completed = true;
    game.score += entry.score;
    game.moves.push(entry);
    save(game, { type: "move.recorded", ...entry });
    return result(observation(game, entry));
  }
  async function command({ command, arguments: args }) {
    if (!database)
      return { status: 503, body: { error: "Dragon Heist is stopped." }, text: "Start Dragon Heist before play." };
    try {
      if (!record(args)) fail(400, "Invalid game arguments.");
      if (command === "game.move") return await move(args);
      if (command === "game.read") {
        if (Object.keys(args).some((key) => key !== "game")) fail(400, "Unknown game query field.");
        if (args.game !== undefined) {
          if (!identifier(args.game, 80)) fail(400, "Invalid game identity.");
          return result(readGame(args.game));
        }
        return result({
          games: database
            .prepare("SELECT state_json FROM games ORDER BY updated_at DESC, game LIMIT 30")
            .all()
            .map((row) => JSON.parse(row.state_json)),
        });
      }
      if (command === "game.create") {
        if (
          !identifier(args.game, 80) ||
          !identifier(args.plan, 200) ||
          Object.keys(args).some((key) => !["game", "plan"].includes(key))
        )
          fail(400, "Invalid game identity.");
        const root = await readPlan(args.plan);
        if (root.parent || root.procedure !== "dragon-heist-game" || root.rootInputs?.game !== args.game)
          fail(403, "Create the game for its actual root Plan.");
        const existing = database
          .prepare("SELECT state_json FROM games WHERE game = ? OR plan = ?")
          .get(args.game, args.plan);
        if (existing) {
          const game = JSON.parse(existing.state_json);
          if (game.game !== args.game || game.plan !== args.plan)
            fail(409, "Game or Plan already belongs to another game.");
          return result(game);
        }
        const at = new Date().toISOString();
        const game = {
          game: args.game,
          plan: args.plan,
          revision: 0,
          createdAt: at,
          updatedAt: at,
          tool: "none",
          tactic: "none",
          dragon: "sleeping",
          chest: "sealed",
          alarm: false,
          alarmCheckUri: null,
          concession: null,
          score: 0,
          completed: false,
          moves: [],
        };
        database
          .prepare("INSERT INTO games(game, plan, revision, updated_at, state_json) VALUES(?, ?, 0, ?, ?)")
          .run(args.game, args.plan, at, JSON.stringify(game));
        publishChanged();
        return result(game, "Dragon Heist game created.");
      }
      fail(400, "Unknown game command.");
    } catch (error) {
      return {
        status: error instanceof GameError ? error.status : 503,
        body: {
          error:
            error instanceof GameError ? error.message : "The game is unavailable. Retry without changing the move.",
        },
        text: error instanceof GameError ? error.message : "The game is unavailable.",
      };
    }
  }
  const enqueue = (input) => {
    const pending = queue.then(() => command(input));
    queue = pending.catch(() => {});
    return pending;
  };
  return {
    async prepare() {
      await mkdir(configuration.dataDirectory, { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(filename);
      try {
        db.exec(
          "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS games(game TEXT PRIMARY KEY, plan TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, state_json TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS game_events(sequence INTEGER PRIMARY KEY, game TEXT NOT NULL REFERENCES games(game), event_json TEXT NOT NULL) STRICT;",
        );
      } finally {
        db.close();
      }
    },
    async start() {
      await access(filename);
      const candidate = new DatabaseSync(filename);
      try {
        candidate.prepare("SELECT state_json FROM games LIMIT 0").all();
        database = candidate;
      } catch (error) {
        candidate.close();
        throw error;
      }
    },
    async stop() {
      await queue;
      database?.close();
      database = undefined;
    },
    async read({ path: resource, query }) {
      if (Object.keys(query).length) return { status: 400, body: { error: "Unknown game query." } };
      if (resource === "/catalog")
        return result({
          ...JSON.parse(await readFile(new URL("./catalog.json", import.meta.url), "utf8")),
          concessionPenalty: scoring.concessionPenalty,
          scoring,
          rules: Object.entries(stages).map(([move, stage]) => ({
            move,
            description: descriptions[move],
            operation: `dragon-heist.${move}`,
            procedure: `dragon-heist-${stage}`,
            choices: choices[move] ?? [],
            prerequisites: prerequisites[move],
            die: ["turn-runes", "distract"].includes(move) ? "d6" : "none",
            tutorialAlarm: move === "turn-runes",
          })),
        });
      if (resource === "/games") return enqueue({ command: "game.read", arguments: {} });
      const match = /^\/games\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/.exec(resource);
      if (match) return enqueue({ command: "game.read", arguments: { game: match[1] } });
      return { status: 404, body: { error: "Unknown game resource." } };
    },
    command: enqueue,
  };
}
