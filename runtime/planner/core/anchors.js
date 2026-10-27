const {
  average,
  canonicalExerciseName,
  dateKey,
  estimated1rm,
  flattenSets,
  round,
  toNumber,
} = require('./compute-utils');

function setSortTime(set) {
  return Date.parse(set.created_at || set.createdAt || set.sessionDate || '1970-01-01') || 0;
}

function compareSets(a,b) {
  const time=setSortTime(a)-setSortTime(b);
  if(time) return time;
  return Number.isSafeInteger(a.id)&&Number.isSafeInteger(b.id)?a.id-b.id:0;
}

function chooseBestSet(sets) {
  let best = null;
  for (const set of sets) {
    const e1rm = estimated1rm(set);
    const score = e1rm ?? toNumber(set.weight) ?? toNumber(set.reps) ?? 0;
    if (!best || score > best.score || (score === best.score && compareSets(set, best.set) > 0)) {
      best = { set, score, e1rm };
    }
  }
  return best;
}

function trendForSets(sets) {
  const scored = sets
    .map((set) => ({ set, e1rm: estimated1rm(set), rpe: toNumber(set.rpe) }))
    .filter((row) => row.e1rm != null)
    .sort((a, b) => compareSets(a.set, b.set));
  const avgRpe = average(sets.map((set) => set.rpe));
  if (avgRpe != null && avgRpe >= 9) return 'overreaching';
  if (scored.length < 3) return 'stalling';
  const split = Math.max(1, Math.floor(scored.length / 2));
  const first = average(scored.slice(0, split).map((row) => row.e1rm));
  const last = average(scored.slice(-split).map((row) => row.e1rm));
  if (first == null || last == null) return 'stalling';
  const pct = ((last - first) / first) * 100;
  if (pct >= 2 && (avgRpe == null || avgRpe < 8.8)) return 'progressing';
  if (pct <= -4 || (avgRpe != null && avgRpe >= 8.7)) return 'overreaching';
  return 'stalling';
}

function normalizeAnchorSet(set, exerciseKb) {
  const canonical = canonicalExerciseName(set.exercise_canonical || set.exercise, exerciseKb);
  return {
    id: set.id ?? null,
    sessionId: set.session_id ?? null,
    sessionDate: dateKey(set.sessionDate || set.created_at),
    createdAt: set.created_at || null,
    dayType: set.sessionDayType || null,
    exercise: set.exercise || set.exercise_canonical || canonical,
    canonical,
    weight: toNumber(set.weight ?? set.load_lb),
    reps: toNumber(set.reps),
    rpe: toNumber(set.rpe),
    durationSeconds: toNumber(set.duration_seconds ?? set.duration_sec),
    estimated1rm: round(estimated1rm(set), 1),
    notes: set.notes || null,
  };
}

function findExerciseAnchors(context = {}, exerciseKb = null) {
  const grouped = new Map();
  for (const rawSet of flattenSets(context)) {
    const canonical = canonicalExerciseName(rawSet.exercise_canonical || rawSet.exercise, exerciseKb);
    if (!canonical) continue;
    const set = normalizeAnchorSet({ ...rawSet, exercise_canonical: canonical }, exerciseKb);
    const arr = grouped.get(canonical) || [];
    arr.push(set);
    grouped.set(canonical, arr);
  }

  const byCanonical = {};
  for (const [canonical, sets] of grouped.entries()) {
    const recentSets = [...sets].sort((a, b) => compareSets(b, a));
    const loadedSets = recentSets.filter((set) => set.weight != null && set.weight > 0 && set.reps != null && set.reps > 0);
    const best = chooseBestSet(loadedSets);
    const lastWorking = loadedSets[0] || null;
    const variantsUsed = Array.from(new Set(recentSets.map((set) => set.exercise).filter(Boolean)));
    byCanonical[canonical] = {
      recentSets,
      lastWorkingWeight: lastWorking?.weight ?? null,
      bestRecentSet: best?.set || null,
      estimated1rm: best?.e1rm == null ? null : round(best.e1rm, 1),
      averageRpe: round(average(recentSets.map((set) => set.rpe)), 1),
      trend: trendForSets(recentSets),
      lastSessionDate: recentSets[0]?.sessionDate || null,
      variantsUsed,
    };
  }

  return { byCanonical };
}

module.exports = { findExerciseAnchors };
