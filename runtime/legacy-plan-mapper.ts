// Exact selected generic functions from the existing private bootstrap mapper.
// Private PT/media behavior is supplied by the private overlay hooks, never bundled as public data.
type StrengthEntry=any;type PlanVariant=any;type SetPrescription=any;type KbRow=any;type PlanRow=any;
function normalizeVariants(
  raw: StrengthEntry['variants'],
): PlanVariant[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: PlanVariant[] = [];
  for (const v of raw) {
    if (typeof v === 'string') {
      const name = v.trim();
      if (name) out.push({ name });
    } else if (v && typeof v === 'object' && typeof v.name === 'string') {
      const name = v.name.trim();
      if (!name) continue;
      const canonical = typeof v.canonical === 'string' && v.canonical.trim()
        ? v.canonical.trim()
        : undefined;
      const shortLabel = typeof v.shortLabel === 'string' && v.shortLabel.trim()
        ? v.shortLabel.trim().slice(0, 24)  // tight cap so chips stay one-line
        : undefined;
      const rec: PlanVariant = { name };
      if (canonical) rec.canonical = canonical;
      if (shortLabel) rec.shortLabel = shortLabel;
      out.push(rec);
    }
  }
  return out.length > 0 ? out : undefined;
}

function cleanRpeToken(value: string | null | undefined): string | null {
  return value ? value.replace(/\s+/g, '').replace(/\.+$/, '') : null;
}

function preferredLoadSequenceText(notes: string): string {
  const text = String(notes || '');
  const machinePath = text.match(/\bsame\s+machine\s+path\s*:\s*([\s\S]*?)(?:\bcable\s+setup\s+alternative\s*:|\bcable\s+alternative\s*:|\balternative\s*:|$)/i);
  return (machinePath?.[1] || text).trim();
}

function parseGenericLoadPrescription(notes: string | null): { weight: number; loadMode: "added" | "assisted" } | null {
  if (!notes) return null;
  const text = preferredLoadSequenceText(notes);
  const loadRe = /\b(?:use|start(?:\s+at)?|load|target|around|about)\s+([\d.]+)(?:\s*[-–]\s*([\d.]+))?\s*(?:lb|lbs|pounds?|kg|kgs|kilograms?)\b([^.;]*)/i;
  const match = text.match(loadRe);
  if (!match) return null;
  const low = parseFloat(match[1]);
  const high = match[2] ? parseFloat(match[2]) : low;
  const descriptor = String(match[3] || '').toLowerCase();
  const weight = Number.isFinite(high) ? high : low;
  if (!Number.isFinite(weight)) return null;
  return {
    weight,
    loadMode: /\b(assist|assisted|assistance|offload)\b/.test(descriptor) ? "assisted" : "added",
  };
}

