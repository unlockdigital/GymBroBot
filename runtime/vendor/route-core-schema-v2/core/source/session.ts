// POST /api/miniapp/session — create a new session row
// body: { dayName, dayType?, planId?, planDate?, source?, notes? }
// returns: { sessionId }
//
// `dayType` is normalized to the bot's canonical strings ('upper body',
// 'lower body', 'full body') so dashboard analytics + bot queries match
// regardless of which interface created the row.
//
// `planDate` (YYYY-MM-DD) is the optional plan_date when the session is
// started by loading a saved/today's plan. When present, the notes get
// prefixed with `loaded plan YYYY-MM-DD\n` so the bot's
// `loadedPlanDateFromSessionNotes()` regex picks it up — that's the hook
// that wires plan-aware coaching back into mid-session bot messages.
import { insertMiniappOnce, miniappEventTime } from "@/lib/miniapp-idempotency";
import { getWriteDb, nowIso } from "@/lib/gymbro-write-db";
import { normalizeDayTypeToCanonical } from "@/lib/miniapp-day-type";
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
  client_started_at?: string;
  client_start_id?: string;
  dayName?: string;
  dayType?: string;
  planId?: string | number | null;
  planDate?: string | null;
  source?: string;
  notes?: string;
};

const PLAN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

  const dayType = normalizeDayTypeToCanonical(body.dayType) || 'mixed';
  const planDate = typeof body.planDate === 'string' && PLAN_DATE_RE.test(body.planDate.trim())
    ? body.planDate.trim()
    : null;

  // Notes assembly: if the session was started from a saved plan, prepend
  // `loaded plan YYYY-MM-DD` so the bot's regex picks it up. Otherwise keep
  // the existing miniapp tag for at-a-glance source identification in the DB.
  const baseNote = body.notes
    ? body.notes.toString()
    : body.dayName ? `miniapp · ${body.dayName}` : 'miniapp session';
  const notes = planDate
    ? `loaded plan ${planDate}\n${baseNote}`
    : baseNote;

  try {
    const db = getWriteDb();
    // multi-tenancy: scoped by (identity_source, external_user_id)
    const res = insertMiniappOnce(db, owner, "session", body.client_start_id, () => db
      .prepare(`INSERT INTO sessions (started_at, status, day_type, notes, identity_source, external_user_id)
                VALUES (?, 'active', ?, ?, ?, ?)`)
      .run(miniappEventTime(body.client_started_at, nowIso()), dayType, notes, owner.identitySource, owner.externalUserId));
    if (res.changes === 0) return miniappOk({ sessionId: Number(res.lastInsertRowid) }, origin);

    const sessionId = Number(res.lastInsertRowid);

    recordSystemEvent(owner, {
      category: 'session_lifecycle',
      eventName: 'miniapp_session_started',
      sessionId,
      payload: {
        plan_id: body.planId ?? null,
        plan_date: planDate,
        day_type: dayType,
        source: body.source || 'miniapp',
      },
    });
    if (planDate) {
      recordSystemEvent(owner, {
        category: 'plan_lifecycle',
        eventName: 'miniapp_plan_loaded',
        sessionId,
        payload: {
          plan_id: body.planId ?? null,
          plan_date: planDate,
          day_type: dayType,
        },
      });
    }

    return miniappOk({ sessionId }, origin, 201);
  } catch (err) {
    recordSystemEvent(owner, {
      category: 'error',
      eventName: 'miniapp_write_failed',
      status: 'error',
      payload: {
        operation: 'session.create',
        error_message: err instanceof Error ? err.message : String(err),
      },
    });
    console.error("[miniapp/session POST]", err);
    return miniappFail(err instanceof Error ? err.message : "unknown", origin, 500);
  }
}
