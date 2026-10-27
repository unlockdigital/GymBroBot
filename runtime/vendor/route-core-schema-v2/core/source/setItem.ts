// PATCH /api/miniapp/set/[id]  — correct a logged set (weight / reps / rpe /
//                                 duration_seconds / notes).
// DELETE /api/miniapp/set/[id] — remove a mis-logged set.
// body (PATCH): { weight?, reps?, rpe?, duration_seconds?, notes? }
// returns: { setId, updated: n } | { setId, deleted: n }
//
// Added Apr 2026 after the first live Mini App session showed the UX gap:
// users spot a typo right after tapping "Complete set" (wrong RPE, tapped
// 175 instead of 185, one extra rep) and had no way to fix it without
// falling back to chat. Mirrors the cardio [id] route structure.
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
  weight?: number | null;
  reps?: number | null;
  rpe?: number | null;
  duration_seconds?: number | null;
  notes?: string | null;
};

type SetRow = {
  id: number;
  session_id: number | null;
  exercise: string | null;
  weight: number | null;
  reps: number | null;
  rpe: number | null;
  duration_seconds: number | null;
  notes: string | null;
  measurement_type: string | null;
  superset_group: string | null;
};

export function OPTIONS(request: Request) {
  return miniappPreflight(request.headers.get("origin"));
}

// Next.js 15+ hands params as a Promise in dynamic routes.
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const origin = request.headers.get("origin");
  const auth = requireAuth(request);
  if (!auth.ok) return miniappAuthFail(auth, origin);
  const owner = resolveOwner(auth);
  if (!owner) return miniappOwnerMissing(origin, auth);

  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return miniappFail("Invalid set id", origin, 400);
  }

  let body: Body;
  try { body = await request.json(); } catch { return miniappFail("Invalid JSON body", origin, 400); }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const patchValues: Record<string, string | number | null> = {};

  // All fields are optional — only patch what was passed. Explicit `null`
  // clears the value (e.g. clearing an RPE typo); `undefined`/missing
  // leaves the column untouched.
  if (Object.prototype.hasOwnProperty.call(body, "weight")) {
    const v = body.weight;
    if (v != null && !Number.isFinite(Number(v))) return miniappFail("weight must be numeric or null", origin, 400);
    const next = v == null ? null : Number(v);
    sets.push("weight = ?"); vals.push(next); patchValues.weight = next;
  }
  if (Object.prototype.hasOwnProperty.call(body, "reps")) {
    const v = body.reps;
    if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) return miniappFail("reps must be a non-negative number or null", origin, 400);
    const next = v == null ? null : Number(v);
    sets.push("reps = ?"); vals.push(next); patchValues.reps = next;
  }
  if (Object.prototype.hasOwnProperty.call(body, "rpe")) {
    const v = body.rpe;
    if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 10)) {
      return miniappFail("rpe must be 0-10 or null", origin, 400);
    }
    const next = v == null ? null : Number(v);
    sets.push("rpe = ?"); vals.push(next); patchValues.rpe = next;
  }
  if (Object.prototype.hasOwnProperty.call(body, "duration_seconds")) {
    const v = body.duration_seconds;
    if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
      return miniappFail("duration_seconds must be a non-negative number or null", origin, 400);
    }
    const next = v == null ? null : Number(v);
    sets.push("duration_seconds = ?"); vals.push(next); patchValues.duration_seconds = next;
  }
  if (Object.prototype.hasOwnProperty.call(body, "notes")) {
    const next = body.notes == null ? null : String(body.notes).slice(0, 400);
    sets.push("notes = ?"); vals.push(next); patchValues.notes = next;
  }

  if (sets.length === 0) return miniappFail("No updatable fields provided", origin, 400);

  try {
    const db = getWriteDb();
    const before = db
      .prepare(`SELECT id, session_id, exercise, weight, reps, rpe, duration_seconds,
                       notes, measurement_type, superset_group
                FROM sets
                WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .get(id, owner.identitySource, owner.externalUserId) as SetRow | undefined;
    if (!before) return miniappFail("Set not found", origin, 404);

    // multi-tenancy: scoped by (identity_source, external_user_id)
    const res = db
      .prepare(`UPDATE sets SET ${sets.join(", ")}
                WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .run(...vals, id, owner.identitySource, owner.externalUserId);
    if (res.changes === 0) return miniappFail("Set not found", origin, 404);

    const changedFields = Object.keys(patchValues).filter((field) => {
      const prev = before[field as keyof SetRow];
      const next = patchValues[field];
      return prev !== next;
    });
    if (changedFields.length > 0) {
      const previous: Record<string, unknown> = {};
      const updated: Record<string, unknown> = {};
      for (const field of changedFields) {
        previous[field] = before[field as keyof SetRow];
        updated[field] = patchValues[field];
      }
      recordSystemEvent(owner, {
        category: 'set_log',
        eventName: 'miniapp_set_updated',
        sessionId: before.session_id,
        payload: {
          set_id: id,
          exercise: before.exercise,
          measurement_type: before.measurement_type,
          superset_group: before.superset_group,
          changed_fields: changedFields,
          previous,
          updated,
        },
      });
    }
    return miniappOk({ setId: id, updated: res.changes }, origin);
  } catch (err) {
    recordSystemEvent(owner, {
      category: 'error',
      eventName: 'miniapp_write_failed',
      status: 'error',
      payload: {
        operation: 'set.update',
        set_id: id,
        error_message: err instanceof Error ? err.message : String(err),
      },
    });
    console.error("[miniapp/set PATCH]", err);
    return miniappFail(err instanceof Error ? err.message : "unknown", origin, 500);
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const origin = request.headers.get("origin");
  const auth = requireAuth(request);
  if (!auth.ok) return miniappAuthFail(auth, origin);
  const owner = resolveOwner(auth);
  if (!owner) return miniappOwnerMissing(origin, auth);

  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return miniappFail("Invalid set id", origin, 400);
  }

  try {
    const db = getWriteDb();
    // If the deleted set is the session's last_set_id hint, null it out so
    // the bot doesn't reference a now-dangling id. (last_exercise is a
    // label string, not a foreign key, so we leave it.)
    // multi-tenancy: SELECT, DELETE on sets, and the UPDATE on sessions all
    // scoped by (identity_source, external_user_id)
    const info = db
      .prepare(`SELECT session_id FROM sets
                WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .get(id, owner.identitySource, owner.externalUserId) as
      | { session_id: number | null }
      | undefined;
    const res = db
      .prepare(`DELETE FROM sets
                WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .run(id, owner.identitySource, owner.externalUserId);
    if (res.changes === 0) return miniappFail("Set not found", origin, 404);
    if (info?.session_id != null) {
      db.prepare(`UPDATE sessions SET last_set_id = NULL
                  WHERE id = ? AND last_set_id = ?
                    AND identity_source = ? AND external_user_id = ?`)
        .run(info.session_id, id, owner.identitySource, owner.externalUserId);
    }
    return miniappOk({ setId: id, deleted: res.changes }, origin);
  } catch (err) {
    console.error("[miniapp/set DELETE]", err);
    return miniappFail(err instanceof Error ? err.message : "unknown", origin, 500);
  }
}