function parseSetPlan(
  notes: string | null,
  plannedSets: number,
  repsStr: string | null,
  rpeStr: string | null,
): SetPrescription[] {
  const fromNotes: Record<number, Omit<SetPrescription, 'set'>> = {};
  if (notes) {
    // "Set N: <weight> [lb] [dumbbells|assistance|machine...] x <reps>"
    // optionally followed by "@ RPE X", "@ X", or "RPE X". Weight can be an
    // integer, decimal, or range ("65-70 lb"); ranges use the low end so the
    // first rendered suggestion is conservative and editable.
    const re = /Set\s+(\d+)\s*:\s*([\d.]+)(?:\s*[-–]\s*([\d.]+))?\s*(?:(?:lb|lbs|pounds?|kg|kgs|kilograms?)\b)?\s*([^.;]*?)\s+x\s*(\d+)(?:\s*[-–]\s*(\d+))?(?:[^.]*?(?:@\s*RPE\s*|RPE\s*|@\s*)([\d.]+(?:\s*[-–]\s*[\d.]+)?))?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(notes)) !== null) {
      const n = parseInt(m[1], 10);
      const w = parseFloat(m[2]);
      const descriptor = String(m[4] || '').toLowerCase();
      const lo = parseInt(m[5], 10);
      const hi = m[6] ? parseInt(m[6], 10) : lo;
      // Strip sentence-terminator periods (RPE "7." → "7", "8.5." → "8.5",
      // "8-8.5." → "8-8.5"). The regex's [\d.]+ greedily swallows the period
      // that ends the clause; we drop trailing dots without harming decimals.
      const rpe = cleanRpeToken(m[7]);
      const loadMode = /\b(assist|assisted|assistance|offload)\b/.test(descriptor)
        ? "assisted"
        : "added";
      if (n >= 1 && Number.isFinite(w)) {
        fromNotes[n] = { weight: w, loadMode, repsLow: lo, repsHigh: hi, rpe };
      }
    }

    if (Object.keys(fromNotes).length === 0) {
      const fallbackText = preferredLoadSequenceText(notes);
      const fallbackRe = /([\d.]+)(?:\s*[-–]\s*([\d.]+))?\s*(?:(?:lb|lbs|pounds?|kg|kgs|kilograms?)\b)?\s*([^.;,]*?)\s+x\s*(\d+)(?:\s*[-–]\s*(\d+))?(?:[^.;,]*?(?:@\s*RPE\s*|RPE\s*|@\s*)([\d.]+(?:\s*[-–]\s*[\d.]+)?))?/gi;
      let m2: RegExpExecArray | null;
      let setNum = 1;
      while ((m2 = fallbackRe.exec(fallbackText)) !== null && setNum <= Math.max(plannedSets || 0, 1)) {
        const w = parseFloat(m2[1]);
        const descriptor = String(m2[3] || '').toLowerCase();
        const lo = parseInt(m2[4], 10);
        const hi = m2[5] ? parseInt(m2[5], 10) : lo;
        const rpe = cleanRpeToken(m2[6]);
        const loadMode = /\b(assist|assisted|assistance|offload)\b/.test(descriptor)
          ? "assisted"
          : "added";
        if (Number.isFinite(w) && Number.isFinite(lo)) {
          fromNotes[setNum] = { weight: w, loadMode, repsLow: lo, repsHigh: hi, rpe };
          setNum += 1;
        }
      }
    }

    if (Object.keys(fromNotes).length === 0) {
      const genericLoad = parseGenericLoadPrescription(notes);
      if (genericLoad) {
        const count = Math.max(plannedSets || 0, 1);
        for (let i = 1; i <= count; i += 1) {
          fromNotes[i] = {
            weight: genericLoad.weight,
            loadMode: genericLoad.loadMode,
            repsLow: null,
            repsHigh: null,
            rpe: null,
          };
        }
      }
    }
  }

  // Per-set reps from the structured `reps` string. Single entry ("8-10") is
  // applied to every set; comma-separated ("8, 8, 6, 8-10") maps 1:1.
  const repsTokens = repsStr
    ? repsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  function repsForSet(i: number): { lo: number | null; hi: number | null } {
    const token = repsTokens.length === 1 ? repsTokens[0] : repsTokens[i - 1];
    if (!token) return { lo: null, hi: null };
    const m = token.match(/(\d+)(?:\s*[-–]\s*(\d+))?/);
    if (!m) return { lo: null, hi: null };
    const lo = parseInt(m[1], 10);
    const hi = m[2] ? parseInt(m[2], 10) : lo;
    return { lo, hi };
  }

  const rpeTokens = rpeStr
    ? rpeStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  function rpeForSet(i: number): string | null {
    if (rpeTokens.length === 0) return null;
    if (rpeTokens.length === 1) return rpeTokens[0];
    return rpeTokens[i - 1] || null;
  }

  const count = Math.max(
    plannedSets || 0,
    Object.keys(fromNotes).length ? Math.max(...Object.keys(fromNotes).map(Number)) : 0,
    repsTokens.length,
    rpeTokens.length,
  );
  const plan: SetPrescription[] = [];
  for (let i = 1; i <= count; i++) {
    const n = fromNotes[i];
    const r = repsForSet(i);
    const rp = rpeForSet(i);
    const weight = n?.weight ?? null;
    const repsLow = n?.repsLow ?? r.lo;
    const repsHigh = n?.repsHigh ?? r.hi;
    const rpe = n?.rpe ?? rp;
    // Drop entries that have nothing useful — no need to carry empty slots.
    if (weight == null && repsLow == null && rpe == null) continue;
    const entry: SetPrescription = { set: i, weight, repsLow, repsHigh, rpe };
    if (n?.loadMode) entry.loadMode = n.loadMode;
    plan.push(entry);
  }
  return plan;
}

function isTimedReps(repsStr: string | null): boolean {
  if (!repsStr) return false;
  return /\b(sec|second|secs|min|minute|mins)\b/i.test(repsStr);
}

