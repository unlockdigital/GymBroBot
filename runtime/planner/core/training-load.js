const {
  dateKey,
  daysBetween,
  flattenSets,
  normalizeDayType,
  normalizeSessions,
  round,
  targetDate,
  toNumber,
} = require('./compute-utils');

function cardioMinutes(context, withinDays, today) {
  const rows = context.cardioBlocks || context.cardio || [];
  return rows.reduce((sum, row) => {
    const rowDate = dateKey(row.created_at || row.date);
    const age = daysBetween(rowDate, today);
    if (age == null || age < 0 || age >= withinDays) return sum;
    return sum + (toNumber(row.minutes) || 0);
  }, 0);
}

function computeTrainingLoad(context = {}) {
  const today = targetDate(context);
  const sessions = normalizeSessions(context);
  const recentSessions = sessions
    .map((session) => ({ ...session, ageDays: daysBetween(session.sessionDate || session.started_at, today) }))
    .filter((session) => session.ageDays != null && session.ageDays >= 0)
    .sort((a, b) => String(b.sessionDate || '').localeCompare(String(a.sessionDate || '')));
  const weekSessions = recentSessions.filter((session) => session.ageDays < 7);
  const weekSets = flattenSets({ ...context, recentSessions: weekSessions })
    .filter((set) => (set.measurement_type || 'reps') !== 'duration_seconds');

  const weeklyVolumeByDayType = {};
  for (const session of weekSessions) {
    const dayType = normalizeDayType(session.day_type);
    const count = (session.sets || []).filter((set) => (set.measurement_type || 'reps') !== 'duration_seconds').length;
    weeklyVolumeByDayType[dayType] = (weeklyVolumeByDayType[dayType] || 0) + count;
  }

  const weeklyTotalSets = weekSets.length;
  const weeklyHighRpeSets = weekSets.filter((set) => {
    const rpe = toNumber(set.rpe);
    return rpe != null && rpe >= 8.5;
  }).length;
  const lastSession = recentSessions[0] || null;
  const recentDayTypes = weekSessions.map((session) => normalizeDayType(session.day_type));
  const last48hSets = flattenSets({ ...context, recentSessions: weekSessions.filter((session) => session.ageDays < 2) }).length;
  const cardioMins = cardioMinutes(context, 7, today);
  const lastNDaysFatigueIndex = round(Math.min(100, weeklyTotalSets * 2 + weeklyHighRpeSets * 4 + last48hSets * 2 + cardioMins * 0.35), 1);

  return {
    weeklyTotalSets,
    weeklyHighRpeSets,
    weeklyVolumeByDayType,
    lastSessionDate: lastSession ? dateKey(lastSession.sessionDate || lastSession.started_at) : null,
    lastSessionDayType: lastSession ? normalizeDayType(lastSession.day_type) : null,
    recentDayTypes,
    lastNDaysFatigueIndex,
  };
}

module.exports = { computeTrainingLoad };
