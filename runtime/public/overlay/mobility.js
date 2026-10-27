export const MOBILITY_ROUTINE = { drills: [] };
export const MOBILITY_MAX_SCORE = 10;
export const MOBILITY_KNEE_PAIN_CEILING = 2;
export const MOBILITY_CORE_TARGET = 5;
export const MOBILITY_COMPLETE_DRILL_MIN = 4;
export const MOBILITY_COMPLETE_MINUTES_MIN = null;
export const MOBILITY_POINTS_COMPLETE = 10;
export const MOBILITY_POINTS_FULL = 15;

// 0..3 low, 4..6 mid, 7..10 high — drives chip color + summary tone.
// null (not answered yet) → 'none'.
export function scoreBand(score) {
  if (score == null) return 'none';
  if (score <= 3) return 'low';
  if (score <= 6) return 'mid';
  return 'high';
}

// Points mirror the server rule:
//   incomplete = 0
//   complete   = 10 (pain/stiffness check-in + 4 core drills)
//   full       = 15 (pain/stiffness check-in + 5 core drills)
export function mobilityPoints({
  drillsDone = 0,
  coreDrillsDone = null,
  coreMinutes = 0,
  totalCoreDrills = MOBILITY_CORE_TARGET,
  kneePain = null,
  hipStiffness = null,
} = {}) {
  const coreDone = coreDrillsDone == null ? drillsDone : coreDrillsDone;
  const painCheckin = kneePain != null || hipStiffness != null;
  if (!painCheckin) return 0;
  if (coreDone >= totalCoreDrills) return MOBILITY_POINTS_FULL;
  void coreMinutes;
  if (coreDone >= MOBILITY_COMPLETE_DRILL_MIN) {
    return MOBILITY_POINTS_COMPLETE;
  }
  return 0;
}

// Pure streak transition. All dates are YYYY-MM-DD strings.
//   - already completed today      → unchanged (min 1)
//   - last completion was yesterday → prev + 1
//   - any other gap (or never)      → reset to 1
export function nextMobilityStreak({
  prevStreak = 0,
  lastCompletedDate = null,
  todayKey,
  yesterdayKey,
}) {
  if (lastCompletedDate === todayKey) return Math.max(prevStreak, 1);
  if (lastCompletedDate === yesterdayKey) return Math.max(prevStreak, 0) + 1;
  return 1;
}

// Streak milestones → badges. A forward hook the completion summary renders.
export const MOBILITY_BADGES = [
  { milestone: 3, label: '3-day streak', emoji: '🥉' },
  { milestone: 7, label: '7-day streak', emoji: '🥈' },
  { milestone: 14, label: '2-week streak', emoji: '🥇' },
  { milestone: 30, label: '30-day streak', emoji: '🏆' },
];

// Returns { earned, justEarned, current, next, toNext }:
//   current   — highest milestone reached (badge to show), or null
//   justEarned — true when this exact streak hits a milestone (celebrate!)
//   next/toNext — the next milestone and days remaining (progress hook)
export function mobilityBadge(streak = 0) {
  let current = null;
  let next = null;
  for (const b of MOBILITY_BADGES) {
    if (streak >= b.milestone) current = b;
    else {
      next = b;
      break;
    }
  }
  const justEarned = MOBILITY_BADGES.some((b) => b.milestone === streak);
  return {
    earned: !!current,
    justEarned,
    current,
    next,
    toNext: next ? next.milestone - streak : 0,
  };
}

// Fresh per-day state. `done` maps drillId → true.
export function defaultMobilityState(todayKey) {
  return {
    date: todayKey,
    done: {},
    kneePain: null,
    hipStiffness: null,
    completedAt: null,
    completionTier: 'incomplete',
    streak: 0,
    lastCompletedDate: null,
    pointsEarned: 0,
    pointsBalance: 0,
    rewards: [],
  };
}

// New-day rollover: keep streak continuity (streak + lastCompletedDate carry
// forward) but reset the day's checklist/scores. Same-day → returned as-is.
export function rolloverMobility(stored, todayKey) {
  if (stored && stored.date === todayKey) return stored;
  const fresh = defaultMobilityState(todayKey);
  if (stored) {
    fresh.streak = stored.streak || 0;
    fresh.lastCompletedDate = stored.lastCompletedDate || null;
  }
  return fresh;
}

// Count of ticked drills in a state's `done` map.
export function drillsDoneCount(mobility) {
  if (!mobility || !mobility.done) return 0;
  return Object.values(mobility.done).filter(Boolean).length;
}

export function coreDrillsDoneCount(mobility, drills = MOBILITY_ROUTINE.drills) {
  if (!mobility || !mobility.done) return 0;
  return drills.filter((d) => d.isCore !== false && mobility.done[d.id]).length;
}