function parseTargetDuration(repsStr: string | null): number | null {
  if (!repsStr) return null;
  const m = repsStr.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s*(sec|second|secs|min|minute|mins)\b/i);
  if (!m) return null;
  const lo = parseInt(m[1], 10);
  const unit = m[3].toLowerCase();
  const mult = unit.startsWith('min') ? 60 : 1;
  return lo * mult;
}

function timerSegmentsForReps(repsStr: string | null): { count: number; label?: string } {
  if (!repsStr) return { count: 1 };
  if (/\b(per|each)\s+side\b|\/side\b/i.test(repsStr)) return { count: 2, label: "side" };
  if (/\b(per|each)\s+(arm|leg)\b|\/(arm|leg)\b/i.test(repsStr)) return { count: 2, label: "side" };
  return { count: 1 };
}

function resolveKbForExercise(
  name: string,
  kbByKey: Map<string, KbRow>,
  kbAliasMap: Map<string, string>,
): KbRow | null {
  const canonical = canonicalizeExerciseKey(name);
  if (!canonical) return null;
  const resolved = kbByKey.get(canonical)
    ? canonical
    : kbAliasMap.get(canonical);
  return resolved ? (kbByKey.get(resolved) ?? null) : null;
}

function mapExercise(
  e: StrengthEntry,
  idx: number,
  block: string,
  keyPrefix: string,
  kbByKey: Map<string, KbRow>,
  kbAliasMap: Map<string, string>,
) {
  const range = parseRepRange(e.reps);
  const targetSets = firstInt(e.sets, 3);
  const repsStr = e.reps != null ? String(e.reps) : null;
  const measurement = measurementForExercise(String(e.name), repsStr);
  const timed = measurement === "duration";
  const targetDuration = timed ? parseTargetDuration(repsStr) : null;
  const timerSegments = timed ? timerSegmentsForReps(repsStr) : { count: 1 };
  const prepKey = normalizePtPrepKey(String(e.name)) || "";
  const holdTemplate = prepKey ? PT_PREP_LIBRARY[prepKey] : undefined;
  const setPlan = parseSetPlan(
    typeof e.notes === 'string' ? e.notes : null,
    targetSets,
    repsStr,
    e.rpe != null ? String(e.rpe) : null,
  );
  // If the coach prescribed a first-set weight, surface it as targetWeight
  // so the exercise-row summary + first-set draft shows a real number
  // instead of 0. Falls back to any structured weight field, then 0.
  const firstSetWeight = setPlan.find(s => s.weight != null)?.weight ?? null;
  const targetWeight =
    firstSetWeight != null
      ? firstSetWeight
      : (typeof e.weight === 'number' ? e.weight : (holdTemplate?.targetWeight ?? 0));
  // Mark bodyweight-capable so the Mini App's BW/+Weight/-Assist toggle
  // renders. Plan-loaded exercises previously lacked this flag (only the
  // catalog defaults had it). The flag preserves assistance entry controls.
  const canonical = canonicalizeExerciseKey(String(e.name));
  const holdConfig = holdConfigForExercise(String(e.name));
  const media = exerciseMediaForName(e.name ? String(e.name) : null);
  const kb = resolveKbForExercise(String(e.name), kbByKey, kbAliasMap);
  const kbCues = kb ? parseJson<string[]>(kb.cues_json ?? null, []) : [];
  return {
    id: `${keyPrefix}${slugify(String(e.name)) || `ex-${idx}`}`,
    name: String(e.name),
    // 'duration' matches the Mini App's existing timed-exercise branch
    // (stopwatch bound to targetDuration). 'reps' covers everything else —
    // circuits with complex rep targets ("leg lifts 20-30 + flutter kicks
    // 30-40") fall back to showing the full target in the coach note.
    measurement,
    targetSets,
    targetRepsLow: holdConfig?.isometricHold ? (holdTemplate?.targetRepsLow ?? range.low) : range.low,
    targetRepsHigh: holdConfig?.isometricHold ? (holdTemplate?.targetRepsHigh ?? range.high) : range.high,
    targetDuration,
    timerSegments: timerSegments.count,
    timerSegmentLabel: timerSegments.label,
    targetWeight,
    repLabel: holdConfig?.repLabel,
    holdSeconds: holdConfig?.holdSeconds ?? null,
    isometricHold: !!holdConfig?.isometricHold,
    unit: 'lb',
    block: isPtPrepExerciseName(String(e.name)) ? "prep" : block,
    bodyweight_capable: isBodyweightCapable(kb?.exercise_key || canonical),
    canonicalKey: kb?.exercise_key || canonical,
    formCues: kbCues,
    exercisePhilosophy: kb?.philosophy || undefined,
    rpeTarget: e.rpe ? String(e.rpe) : undefined,
    restHint: e.rest ? String(e.rest) : undefined,
    // Per-set coaching prescriptions (weight + reps + rpe, by set index).
    // Empty array if the plan has no per-set structure — the Mini App
    // gracefully falls through to last-set-repeat behavior in that case.
    setPlan,
    // Full coach notes preserved for display (progress markers, form cues,
    // "skip top set if RPE > 8.5", etc.). The Mini App renders this under
    // the target line so the coaching context travels with the rep.
    coachNote: typeof e.notes === 'string' && e.notes.trim() ? e.notes.trim() : undefined,
    // Circuit/rotate metadata — undefined unless the plan opts in. The Mini
    // App uses these to render the round counter + variant picker and to
    // auto-group same-group exercises into a superset/circuit at session
    // start.
    type: e.type === 'rotate' ? 'rotate' : undefined,
    variants: normalizeVariants(e.variants),
    group: typeof e.group === 'string' && e.group.trim() ? e.group.trim() : undefined,
    media: media ?? undefined,
  };
}

