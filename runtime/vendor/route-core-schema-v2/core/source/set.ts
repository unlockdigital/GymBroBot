// POST /api/miniapp/set — log a set (reps or duration)
// body: {
//   sessionId, exercise, exercise_key?,
//   weight?, reps?, rpe?, notes?,
//   measurement_type?: 'reps' | 'duration_seconds',
//   duration_seconds?, superset_group?,
// }
// returns: { setId }
import { insertMiniappOnce, miniappEventTime } from "@/lib/miniapp-idempotency";
import { getWriteDb, nowIso } from "@/lib/gymbro-write-db";
import { canonicalizeExerciseKey } from "@/lib/exercise-canonical";
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
  client_logged_at?: string;
  client_set_id?: string;
  sessionId?: number;
  exercise?: string;
  exercise_key?: string;
  weight?: number;
  reps?: number;
  rpe?: number;
  notes?: string;
  measurement_type?: "reps" | "duration_seconds";
  duration_seconds?: number;
  superset_group?: string | null;
};

const REP_ONLY_EXERCISES = new Set([
  "flutter kicks",
  "scissor kicks",
  "leg lifts",
  "ab wheel rollouts",
  "russian twists",
  "dead bug",
  "standing knee flexion stretch on step",
  "partial isometric hamstring curl machine",
]);

const HOLD_EXERCISES: Record<string, { holdSeconds: number }> = {
  "partial isometric hamstring curl machine": { holdSeconds: 10 },
};

