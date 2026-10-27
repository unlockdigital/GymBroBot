// PATCH /api/miniapp/cardio/[id] — edit a previously-logged cardio block.
// DELETE /api/miniapp/cardio/[id] — remove it.
// body (PATCH): { phase?, mode?, minutes?, distance_miles?, calories?, notes? }
// returns: { blockId, updated: n }
//
// Split into its own dynamic route so the top-level /cardio route stays
// simple (POST only). Edit flow: client taps a logged cardio row in the
// overview → opens the sheet pre-filled → commit PATCHes here.
import { getWriteDb } from "@/lib/gymbro-write-db";
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
  phase?: "warmup" | "cardio" | "cooldown" | "other";
  mode?: string;
  minutes?: number;
  distance_miles?: number | null;
  calories?: number | null;
  notes?: string | null;
};

const VALID_PHASES = new Set(["warmup", "cardio", "cooldown", "other"]);

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
    return miniappFail("Invalid block id", origin, 400);
  }

  let body: Body;
  try { body = await request.json(); } catch { return miniappFail("Invalid JSON body", origin, 400); }

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.phase != null) {
    const phase = String(body.phase).toLowerCase();
    if (!VALID_PHASES.has(phase)) return miniappFail(`phase must be one of: ${[...VALID_PHASES].join(", ")}`, origin, 400);
    sets.push("phase = ?"); vals.push(phase);
  }
  if (body.mode != null) {
    if (typeof body.mode !== "string" || !body.mode.trim()) return miniappFail("mode must be a non-empty string", origin, 400);
    sets.push("mode = ?"); vals.push(body.mode.toString().toLowerCase().trim());
  }
  if (body.minutes != null) {
    if (!Number.isFinite(Number(body.minutes)) || Number(body.minutes) <= 0) {
      return miniappFail("minutes must be > 0", origin, 400);
    }
    sets.push("minutes = ?"); vals.push(Number(body.minutes));
  }
  if (Object.prototype.hasOwnProperty.call(body, "distance_miles")) {
    sets.push("distance_miles = ?"); vals.push(body.distance_miles == null ? null : Number(body.distance_miles));
  }
  if (Object.prototype.hasOwnProperty.call(body, "calories")) {
    sets.push("calories_burned = ?"); vals.push(body.calories == null ? null : Number(body.calories));
  }
  if (Object.prototype.hasOwnProperty.call(body, "notes")) {
    sets.push("notes = ?"); vals.push(body.notes == null ? null : String(body.notes).slice(0, 400));
  }

  if (sets.length === 0) return miniappFail("No updatable fields provided", origin, 400);

  try {
    const db = getWriteDb();
    // multi-tenancy: scoped by (identity_source, external_user_id)
    const res = db
      .prepare(`UPDATE cardio_blocks SET ${sets.join(", ")}
                WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .run(...vals, id, owner.identitySource, owner.externalUserId);
    if (res.changes === 0) return miniappFail("Block not found", origin, 404);
    return miniappOk({ blockId: id, updated: res.changes }, origin);
  } catch (err) {
    console.error("[miniapp/cardio PATCH]", err);
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
    return miniappFail("Invalid block id", origin, 400);
  }

  try {
    const db = getWriteDb();
    // multi-tenancy: scoped by (identity_source, external_user_id)
    const res = db
      .prepare(`DELETE FROM cardio_blocks
                WHERE id = ? AND identity_source = ? AND external_user_id = ?`)
      .run(id, owner.identitySource, owner.externalUserId);
    if (res.changes === 0) return miniappFail("Block not found", origin, 404);
    return miniappOk({ blockId: id, deleted: res.changes }, origin);
  } catch (err) {
    console.error("[miniapp/cardio DELETE]", err);
    return miniappFail(err instanceof Error ? err.message : "unknown", origin, 500);
  }
}
