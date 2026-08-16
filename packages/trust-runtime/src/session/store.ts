import type { Selectable } from "kysely";

import type { Database, SessionTable } from "../database/database.js";
import type { Session } from "../model.js";

type SessionRow = Selectable<SessionTable>;

export class SessionStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  using(database: Database): SessionStore {
    return new SessionStore({ database });
  }

  async create(session: Session): Promise<void> {
    await this.dependencies.database.insertInto("sessions").values({
      session_id: session.id,
      plan_slug: session.planSlug,
      state: session.state,
      opened_at: session.openedAt,
      expires_at: session.expiresAt,
      closed_at: session.closedAt ?? null,
    }).execute();
  }

  async findOpen(planSlug: string): Promise<Session | undefined> {
    return this.findWhere(planSlug);
  }

  async findAvailable(planSlug: string, now: Date): Promise<Session | undefined> {
    const row = await this.dependencies.database
      .selectFrom("sessions")
      .selectAll()
      .where("plan_slug", "=", planSlug)
      .where("state", "=", "open")
      .where("expires_at", ">", now.toISOString())
      .executeTakeFirst();
    return row ? toSession(row) : undefined;
  }

  async findById(sessionId: string): Promise<Session | undefined> {
    const row = await this.dependencies.database
      .selectFrom("sessions")
      .selectAll()
      .where("session_id", "=", sessionId)
      .executeTakeFirst();
    return row ? toSession(row) : undefined;
  }

  async listForPlan(planSlug: string): Promise<Session[]> {
    const rows = await this.dependencies.database
      .selectFrom("sessions")
      .selectAll()
      .where("plan_slug", "=", planSlug)
      .orderBy("opened_at", "desc")
      .execute();
    return rows.map(toSession);
  }

  async changeState(sessionId: string, state: Session["state"], closedAt?: string): Promise<void> {
    const result = await this.dependencies.database
      .updateTable("sessions")
      .set({ state, closed_at: closedAt ?? null })
      .where("session_id", "=", sessionId)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error(`unknown Session: ${sessionId}`);
  }

  private async findWhere(planSlug: string): Promise<Session | undefined> {
    const row = await this.dependencies.database
      .selectFrom("sessions")
      .selectAll()
      .where("plan_slug", "=", planSlug)
      .where("state", "=", "open")
      .executeTakeFirst();
    return row ? toSession(row) : undefined;
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
