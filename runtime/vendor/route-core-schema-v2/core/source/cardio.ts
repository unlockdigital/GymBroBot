// POST /api/miniapp/cardio — log a cardio block
// body: { sessionId, phase, mode, minutes, distance_miles?, calories?, notes? }
// returns: { blockId }
import { insertMiniappOnce, miniappEventTime } from "@/lib/miniapp-idempotency";
import { getWriteDb, nowIso } from "@/lib/gymbro-write-db";
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
  client_write_id?: string;
  sessionId?: number;
  phase?: "warmup" | "cardio" | "cooldown" | "other";
  mode?: string;
  minutes?: number;
  distance_miles?: number;
  calories?: number;
  notes?: string;
};

const VALID_PHASES = new Set(["warmup", "cardio", "cooldown", "other"]);

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
  const phase = (body.phase || "cardio").toLowerCase();
  if (!VALID_PHASES.has(phase)) {
    return miniappFail(`phase must be one of: ${[...VALID_PHASES].join(", ")}`, origin, 400);
  }
  if (!body.mode || typeof body.mode !== "string") {
    return miniappFail("mode required (e.g. 'rowing', 'bike', 'basketball')", origin, 400);
  }
  if (body.minutes == null || Number(body.minutes) <= 0) {
    return miniappFail("minutes must be > 0", origin, 400);
  }

  try {
    const db = getWriteDb();
    // Defense-in-depth: refuse to attach the cardio block to a session
    // that doesn't belong to this user. Cheap parent-row check before insert.
    const sessionRow = db
      .prepare(`SELECT id FROM sessions WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .get(body.sessionId, owner.identitySource, owner.externalUserId) as { id: number } | undefined;
    if (!sessionRow) return miniappFail("Session not found", origin, 404);

    // multi-tenancy: scoped by (identity_source, external_user_id)
    const res = insertMiniappOnce(db, owner, "cardio", body.client_write_id, () => db
      .prepare(`INSERT INTO cardio_blocks (
                  session_id, phase, mode, minutes, distance_miles, calories_burned,
                  notes, source, created_at, identity_source, external_user_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'miniapp', ?, ?, ?)`)
      .run(
        body.sessionId,
        phase,
        body.mode!.toString().toLowerCase().trim(),
        Number(body.minutes),
        body.distance_miles == null ? null : Number(body.distance_miles),
        body.calories == null ? null : Number(body.calories),
        body.notes ? body.notes.toString() : null,
        miniappEventTime(body.client_logged_at, nowIso()),
        owner.identitySource,
        owner.externalUserId,
      ));
    if (res.changes === 0) return miniappOk({ blockId: Number(res.lastInsertRowid) }, origin);
    const blockId = Number(res.lastInsertRowid);
    recordSystemEvent(owner, {
      category: 'cardio_log',
      eventName: 'miniapp_cardio_logged',
      sessionId: body.sessionId,
      payload: {
        block_id: blockId,
        phase,
        mode: body.mode!.toString().toLowerCase().trim(),
        minutes: Number(body.minutes),
        distance_miles: body.distance_miles == null ? null : Number(body.distance_miles),
        calories: body.calories == null ? null : Number(body.calories),
      },
    });
    return miniappOk({ blockId }, origin, 201);
  } catch (err) {
    recordSystemEvent(owner, {
      category: 'error',
      eventName: 'miniapp_write_failed',
      status: 'error',
      sessionId: body.sessionId ?? null,
      payload: {
        operation: 'cardio.create',
        error_message: err instanceof Error ? err.message : String(err),
      },
    });
    console.error("[miniapp/cardio POST]", err);
    return miniappFail(err instanceof Error ? err.message : "unknown", origin, 500);
  }
}