// The legacy sets table (created by migration 0001) doesn't have the
// columns the Mini App needs (measurement_type for timed exercises,
// duration_seconds for planks, exercise_canonical for lookups). We
// ALTER the table on first call — idempotent via PRAGMA table_info.
// This runs once per server process.
let _setsSchemaReady = false;
function ensureSetsColumns() {
  if (_setsSchemaReady) return;
  const db = getWriteDb();
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(sets)`).all() as Array<{ name: string }>)
      .map(r => r.name)
  );
  if (!existing.has("exercise_canonical")) db.exec(`ALTER TABLE sets ADD COLUMN exercise_canonical TEXT`);
  if (!existing.has("measurement_type")) db.exec(`ALTER TABLE sets ADD COLUMN measurement_type TEXT DEFAULT 'reps'`);
  if (!existing.has("duration_seconds")) db.exec(`ALTER TABLE sets ADD COLUMN duration_seconds INTEGER`);
  _setsSchemaReady = true;
}

export function OPTIONS(request: Request) {
  return miniappPreflight(request.headers.get("origin"));
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const auth = requireAuth(request);
  if (!auth.ok) return miniappAuthFail(auth, origin);
  const owner = resolveOwner(auth);
  if (!owner) return miniappOwnerMissing(origin, auth);

  let body: Body;
  try { body = await request.json(); } catch { return miniappFail("Invalid JSON body", origin, 400); }

  if (!body.sessionId || !Number.isInteger(body.sessionId)) {
    return miniappFail("sessionId required", origin, 400);
  }
  if (!body.exercise || typeof body.exercise !== "string") {
    return miniappFail("exercise name required", origin, 400);
  }
  const canonical = canonicalizeExerciseKey(body.exercise_key || body.exercise);
  let measurement = body.measurement_type === "duration_seconds" ? "duration_seconds" : "reps";
  let reps = body.reps == null ? null : Number(body.reps);
  let durationSeconds = body.duration_seconds == null ? null : Number(body.duration_seconds);
  let notes = body.notes ? body.notes.toString() : null;

  if (canonical && REP_ONLY_EXERCISES.has(canonical) && measurement === "duration_seconds") {
    if (canonical === "flutter kicks" && typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0) {
      reps = durationSeconds;
      durationSeconds = null;
      measurement = "reps";
      notes = [notes, "coerced_from_duration_seconds=true"].filter(Boolean).join("; ");
    } else {
      return miniappFail(`${body.exercise!.trim()} is logged by reps/holds, not timed seconds. Refresh the mini-app and log the hold count.`, origin, 400);
    }
  }

  if (canonical && HOLD_EXERCISES[canonical] && measurement === "reps") {
    const holdSeconds = HOLD_EXERCISES[canonical].holdSeconds;
    notes = [notes, `isometric_holds=true`, `hold_seconds=${holdSeconds}`].filter(Boolean).join("; ");
  }

  if (measurement === "reps" && (reps == null || Number(reps) <= 0)) {
    return miniappFail("reps must be > 0 for rep-based set", origin, 400);
  }
  if (measurement === "duration_seconds" && (durationSeconds == null || Number(durationSeconds) <= 0)) {
    return miniappFail("duration_seconds must be > 0 for timed set", origin, 400);
  }

  try {
    ensureSetsColumns();
    const db = getWriteDb();
    // Reject sets targeting another user's session before they land in the
    // table — stops cross-user writes that would otherwise be hidden by a
    // mismatched (identity_source, external_user_id) on the parent.
    const sessionRow = db
      .prepare(`SELECT id FROM sessions WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .get(body.sessionId, owner.identitySource, owner.externalUserId) as { id: number } | undefined;
    if (!sessionRow) return miniappFail("Session not found", origin, 404);

    // multi-tenancy: scoped by (identity_source, external_user_id)
    const res = insertMiniappOnce(db, owner, "set", body.client_set_id, () => db
      .prepare(`INSERT INTO sets (
                  session_id, exercise, exercise_canonical,
                  weight, reps, rpe, notes,
                  measurement_type, duration_seconds, superset_group,
                  created_at, identity_source, external_user_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        body.sessionId,
        body.exercise!.trim(),
        canonical,
        body.weight == null ? null : Number(body.weight),
        measurement === "reps" ? reps : null,
        body.rpe == null ? null : Number(body.rpe),
        notes,
        measurement,
        measurement === "duration_seconds" && durationSeconds != null
          ? Number(durationSeconds)
          : null,
        body.superset_group || null,
        miniappEventTime(body.client_logged_at, nowIso()),
        owner.identitySource,
        owner.externalUserId,
      ));
    if (res.changes === 0) return miniappOk({ setId: Number(res.lastInsertRowid) }, origin);

    // Update last_exercise / last_set_id hint on the session so the bot
    // can reconstruct context (same pattern the existing logSet uses).
    // multi-tenancy: scoped by (identity_source, external_user_id)
    db.prepare(`UPDATE sessions SET last_exercise = ?, last_set_id = ?
                WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .run(body.exercise!.trim(), Number(res.lastInsertRowid), body.sessionId, owner.identitySource, owner.externalUserId);

    const setId = Number(res.lastInsertRowid);
    const hasAssistance = typeof body.notes === 'string'
      && /\bassistance_(?:lb|kg)=\d/i.test(body.notes);
    recordSystemEvent(owner, {
      category: 'set_log',
      eventName: 'miniapp_set_logged',
      sessionId: body.sessionId,
      payload: {
        set_id: setId,
        exercise: body.exercise!.trim(),
        exercise_canonical: canonical,
        weight: body.weight == null ? null : Number(body.weight),
        reps: measurement === 'reps' && reps != null ? Number(reps) : null,
        rpe: body.rpe == null ? null : Number(body.rpe),
        measurement_type: measurement,
        duration_seconds:
          measurement === 'duration_seconds' && durationSeconds != null
            ? Number(durationSeconds)
            : null,
        has_assistance: hasAssistance,
        superset_group: body.superset_group || null,
      },
    });

    return miniappOk({ setId }, origin, 201);
  } catch (err) {
    recordSystemEvent(owner, {
      category: 'error',
      eventName: 'miniapp_write_failed',
      status: 'error',
      sessionId: body.sessionId ?? null,
      payload: {
        operation: 'set.create',
        error_message: err instanceof Error ? err.message : String(err),
        exercise: body.exercise || null,
      },
    });
    console.error("[miniapp/set POST]", err);
    return miniappFail(err instanceof Error ? err.message : "unknown", origin, 500);
  }
}
