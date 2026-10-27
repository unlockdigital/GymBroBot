function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function average(values) {
  const nums = values.map(toNumber).filter((n) => n != null);
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function dateKey(value) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function daysBetween(a, b) {
  const aKey = dateKey(a);
  const bKey = dateKey(b);
  if (!aKey || !bKey) return null;
  const aMs = Date.parse(`${aKey}T00:00:00.000Z`);
  const bMs = Date.parse(`${bKey}T00:00:00.000Z`);
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return null;
  return Math.round((bMs - aMs) / 86400000);
}

function normalizeExerciseKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^core[-_\s]+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalExerciseName(value, exerciseKb = null) {
  const key = normalizeExerciseKey(value);
  if (!key) return '';
  const aliases = exerciseKb?.aliases || {};
  return aliases[key] || key;
}

function normalizeDayType(value) {
  const text = String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!text) return 'unknown';
  if (/\blower|legs?\b|quad|hamstring|glute/.test(text)) return 'lower body';
  if (/\bupper|push|pull|chest|back|shoulder|arms?/.test(text)) return 'upper body';
  if (/\bfull|total/.test(text)) return 'full body';
  if (/\bcardio|run|zone 2|bike|row/.test(text)) return 'cardio_only';
  if (/\brecovery|mobility|deload/.test(text)) return 'recovery';
  return text;
}

function rowsFromFixtureSession(session) {
  const sessionDate = dateKey(session?.started_at || session?.date);
  const rows = [];
  for (const exercise of session?.exercises || []) {
    const canonical = exercise.canonical || exercise.name || exercise.exercise;
    let index = 0;
    for (const set of exercise.sets || []) {
      index += 1;
      rows.push({
        id: `${sessionDate || 'unknown'}-${canonical}-${index}`,
        session_id: session.id || sessionDate || null,
        sessionDate,
        sessionDayType: normalizeDayType(session.day_type),
        exercise: canonical,
        exercise_canonical: canonical,
        weight: set.weight ?? set.load_lb ?? null,
        reps: set.reps ?? null,
        rpe: set.rpe ?? null,
        notes: set.notes || (set.assistance_lb != null ? `assistance_lb=${set.assistance_lb}` : null),
        measurement_type: set.duration_sec != null ? 'duration_seconds' : (set.measurement_type || 'reps'),
        duration_seconds: set.duration_seconds ?? set.duration_sec ?? null,
        created_at: set.created_at || `${sessionDate || '1970-01-01'}T12:00:${String(index).padStart(2, '0')}.000Z`,
      });
    }
  }
  return rows;
}

function normalizeSessions(context = {}) {
  const sessions = context.recentSessions || context.sessions || [];
  return sessions.map((session) => {
    const startedAt = session.started_at || session.date || session.startedAt || null;
    const dayType = normalizeDayType(session.day_type || session.dayType);
    const sets = Array.isArray(session.sets) && session.sets.length
      ? session.sets.map((set) => ({
        ...set,
        session_id: set.session_id ?? session.id ?? null,
        sessionDate: dateKey(startedAt || set.created_at),
        sessionDayType: dayType,
      }))
      : rowsFromFixtureSession(session);
    return {
      ...session,
      started_at: startedAt,
      sessionDate: dateKey(startedAt),
      day_type: dayType,
      sets,
    };
  });
}

function flattenSets(context = {}) {
  return normalizeSessions(context)
    .flatMap((session) => session.sets.map((set) => ({
      ...set,
      session_id: set.session_id ?? session.id ?? null,
      sessionDate: set.sessionDate || dateKey(session.started_at || set.created_at),
      sessionDayType: normalizeDayType(set.sessionDayType || session.day_type),
      created_at: set.created_at || session.started_at || session.date || null,
    })));
}

function metricDate(row) {
  return dateKey(row?.metric_date || row?.date);
}

function normalizeMetrics(context = {}) {
  const metrics = context.dailyWearableMetrics || context.metrics || context.recovery_history || [];
  return metrics
    .map((row) => ({
      ...row,
      metric_date: metricDate(row),
      sleep_hours: row.sleep_hours ?? row.sleep_hrs ?? null,
      hrv: row.hrv ?? row.hrv_ms ?? null,
      hrv_deep_rmssd: row.hrv_deep_rmssd ?? row.hrv_ms ?? null,
      resting_hr: row.resting_hr ?? row.rhr_bpm ?? null,
      recovery_score: row.recovery_score ?? row.score ?? null,
      readiness_band: row.readiness_band ?? null,
    }))
    .filter((row) => row.metric_date)
    .sort((a, b) => String(b.metric_date).localeCompare(String(a.metric_date)));
}

function targetDate(context = {}) {
  return dateKey(context.todayDate || context.today_date || context.targetDate || context.target_date)
    || normalizeMetrics(context)[0]?.metric_date
    || dateKey(new Date().toISOString());
}

function estimated1rm(set) {
  const weight = toNumber(set?.weight ?? set?.load_lb);
  const reps = toNumber(set?.reps);
  if (weight == null || weight <= 0 || reps == null || reps <= 0) return null;
  return weight * (1 + reps / 30);
}

module.exports = {
  average,
  canonicalExerciseName,
  clamp,
  dateKey,
  daysBetween,
  estimated1rm,
  flattenSets,
  normalizeDayType,
  normalizeExerciseKey,
  normalizeMetrics,
  normalizeSessions,
  round,
  targetDate,
  toNumber,
};
