// PATCH /api/miniapp/session/:id — update session (status, notes, last_exercise)
// body: { status?, notes?, last_exercise?, active_superset_group? }
// DELETE /api/miniapp/session/:id — hard-delete the session AND all its child
// rows (sets, cardio_blocks, supersets, body_metrics tied to this session).
// Used by the Mini App "Delete session" action on the post-complete summary
// screen so accidental/test sessions don't pollute training history.
import { getWriteDb } from "@/lib/gymbro-write-db";
import { recordSystemEvent } from "@/lib/miniapp-events";
import {
  miniappOk,
  miniappFail,
  miniappAuthFail,
  miniappOwnerMissing,
  miniappPreflight,
  requireAuth,
  resolveOwner,
} from "@/lib/miniapp-auth";

type Body = {
  status?: string;
  notes?: string;
  last_exercise?: string;
  active_superset_group?: string | null;
};

type RouteCtx = { params: Promise<{ id: string }> };

export function OPTIONS(request: Request) {
  return miniappPreflight(request.headers.get("origin"));
}

export async function PATCH(request: Request, ctx: RouteCtx) {
  const origin = request.headers.get("origin");
  const auth = requireAuth(request);
  if (!auth.ok) return miniappAuthFail(auth, origin);
  const owner = resolveOwner(auth);
  if (!owner) return miniappOwnerMissing(origin, auth);

  const { id: rawId } = await ctx.params;
  const sessionId = Number(rawId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return miniappFail("Invalid session id", origin, 400);
  }

  let body: Body;
  try { body = await request.json(); } catch { return miniappFail("Invalid JSON body", origin, 400); }

  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (body.status !== undefined) { fields.push("status = ?"); values.push(body.status); }
  if (body.notes !== undefined) { fields.push("notes = ?"); values.push(body.notes); }
  if (body.last_exercise !== undefined) { fields.push("last_exercise = ?"); values.push(body.last_exercise); }
  if (body.active_superset_group !== undefined) {
    fields.push("active_superset_group = ?");
    values.push(body.active_superset_group);
  }
  if (fields.length === 0) return miniappFail("No fields to update", origin, 400);

  try {
    const db = getWriteDb();
    // multi-tenancy: scoped by (identity_source, external_user_id)
    const res = db
      .prepare(`UPDATE sessions SET ${fields.join(", ")}
                WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .run(...values, sessionId, owner.identitySource, owner.externalUserId);
    if (res.changes === 0) return miniappFail("Session not found", origin, 404);

    // Lifecycle telemetry: when the mini-app marks the session
    // 'completed' (the standard end-of-workout PATCH), emit the parity
    // event so analytics that count session_lifecycle events catch it.
    if (typeof body.status === 'string' && body.status.toLowerCase() === 'completed') {
      // Pull a quick set count + duration for the payload; cheap, both indexed.
      const stats = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM sets
                WHERE session_id = ?
                  AND identity_source = ? AND external_user_id = ?) AS set_count,
             (SELECT started_at FROM sessions
                WHERE id = ?
                  AND identity_source = ? AND external_user_id = ?) AS started_at`
        )
        .get(
          sessionId, owner.identitySource, owner.externalUserId,
          sessionId, owner.identitySource, owner.externalUserId,
        ) as { set_count: number | null; started_at: string | null } | undefined;
      let durationMinutes: number | null = null;
      if (stats?.started_at) {
        const startMs = Date.parse(stats.started_at);
        if (Number.isFinite(startMs)) {
          durationMinutes = Math.max(0, Math.round((Date.now() - startMs) / 60000));
        }
      }
      recordSystemEvent(owner, {
        category: 'session_lifecycle',
        eventName: 'miniapp_session_ended',
        sessionId,
        payload: {
          set_count: stats?.set_count ?? null,
          duration_minutes: durationMinutes,
        },
      });
    }

    return miniappOk({ ok: true, sessionId }, origin);
  } catch (err) {
    recordSystemEvent(owner, {
      category: 'error',
      eventName: 'miniapp_write_failed',
      status: 'error',
      sessionId,
      payload: {
        operation: 'session.update',
        error_message: err instanceof Error ? err.message : String(err),
      },
    });
    console.error("[miniapp/session PATCH]", err);
    return miniappFail(err instanceof Error ? err.message : "unknown", origin, 500);
  }
}

export async function DELETE(request: Request, ctx: RouteCtx) {
  const origin = request.headers.get("origin");
  const auth = requireAuth(request);
  if (!auth.ok) return miniappAuthFail(auth, origin);
  const owner = resolveOwner(auth);
  if (!owner) return miniappOwnerMissing(origin, auth);

  const { id: rawId } = await ctx.params;
  const sessionId = Number(rawId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return miniappFail("Invalid session id", origin, 400);
  }

  try {
    const db = getWriteDb();
    // Run all deletes in a single transaction so the session and its
    // children vanish atomically — a partial delete would leave orphan
    // rows pointing at a session_id that no longer exists.
    // multi-tenancy: every DELETE is scoped by (identity_source, external_user_id)
    const cascadeDelete = db.transaction((id: number, src: string, uid: string) => {
      const setsDel    = db.prepare(`DELETE FROM sets           WHERE session_id = ? AND identity_source = ? AND external_user_id = ?`).run(id, src, uid);
      const cardioDel  = db.prepare(`DELETE FROM cardio_blocks  WHERE session_id = ? AND identity_source = ? AND external_user_id = ?`).run(id, src, uid);
      const superDel   = db.prepare(`DELETE FROM supersets      WHERE session_id = ? AND identity_source = ? AND external_user_id = ?`).run(id, src, uid);
      // Body metrics tied to this session were logged as part of the
      // session (e.g. post-workout weigh-in). If the session is being
      // deleted as a test, the weigh-in should go with it. Standalone
      // weigh-ins without session_id are never touched.
      const bmDel      = db.prepare(`DELETE FROM body_metrics   WHERE session_id = ? AND identity_source = ? AND external_user_id = ?`).run(id, src, uid);
      const sessDel    = db.prepare(`DELETE FROM sessions       WHERE id = ? AND identity_source = ? AND external_user_id = ?`).run(id, src, uid);
      return {
        sessionDeleted: sessDel.changes,
        setsDeleted:    setsDel.changes,
        cardioDeleted:  cardioDel.changes,
        supersetsDeleted: superDel.changes,
        bodyMetricsDeleted: bmDel.changes,
      };
    });
    const counts = cascadeDelete(sessionId, owner.identitySource, owner.externalUserId);
    if (counts.sessionDeleted === 0) return miniappFail("Session not found", origin, 404);
    return miniappOk({ ok: true, sessionId, ...counts }, origin);
  } catch (err) {
    console.error("[miniapp/session DELETE]", err);
    return miniappFail(err instanceof Error ? err.message : "unknown", origin, 500);
  }
}