function mapPlan(row: PlanRow, kbByKey: Map<string, KbRow>, kbAliasMap: Map<string, string>) {
  const plan = parseJson<Record<string, unknown>>(row.plan_json, {});
  const strength = Array.isArray((plan as { strength?: unknown }).strength)
    ? ((plan as { strength: StrengthEntry[] }).strength)
    : Array.isArray((plan as { exercises?: unknown }).exercises)
      ? ((plan as { exercises: StrengthEntry[] }).exercises)
      : [];
  // Core block lives alongside strength in the coach's plan_json. Flatten
  // into the same exercises array so the live-workout flow treats bracing/
  // rollout work the same as squats — still loggable set by set, with
  // per-set targets and coach notes. Prefix ids so a core "Plank" can't
  // collide with a hypothetical strength "Plank".
  const core = Array.isArray((plan as { core?: unknown }).core)
    ? ((plan as { core: StrengthEntry[] }).core)
    : [];
  const prep = Array.isArray((plan as { prep?: unknown }).prep)
    ? ((plan as { prep: StrengthEntry[] }).prep)
    : [];
  // Accessory block support for future coach plans that split main lifts
  // from accessories. Safe to be empty today.
  const accessory = Array.isArray((plan as { accessory?: unknown }).accessory)
    ? ((plan as { accessory: StrengthEntry[] }).accessory)
    : [];
  const planExercises = [
    ...prep.filter(e => e && e.name).map((e, idx) => mapExercise(e, idx, 'prep', 'prep-', kbByKey, kbAliasMap)),
    ...strength.filter(e => e && e.name).map((e, idx) => mapExercise(e, idx, 'strength', '', kbByKey, kbAliasMap)),
    ...accessory.filter(e => e && e.name).map((e, idx) => mapExercise(e, idx, 'accessory', 'acc-', kbByKey, kbAliasMap)),
    ...core.filter(e => e && e.name).map((e, idx) => mapExercise(e, idx, 'core', 'core-', kbByKey, kbAliasMap)),
  ];
  const generatedPrep = buildGeneratedPrepExercises(planExercises, kbByKey, kbAliasMap);
  const exercises = [
    ...generatedPrep,
    ...planExercises,
  ];
  return {
    id: `plan-${row.id}`,
    dayName: (plan as { dayName?: string }).dayName
      || (plan as { name?: string }).name
      || `${row.day_type || 'workout'} · ${row.plan_date}`,
    dayType: normalizeDayType(row.day_type),
    plannedAt: row.plan_date,
    source: row.source || "manual",
    status: row.status,
    exercises,
    warmup: Array.isArray((plan as { warmup?: unknown }).warmup) ? (plan as { warmup: string[] }).warmup : [],
    cooldown: Array.isArray((plan as { cooldown?: unknown }).cooldown) ? (plan as { cooldown: string[] }).cooldown : [],
  };
}
export {mapPlan,parseSetPlan};
