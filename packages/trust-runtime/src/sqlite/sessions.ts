import type { Session } from "../model.js";
import type { DatabaseDriver, DatabaseRow } from "./database.js";

interface SessionRow extends DatabaseRow {
  session_id: string;
  plan_slug: string;
  state: Session["state"];
  opened_at: string;
  expires_at: string;
  closed_at: string | null;
}

export class SessionStore {
  constructor(private readonly dependencies: { databaseDriver: DatabaseDriver }) {}

  create(session: Session): void {
    this.dependencies.databaseDriver
      .prepare(
        `INSERT INTO sessions (
           session_id, plan_slug, state, opened_at, expires_at, closed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.planSlug,
        session.state,
        session.openedAt,
        session.expiresAt,
        session.closedAt ?? null,
      );
  }

  findOpen(planSlug: string): Session | undefined {
    const row = this.dependencies.databaseDriver
      .prepare(
        `SELECT session_id, plan_slug, state, opened_at, expires_at, closed_at
           FROM sessions
          WHERE plan_slug = ? AND state = 'open'`,
      )
      .get<SessionRow>(planSlug);
    return row ? toSession(row) : undefined;
  }

  findById(sessionId: string): Session | undefined {
    const row = this.dependencies.databaseDriver
      .prepare(
        `SELECT session_id, plan_slug, state, opened_at, expires_at, closed_at
           FROM sessions
          WHERE session_id = ?`,
      )
      .get<SessionRow>(sessionId);
    return row ? toSession(row) : undefined;
  }

  changeState(sessionId: string, state: Session["state"], closedAt?: string): void {
    const result = this.dependencies.databaseDriver
      .prepare("UPDATE sessions SET state = ?, closed_at = ? WHERE session_id = ?")
      .run(state, closedAt ?? null, sessionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`unknown Session: ${sessionId}`);
    }
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.session_id,
    planSlug: row.plan_slug,
    state: row.state,
    openedAt: row.opened_at,
    expiresAt: row.expires_at,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
  };
}
