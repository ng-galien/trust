import type { ExtensionPageProps, PlanSummaryView, PlanView } from "@trust/extension-sdk";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { Learning } from "./learning";
import { Rune, TableArt } from "./table-art";
import "./style.css";

interface Move {
  move: string;
  plan: string;
  choice: string;
  die: number;
  score: number;
  ready: boolean;
  recordedAt: string;
}
interface Game {
  game: string;
  plan: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  tool: "none" | "pick" | "charm";
  tactic: "none" | "force" | "listen";
  dragon: "sleeping" | "distracted" | "alert";
  chest: "sealed" | "unlocked" | "open" | "empty";
  alarm: boolean;
  score: number;
  completed: boolean;
  moves: Move[];
  concession?: { plan: string; checkUri: string; escalationId: string; resumedAt: string } | null;
}
const words = (value: string) => value.replaceAll("-", " ");
async function read<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("The table could not be refreshed.");
  return response.json();
}

export default function Page({ apiBase, trustBase, eventsUrl, navigation }: ExtensionPageProps) {
  const [games, setGames] = useState<Game[]>([]);
  const [plans, setPlans] = useState<PlanSummaryView[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [localGame, setLocalGame] = useState("");
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanView | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const selected = new URLSearchParams(navigation?.search).get("dragon.game") ?? localGame;
  const game = games.find((value) => value.game === selected) ?? games[0];
  const root = plans.find((value) => value.plan === game?.plan);
  const refresh = useCallback(async () => {
    try {
      const [table, projection] = await Promise.all([
        read<{ games: Game[] }>(`${apiBase}/games`),
        read<{ plans: PlanSummaryView[] }>(`${trustBase}/plans`),
      ]);
      setGames(table.games);
      setPlans(projection.plans);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The table could not be refreshed.");
    } finally {
      setLoading(false);
    }
  }, [apiBase, trustBase]);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    const events = new EventSource(eventsUrl);
    events.onopen = () => {
      setConnected(true);
      void refresh();
    };
    events.addEventListener("change", () => {
      setConnected(true);
      void refresh();
    });
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, [eventsUrl, refresh]);
  useEffect(() => {
    if (inspecting) {
      if (!dialog.current?.open) dialog.current?.showModal();
    } else dialog.current?.close();
    const plan = plans.find((value) => value.plan === inspecting);
    setDetail(null);
    if (plan) {
      let live = true;
      void read<PlanView>(`${trustBase}/plans/${encodeURIComponent(plan.plan)}`)
        .then((value) => {
          if (live) setDetail(value);
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }
  }, [inspecting, plans, trustBase]);
  const choose = (id: string) => {
    setLocalGame(id);
    if (navigation) {
      const query = new URLSearchParams(navigation.search);
      query.set("dragon.game", id);
      navigation.replaceSearch(query.toString());
    }
  };
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (navigation && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      const href = event.currentTarget.getAttribute("href");
      if (href !== null) navigation.navigate(href);
    }
  };
  const planLink = (id: string, mode: string, label: string) =>
    navigation ? (
      <a href={navigation.planHref(id, mode)} onClick={follow}>
        {label} ↗
      </a>
    ) : (
      <span>{label}</span>
    );
  const ancestry = (plan: PlanSummaryView | PlanView): (PlanSummaryView | PlanView)[] => {
    const path = [plan];
    const seen = new Set([plan.plan]);
    let current = plan;
    while (current.parent?.current) {
      const parent = plans.find((value) => value.plan === current.parent?.plan);
      if (!parent || seen.has(parent.plan)) break;
      path.unshift(parent);
      seen.add(parent.plan);
      current = parent;
    }
    return path;
  };
  const seats = root
    ? plans
        .filter((plan) => ancestry(plan)[0]?.plan === root.plan && (plan.plan === root.plan || plan.parent?.current))
        .sort((a, b) => ancestry(a).length - ancestry(b).length || a.plan.localeCompare(b.plan))
    : [];
  const roll = game?.moves.filter((move) => move.die > 0).at(-1);
  const runes = game
    ? [
        {
          label: "The tool",
          value: game.tool === "none" ? "Not chosen" : game.tool === "pick" ? "Lockpick" : "Charm",
          note: "The tool selected in the game.",
        },
        {
          label: "The approach",
          value: game.tactic === "none" ? "Not chosen" : game.tactic === "force" ? "Force" : "Listen",
          note: "The tactic selected in the game.",
        },
        { label: "The seal", value: words(game.chest), note: "The chest state reported by the game." },
      ]
    : [];
  const alerts = root?.descendantEscalations ?? [];
  const ownStop = root?.workState === "ESCALATED";
  const title = (plan: PlanSummaryView | PlanView) =>
    plan.metadata.title ?? words(plan.procedure.replace(/^dragon-heist-/, ""));
  return (
    <main className="heist" aria-label="Dragon Heist game table">
      <header className="heist-heading">
        <div>
          <p className="heist-eyebrow">A cooperative caper</p>
          <h1>
            Dragon<span>Heist</span>
            <i aria-hidden="true">✦</i>
          </h1>
        </div>
        <div className="heist-table-controls">
          <span className={`heist-live${connected ? " is-live" : ""}`}>
            {connected ? "Table connected" : "Reconnecting"}
          </span>
          {games.length > 1 && (
            <label>
              <span className="heist-sr-only">Game</span>
              <select value={game?.game} onChange={(event) => choose(event.target.value)}>
                {games.map((value) => (
                  <option key={value.game} value={value.game}>
                    {value.game}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="heist-icon-button" aria-label="Refresh table" onClick={() => void refresh()}>
            ↻
          </button>
        </div>
      </header>
      {error && (
        <p className="heist-error" role="alert">
          {error} {games.length > 0 && "Showing the last received state."}
        </p>
      )}
      {loading ? (
        <p className="heist-empty" role="status">
          Setting the table…
        </p>
      ) : !game ? (
        <section className="heist-empty">
          <TableArt open={false} disturbed={false} />
          <h2>The treasure is waiting.</h2>
          <p>No game has been created. Start a Dragon Heist Plan to bring your party to the table.</p>
        </section>
      ) : (
        <>
          <div className="heist-game-line">
            <span>{game.game}</span>
            <span>
              Dragon <strong>{game.dragon}</strong>
            </span>
            <span className="heist-score">
              <strong>{game.score}</strong> points
            </span>
            <button type="button" onClick={() => setInspecting(game.plan)}>
              TRUST Plan · {root?.workState ?? "unavailable"} ↗
            </button>
          </div>
          {(game.alarm || alerts.length > 0 || ownStop) && (
            <div className="heist-alert" role="status">
              <span aria-hidden="true">◇</span>
              <p>
                {game.alarm ? "The runes have raised the alarm." : "A player needs a ruling."}
                <small>
                  {ownStop
                    ? "The game Plan itself is escalated."
                    : alerts.length > 0
                      ? `${alerts.length} active descendant escalation${alerts.length > 1 ? "s" : ""}. Open the origin in TRUST to review it.`
                      : "The game alarm is not a TRUST escalation."}
                </small>
              </p>
              <button type="button" onClick={() => setInspecting(ownStop ? game.plan : "rulings")}>
                View ruling ↗
              </button>
            </div>
          )}
          <section className="heist-table" aria-label="The heist table">
            <div className="heist-table-ring" aria-hidden="true" />
            <div className="heist-center">
              <TableArt open={game.chest === "open" || game.chest === "empty"} disturbed={game.dragon === "alert"} />
              <div className="heist-chest-caption">
                <span className="heist-eyebrow">The dragon’s hoard</span>
                <h2>
                  {game.completed
                    ? "The heist is scored."
                    : game.chest === "empty"
                      ? "The hoard is taken."
                      : game.chest === "open"
                        ? "The vault is open."
                        : game.chest === "unlocked"
                          ? "The lock yields."
                          : "Three runes. One way in."}
                </h2>
                <p>
                  {game.completed
                    ? `Game result recorded. TRUST Plan: ${root?.workState ?? "unavailable"}.`
                    : "Every choice belongs to its player. Every move leaves a trace."}
                </p>
              </div>
            </div>
            <section className="heist-seats" aria-label="Player Plans">
              {seats.map((plan, index) => {
                const path = ancestry(plan);
                const side = plan.procedure.includes("distraction");
                return (
                  <button
                    type="button"
                    key={plan.plan}
                    className={`heist-seat heist-seat-${side ? "side" : Math.min(path.length - 1, 3)}`}
                    onClick={() => setInspecting(plan.plan)}
                    aria-label={`Inspect ${title(plan)} Plan`}
                    style={{ "--seat-index": index } as React.CSSProperties}
                  >
                    <span className="heist-seat-avatar" aria-hidden="true">
                      {side ? "♫" : ["♜", "♞", "◇", "⚿"][Math.min(path.length - 1, 3)]}
                    </span>
                    <span>
                      <small>{side ? "Distraction" : `Level ${path.length}`}</small>
                      <strong>{title(plan)}</strong>
                      <em>
                        {plan.workState === "ESCALATED"
                          ? "Needs a ruling"
                          : plan.workState === "COMPLETE"
                            ? "Complete"
                            : "In play"}
                      </em>
                    </span>
                  </button>
                );
              })}
            </section>
            <button
              type="button"
              className="heist-dice-area"
              onClick={() => setInspecting("chronicle")}
              aria-label={roll ? `Last die: ${roll.die}. Open turn log` : "No die rolled. Open turn log"}
            >
              <span
                key={roll ? `${game.game}-${roll.move}-${roll.recordedAt}` : "no-roll"}
                className={`heist-die${roll ? " has-result" : ""}`}
                aria-hidden="true"
              >
                {roll?.die ?? "—"}
              </span>
              <span>
                Last roll<small>{roll ? words(roll.move) : "No roll yet"}</small>
              </span>
            </button>
          </section>
          <section className="heist-runes" aria-label="Runes and tools">
            {runes.map((rune, index) => (
              <button
                type="button"
                key={rune.label}
                className="heist-rune"
                onClick={() => setInspecting(`rune-${index}`)}
              >
                <span className={`heist-rune-disk${index === 2 && game.chest !== "sealed" ? " is-unlocked" : ""}`}>
                  <Rune index={index} />
                </span>
                <span>
                  <small>{rune.label}</small>
                  <strong>{rune.value}</strong>
                </span>
                <span className="heist-rune-info" aria-hidden="true">
                  ↗
                </span>
              </button>
            ))}
          </section>
          <footer className="heist-chronicle">
            <div>
              <span className="heist-eyebrow">At the table</span>
              <h2>
                Turn log <span>{game.moves.length}</span>
              </h2>
            </div>
            {game.moves.length ? (
              <ol>
                {game.moves
                  .slice(-4)
                  .reverse()
                  .map((move) => (
                    <li key={`${move.move}-${move.recordedAt}`}>
                      <span className="heist-log-glyph" aria-hidden="true">
                        {move.ready ? "✓" : "◇"}
                      </span>
                      <div>
                        <strong>{words(move.move)}</strong>
                        <small>
                          {move.choice || (move.ready ? "Observed" : "Awaiting a ruling")}
                          {move.die > 0 ? ` · rolled ${move.die}` : ""}
                        </small>
                      </div>
                    </li>
                  ))}
              </ol>
            ) : (
              <p>The first move has not been recorded.</p>
            )}
            <button type="button" onClick={() => setInspecting("chronicle")}>
              Full chronicle ↗
            </button>
          </footer>
        </>
      )}
      <Learning apiBase={apiBase} />
      <dialog
        ref={dialog}
        className="heist-inspector"
        onCancel={() => setInspecting(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            setInspecting(null);
          }
        }}
        onClick={(event) => {
          if (event.target === dialog.current) setInspecting(null);
        }}
        aria-label="Game context"
      >
        <div className="heist-inspector-inner">
          <header>
            <span className="heist-eyebrow">At a closer look</span>
            <button
              type="button"
              className="heist-icon-button"
              onClick={() => setInspecting(null)}
              aria-label="Close game context"
            >
              ×
            </button>
          </header>
          {detail ? (
            <>
              <h2>{title(detail)}</h2>
              <p className="heist-context-path">
                {ancestry(detail)
                  .map((value) => title(value))
                  .join(" → ")}
              </p>
              {planLink(detail.plan, detail.mode, "Open Plan")}
              <dl>
                <dt>Plan state</dt>
                <dd>{detail.workState}</dd>
                <dt>Qualified Checks</dt>
                <dd>
                  {detail.satisfiedChecks} / {detail.checks.length}
                </dd>
              </dl>
              <h3>Current intent</h3>
              <p>{detail.currentIntent ?? "No current intent declared."}</p>
              <h3>Announced next intent</h3>
              <p>{detail.nextIntent ?? "Not yet declared."}</p>
              <small>
                Intentions are declarations, not proof of live execution. Check counts are not a percentage of game
                completion.
              </small>
              {detail.activeEscalation && (
                <section className="heist-context-alert">
                  <h3>This Plan needs a ruling</h3>
                  <p>{detail.activeEscalation.blockingReason}</p>
                  <p>{detail.activeEscalation.forbiddenFurtherAction}</p>
                </section>
              )}
            </>
          ) : inspecting === "rulings" ? (
            <>
              <h2>A pause at the table.</h2>
              <p>No move is inferred from an alarm. Review the active TRUST escalation at its origin.</p>
              {alerts.length ? (
                <ul className="heist-rulings">
                  {alerts.map((alert) => (
                    <li key={alert.escalationId}>
                      {planLink(alert.plan, alert.mode, alert.title || alert.plan)}
                      <p>{alert.blockingReason}</p>
                      <small>{alert.forbiddenFurtherAction}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No descendant escalation is reported.</p>
              )}
              {game?.concession && (
                <p className="heist-context-alert">
                  An operator resumed {planLink(game.concession.plan, root?.mode ?? "live", "the escalated Plan")}. The
                  game’s recorded concession applies.
                </p>
              )}
            </>
          ) : inspecting?.startsWith("rune-") ? (
            <>
              <h2>{runes[Number(inspecting.slice(-1))]?.label}</h2>
              <p className="heist-context-value">{runes[Number(inspecting.slice(-1))]?.value}</p>
              <p>
                {runes[Number(inspecting.slice(-1))]?.note} Choices and moves are made through the governed game
                Procedure, not by this viewer.
              </p>
              {root && planLink(root.plan, root.mode, "Open game Plan")}
            </>
          ) : (
            <>
              <h2>The chronicle</h2>
              <ol className="heist-full-log">
                {game?.moves.map((move) => (
                  <li key={`${move.move}-${move.recordedAt}`}>
                    <h3>
                      {words(move.move)} {move.die > 0 && <span>⚄ {move.die}</span>}
                    </h3>
                    <p>
                      {move.choice || "No choice recorded"} · {move.ready ? "Ready" : "Not ready"} · {move.score} points
                    </p>
                    <small>{new Date(move.recordedAt).toLocaleString()}</small>
                    {planLink(move.plan, root?.mode ?? "live", "Open player Plan")}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </dialog>
    </main>
  );
}
