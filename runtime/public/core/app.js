import {capture,storageFailed,storageSaved,lockSnapshot,assertWritable,assertDurable} from '../safety.js';
// =========================================================
// GymBroBot Mini App — v1
// Single-module app.
// Scope: launch (today's plan / generate / browse / empty / cardio-only),
// session overview + cardio blocks, active set (reps or duration),
// bodyweight/assistance 3-way toggle, superset linking, tap-to-edit
// numeric keypad, rest timer, exercise switcher, ad-hoc add, pause/resume,
// summary.
// Every user action is piped through track() → miniapp_events table so
// post-workout debug is possible from the logs (no in-app debug view).
// =========================================================
import {
  todaysPlan as mockTodaysPlan,
  savedPlans as mockSavedPlans,
  generateWorkout,
  exerciseKB,
  DAY_TYPES,
  dayTypeLabel,
  adhocCandidates,
  PLATE_CHIPS,
  DEFAULT_REST_SECONDS,
  CARDIO_ACTIVITIES,
  CARDIO_PHASES,
} from '../overlay/sample-workout.js';
import { api, onSyncChange, getSyncState, currentAuthMode, cachedRead, pendingMobility, syncMobilityOutbox } from './api.js';
import {
  track,
  trackError,
  setTelemetryContext,
  flushTelemetry,
} from '../overlay/telemetry.js';
import {
  MOBILITY_ROUTINE,
  MOBILITY_MAX_SCORE,
  MOBILITY_KNEE_PAIN_CEILING,
  MOBILITY_CORE_TARGET,
  MOBILITY_COMPLETE_DRILL_MIN,
  scoreBand,
  mobilityPoints,
  nextMobilityStreak,
  mobilityBadge,
  defaultMobilityState,
  rolloverMobility,
  drillsDoneCount,
  coreDrillsDoneCount,
} from '../overlay/mobility.js';

// Daily Mobility feature flags. The UI ships on; remote persistence is the
// canonical path when the server API/auth are available, with localStorage as
// the offline/dev fallback. Prod can override either flag via
// window.MINIAPP_CONFIG.features without a code change.
const MOBILITY_ENABLED = window.MINIAPP_CONFIG?.features?.mobility ?? true;
const MOBILITY_REMOTE = window.MINIAPP_CONFIG?.features?.mobilityRemote ?? false;
const MOBILITY_TIME_ZONE =
  window.MINIAPP_CONFIG?.timeZone ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  'UTC';
const MOBILITY_DAILY_VISIBLE_MAX = 8;
const MOBILITY_META_REFRESH_DEBOUNCE_MS = 1200;
const MOBILITY_LOCAL_DAILY_IDS = [];

// ---------------------------------------------------------
// Telegram SDK wrapper (no-ops in desktop browser preview)
// ---------------------------------------------------------
const tg = window.Telegram?.WebApp;
function initTelegram() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    tg.setHeaderColor?.('secondary_bg_color');
  } catch (e) { console.warn('TG init:', e); trackError('tg.init', e); }
}
const haptic = (s = 'light') => tg?.HapticFeedback?.impactOccurred?.(s);
const hapticNotify = (t = 'success') => tg?.HapticFeedback?.notificationOccurred?.(t);

// ---------------------------------------------------------
// State
// ---------------------------------------------------------
const state = {
  view: 'launch',     // launch | browse | overview | active | rest | paused | summary | mobility
  session: null,      // populated by initSession()
  activeExerciseId: null,
  draft: null,        // { reps, weight, rpe, durationSeconds?, assistanceMode? } being edited
  rest: null,         // { endsAt, duration, remainingAtPause? }
  workTimer: null,    // { exId, setNum, duration, segments, segmentIndex, remaining, endsAt, running, started, done }
  keypad: null,       // { target: 'reps'|'weight'|'rest'|'duration'|'cardio-min', buffer, fresh }
  switcher: false,
  cardioSheet: null,  // { mode: 'launch'|'inline', phase, activityId, durationMin, note }
  mediaSheet: null,   // { exId, choiceIdx?, source?: 'session'|'mobility' } GIF/image viewer
  mobility: null,     // Daily Mobility checklist for today — see mobility.js / loadMobilityLocal()
  mobilityCatalog: null, // API-backed drill cards, mapped to the same shape as MOBILITY_ROUTINE.drills
  mobilitySyncing: false,
  mobilityRewardRedeemingId: null,
  weighIn: null,      // { weight, linkToSession, note, saving, context: 'launch'|'overview'|'summary' }
  editSet: null,      // { exId, setIdx, weight, reps, durationSeconds, rpe, isTimed, dbSetId, saving }
  linkSheet: null,    // { anchorId, memberIds: string[] } — ad-hoc 2-5 exercise grouping picker
  bootstrap: null,    // { todaysPlan, savedPlans, exerciseKB, recentWeights } from /api/miniapp/bootstrap (null = mocks)
  bodyWeights: [],    // [{ id, timestamp, session_id, weight_lbs }] newest-first; populated from bootstrap
  weighInThisSession: false, // true once a weight is logged against the active session
  browsePlanId: null, // saved-plan id being inspected without starting a workout
  portraitGuardActive: false,
  _switcherSearch: '',
  toast: null,
};

// Ephemeral flags driving one-shot entrance animations. Any re-render
// that happens while an overlay is already open leaves the flag false,
// so the slide-up animation doesn't replay.
let _sheetJustOpened = false;
let _keypadJustOpened = false;
let _toastJustShown = false;
let _cardioSheetJustOpened = false;
let _mediaSheetJustOpened = false;
let _weighInSheetJustOpened = false;
let _editSetSheetJustOpened = false;
let _linkSheetJustOpened = false;
let _clientSetSeq = 0;
let _sessionCreatePromise = null;
let _timerAudioCtx = null;
let _timerAudioUnlocked = false;
let _mobilityDrillSyncSeq = 0;
let _mobilityMetaRefreshTimer = null;
let _lastMobilityCatalogTrackKey = '';
let _telegramPortraitLocked = false;
let _screenPortraitLockAttempted = false;
let _portraitGuardTracked = false;
let _textEntryFocused = false;

// Resolved plans — bootstrap from DB if available, else mock sample data.
// Re-derived every render; cheap since arrays are tiny.
function currentTodaysPlan() {
  const plan = state.bootstrap?.todaysPlan;
  return plan && (!plan.plannedAt || plan.plannedAt === mobilityTodayKey()) ? plan : null;
}
function currentSavedPlans() { return state.bootstrap?.savedPlans || []; }

function normalizeExerciseLibraryText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactExerciseLibraryText(value) {
  return normalizeExerciseLibraryText(value).replace(/\s+/g, '');
}

function exerciseLibraryDisplayName(value) {
  return normalizeExerciseLibraryText(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .replace(/\bRdl\b/g, 'RDL')
    .replace(/\bIr\b/g, 'IR')
    .replace(/\bEr\b/g, 'ER');
}

function inferExerciseLibraryEquipment(key) {
  if (/\bdumbbell\b/.test(key)) return 'dumbbell';
  if (/\bbarbell\b/.test(key)) return 'barbell';
  if (/\bcable\b/.test(key)) return 'cable';
  if (/\bmachine\b/.test(key)) return 'machine';
  return 'library';
}

// The browser ships a compact generator library, while the server owns the
// full canonical exercise KB. Merge both so the switcher exposes every live
// exercise and static generator ids resolve to canonical storage keys.
function currentExerciseKb() {
  const serverRows = Array.isArray(state.bootstrap?.exerciseKB) ? state.bootstrap.exerciseKB : [];
  const exactRows = new Map();
  const aliasRows = new Map();

  for (const row of serverRows) {
    const key = normalizeExerciseLibraryText(row?.key);
    if (!key) continue;
    exactRows.set(key, row);
    for (const value of [key, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
      const alias = normalizeExerciseLibraryText(value);
      if (!alias) continue;
      if (!aliasRows.has(alias)) aliasRows.set(alias, row);
      else if (normalizeExerciseLibraryText(aliasRows.get(alias)?.key) !== key) aliasRows.set(alias, null);
    }
  }

  const merged = exerciseKB.map((item) => {
    const requested = normalizeExerciseLibraryText(item.canonicalKey || item.name);
    const row = exactRows.get(requested) || aliasRows.get(requested) || null;
    return {
      ...item,
      canonicalKey: normalizeExerciseLibraryText(row?.key) || requested,
      aliases: Array.isArray(row?.aliases) ? row.aliases : (item.aliases || []),
    };
  });
  const represented = new Set(merged.map((item) => normalizeExerciseLibraryText(item.canonicalKey)));

  for (const row of serverRows) {
    const key = normalizeExerciseLibraryText(row?.key);
    if (!key || represented.has(key)) continue;
    represented.add(key);
    merged.push({
      id: `kb-${key.replace(/\s+/g, '-')}`,
      name: exerciseLibraryDisplayName(key),
      canonicalKey: key,
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      muscle: 'library',
      category: 'accessory',
      equipment: inferExerciseLibraryEquipment(key),
      measurement: 'reps',
      defaults: { sets: 3, repsLow: 8, repsHigh: 12, weight: 0 },
    });
  }

  return merged;
}

function canonicalKeyForExercise(exercise) {
  const explicit = normalizeExerciseLibraryText(exercise?.canonicalKey);
  if (explicit) return explicit;
  const libraryMatch = currentExerciseKb().find((item) => item.id === exercise?.id);
  return normalizeExerciseLibraryText(libraryMatch?.canonicalKey || exercise?.name || exercise?.id);
}

// Most-recent body weight (lbs) + timestamp; null if no history yet.
function latestBodyWeight() {
  const w = state.bodyWeights?.[0];
  if (!w || w.weight_lbs == null) return null;
  return { value: Number(w.weight_lbs), ts: w.timestamp || null };
}
// Delta between latest two weigh-ins (most recent − previous). null if <2.
function bodyWeightDelta() {
  const [a, b] = state.bodyWeights || [];
  if (!a || !b || a.weight_lbs == null || b.weight_lbs == null) return null;
  return Number(a.weight_lbs) - Number(b.weight_lbs);
}
function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d}d ago`;
}

// ---------------------------------------------------------
// Session persistence — survives app close, phone lock, lost connectivity.
// Stores only the active-session snapshot in localStorage; re-fetches the
// plan list from the server on boot. Snapshots older than 12h are ignored
// (you probably moved on).
// ---------------------------------------------------------
const SESSION_STORAGE_KEY = 'gymbro.miniapp.session.v1';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function saveSessionLocal() {
  try {
    assertWritable();
    if (!state.session) {
      capture(null);
      localStorage.removeItem(SESSION_STORAGE_KEY);
      storageSaved();
      return;
    }
    const snap = {
      version: 1,
      savedAt: Date.now(),
      // Live workout state (everything needed to re-render where you left off)
      session: state.session,
      activeExerciseId: state.activeExerciseId,
      draft: state.draft,
      view: state.view,
      mobilityReturnView: state.mobilityReturnView,
      rest: state.rest,
      workTimer: state.workTimer,
      weighInThisSession: state.weighInThisSession,
    };
    capture(snap);
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snap));
    storageSaved();
  } catch (e) {
    storageFailed(e);
  }
}

function loadSessionLocal() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap?.session || snap.version !== 1) throw Error('Invalid retained workout snapshot');
    return snap;
  } catch(e) { lockSnapshot();storageFailed(e);return null; }
}

function clearSessionLocal() {
  assertWritable();
  assertDurable();
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

// Restore a persisted snapshot into live state. Called once at boot before
// the first render. Returns true if a session was restored so the boot
// sequence can skip the launch screen and show overview/active directly.
function restoreSessionFromLocal() {
  const snap = loadSessionLocal();
  if (!snap) return false;
  state.session = snap.session;
  if (state.session) state.session.dbSessionCreating = false;
  state.activeExerciseId = snap.activeExerciseId || null;
  state.draft = snap.draft || null;
  state.mobilityReturnView = snap.mobilityReturnView || null;
  state.view = snap.view === 'launch' ? 'overview' : (snap.view || 'overview');
  state.weighInThisSession = !!snap.weighInThisSession;
  state.workTimer = snap.workTimer || null;

  // Rest timer: if the deadline already passed while the app was closed,
  // drop rest state and drop user back into the active view.
  if (snap.rest?.endsAt) {
    if (snap.rest.endsAt > Date.now() + 500) {
      state.rest = snap.rest;
      // ticker is started below after DOM is ready
    } else {
      state.rest = null;
      if (state.view === 'rest') state.view = 'active';
    }
  }

  if (state.workTimer?.running && state.workTimer.endsAt && state.workTimer.endsAt <= Date.now()) {
    state.workTimer.running = false;
    state.workTimer.remaining = 0;
    state.workTimer.done = true;
  }

  // Pause state: if was paused when we persisted, keep it paused — user
  // must explicitly Resume so the timer math is clean.
  if (state.session?.pausedAt) {
    state.view = 'paused';
  }

  // Re-wire telemetry context so post-resume events group correctly.
  try {
    setTelemetryContext({
      dbSessionId: state.session.dbSessionId || null,
      clientStart: state.session.clientStart || null,
    });
  } catch (_) {}
  track('session.restored', {
    ageMs: Date.now() - (snap.savedAt || 0),
    view: state.view,
    hasDbId: !!state.session.dbSessionId,
    pendingSets: state.session.pendingSets?.length || 0,
    pendingCardio: state.session.pendingCardio?.length || 0,
  });
  return true;
}

// ---------------------------------------------------------
// Daily Mobility persistence. The canonical path is the dashboard API; the
// local copy keeps the checklist usable while offline and gives the launch card
// an immediate state before the remote refresh returns. Dates are resolved in
// the configured user timezone so "today" matches the reminder schedule.
// ---------------------------------------------------------
const MOBILITY_STORAGE_KEY = 'gymbro.miniapp.mobility.v1';
const LEGACY_MOBILITY_ID_MAP = {};

function dateKeyInTimeZone(date = new Date(), timeZone = MOBILITY_TIME_ZONE) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch (_) {
    return date.toLocaleDateString('en-CA');
  }
}

function mobilityTodayKey() { return dateKeyInTimeZone(new Date()); }
function mobilityYesterdayKey() {
  const d = new Date(`${mobilityTodayKey()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function normalizeMobilityState(m) {
  if (!m || typeof m !== 'object') return m;
  const done = {};
  for (const [id, value] of Object.entries(m.done || {})) {
    if (!value) continue;
    done[LEGACY_MOBILITY_ID_MAP[id] || id] = true;
  }
  return {
    ...m,
    done,
    completionTier: m.completionTier || (m.completedAt ? 'complete' : 'incomplete'),
    pointsBalance: Number.isFinite(Number(m.pointsBalance)) ? Number(m.pointsBalance) : 0,
    rewards: Array.isArray(m.rewards) ? m.rewards : [],
    redemptions: Array.isArray(m.redemptions) ? m.redemptions : [],
  };
}
function loadMobilityLocal() {
  const today = mobilityTodayKey();
  try {
    const raw = localStorage.getItem(MOBILITY_STORAGE_KEY);
    if (raw) return normalizeMobilityState(rolloverMobility(JSON.parse(raw), today));
  } catch (_) {}
  return defaultMobilityState(today);
}
function saveMobilityLocal() {
  try {
    if (state.mobility) localStorage.setItem(MOBILITY_STORAGE_KEY, JSON.stringify(state.mobility));
  } catch (_) {}
}
// Lazily ensure state.mobility exists, rolling over if the day changed since
// it was loaded (covers the app being left open past midnight).
function ensureMobilityState() {
  const today = mobilityTodayKey();
  if (!state.mobility) state.mobility = loadMobilityLocal();
  else if (state.mobility.date !== today) {
    state.mobility = rolloverMobility(state.mobility, today);
    saveMobilityLocal();
  }
  state.mobility = normalizeMobilityState(state.mobility);
  return state.mobility;
}
function fallbackMedia(sourceName) {
  return {
    provider: 'gymbrobot',
    mediaType: 'gif',
    sourceName,
    url: null,
    placeholderTitle: 'Movement reference',
  };
}
function durationTarget(seconds) {
  const n = Number(seconds || 0);
  if (!n) return '';
  if (n % 60 === 0) return `${n / 60} min`;
  return `${n} sec`;
}
function apiDrillToCard(drill) {
  const local = MOBILITY_ROUTINE.drills.find((d) => d.id === drill.slug);
  return {
    ...(local || {}),
    id: drill.slug,
    drillId: drill.id,
    name: drill.name || local?.name || drill.slug,
    target: local?.target || durationTarget(drill.default_duration_seconds) || 'as written',
    focus: local?.focus || drill.target_region || drill.category || 'mobility',
    isCore: drill.is_core !== false,
    defaultDurationSeconds: drill.default_duration_seconds ?? local?.defaultDurationSeconds ?? 60,
    cue: local?.cue || drill.description || 'Move slowly and stay inside a pain-free range.',
    cues: local?.cues || [drill.description || 'Move slowly and stay inside a pain-free range.'],
    media: local?.media || fallbackMedia(drill.name || drill.slug),
    recommendationReason: drill.recommendation_reason || local?.recommendationReason || '',
    recommendationTags: drill.recommendation_tags || local?.recommendationTags || [],
    recommendationRank: drill.recommendation_rank || null,
  };
}
function localDailyMobilityDrills() {
  const byId = new Map(MOBILITY_ROUTINE.drills.map((d) => [d.id, d]));
  const selected = MOBILITY_LOCAL_DAILY_IDS.map((id) => byId.get(id)).filter(Boolean);
  return selected.length >= MOBILITY_COMPLETE_DRILL_MIN
    ? selected
    : MOBILITY_ROUTINE.drills.slice(0, MOBILITY_DAILY_VISIBLE_MAX);
}
function currentMobilityRoutine() {
  const drills = Array.isArray(state.mobilityCatalog) && state.mobilityCatalog.length
    ? state.mobilityCatalog.slice(0, MOBILITY_DAILY_VISIBLE_MAX)
    : localDailyMobilityDrills();
  const seconds = drills.reduce((sum, d) => sum + Number(d.defaultDurationSeconds || 0), 0);
  return {
    ...MOBILITY_ROUTINE,
    drills,
    estMinutes: Math.max(1, Math.round(seconds / 60) || MOBILITY_ROUTINE.estMinutes),
  };
}

function trackMobilityCatalogShown(source = 'render') {
  if (!MOBILITY_ENABLED) return;
  const routine = currentMobilityRoutine();
  const date = state.mobility?.date || mobilityTodayKey();
  const drillIds = routine.drills.map((d) => d.id);
  const key = `${date}:${source}:${drillIds.join('|')}`;
  if (key === _lastMobilityCatalogTrackKey) return;
  _lastMobilityCatalogTrackKey = key;
  track('mobility.catalog_shown', {
    date,
    source,
    total: drillIds.length,
    drillIds,
    reasons: routine.drills.map((d) => ({
      id: d.id,
      rank: d.recommendationRank || null,
      reason: d.recommendationReason || null,
      tags: d.recommendationTags || [],
    })),
  });
}

function mobilityCoreMinutes(m, drills = currentMobilityRoutine().drills) {
  if (!m?.done) return 0;
  const seconds = drills
    .filter((d) => d.isCore !== false && m.done[d.id])
    .reduce((sum, d) => sum + Number(d.defaultDurationSeconds || 0), 0);
  return seconds / 60;
}
function mobilityCompletionTier(m, drills = currentMobilityRoutine().drills) {
  const coreDone = coreDrillsDoneCount(m, drills);
  const availableCore = drills.filter((d) => d.isCore !== false).length || MOBILITY_CORE_TARGET;
  const coreTotal = Math.min(MOBILITY_CORE_TARGET, availableCore);
  const pts = mobilityPoints({
    coreDrillsDone: coreDone,
    coreMinutes: mobilityCoreMinutes(m, drills),
    totalCoreDrills: coreTotal,
    kneePain: m?.kneePain,
    hipStiffness: m?.hipStiffness,
  });
  if (pts >= 15) return 'full';
  if (pts >= 10) return 'complete';
  return 'incomplete';
}
function applyMobilityRemoteState({ sessionView = null, summary = null, rewardsData = null } = {}) {
  if (sessionView?.queued || pendingMobility().length) return;
  const date = sessionView?.date || summary?.today || mobilityTodayKey();
  const existing = state.mobility?.date === date
    ? normalizeMobilityState(state.mobility)
    : rolloverMobility(state.mobility, date);
  const done = {};
  for (const item of sessionView?.items || []) {
    if (item.completed && item.drill_slug) done[item.drill_slug] = true;
  }
  const session = sessionView?.session || null;
  const tier = session?.completion_tier || existing.completionTier || 'incomplete';
  const complete = tier === 'complete' || tier === 'full';
  const rewards = rewardsData?.rewards || existing.rewards || [];
  const points = rewardsData?.points || summary?.points || null;
  const redemptions = rewardsData?.redemptions || existing.redemptions || [];
  state.mobility = normalizeMobilityState({
    ...existing,
    date,
    done: sessionView ? done : existing.done,
    kneePain: session ? session.knee_pain_score : existing.kneePain,
    hipStiffness: session ? session.hip_groin_stiffness_score : existing.hipStiffness,
    completedAt: complete
      ? (session?.updated_at || session?.created_at || existing.completedAt || new Date().toISOString())
      : null,
    completionTier: tier,
    streak: summary?.streak?.current ?? existing.streak ?? 0,
    lastCompletedDate: summary?.streak?.last_complete_date ?? existing.lastCompletedDate ?? null,
    pointsEarned: session?.points_awarded ?? existing.pointsEarned ?? 0,
    pointsBalance: points?.balance ?? existing.pointsBalance ?? 0,
    rewards,
    redemptions,
    summary: summary || existing.summary || null,
    remoteSyncedAt: Date.now(),
    syncError: null,
  });
  saveMobilityLocal();
}
async function refreshMobilityRemote({ renderAfter = false, silent = true } = {}) {
  if (!MOBILITY_ENABLED || !MOBILITY_REMOTE) return false;
  const date = mobilityTodayKey();
  state.mobilitySyncing = true;
  try {
    await syncMobilityOutbox();
    const [catalog, sessionView, summary, rewardsData] = await Promise.all([
      api.mobilityCatalog(date),
      api.mobilitySession(date),
      api.mobilitySummary(date, 21),
      api.mobilityRewards(),
    ]);
    if (Array.isArray(catalog?.drills)) {
      state.mobilityCatalog = catalog.drills.map(apiDrillToCard);
    }
    applyMobilityRemoteState({ sessionView, summary, rewardsData });
    trackMobilityCatalogShown('remote_refresh');
    return true;
  } catch (err) {
    const m = ensureMobilityState();
    m.syncError = err?.message || 'Mobility sync failed';
    saveMobilityLocal();
    trackError('mobility.refresh', err);
    if (!silent) showToast('Mobility using local mode');
    return false;
  } finally {
    state.mobilitySyncing = false;
    if (renderAfter) renderAfterMobilityUpdate();
  }
}
async function refreshMobilityMeta({ renderAfter = false } = {}) {
  if (!MOBILITY_REMOTE) return;
  const date = mobilityTodayKey();
  try {
    const [summary, rewardsData] = await Promise.all([
      api.mobilitySummary(date, 21),
      api.mobilityRewards(),
    ]);
    applyMobilityRemoteState({ summary, rewardsData });
  } catch (err) {
    trackError('mobility.meta', err);
  } finally {
    if (renderAfter) renderAfterMobilityUpdate();
  }
}
function scheduleMobilityMetaRefresh({ renderAfter = true } = {}) {
  if (!MOBILITY_REMOTE) return;
  if (_mobilityMetaRefreshTimer) clearTimeout(_mobilityMetaRefreshTimer);
  _mobilityMetaRefreshTimer = setTimeout(() => {
    _mobilityMetaRefreshTimer = null;
    refreshMobilityMeta({ renderAfter });
  }, MOBILITY_META_REFRESH_DEBOUNCE_MS);
}
function cancelScheduledMobilityMetaRefresh() {
  if (!_mobilityMetaRefreshTimer) return;
  clearTimeout(_mobilityMetaRefreshTimer);
  _mobilityMetaRefreshTimer = null;
}
async function syncMobilityScores() {
  if (!MOBILITY_REMOTE) return;
  const m = ensureMobilityState();
  try {
    const sessionView = await api.saveMobilityCheckin({
      date: m.date,
      knee_pain_score: m.kneePain,
      hip_groin_stiffness_score: m.hipStiffness,
      notes: 'miniapp',
    });
    applyMobilityRemoteState({ sessionView });
    scheduleMobilityMetaRefresh({ renderAfter: true });
  } catch (err) {
    trackError('mobility.score_sync', err);
    showToast('Mobility check-in not synced');
  }
}
// Set a 0–10 score from a tapped chip; tapping the current value clears it.
function setMobilityScore(key, el) {
  const score = Number(el.dataset.score);
  if (!Number.isFinite(score)) return;
  const m = ensureMobilityState();
  m[key] = m[key] === score ? null : score;
  saveMobilityLocal();
  haptic('light');
  track('mobility.score', { key, score: m[key] });
  renderPreservingScroll();
  syncMobilityScores();
}
function renderAfterMobilityUpdate() {
  if (state.view === 'mobility') {
    renderPreservingScroll();
    return;
  }
  renderPreservingScroll();
}

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const activeEx = () => state.session?.exercises.find(e => e.id === state.activeExerciseId);
const exercisesDone = () =>
  state.session ? state.session.exercises.filter(e => e.sets.length >= e.targetSets || e.skipped).length : 0;
const setsDone = () =>
  state.session ? state.session.exercises.reduce((s, e) => s + e.sets.length, 0) : 0;

function nextClientSetId() {
  _clientSetSeq += 1;
  return `cs-${Date.now().toString(36)}-${_clientSetSeq.toString(36)}`;
}

function repLabelForExercise(ex) {
  return ex?.repLabel || (ex?.isometricHold ? 'Holds' : 'Reps');
}

function repUnitForExercise(ex) {
  return repLabelForExercise(ex).toLowerCase();
}

function targetRepSuffix(ex) {
  return ex?.holdSeconds ? ` · ${ex.holdSeconds}s each` : '';
}

function findLoggedSetByClientId(clientSetId) {
  if (!clientSetId || !state.session?.exercises) return null;
  for (const ex of state.session.exercises) {
    const idx = ex.sets.findIndex(s => s.clientSetId === clientSetId);
    if (idx >= 0) return { ex, set: ex.sets[idx], setIdx: idx };
  }
  return null;
}

function elapsedSec() {
  if (!state.session) return 0;
  const now = state.session.pausedAt ?? Date.now();
  return Math.max(0, Math.floor((now - state.session.startedAt - state.session.accumulatedPaused) / 1000));
}
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '–';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function avgRpe(sets) {
  const rpes = sets.map(s => s.rpe).filter(r => r != null);
  if (!rpes.length) return '–';
  return (rpes.reduce((a, b) => a + b, 0) / rpes.length).toFixed(1);
}
function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch (_) { return iso; }
}
// "Today" label for the launch screen. The plan's `plannedAt` can lag by a
// day because bootstrap returns the most recent plan which may have been
// generated yesterday (or drift across UTC→local midnight). The user-facing
// header should always say *actual* today in their local time — we compute
// it from `new Date()` directly so it tracks the device clock.
function todayLocalLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function estimateDuration(plan) {
  if (!plan?.exercises?.length) return 30;
  const totalSets = plan.exercises.reduce((s, e) => s + (e.targetSets || 3), 0);
  return Math.round(totalSets * 3.5);
}
function clearToast() {
  if (state.toast?.timer) clearTimeout(state.toast.timer);
  state.toast = null;
}
function showToast(msg, opts = {}) {
  clearToast();
  const durationMs = opts.durationMs ?? (opts.action ? 3400 : 1700);
  state.toast = {
    message: msg,
    action: opts.action || null,
    actionLabel: opts.actionLabel || '',
    drillId: opts.drillId || null,
    timer: setTimeout(() => { state.toast = null; renderPreservingScroll(); }, durationMs),
  };
  _toastJustShown = true;
  renderPreservingScroll();
}
// Look up the coach's prescription for the set the user is about to do.
// Returns undefined if no per-set plan was carried in the bootstrap payload,
// or if we've run past the end of the plan (e.g. user added an extra set).
function plannedSet(ex) {
  if (!Array.isArray(ex.setPlan) || ex.setPlan.length === 0) return null;
  const idx = ex.sets.length; // next set = 0-based index into setPlan
  return ex.setPlan[idx] || null;
}

function workTimerSegments(ex) {
  const n = Number(ex?.timerSegments || 1);
  return Number.isFinite(n) && n > 1 ? Math.min(4, Math.round(n)) : 1;
}

function workTimerSetNum(ex) {
  return (ex?.sets?.length || 0) + 1;
}

function workTimerMatches(timer, ex) {
  return !!timer && !!ex && timer.exId === ex.id && timer.setNum === workTimerSetNum(ex);
}

function getActiveWorkTimer(ex = activeEx()) {
  return workTimerMatches(state.workTimer, ex) ? state.workTimer : null;
}

function createWorkTimer(ex) {
  const duration = Math.max(1, Math.round(Number(state.draft?.durationSeconds || ex?.targetDuration || 30)));
  return {
    exId: ex.id,
    setNum: workTimerSetNum(ex),
    duration,
    segments: workTimerSegments(ex),
    segmentIndex: 0,
    remaining: duration,
    endsAt: null,
    running: false,
    started: false,
    done: false,
  };
}

function workTimerRemaining(timer) {
  if (!timer) return 0;
  if (timer.done) return 0;
  if (timer.running && timer.endsAt) {
    return Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
  }
  return Math.max(0, Math.round(timer.remaining ?? timer.duration ?? 0));
}

function workTimerSegmentName(ex, timer = null) {
  const t = timer || getActiveWorkTimer(ex);
  const idx = Math.max(0, t?.segmentIndex || 0);
  const label = String(ex?.timerSegmentLabel || '').toLowerCase();
  if (label === 'side') return `Side ${idx + 1}`;
  if (label) return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${idx + 1}`;
  return `Round ${idx + 1}`;
}

function syncWorkTimerDurationToDraft() {
  const ex = activeEx();
  const timer = getActiveWorkTimer(ex);
  if (!timer || timer.running) return;
  const next = Math.max(1, Math.round(Number(state.draft?.durationSeconds || ex?.targetDuration || timer.duration || 30)));
  timer.duration = next;
  timer.remaining = next;
  if (timer.done) timer.segmentIndex = 0;
  timer.done = false;
}

function pauseRunningWorkTimer() {
  if (!state.workTimer?.running) return false;
  state.workTimer.remaining = workTimerRemaining(state.workTimer);
  state.workTimer.running = false;
  state.workTimer.endsAt = null;
  clearWorkTimerTicker();
  return true;
}

function workTimerWasStarted(timer) {
  if (!timer) return false;
  return !!timer.started || !!timer.running || Number(timer.segmentIndex || 0) > 0 || Number(timer.remaining) !== Number(timer.duration);
}

function timerAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!_timerAudioCtx) _timerAudioCtx = new Ctx();
  return _timerAudioCtx;
}

function unlockTimerAudio() {
  try {
    const ctx = timerAudioContext();
    if (!ctx) return false;
    if (ctx.state === 'running') {
      _timerAudioUnlocked = true;
      return true;
    }
    const resumed = ctx.resume?.();
    if (resumed?.then) resumed.then(() => { _timerAudioUnlocked = ctx.state === 'running'; }).catch(() => {});
    return _timerAudioUnlocked;
  } catch (_) {
    return false;
  }
}

function scheduleTimerChirp(ctx, kind = 'timer') {
  if (!ctx || ctx.state !== 'running') return false;
  const now = ctx.currentTime;
  const baseFreq = kind === 'rest' ? 784 : 1046;
  const peakFreq = kind === 'rest' ? 988 : 1318;
  [0, 0.28, 0.56].forEach((offset, idx) => {
    const start = now + offset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(baseFreq + idx * 32, start);
    osc.frequency.exponentialRampToValueAtTime(peakFreq + idx * 40, start + 0.1);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.2);
  });
  return true;
}

function playTimerChirp(kind = 'timer') {
  try {
    const ctx = timerAudioContext();
    if (!_timerAudioUnlocked || !ctx) return false;
    if (ctx.state === 'running') return scheduleTimerChirp(ctx, kind);
    const resumed = ctx.resume?.();
    if (resumed?.then) {
      resumed.then(() => {
        if (ctx.state === 'running') {
          _timerAudioUnlocked = true;
          scheduleTimerChirp(ctx, kind);
        }
      }).catch(() => {});
    }
    return false;
  } catch (_) {
    return false;
  }
}

function fireTimerEndAlert(kind = 'timer') {
  const notification = kind === 'rest' ? 'warning' : 'success';
  try { hapticNotify(notification); } catch (_) {}
  try { haptic('heavy'); } catch (_) {}
  try { navigator.vibrate?.(kind === 'rest' ? [180, 80, 180, 80, 260] : [180, 80, 180]); } catch (_) {}
  const audioPlayed = playTimerChirp(kind);
  track('timer.alert', {
    kind,
    telegramHaptics: !!tg?.HapticFeedback,
    vibrate: !!navigator.vibrate,
    audioUnlocked: _timerAudioUnlocked,
    audioPlayed,
  });
}

function vibrateWorkTimerDone() {
  fireTimerEndAlert('work');
}

function keypadTelemetryContext(target) {
  const ctx = { target };
  const ex = activeEx();
  if (['reps', 'weight', 'duration'].includes(target) && ex) {
    ctx.exercise = ex.name;
    ctx.exId = ex.id;
    ctx.setNum = (ex.sets?.length || 0) + 1;
  }
  if (String(target || '').startsWith('editset-') && state.editSet) {
    const editEx = state.session?.exercises?.find((candidate) => candidate.id === state.editSet.exId);
    ctx.exercise = editEx?.name || null;
    ctx.exId = state.editSet.exId || null;
    ctx.setIndex = state.editSet.setIdx ?? null;
    ctx.dbSetId = state.editSet.dbSetId || null;
  }
  if (target === 'cardio-min' && state.cardioSheet) {
    ctx.cardioMode = state.cardioSheet.mode || null;
    ctx.phase = state.cardioSheet.phase || null;
    ctx.activityId = state.cardioSheet.activityId || null;
    ctx.editingIndex = state.cardioSheet.editingIndex ?? null;
  }
  if (target === 'bodyweight' && state.weighIn) {
    ctx.weighInContext = state.weighIn.context || null;
    ctx.linkToSession = !!state.weighIn.linkToSession;
  }
  return ctx;
}

function plannedLoadLabel(ex, planned = null, fallbackWeight = null) {
  const unit = ex?.unit || 'lb';
  const mode = planned?.loadMode || null;
  const weight = planned?.weight != null ? Number(planned.weight)
    : fallbackWeight != null ? Number(fallbackWeight)
      : null;
  if (mode === 'assisted') {
    return Number.isFinite(weight) && weight > 0 ? `${fmtNum(weight)} ${unit} assistance` : 'assistance';
  }
  if (ex?.bodyweight_capable && (!Number.isFinite(weight) || weight <= 0)) return 'BW';
  if (!Number.isFinite(weight)) return null;
  return `${fmtNum(weight)} ${unit}`;
}

// --- Group helpers (superset / circuit / rotating slot) ---
// A group in state.session.supersetGroups holds 2+ exercise ids under a
// letter key. `kind` is 'superset' (2 members) or 'circuit' (3+); `label`
// is the human name ("Core"). Plan-driven groups come from the ex.group
// field; ad-hoc groups from the link-superset action.
function groupMembers(groupKey) {
  return state.session?.supersetGroups?.[groupKey] || [];
}
function groupKind(groupKey) {
  return state.session?.supersetKinds?.[groupKey]
    || (groupMembers(groupKey).length >= 3 ? 'circuit' : 'superset');
}
function groupLabel(groupKey) {
  return state.session?.supersetLabels?.[groupKey] || '';
}
function isCircuit(ex) {
  return !!(ex?.supersetGroup && groupKind(ex.supersetGroup) === 'circuit');
}
function groupOrder(groupKey) {
  const s = state.session;
  const members = groupMembers(groupKey);
  if (!s || members.length === 0) return [];
  if (!s.supersetOrders) s.supersetOrders = {};
  const saved = Array.isArray(s.supersetOrders[groupKey]) ? s.supersetOrders[groupKey] : [];
  const seen = new Set();
  const order = [];
  for (const id of saved) {
    if (members.includes(id) && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const id of members) {
    if (!seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  s.supersetOrders[groupKey] = order;
  return order;
}
function orderedGroupExercises(groupKey) {
  const order = groupOrder(groupKey);
  return order
    .map(id => state.session?.exercises?.find(e => e.id === id))
    .filter(Boolean);
}
function supersetPayloadForGroup(groupKey) {
  const memberExs = orderedGroupExercises(groupKey);
  if (memberExs.length < 2) return null;
  return {
    superset_group: groupKey,
    exercises: memberExs.map(e => e.name),
    kind: groupKind(groupKey),
    label: groupLabel(groupKey) || memberExs.map(e => e.name).join(' + ').slice(0, 80),
  };
}
function queueSupersetMetadataWrite(groupKey, reason = 'order') {
  const payload = supersetPayloadForGroup(groupKey);
  if (!payload || !state.session) return;
  persistSupersetWrite(payload);
}
function persistSupersetWrite(payload) {
  state.session.pendingSupersets.push(payload);
  saveSessionLocal();
  if (state.session.dbSessionId) void flushPendingSupersetsOnce();
}
function orderedPendingAfter(groupKey, fromId, predicate) {
  const order = groupOrder(groupKey);
  if (!order.length) return null;
  const start = Math.max(0, order.indexOf(fromId));
  const rotated = [...order.slice(start + 1), ...order.slice(0, start + 1)];
  for (const id of rotated) {
    const ex = state.session?.exercises?.find(e => e.id === id);
    if (ex && predicate(ex)) return ex;
  }
  return null;
}
function reanchorGroupOrderForManualJump(ex) {
  const groupKey = ex?.supersetGroup;
  if (!groupKey || !state.session) return false;
  const currentOrder = groupOrder(groupKey);
  if (!currentOrder.includes(ex.id)) return false;
  const selectedRound = (ex.sets?.length || 0) + 1;
  const orderIdx = id => {
    const idx = currentOrder.indexOf(id);
    return idx < 0 ? currentOrder.length : idx;
  };
  const completedThisRound = orderedGroupExercises(groupKey)
    .filter(member => member.id !== ex.id && !member.skipped && (member.sets?.length || 0) >= selectedRound)
    .sort((a, b) => {
      const at = a.sets?.[selectedRound - 1]?.loggedAt || 0;
      const bt = b.sets?.[selectedRound - 1]?.loggedAt || 0;
      if (at !== bt) return at - bt;
      return orderIdx(a.id) - orderIdx(b.id);
    })
    .map(member => member.id);
  const used = new Set([...completedThisRound, ex.id]);
  const remainder = currentOrder.filter(id => !used.has(id));
  const nextOrder = [...completedThisRound, ex.id, ...remainder];
  if (nextOrder.join('\0') === currentOrder.join('\0')) return false;
  state.session.supersetOrders[groupKey] = nextOrder;
  track('superset.order_update', { group: groupKey, selected: ex.id, order: nextOrder });
  queueSupersetMetadataWrite(groupKey, 'order_update');
  return true;
}
// Rotating slot: plan declared type='rotate' with a variants[] array.
function isRotateSlot(ex) {
  return ex?.type === 'rotate' && Array.isArray(ex.variants) && ex.variants.length > 0;
}
// Default variant for the round we're about to log: round-robin index.
// Round = ex.sets.length + 1; 0-based index wraps across variants.
function defaultVariantIndex(ex) {
  if (!isRotateSlot(ex)) return 0;
  const round = ex.sets.length; // 0-indexed
  return round % ex.variants.length;
}

// Ad-hoc linking is intentionally broad: any non-skipped exercise in the
// workout is linkable, even if it has reached targetSets, AND even if it
// is already a member of another group. The user is the conductor — if
// they want to pair an exercise that the planner pre-grouped, the link
// sheet shows a "in group X" hint and confirm-link migrates the exercise
// out of its prior group (dissolving that group if it would shrink below
// 2 members). The only exclusion is `skipped`, since logging more sets on
// a skipped exercise is non-sensical (the user can un-skip first).
function isAdhocLinkable(ex, { lockedIds = null } = {}) {
  if (!ex) return false;
  if (lockedIds?.has(ex.id)) return true;
  if (ex.skipped) return false;
  return true;
}

function cleanUserNote(value) {
  const note = String(value || '').replace(/\s+/g, ' ').trim();
  return note ? note.slice(0, 240) : null;
}

function renderPreservingSelectorScroll(selectors = []) {
  if (typeof $app === 'undefined' || !$app) {
    render();
    return;
  }
  const scrolls = selectors
    .map(selector => {
      const el = $app.querySelector(selector);
      return el ? { selector, top: el.scrollTop, left: el.scrollLeft } : null;
    })
    .filter(Boolean);
  const restore = () => {
    for (const item of scrolls) {
      const el = $app.querySelector(item.selector);
      if (!el) continue;
      el.scrollTop = item.top;
      el.scrollLeft = item.left;
    }
  };
  render();
  restore();
  if (typeof setTimeout === 'function') setTimeout(restore, 0);
}

function seedSummaryWeighInPrompt() {
  if (setsDone() <= 0 || state.weighInThisSession || state.weighIn) return false;
  state.weighIn = {
    weight: latestBodyWeight()?.value ?? '',
    linkToSession: true,
    note: 'post-workout',
    saving: false,
    context: 'summary',
  };
  _weighInSheetJustOpened = true;
  track('weighin.auto_prompt', { setsDone: setsDone() });
  return true;
}

function draftFor(ex) {
  const isTimed = ex.measurement === 'duration';
  // Default assistance: 'added' keeps old reps-only behavior unaffected.
  const defaultMode = ex.bodyweight_capable
    ? (ex.sets[0]?.assistanceMode || ex.last?.assistanceMode || (ex.targetWeight > 0 ? 'added' : 'pure_bw'))
    : 'added';
  const lastInSession = ex.sets.length > 0 ? ex.sets[ex.sets.length - 1] : null;
  // Rotating slot: pre-select the round-robin variant so the "Complete set"
  // button has a valid target even if the user never taps a chip. User can
  // override by tapping a different variant chip before completing.
  const variantIndex = isRotateSlot(ex) ? defaultVariantIndex(ex) : null;

  // Coach prescription for this specific set wins over last-set-repeat.
  // That's the whole point of a ramped/progressive plan: set 2 should suggest
  // 185 even if the user just logged 175 for set 1. If the plan entry has
  // no weight (bodyweight movements), we still honor its reps/rpe but fall
  // through for the weight from the nearest real source.
  const p = isTimed ? null : plannedSet(ex);
  if (p) {
    const repsFromPlan =
      p.repsLow != null && p.repsHigh != null && p.repsLow !== p.repsHigh
        ? p.repsLow // start at low end of the range; user can bump up
        : p.repsLow ?? p.repsHigh ?? null;
    const weightFromPlan = p.weight != null
      ? p.weight
      : (lastInSession?.weight ?? ex.last?.weight ?? ex.targetWeight ?? 0);
    const plannedMode = ex.bodyweight_capable && p.loadMode === 'assisted'
      ? 'assisted'
      : null;
    return {
      reps: repsFromPlan ?? (ex.targetRepsLow || 10),
      durationSeconds: null,
      weight: weightFromPlan,
      rpe: null,
      assistanceMode: plannedMode || lastInSession?.assistanceMode || ex.last?.assistanceMode || defaultMode,
      variantIndex,
    };
  }

  if (lastInSession) {
    const carriedMode = lastInSession.assistanceMode || defaultMode;
    // When the prior set was assisted, the displayed weight input represents
    // pounds of assistance — pull from assistanceLbs so the user doesn't lose
    // their previous input on set 2.
    const carriedWeight = (carriedMode === 'assisted' && lastInSession.assistanceLbs != null)
      ? lastInSession.assistanceLbs
      : lastInSession.weight;
    return {
      reps: isTimed ? null : lastInSession.reps,
      durationSeconds: isTimed ? lastInSession.durationSeconds : null,
      weight: carriedWeight,
      rpe: null,
      assistanceMode: carriedMode,
      variantIndex,
    };
  }
  if (ex.last) {
    return {
      reps: isTimed ? null : ex.last.reps,
      durationSeconds: isTimed ? ex.last.durationSeconds : null,
      weight: ex.last.weight,
      rpe: null,
      assistanceMode: ex.last.assistanceMode || defaultMode,
      variantIndex,
    };
  }
  return {
    reps: isTimed ? null : (ex.targetRepsLow || 10),
    durationSeconds: isTimed ? (ex.targetDuration || 30) : null,
    weight: ex.targetWeight || 0,
    rpe: null,
    assistanceMode: defaultMode,
    variantIndex,
  };
}

// Build a live session from a plan (or null for an empty session).
// Local-only state; call startSession() to also persist to DB.
function initSession(plan) {
  clearRestTicker();
  state.weighInThisSession = false;
  state.weighIn = null;
  const startedAt = Date.now();
  const clientStart = new Date(startedAt).toISOString();
  state.session = {
    dayName: plan?.dayName || 'Empty session',
    dayType: plan?.dayType || null,
    planId: plan?.id || null,
    // ISO date (YYYY-MM-DD) of the saved plan this session was started
    // from. Sent to the server so the row's notes get the bot-compatible
    // `loaded plan YYYY-MM-DD` prefix; null for ad-hoc/empty sessions.
    planDate: plan?.plannedAt || null,
    source: plan?.source || 'empty',
    warmup: Array.isArray(plan?.warmup) ? plan.warmup : [],
    cooldown: Array.isArray(plan?.cooldown) ? plan.cooldown : [],
    startedAt,
    clientStart,                 // stable ISO id for grouping events pre-DB
    pausedAt: null,
    accumulatedPaused: 0,
    dbSessionId: null,           // populated by startSession() after POST
    pendingSets: [],             // logs logged while dbSessionId was null
    pendingCardio: [],           // cardio blocks logged while dbSessionId was null
    pendingSupersets: [],        // superset groups awaiting DB session
    supersetGroups: {},          // { [groupLetter]: [exId, exId, ...] } members
    supersetLabels: {},          // { [groupLetter]: "Core" } human label
    supersetKinds: {},           // { [groupLetter]: 'superset' | 'circuit' }
    supersetOrders: {},          // { [groupLetter]: [exId, ...] } mutable in-round order
    nextSupersetLetter: 'A',
    cardioBlocks: [],            // { phase, activity, durationSeconds, notes, dbId? }
    exercises: (plan?.exercises || []).map(e => ({
      ...e,
      sets: [],
      skipped: false,
      // carry through flags from KB / plan so active view knows
      bodyweight_capable: !!e.bodyweight_capable,
      measurement: e.measurement || 'reps',
      targetDuration: e.targetDuration || e.defaults?.durationSeconds || null,
    })),
  };
  state.activeExerciseId = null;
  state.draft = null;
  state.rest = null;
  state.workTimer = null;
  state.keypad = null;
  state.switcher = false;
  state.cardioSheet = null;
  state.mediaSheet = null;
  state._switcherSearch = '';
  state.view = 'overview';

  // Scan for plan-driven groupings (ex.group field from bootstrap) and
  // auto-create superset/circuit groups before the user touches the screen.
  // Same group name → same letter; letter count determines kind.
  initPlanGroups();

  // Link all telemetry emitted from here on to this session.
  setTelemetryContext({ clientStart, dbSessionId: null });
  track('session.init_local', {
    dayName: state.session.dayName,
    dayType: state.session.dayType,
    planId: state.session.planId,
    source: state.session.source,
    exerciseCount: state.session.exercises.length,
    groupCount: Object.keys(state.session.supersetGroups).length,
  });
}

// Walk the exercises for .group fields coming from the plan JSON and
// assemble supersetGroups / supersetLabels / supersetKinds. Queue one
// pendingSupersets payload per group so the backend supersets table gets
// rows as soon as the DB session id is known.
function initPlanGroups() {
  const s = state.session;
  if (!s) return;
  const labelToLetter = {};
  let next = s.nextSupersetLetter || 'A';
  for (const ex of s.exercises) {
    if (!ex.group) continue;
    if (!labelToLetter[ex.group]) {
      labelToLetter[ex.group] = next;
      s.supersetGroups[next] = [];
      s.supersetLabels[next] = ex.group;
      next = String.fromCharCode(next.charCodeAt(0) + 1);
    }
    const letter = labelToLetter[ex.group];
    ex.supersetGroup = letter;
    s.supersetGroups[letter].push(ex.id);
  }
  s.nextSupersetLetter = next;
  // Classify kind per group — 2 members = superset, 3+ = circuit.
  for (const [letter, members] of Object.entries(s.supersetGroups)) {
    s.supersetKinds[letter] = members.length >= 3 ? 'circuit' : 'superset';
    s.supersetOrders[letter] = [...members];
  }
  // Queue server-side writes. flushPendingSupersets() drains this once the
  // DB session id is available.
  for (const [letter, members] of Object.entries(s.supersetGroups)) {
    const memberExs = members
      .map(id => s.exercises.find(e => e.id === id))
      .filter(Boolean);
    if (memberExs.length < 2) continue;
    s.pendingSupersets.push({
      superset_group: letter,
      exercises: memberExs.map(e => e.name),
      kind: s.supersetKinds[letter],
      label: s.supersetLabels[letter],
    });
  }
}

function sessionCreatePayload(s) {
  return {
    client_start_id: s.clientStart || String(s.startedAt),
    client_started_at: s.clientStart || new Date(s.startedAt).toISOString(),
    dayName: s.dayName,
    dayType: s.dayType,
    planId: s.planId,
    planDate: s.planDate,
    source: s.source,
  };
}

function pendingWriteCounts(s = state.session) {
  const sets = s?.pendingSets?.length || 0;
  const cardio = s?.pendingCardio?.length || 0;
  const supersets = s?.pendingSupersets?.length || 0;
  return { sets, cardio, supersets, total: sets + cardio + supersets };
}

async function ensureDbSession(reason = 'retry') {
  const s = state.session;
  if (!s) return false;
  if (s.dbSessionId) return true;
  if (_sessionCreatePromise) return _sessionCreatePromise;

  const startedAt = s.startedAt;
  s.dbSessionCreating = true;
  s.dbSessionCreateError = null;
  track('session.db_create_attempt', {
    reason,
    clientStart: s.clientStart || null,
    pending: pendingWriteCounts(s),
  });

  _sessionCreatePromise = api.createSession(sessionCreatePayload(s))
    .then((res) => {
      if (!res?.sessionId) throw new Error('Session create returned no id');
      if (!state.session || state.session.startedAt !== startedAt) return false;
      state.session.dbSessionId = res.sessionId;
      state.session.dbSessionCreating = false;
      state.session.dbSessionCreateError = null;
      setTelemetryContext({ dbSessionId: res.sessionId });
      track('session.db_created', { sessionId: res.sessionId, reason });
      return true;
    })
    .catch((err) => {
      if (state.session && state.session.startedAt === startedAt) {
        state.session.dbSessionCreating = false;
        state.session.dbSessionCreateError = err?.message || String(err);
      }
      trackError('session.create', err);
      console.warn('createSession', err);
      return false;
    })
    .finally(() => {
      _sessionCreatePromise = null;
    });

  return _sessionCreatePromise;
}

// Start a session locally + persist to DB. Safe if API is down — the
// Mini App still works, just with a red sync pin.
async function startSession(plan) {
  initSession(plan);
  renderPreservingScroll();
  const created = await ensureDbSession('start');
  if (created && state.session?.dbSessionId) {
    // Flush any queued writes the user generated before DB was ready.
    await flushPendingSets();
    await flushPendingCardio();
    await flushPendingSupersets();
  }
  renderPreservingScroll();
}

function hasReplaceableActiveSession() {
  return !!state.session && state.view !== 'summary';
}

async function confirmStartNewSession(label = 'start a new workout') {
  try { assertWritable(); assertDurable(); } catch(e) { showToast(e.message); return false; }
  if (hasUnsyncedWorkout()) { showToast('Reconnect to sync this workout before starting another'); return false; }
  if (!hasReplaceableActiveSession()) return true;
  const name = state.session.dayName || 'current workout';
  const msg = `You already have "${name}" open. Start a new workout anyway? Cancel keeps the current session open.`;
  const ok = await new Promise(resolve => {
    if (tg?.showConfirm) tg.showConfirm(msg, (confirmed) => resolve(!!confirmed));
    else resolve(window.confirm(msg));
  });
  if (!ok) {
    state.view = state.activeExerciseId ? 'active' : 'overview';
    showToast(`Kept current session · ${label} canceled`);
    renderPreservingScroll();
    return false;
  }
  return true;
}

// Find the "next" exercise in a superset/circuit group relative to ex.
//  - 2-member superset: returns the other one.
//  - 3+ member circuit: returns the next member in rotation (wraps around).
// Returns null if ex isn't grouped.
function findSupersetPartner(ex) {
  if (!ex?.supersetGroup || !state.session?.supersetGroups) return null;
  const members = groupOrder(ex.supersetGroup);
  if (members.length < 2) return null;
  const myIdx = members.indexOf(ex.id);
  if (myIdx === -1) return null;
  const nextIdx = (myIdx + 1) % members.length;
  const nextId = members[nextIdx];
  if (nextId === ex.id) return null;
  return state.session.exercises.find(e => e.id === nextId) || null;
}

// Format BW/assistance notes the bot can parse via parseAssistanceNote()
// in index.js (regex /\bassistance_lb=(\d+(?:\.\d+)?)\b/). The bot's
// nextSetSuggestion has a hasAssistance branch that fires only when this
// marker is present.
//
//  pure_bw → null (clean bodyweight; no assistance, no added weight)
//  assisted → `assistance_lb=X` (X = magnitude of assistance, weight column = null)
//  added (with positive weight) → null (weight column carries the load)
//  added (weight 0) → null (degenerate; renders as bodyweight)
function formatSetNotes(ex, loggedSet) {
  const notes = [];
  const userNote = cleanUserNote(loggedSet.note);
  if (userNote) notes.push(userNote);
  if (ex.isometricHold || ex.holdSeconds) {
    notes.push('isometric_holds=true');
    if (ex.holdSeconds) notes.push(`hold_seconds=${Number(ex.holdSeconds)}`);
  }
  const mode = loggedSet.assistanceMode;
  if (ex.bodyweight_capable && mode === 'assisted') {
    const lbs = Number(loggedSet.assistanceLbs ?? loggedSet.weight ?? 0);
    if (Number.isFinite(lbs) && lbs > 0) notes.push(`assistance_lb=${lbs}`);
  }
  return notes.length ? notes.join('; ') : null;
}

async function persistSet(ex, loggedSet) {
  if (ex.persistAs === 'cardio') {
    const durationSeconds = Number(loggedSet.durationSeconds || 0);
    const payload = {
      phase: ex.cardioPhase || 'warmup',
      mode: ex.cardioActivityId || 'treadmill',
      minutes: Math.round((durationSeconds / 60) * 10) / 10,
      notes: cleanUserNote(loggedSet.note) || ex.coachNote || ex.name,
    };
    if (!payload.minutes || payload.minutes <= 0) {
      track('cardio.exercise_skip_persist', { exercise: ex.name, reason: 'missing_duration' });
      return;
    }
    state.session.pendingCardio.push({ ...payload, client_write_id: loggedSet.clientSetId || nextClientSetId() });
    saveSessionLocal();
    await retryPendingIfResumed('cardio_exercise_queued');
    return;
  }

  const isTimed = ex.measurement === 'duration';
  // Rotating slot: the slot itself ("Leg Lift Circuit") is a UI concept.
  // The DB row we persist is the actual variant performed this round
  // (Flutter Kicks / Scissor Kicks / Leg Lifts), so family-level rollups
  // still work and individual variants count separately in history.
  const variant = isRotateSlot(ex) && Number.isInteger(loggedSet.variantIndex)
    ? ex.variants[loggedSet.variantIndex]
    : null;
  const exerciseName = variant?.name || ex.name;
  const exerciseKey = variant?.canonical || canonicalKeyForExercise(ex);
  // Weight column convention (matches the bot):
  //  - pure_bw: NULL (the row is bodyweight; no load to record)
  //  - assisted: NULL (assistance lives in the notes via assistance_lb=X;
  //              the weight column stays null so weight-based queries like
  //              max-weight / ESV ignore the row, same as the bot's path)
  //  - added (with positive weight): the weight number
  //  - added (weight=0) or non-bodyweight zero: the literal 0
  const mode = loggedSet.assistanceMode;
  let weightForDb;
  if (ex.bodyweight_capable && (mode === 'pure_bw' || mode === 'assisted')) {
    weightForDb = null;
  } else {
    weightForDb = loggedSet.weight == null ? 0 : Number(loggedSet.weight);
  }
  const payload = {
    client_set_id: loggedSet.clientSetId || null,
    client_logged_at: new Date(loggedSet.loggedAt || Date.now()).toISOString(),
    exercise: exerciseName,
    exercise_key: exerciseKey,
    weight: weightForDb,
    rpe: loggedSet.rpe,
    notes: formatSetNotes(ex, loggedSet),
    measurement_type: isTimed ? 'duration_seconds' : 'reps',
    reps: isTimed ? null : loggedSet.reps,
    duration_seconds: isTimed ? loggedSet.durationSeconds : null,
    superset_group: ex.supersetGroup || null,
  };

  // Persist the outbox before sending: closing the app during a request
  // leaves a retryable entry, including the stable client set identifier.
  state.session.pendingSets.push(payload);
  saveSessionLocal();
  await retryPendingIfResumed('set_queued');

}

function singleFlight(fn) {
  let inflight = null;
  return (...args) => inflight || (inflight = fn(...args).finally(() => { inflight = null; }));
}
const flushPendingSets = singleFlight(flushPendingSetsOnce);
const flushPendingCardio = singleFlight(flushPendingCardioOnce);
const flushPendingSupersets = singleFlight(flushPendingSupersetsOnce);

async function flushPendingSetsOnce() {
  if (!state.session) return;
  if (!state.session.dbSessionId) {
    const created = await ensureDbSession('flush_sets');
    if (!created) { renderPreservingScroll(); return; }
  }
  if (!state.session.pendingSets?.length) return;
  const queued = state.session.pendingSets.slice();
  track('set.flush_start', { count: queued.length });
  for (const payload of queued) {
    try {
      const res = await api.logSet({ ...payload, sessionId: state.session.dbSessionId });
      const match = findLoggedSetByClientId(payload.client_set_id);
      if (match?.set && res?.setId != null && !match.set.dbSetId) match.set.dbSetId = Number(res.setId);
      state.session.pendingSets.splice(state.session.pendingSets.indexOf(payload), 1);
      saveSessionLocal();
    } catch (err) {

      trackError('set.flush', err);
      console.warn('flushPendingSets', err);
      renderPreservingScroll();
      return;
    }
  }
  track('set.flush_done');
}

async function flushPendingCardioOnce() {
  if (!state.session) return;
  if (!state.session.dbSessionId) {
    const created = await ensureDbSession('flush_cardio');
    if (!created) { renderPreservingScroll(); return; }
  }
  if (!state.session.pendingCardio?.length) return;
  for (const entry of state.session.pendingCardio) { entry.client_write_id ||= nextClientSetId(); entry.client_logged_at ||= new Date().toISOString(); }
  saveSessionLocal();
  const queued = state.session.pendingCardio.slice();
  for (const entry of queued) {
    // Strip internal fields (e.g. _blockIndex) before POST — keep what
    // the server accepts: phase, mode, minutes, distance_miles, calories, notes.
    const { _blockIndex, ...payload } = entry;
    try {
      const res = await api.logCardio({ ...payload, sessionId: state.session.dbSessionId });
      // If we know which UI block this belongs to, write dbId back so
      // subsequent edits PATCH the right row instead of creating a dupe.
      if (res?.blockId != null && Number.isInteger(_blockIndex)) {
        const b = state.session.cardioBlocks?.[_blockIndex];
        if (b && !b.dbId) b.dbId = Number(res.blockId);
      }
      state.session.pendingCardio.splice(state.session.pendingCardio.indexOf(entry), 1);
      saveSessionLocal();
    } catch (err) {

      trackError('cardio.flush', err);
      renderPreservingScroll();
      return;
    }
  }
}

let supersetsFlushing = false;
async function flushPendingSupersetsOnce() {
  if (supersetsFlushing) return;
  supersetsFlushing = true;
  try { await drainPendingSupersets(); } finally { supersetsFlushing = false; }
}
async function drainPendingSupersets() {
  if (!state.session) return;
  if (!state.session.dbSessionId) {
    const created = await ensureDbSession('flush_supersets');
    if (!created) { renderPreservingScroll(); return; }
  }
  if (!state.session.pendingSupersets?.length) return;
  const queued = state.session.pendingSupersets.slice();
  for (const payload of queued) {
    try {
      await api.createSuperset({ ...payload, sessionId: state.session.dbSessionId });
      state.session.pendingSupersets.splice(state.session.pendingSupersets.indexOf(payload), 1);
      saveSessionLocal();
    } catch (err) {

      trackError('superset.flush', err);
      renderPreservingScroll();
      return;
    }
  }
}

function resetToLaunch() {
  try { assertWritable(); assertDurable(); } catch(e) { showToast(e.message); return false; }
  clearSessionLocal();
  clearRestTicker();
  clearWorkTimerTicker();
  state.session = null;
  state.activeExerciseId = null;
  state.draft = null;
  state.rest = null;
  state.workTimer = null;
  state.keypad = null;
  state.switcher = false;
  state.cardioSheet = null;
  state.mediaSheet = null;
  state.weighIn = null;
  state.weighInThisSession = false;
  state.browsePlanId = null;
  state._switcherSearch = '';
  clearToast();
  state.view = 'launch';
  setTelemetryContext({ dbSessionId: null, clientStart: null });
  track('session.reset');
}

// Load today's plan + saved plans from the dashboard. Silent fall-back
// to mock data if the API is down so the app still launches.
async function loadBootstrap() {
  try {
    const res = await api.bootstrap();
    // Only adopt plans that actually have exercises — a stub row with no
    // exercises would show an empty "Start today's plan" card.
    const tp = res?.todaysPlan?.exercises?.length ? res.todaysPlan : null;
    const sp = Array.isArray(res?.savedPlans)
      ? res.savedPlans.filter(p => p?.exercises?.length)
      : [];
    const serverExerciseKb = Array.isArray(res?.exerciseKB) ? res.exerciseKB : [];
    state.bootstrap = {
      todaysPlan: tp,
      savedPlans: sp,
      exerciseKB: serverExerciseKb,
      recentWeights: res?.recentWeights || [],
    };
    state.bodyWeights = Array.isArray(res?.recentWeights) ? res.recentWeights : [];
    track('bootstrap.loaded', {
      hasTodaysPlan: !!tp,
      savedCount: sp.length,
      exerciseKbCount: serverExerciseKb.length,
      recentWeightCount: state.bodyWeights.length,
      latestWeight: state.bodyWeights[0]?.weight_lbs ?? null,
      serverTime: res?.serverTime,
    });
    if (state.view === 'launch' || state.view === 'browse') renderPreservingScroll();
  } catch (err) {
    trackError('bootstrap', err);
    console.warn('loadBootstrap', err);
    // Leave state.bootstrap null → mocks used; user sees red pin.
  }
}

// ---------------------------------------------------------
// Views
// ---------------------------------------------------------
function view() {
  let html;
  switch (state.view) {
    case 'launch':   html = renderLaunch(); break;
    case 'browse':   html = renderBrowsePlans(); break;
    case 'mobility': html = renderMobility(); break;
    case 'active':   html = renderActive(); break;
    case 'rest':     html = renderRest(); break;
    case 'paused':   html = renderPaused(); break;
    case 'summary':  html = renderSummary(); break;
    default:         html = renderOverview();
  }
  if (MOBILITY_ENABLED && state.session && state.view !== 'mobility') html = `<div class="workout-mobility-bar"><button data-action="open-mobility">Daily mobility</button></div>` + html;
  if (state.switcher) html += renderSwitcher();
  if (state.cardioSheet) html += renderCardioSheet();
  if (state.mediaSheet) html += renderMediaSheet();
  if (state.weighIn) html += renderWeighInSheet();
  if (state.editSet) html += renderEditSetSheet();
  if (state.linkSheet) html += renderLinkSheet();
  if (state.keypad) html += renderKeypad();
  if (state.toast) html += renderToast();
  if (state.portraitGuardActive) html += renderPortraitGuard();
  return html;
}

function renderPortraitGuard() {
  return `
    <div class="portrait-guard" role="dialog" aria-live="assertive" aria-label="Portrait orientation required">
      <div class="portrait-guard-panel">
        <div class="portrait-guard-icon">↻</div>
        <div class="portrait-guard-title">Rotate to portrait</div>
        <div class="portrait-guard-copy">gymbrobot training controls are built for vertical use.</div>
      </div>
    </div>
  `;
}

function renderToast() {
  const t = state.toast;
  if (!t) return '';
  const action = t.action
    ? `<button class="toast-action" data-action="${escapeHtml(t.action)}"${t.drillId ? ` data-drill-id="${escapeHtml(t.drillId)}"` : ''}>${escapeHtml(t.actionLabel || 'Undo')}</button>`
    : '';
  return `
    <div class="toast${action ? ' has-action' : ''}">
      <span class="toast-message">${escapeHtml(t.message)}</span>
      ${action}
    </div>
  `;
}

function renderSessionSyncBanner() {
  const s = state.session;
  if (!s || state.view === 'launch' || state.view === 'browse' || state.view === 'mobility') return '';
  const pending = pendingWriteCounts(s);
  const needsSession = !s.dbSessionId;
  const creating = !!s.dbSessionCreating || !!_sessionCreatePromise;
  if (!needsSession && pending.total === 0 && !creating) return '';

  const itemLabel = pending.total === 1 ? 'item' : 'items';
  let title;
  let detail;
  if (needsSession && pending.total > 0) {
    title = `${pending.total} ${itemLabel} waiting for session`;
    detail = creating ? 'Creating workout, then syncing sets' : 'Saved on this phone, ready to retry';
  } else if (needsSession) {
    title = 'Workout session not saved yet';
    detail = creating ? 'Creating workout session' : 'Saved locally until the DB responds';
  } else {
    title = `${pending.total} ${itemLabel} not saved yet`;
    detail = creating ? 'Sync in progress' : 'Will retry on reconnect';
  }
  if (s.dbSessionCreateError && !creating) detail = s.dbSessionCreateError;

  return `
    <div class="unsaved-banner" role="status" aria-live="polite">
      <div class="unsaved-dot${creating ? ' syncing' : ''}"></div>
      <div class="unsaved-copy">
        <div class="unsaved-title">${escapeHtml(title)}</div>
        <div class="unsaved-detail">${escapeHtml(detail)}</div>
      </div>
      <button class="unsaved-retry" data-action="retry-sync"${creating ? ' disabled' : ''}>Retry</button>
    </div>
  `;
}

// --- Launch screen ---
function renderLaunch() {
  const tp = currentTodaysPlan();
  const saved = currentSavedPlans();
  const fromDb = !!state.bootstrap;
  return `
    <div class="tg-top">
      <span></span>
      <span class="title">gymbrobot</span>
      <span></span>
    </div>
    <div class="body launch">
      <div class="launch-hero">
        <h2>Ready to train?</h2>
        <div class="sub">Pick a plan, generate one, or just start.${fromDb ? '' : ' <span class="muted">Connect once to save today’s plan.</span>'}</div>
      </div>

      ${tp ? `
        <div class="section-label">
          <span>Today</span>
          <span class="muted" style="text-transform:none;letter-spacing:0;font-size:11px;">${todayLocalLabel()}</span>
        </div>
        <div class="today-card" data-action="start-todays-plan">
          <div class="today-head">
            <div style="min-width:0;">
              <div class="today-name">${escapeHtml(tp.dayName)}</div>
              <div class="today-meta">${tp.exercises.length} exercises · ~${estimateDuration(tp)} min · ${dayTypeLabel(tp.dayType)}</div>
            </div>
            <span class="today-source">${
              tp.source?.startsWith('codex-') ? '🧠 coached'
              : tp.source === 'chat-planning-llm' ? '💬 chat-planned'
              : tp.source === 'generated' ? '✨ generated'
              : '📝 manual'
            }</span>
          </div>
          <div class="today-exercises">
            ${tp.exercises.slice(0, 4).map(e => `<span class="today-ex">${escapeHtml(e.name)}</span>`).join('')}
            ${tp.exercises.length > 4 ? `<span class="today-ex more">+${tp.exercises.length - 4}</span>` : ''}
          </div>
          <div class="today-cta">▶ Start today's plan</div>
        </div>
      ` : ''}

      ${MOBILITY_ENABLED ? `
        <div class="section-label"><span>Daily care</span></div>
        ${renderMobilityLaunchCard()}
      ` : ''}

      <div class="section-label"><span>Generate a workout</span></div>
      <div class="quick-grid">
        ${DAY_TYPES.map(dt => `
          <button class="quick-chip" data-action="generate-day" data-day-type="${dt.id}">
            <span class="emoji">${dt.emoji}</span>
            <span class="label">${dt.label}</span>
          </button>
        `).join('')}
      </div>
      <div class="muted" style="font-size:11px; margin-top:8px; text-align:center;">Deterministic · same day → same workout</div>

      <div class="section-label"><span>Body weight</span></div>
      ${renderBodyWeightCard('launch')}

      <div class="section-label"><span>More</span></div>
      <div class="launch-actions">
        <button class="launch-btn" data-action="open-browse">
          <span class="emoji">📚</span>
          <div class="launch-btn-text">
            <div class="name">Browse saved plans</div>
            <div class="meta">${saved.length} saved</div>
          </div>
          <span class="chev">›</span>
        </button>
        <button class="launch-btn" data-action="open-cardio-only">
          <span class="emoji">🏃</span>
          <div class="launch-btn-text">
            <div class="name">Log cardio only</div>
            <div class="meta">Skip the lifting, just cardio</div>
          </div>
          <span class="chev">›</span>
        </button>
        <button class="launch-btn" data-action="empty-session">
          <span class="emoji">🚀</span>
          <div class="launch-btn-text">
            <div class="name">Empty session</div>
            <div class="meta">Add exercises as you go</div>
          </div>
          <span class="chev">›</span>
        </button>
      </div>
    </div>
  `;
}

// Small reusable "last weigh-in" card — context = 'launch' | 'summary'.
// Shows last value, delta, age; taps open the weigh-in sheet.
function renderBodyWeightCard(context) {
  const latest = latestBodyWeight();
  const delta = bodyWeightDelta();
  const age = daysSince(latest?.ts);
  const deltaStr = delta == null
    ? ''
    : `<span class="bw-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}">${delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} ${fmtNum(Math.abs(delta))} lb</span>`;
  const lead = latest
    ? `<div class="bw-last"><span class="v">${fmtNum(latest.value)}</span><span class="u">lb</span></div>
       <div class="bw-meta">${age || 'recent'}${deltaStr ? ' · ' + deltaStr : ''}</div>`
    : `<div class="bw-last muted"><span class="v">–</span><span class="u">lb</span></div>
       <div class="bw-meta muted">No weigh-ins yet</div>`;
  return `
    <button class="bw-card" data-action="open-weighin" data-context="${context}">
      <span class="emoji">⚖️</span>
      <div class="bw-card-body">
        ${lead}
      </div>
      <div class="bw-card-cta">Log<br/>weight ›</div>
    </button>
  `;
}

// ---------------------------------------------------------
// Daily Mobility — a habit checklist (drills + scores), not a session.
// Reachable from the launch screen; completable at any time.
// ---------------------------------------------------------
function renderMobilityLaunchCard() {
  const m = ensureMobilityState();
  const routine = currentMobilityRoutine();
  const total = routine.drills.length;
  const done = drillsDoneCount(m);
  const completed = !!m.completedAt;
  const streak = m.streak || 0;
  const badge = mobilityBadge(streak);
  const badgeMarkup = badge.current
    ? `<span class="mob-card-badge${badge.justEarned ? ' just' : ''}">
         <span class="mob-card-badge-icon">${badge.current.emoji}</span>
         <span>${escapeHtml(badge.current.label)}</span>
       </span>`
    : '';
  const sync = state.mobilitySyncing ? ' · syncing' : '';
  const status = completed
    ? `Done today${streak > 1 ? ` · ${streak}-day streak 🔥` : ''}${sync}`
    : done > 0
      ? `${done}/${total} drills done · resume${sync}`
      : `${total} drills · ~${routine.estMinutes} min${sync}`;
  return `
    <button class="mobility-card${completed ? ' done' : ''}" data-action="open-mobility">
      <span class="mob-card-icon">${completed ? '✓' : '🧘'}</span>
      <div class="mob-card-body">
        <div class="mob-card-head">
          <div class="mob-card-title">${escapeHtml(routine.title)}</div>
          ${badgeMarkup}
        </div>
        <div class="mob-card-meta">${escapeHtml(status)}</div>
      </div>
      <span class="chev">›</span>
    </button>
  `;
}

function renderMobility() {
  const m = ensureMobilityState();
  return m.completedAt ? renderMobilityComplete() : renderMobilityChecklist();
}

// 0–10 tap scale. Tapping the selected value again clears it.
function renderMobilityScore({ label, action, value, lowLabel, highLabel }) {
  let dots = '';
  for (let n = 0; n <= MOBILITY_MAX_SCORE; n++) {
    const sel = value === n;
    dots += `<button class="mob-dot band-${scoreBand(n)}${sel ? ' sel' : ''}" data-action="${action}" data-score="${n}">${n}</button>`;
  }
  return `
    <div class="mob-score">
      <div class="mob-score-head">
        <span class="lbl">${escapeHtml(label)}</span>
        <span class="val band-${scoreBand(value)}">${value == null ? '—' : value}</span>
      </div>
      <div class="mob-scale">${dots}</div>
      <div class="mob-scale-ends"><span>${escapeHtml(lowLabel)}</span><span>${escapeHtml(highLabel)}</span></div>
    </div>
  `;
}

function renderMobilityDrillCard(drill) {
  const done = !!state.mobility?.done?.[drill.id];
  const hasMedia = !!drill.media;
  const mediaIcon = drill.media?.url
    ? drill.media.mediaType === 'image' ? 'IMG' : drill.media.mediaType === 'gif' ? 'GIF' : drill.media.mediaType === 'image_sequence' ? 'SEQ' : 'VIS'
    : '◷';
  const reason = drill.recommendationReason
    ? `<div class="mob-drill-reason">${escapeHtml(drill.recommendationReason)}</div>`
    : '';
  return `
    <div class="mob-drill${done ? ' done' : ''}">
      <button class="mob-check" data-action="toggle-drill" data-drill-id="${escapeHtml(drill.id)}" aria-pressed="${done}">
        <span class="mob-check-mark">${done ? '✓' : ''}</span>
      </button>
      <div class="mob-drill-main">
        <div class="mob-drill-head">
          <span class="mob-drill-name">${escapeHtml(drill.name)}</span>
          <span class="mob-drill-target">${escapeHtml(drill.target)}</span>
        </div>
        <div class="mob-drill-cue">${escapeHtml(drill.cue)}</div>
        ${reason}
        ${hasMedia ? `
          <button class="mob-drill-media" data-action="open-media" data-ex-id="${escapeHtml(drill.id)}" data-media-source="mobility">
            <span class="mmi">${mediaIcon}</span><span>Form &amp; cues</span><span class="mmc">›</span>
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

function renderMobilityChecklist() {
  const m = state.mobility;
  const routine = currentMobilityRoutine();
  const total = routine.drills.length;
  const availableCore = routine.drills.filter((d) => d.isCore !== false).length || MOBILITY_CORE_TARGET;
  const coreTotal = Math.min(MOBILITY_CORE_TARGET, availableCore);
  const done = drillsDoneCount(m);
  const coreDone = coreDrillsDoneCount(m, routine.drills);
  const streak = m.streak || 0;
  const coreMinutes = mobilityCoreMinutes(m, routine.drills);
  const projectedPts = mobilityPoints({
    coreDrillsDone: coreDone,
    coreMinutes,
    totalCoreDrills: coreTotal,
    kneePain: m.kneePain,
    hipStiffness: m.hipStiffness,
  });
  const canComplete = projectedPts > 0;
  const kneePainAbovePtCeiling = Number.isFinite(m.kneePain)
    && m.kneePain > MOBILITY_KNEE_PAIN_CEILING;
  const dueHint = m.kneePain == null && m.hipStiffness == null
    ? 'Log knee pain or hip/groin stiffness to complete'
    : coreDone < MOBILITY_COMPLETE_DRILL_MIN
      ? `${MOBILITY_COMPLETE_DRILL_MIN} core drills completes the day`
      : projectedPts >= 15
        ? 'Full day ready'
        : 'Completion ready';
  return `
    <div class="tg-top">
      <button class="btn-link" data-action="close-mobility">${state.session ? '‹ Workout' : '‹ Home'}</button>
      <span class="title">${escapeHtml(routine.title)}</span>
      <span></span>
    </div>
    <div class="body">
      <div class="mob-hero">
        <h2>${escapeHtml(routine.subtitle)}</h2>
        <div class="mob-hero-sub">Tick drills as you go — finish anytime.${streak > 0 ? ` <span class="mob-streak">🔥 ${streak}-day streak</span>` : ''}</div>
      </div>

      <div class="section-label"><span>How you feel</span><span class="muted" style="text-transform:none;letter-spacing:0;font-size:11px;">optional</span></div>
      ${renderMobilityScore({ label: 'Knee pain', action: 'set-knee-pain', value: m.kneePain, lowLabel: 'No pain', highLabel: 'Severe' })}
      ${kneePainAbovePtCeiling ? `
        <div class="mob-pt-pain-alert" role="status">
          <strong>PT pain ceiling exceeded</strong>
          <span>${escapeHtml(`Knee pain is ${m.kneePain}/10. Use gentle mobility today and reserve loaded knee flexion, jumping, and sprint work for a ${MOBILITY_KNEE_PAIN_CEILING}/10 or lower day.`)}</span>
        </div>
      ` : ''}
      ${renderMobilityScore({ label: 'Hip / groin stiffness', action: 'set-hip-stiffness', value: m.hipStiffness, lowLabel: 'Loose', highLabel: 'Locked up' })}

      <div class="section-label"><span>Drills</span><span class="muted" style="text-transform:none;letter-spacing:0;font-size:11px;">${done}/${total}</span></div>
      <div class="mob-drill-list">
        ${routine.drills.map(renderMobilityDrillCard).join('')}
      </div>

      <button class="btn success mob-complete-btn" data-action="complete-mobility"${canComplete ? '' : ' disabled'}>✓ Mark mobility done</button>
      <div class="mob-foot-note muted">${escapeHtml(dueHint)}${projectedPts ? ` · +${projectedPts} pts` : ''}</div>
    </div>
  `;
}

function renderMobilityRewardsPanel(m) {
  const rewards = Array.isArray(m.rewards) ? m.rewards : [];
  const redemptions = Array.isArray(m.redemptions) ? m.redemptions : [];
  const balance = Number(m.pointsBalance || 0);
  if (!rewards.length) return '';
  const rewardRows = rewards.map((reward) => {
    const cost = Number(reward.cost_points || 0);
    const affordable = balance >= cost;
    const isRedeeming = String(state.mobilityRewardRedeemingId || '') === String(reward.id);
    const sub = affordable
      ? `${cost} pts available`
      : `${cost} pts · ${Math.max(0, cost - balance)} to go`;
    return `
      <div class="mob-reward-row${affordable ? ' affordable' : ''}">
        <div class="mob-reward-main">
          <div class="mob-reward-title">${escapeHtml(reward.title)}</div>
          <div class="mob-reward-sub">${escapeHtml(sub)}</div>
        </div>
        <button class="btn ${affordable ? 'success' : 'ghost'} sm mob-reward-btn"
                data-action="redeem-mobility-reward"
                data-reward-id="${escapeHtml(String(reward.id))}"
                ${affordable && !isRedeeming ? '' : 'disabled'}>
          ${isRedeeming ? 'Saving' : affordable ? 'Redeem' : 'Locked'}
        </button>
      </div>
    `;
  }).join('');
  const recent = redemptions.slice(0, 2).map((r) => {
    const when = r.redeemed_at ? String(r.redeemed_at).slice(0, 10) : 'recent';
    return `<div class="mob-reward-history">✓ ${escapeHtml(r.reward_title || 'Reward')} · ${escapeHtml(when)}</div>`;
  }).join('');
  return `
    <div class="mob-rewards-panel">
      <div class="mob-rewards-head">
        <div>
          <div class="mob-rewards-title">Rewards</div>
          <div class="mob-rewards-sub">${balance} pts banked</div>
        </div>
        <span class="mob-rewards-gift">🎁</span>
      </div>
      <div class="mob-reward-list">${rewardRows}</div>
      ${recent ? `<div class="mob-reward-history-list">${recent}</div>` : ''}
    </div>
  `;
}

function renderMobilityComplete() {
  const m = state.mobility;
  const routine = currentMobilityRoutine();
  const total = routine.drills.length;
  const done = drillsDoneCount(m);
  const streak = m.streak || 0;
  const badge = mobilityBadge(streak);
  const pts = m.pointsEarned || 0;

  const badgeMarkup = badge.current
    ? `<div class="mob-badge${badge.justEarned ? ' just' : ''}">
         <span class="mob-badge-emoji">${badge.current.emoji}</span>
         <div class="mob-badge-text">
           <div class="mob-badge-label">${escapeHtml(badge.current.label)}</div>
           <div class="mob-badge-sub">${badge.justEarned ? 'New badge unlocked!' : 'Badge held'}</div>
         </div>
       </div>`
    : '';
  const nextMarkup = badge.next
    ? `<div class="mob-next muted">${badge.toNext} day${badge.toNext === 1 ? '' : 's'} to your ${escapeHtml(badge.next.label)} badge ${badge.next.emoji}</div>`
    : '';

  const scoreChip = (label, value) => `
    <div class="mob-recap-chip band-${scoreBand(value)}">
      <span class="rc-label">${escapeHtml(label)}</span>
      <span class="rc-val">${value == null ? 'not logged' : value + '/' + MOBILITY_MAX_SCORE}</span>
    </div>`;

  return `
    <div class="tg-top">
      <span></span>
      <span class="title">${escapeHtml(routine.title)}</span>
      <span></span>
    </div>
    <div class="body mob-complete-body">
      <div class="mob-celebrate">
        <div class="mob-celebrate-mark">✓</div>
        <h2>Mobility logged</h2>
        <div class="mob-celebrate-sub">${done}/${total} drills · nice work</div>
      </div>

      <div class="mob-points-card">
        <div class="mob-points-pts">+${pts}<span>pts</span></div>
        <div class="mob-points-streak">🔥 ${streak}-day streak${m.pointsBalance ? ` · ${m.pointsBalance} banked` : ''}</div>
      </div>

      ${badgeMarkup}
      ${nextMarkup}
      ${renderMobilityRewardsPanel(m)}

      <div class="section-label"><span>Today's check-in</span></div>
      <div class="mob-recap">
        ${scoreChip('Knee pain', m.kneePain)}
        ${scoreChip('Hip / groin', m.hipStiffness)}
      </div>

      <button class="btn primary" data-action="mobility-home">${state.session ? 'Return to workout' : 'Back to home'}</button>
      <button class="btn ghost mob-adjust-btn" data-action="adjust-mobility">Adjust entry</button>
    </div>
  `;
}

// --- Browse saved plans ---
function planExerciseTarget(ex) {
  const sets = ex.targetSets || ex.defaults?.sets || 0;
  if (ex.measurement === 'duration') {
    const seconds = ex.targetDuration || ex.defaults?.durationSeconds || 30;
    const load = Number(ex.targetWeight || ex.defaults?.weight || 0);
    return `${sets} × ${fmtTime(seconds)}${load > 0 ? ` · ${fmtNum(load)} ${ex.unit || 'lb'}` : ''}`;
  }
  const low = ex.targetRepsLow ?? ex.defaults?.repsLow;
  const high = ex.targetRepsHigh ?? ex.defaults?.repsHigh;
  const reps = low != null && high != null
    ? (low === high ? `${low}` : `${low}–${high}`)
    : 'reps';
  const load = Number(ex.targetWeight ?? ex.defaults?.weight ?? 0);
  return `${sets} × ${reps}${load > 0 ? ` · ${fmtNum(load)} ${ex.unit || 'lb'}` : ''}`;
}

function renderSavedPlanDetail(plan) {
  return `
    <div class="tg-top">
      <button class="btn-link" data-action="back-to-browse-list">‹ Plans</button>
      <span class="title">Plan preview</span>
      <span></span>
    </div>
    <div class="body saved-detail-body">
      <div class="saved-detail-hero">
        <div class="saved-detail-eyebrow">${fmtDate(plan.plannedAt)} · ${escapeHtml(dayTypeLabel(plan.dayType))}</div>
        <h2>${escapeHtml(plan.dayName)}</h2>
        <div class="saved-detail-meta">${plan.exercises.length} exercises · ~${estimateDuration(plan)} min</div>
      </div>

      <button class="btn primary saved-start-btn" data-action="start-saved" data-plan-id="${escapeHtml(plan.id)}">Start workout</button>

      ${renderSessionCoaching(plan)}

      <div class="saved-detail-list">
        ${plan.exercises.map((ex, idx) => `
          <div class="plan-preview-row">
            <div class="marker">${idx + 1}</div>
            <div class="plan-preview-main">
              <div class="name">${escapeHtml(ex.name)}</div>
              <div class="meta">${escapeHtml(planExerciseTarget(ex))}${ex.group ? ` · ${escapeHtml(ex.group)}` : ''}</div>
              ${ex.coachNote ? `<div class="coach">${escapeHtml(ex.coachNote)}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderBrowsePlans() {
  const saved = currentSavedPlans();
  const selected = state.browsePlanId
    ? saved.find(p => String(p.id) === String(state.browsePlanId))
    : null;
  if (selected) return renderSavedPlanDetail(selected);

  return `
    <div class="tg-top">
      <button class="btn-link" data-action="back-to-launch">‹ Back</button>
      <span class="title">Saved plans</span>
      <span></span>
    </div>
    <div class="body">
      <div class="saved-list">
        ${saved.length === 0 ? `
          <div class="muted" style="text-align:center;padding:40px 20px;">No saved plans found.</div>
        ` : saved.map(p => `
          <div class="saved-card" data-action="view-saved" data-plan-id="${escapeHtml(p.id)}">
            <div class="saved-head">
              <div class="saved-name">${escapeHtml(p.dayName)}</div>
              <span class="pill">${escapeHtml(dayTypeLabel(p.dayType))}</span>
            </div>
            <div class="saved-meta">${p.exercises.length} exercises · ~${estimateDuration(p)} min · ${fmtDate(p.plannedAt)}</div>
            <div class="saved-exs">
              ${p.exercises.slice(0, 5).map(e => escapeHtml(e.name)).join(' · ')}${p.exercises.length > 5 ? ` · +${p.exercises.length - 5}` : ''}
            </div>
            <div class="saved-card-cta">Review plan</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// --- Overview ---
function renderOverview() {
  const s = state.session;
  if (!s) { state.view = 'launch'; return renderLaunch(); }
  const done = exercisesDone();
  const total = s.exercises.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const isEmpty = total === 0;

  return `
    <div class="tg-top">
      <button class="btn-link" data-action="end-session">End</button>
      <span class="title">${escapeHtml(s.dayName)}</span>
      <button class="icon-btn" data-action="pause">⏸</button>
    </div>
    <div class="body">
      ${renderSessionSyncBanner()}
      <div class="session-head">
        <div>
          <h2>${escapeHtml(s.dayName)}</h2>
          <div class="timer"><span class="live-dot"></span>Live · ${fmtTime(elapsedSec())} elapsed</div>
        </div>
        <span class="pill">${done} / ${total}</span>
      </div>
      <div class="progress-bar"><div style="width:${pct}%"></div></div>
      ${renderSessionCoaching(s)}
      ${isEmpty ? `
        <div class="empty-state">
          <div class="empty-icon">🚀</div>
          <div class="empty-title">Empty session started</div>
          <div class="empty-sub">Search the library, add cardio, or create something new.</div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:20px;">
            <button class="btn primary" style="width:100%;" data-action="open-switcher">+ Add exercise</button>
            <button class="btn ghost" style="width:100%;" data-action="open-cardio-inline">+ Add cardio block</button>
          </div>
        </div>
      ` : `
        <div class="ex-list">
          ${renderExerciseListWithBlocks(s.exercises)}
        </div>
        <div class="add-adhoc-row" data-action="open-switcher">
          <span style="font-size:18px">＋</span>
          <span>Add ad-hoc exercise</span>
        </div>
      `}

      ${s.cardioBlocks && s.cardioBlocks.length > 0 ? `
        <div class="section-label" style="margin-top:20px;"><span>Cardio</span></div>
        <div class="cardio-list">
          ${s.cardioBlocks.map((c, idx) => `
            <div class="cardio-row editable" data-action="open-cardio-edit" data-idx="${idx}">
              <div class="phase">${escapeHtml(CARDIO_PHASES.find(p => p.id === c.phase)?.label || c.phase)}</div>
              <div class="info">
                <div class="name">${escapeHtml(cardioActivityLabel(c.activity))}${c.dbId ? '' : ' <span class="pill" style="font-size:9px;padding:1px 5px;margin-left:4px;">pending</span>'}</div>
                <div class="meta">${Math.round((c.durationSeconds || 0) / 60)} min${c.notes ? ' · ' + escapeHtml(c.notes) : ''}</div>
              </div>
              <div class="chev">›</div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="add-adhoc-row" data-action="open-cardio-inline" style="margin-top:12px;">
        <span style="font-size:18px">🏃</span>
        <span>Add cardio block</span>
      </div>

      <div class="add-adhoc-row" data-action="open-weighin" data-context="overview" style="margin-top:8px;">
        <span style="font-size:18px">⚖️</span>
        <span>${state.weighInThisSession ? 'Update body weight' : 'Log body weight'}</span>
      </div>
    </div>
  `;
}

function cardioActivityLabel(id) {
  const match = CARDIO_ACTIVITIES.find(a => a.id === id);
  return match ? `${match.emoji} ${match.label}` : (id || 'Cardio');
}

function renderSessionCoaching(s) {
  const support = Array.isArray(s.supportCoaching) ? s.supportCoaching : [];
  const warmup = Array.isArray(s.warmup) ? s.warmup.filter(Boolean) : [];
  if (!support.length && !warmup.length) return '';
  return `
    <div class="session-coaching">
      ${warmup.length ? `
        <div class="section-label" style="margin-top:4px;"><span>Warm-up</span></div>
        <div class="coach-plan-card">
          ${warmup.map(item => `<div class="coach-plan-line">${escapeHtml(item)}</div>`).join('')}
        </div>
      ` : ''}
      ${support.length ? `
        <div class="section-label" style="margin-top:14px;"><span>PT prep</span></div>
        <div class="support-coaching-list">
          ${support.map(renderSupportCoachingCard).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderSupportCoachingCard(item) {
  const cues = Array.isArray(item.cues) ? item.cues.filter(Boolean).slice(0, 2) : [];
  const status = item.done
    ? '<span class="support-status done">logged</span>'
    : item.addedExerciseId
      ? '<span class="support-status">added</span>'
      : '';
  const meta = item.kind === 'cardio'
    ? `${CARDIO_PHASES.find(p => p.id === item.phase)?.label || 'Warm-up'} · ${cardioActivityLabel(item.activityId)}${item.durationMin ? ` · ${item.durationMin} min` : ''}`
    : item.kind === 'exercise'
      ? `${item.targetSets || 1} × ${fmtTime(item.targetDurationSeconds || 30)}`
      : 'Coaching';
  const action = item.kind === 'cardio'
    ? `<button class="support-action" data-action="log-support-cardio" data-support-id="${escapeHtml(item.id)}">Log warm-up</button>`
    : item.kind === 'exercise'
      ? `<button class="support-action" data-action="add-support-exercise" data-support-id="${escapeHtml(item.id)}">${item.addedExerciseId ? 'Open exercise' : 'Add exercise'}</button>`
      : '';
  return `
    <div class="support-card ${item.done || item.addedExerciseId ? 'complete' : ''}">
      <div class="support-top">
        <div>
          <div class="support-eyebrow">From ${escapeHtml(item.sourceExercise || 'plan')}</div>
          <div class="support-name">${escapeHtml(item.name)}</div>
        </div>
        ${status}
      </div>
      <div class="support-meta">${escapeHtml(meta)}</div>
      ${item.note ? `<div class="support-note">${escapeHtml(item.note)}</div>` : ''}
      ${cues.length ? `<div class="support-cues">${cues.map(cue => `<span>${escapeHtml(cue)}</span>`).join('')}</div>` : ''}
      ${action ? `<div class="support-foot">${action}</div>` : ''}
    </div>
  `;
}

// Human-readable label for a plan block, or null if we don't have one.
// Unknown blocks (plan JSON keys we haven't mapped) render without a header
// rather than showing raw strings like "foo" to the user.
function blockLabel(block) {
  switch (block) {
    case 'prep':      return 'Prep';
    case 'strength':  return 'Strength';
    case 'accessory': return 'Accessory';
    case 'core':      return 'Core';
    default:          return null;
  }
}

// Render the exercises list with a section header between different plan
// blocks (e.g. Strength → Core). If every exercise belongs to the same
// block, no headers render — the typical strength-only session keeps its
// current clean flat look. Ad-hoc exercises have no block, so they fall
// through to the last-seen block header naturally.
function renderExerciseListWithBlocks(exercises) {
  const blocks = new Set(exercises.map(e => e.block).filter(Boolean));
  const showHeaders = blocks.size > 1;
  const parts = [];
  let lastBlock = null;
  exercises.forEach((ex, i) => {
    const b = ex.block || lastBlock;
    if (showHeaders && b && b !== lastBlock) {
      const label = blockLabel(b);
      if (label) {
        parts.push(`<div class="section-label" style="margin:${i === 0 ? '2px' : '14px'} 0 6px 0;"><span>${label}</span></div>`);
      }
      lastBlock = b;
    }
    parts.push(renderExerciseRow(ex, i));
  });
  return parts.join('');
}

function renderExerciseRow(ex, idx) {
  const done = ex.sets.length >= ex.targetSets;
  const inProgress = ex.sets.length > 0 && !done && !ex.skipped;
  const cls = ['ex', done && 'done', inProgress && 'now', ex.adhoc && 'adhoc'].filter(Boolean).join(' ');
  const mark = done ? '✓' : ex.skipped ? '–' : String(idx + 1);
  const isTimed = ex.measurement === 'duration';
  const targetStr = isTimed
    ? `${ex.targetSets} × ${fmtTime(ex.targetDuration || 30)}${ex.targetWeight ? ` · ${fmtNum(ex.targetWeight)} ${ex.unit}` : ''}`
    : `${ex.targetSets} × ${ex.targetRepsLow}-${ex.targetRepsHigh}${ex.targetWeight ? ` · ${fmtNum(ex.targetWeight)} ${ex.unit}` : ''}`;
  const lastSetStr = inProgress
    ? ex.sets.map(s => isTimed ? fmtTime(s.durationSeconds || 0) : `${fmtNum(s.weight)}×${s.reps}`).join(' · ')
    : '';
  const meta = done
    ? `${ex.sets.length} sets · avg RPE ${avgRpe(ex.sets)}`
    : inProgress
      ? `Set ${ex.sets.length + 1}/${ex.targetSets} up next · ${lastSetStr}`
      : ex.skipped
        ? 'Skipped'
        : targetStr;
  // Superset badge: "A1", "A2" etc. inferred from group + position.
  const ssGroup = ex.supersetGroup;
  const ssMembers = ssGroup ? groupOrder(ssGroup) : [];
  const ssPos = ssGroup ? ssMembers.indexOf(ex.id) + 1 : 0;
  const ssBadge = ssGroup && ssPos > 0 ? `<span class="ss-badge">${ssGroup}${ssPos}</span>` : '';

  return `
    <div class="${cls}" data-action="jump-to-exercise" data-ex-id="${ex.id}">
      <div class="mark">${mark}</div>
      <div class="info">
        <div class="name">${ssBadge}${escapeHtml(ex.name)}${ex.adhoc ? ' <span class="pill" style="font-size:10px;padding:2px 6px;margin-left:4px;">ad-hoc</span>' : ''}${isTimed ? ' <span class="pill ts-pill">⏱</span>' : ''}</div>
        <div class="meta">${meta}</div>
      </div>
      <div class="chev">›</div>
    </div>
  `;
}

function mediaProviderLabel(media) {
  if (!media) return 'No media';
  if (media.provider === 'exercisedb') return media.mediaType === 'gif' ? 'ExerciseDB GIF' : 'ExerciseDB';
  if (media.provider === 'wger') return media.mediaType === 'image' ? 'wger image' : 'wger';
  if (media.provider === 'external-reference') {
    if (media.mediaType === 'image_sequence') return 'Reference sequence';
    return media.mediaType === 'image' ? 'Reference image' : 'Reference';
  }
  if (media.provider === 'gymbrobot') return 'GymBroBot guide';
  return 'Capture needed';
}

function mediaMatchLabel(media) {
  if (media?.approvalStatus === 'approved') return 'approved';
  switch (media?.matchQuality) {
    case 'exact': return 'exact';
    case 'near': return 'near match';
    case 'fallback': return 'fallback';
    case 'needs_capture': return 'needs GIF';
    default: return 'unreviewed';
  }
}

function mediaCtaLabel(media) {
  if (!media) return 'No visual';
  if (media.mediaType === 'gif') return media.approvalStatus === 'approved' || media.matchQuality === 'exact' ? 'Form GIF' : 'Review GIF';
  if (media.mediaType === 'image') return 'Form image';
  if (media.mediaType === 'image_sequence') return 'Form sequence';
  return 'Needs GIF';
}

function mediaChoices(media) {
  if (!media) return [];
  const primaryLabel = media.mediaType === 'gif'
    ? 'GIF'
    : media.mediaType === 'image_sequence'
      ? 'Sequence'
      : 'Primary';
  const choices = [{ label: primaryLabel, media }];
  if (Array.isArray(media.alternates)) {
    media.alternates.forEach((m, idx) => choices.push({ label: `Alt ${idx + 1}`, media: m }));
  }
  if (media.fallback) choices.push({ label: 'Fallback', media: media.fallback });
  return choices;
}

function fallbackFormCues(ex) {
  const name = (ex?.name || '').toLowerCase();
  if (/squat|lunge|split|leg press|glute|calf/.test(name)) {
    return [
      'Brace before the rep and keep pressure through the full foot.',
      'Let the knee track cleanly over the toes without collapsing inward.',
      'Use a controlled range that stays pain-free and repeatable.',
    ];
  }
  if (/deadlift|rdl|hinge|good morning|pull-through|swing/.test(name)) {
    return [
      'Hinge from the hips with ribs stacked over pelvis.',
      'Keep the load close and stop before low-back position changes.',
      'Drive through the hips without overextending at lockout.',
    ];
  }
  if (/bench|press|pushdown|dip|fly/.test(name)) {
    return [
      'Set shoulder blades before the first rep.',
      'Keep wrists stacked and elbows on a repeatable path.',
      'Control the lowering phase instead of chasing load.',
    ];
  }
  if (/row|pull|pulldown|pull-up|pull ups/.test(name)) {
    return [
      'Start by setting the shoulder blades, then pull with elbows.',
      'Keep ribs down and avoid swinging momentum.',
      'Pause briefly in the strong position before returning slowly.',
    ];
  }
  if (/plank|crunch|twist|raise|rollout|climber|wood/.test(name)) {
    return [
      'Stack ribs over pelvis and brace before moving.',
      'Move only as far as trunk position stays controlled.',
      'Breathe steadily and stop before low-back compensation.',
    ];
  }
  return [
    'Set position before adding speed or load.',
    'Use a range of motion you can repeat cleanly.',
    'Stop if pain, locking, or sharp discomfort shows up.',
  ];
}

function exerciseFormCues(ex, media) {
  const cues = [];
  if (Array.isArray(ex?.formCues)) {
    ex.formCues.forEach(cue => {
      if (typeof cue === 'string' && cue.trim()) cues.push(cue.trim());
    });
  }
  if (cues.length < 3) fallbackFormCues(ex).forEach(cue => cues.push(cue));
  const unique = [];
  cues.forEach(cue => {
    if (!unique.some(existing => existing.toLowerCase() === cue.toLowerCase())) unique.push(cue);
  });
  if (media?.matchQuality && media.matchQuality !== 'exact' && media.approvalStatus !== 'approved') {
    unique.push('Use the visual as a movement-pattern reference until this match is approved.');
  }
  return unique.slice(0, 4);
}

function renderExerciseMediaCta(ex) {
  const media = ex?.media;
  if (!media) return '';
  const reviewClass = media.matchQuality === 'near' || media.matchQuality === 'fallback' || media.matchQuality === 'needs_capture'
    ? ' needs-review'
    : '';
  return `
    <button class="form-media-cta${reviewClass}" data-action="open-media" data-ex-id="${escapeHtml(ex.id)}">
      <span class="form-media-icon">${escapeHtml(media.mediaType === 'gif' ? 'GIF' : media.mediaType === 'image' ? 'IMG' : media.mediaType === 'image_sequence' ? 'SEQ' : 'TODO')}</span>
      <span class="form-media-main">
        <span class="form-media-title">${escapeHtml(mediaCtaLabel(media))}</span>
        <span class="form-media-meta">${escapeHtml(mediaProviderLabel(media))} · ${escapeHtml(mediaMatchLabel(media))}</span>
      </span>
      <span class="form-media-chev">›</span>
    </button>
  `;
}

function renderMediaCoachingCard(ex, media) {
  const cues = exerciseFormCues(ex, media);
  const reviewNote = media.approvalStatus === 'approved'
    ? '<div class="media-review-note approved">Approved in GymBroBot media review.</div>'
    : media.matchQuality === 'exact'
    ? ''
    : `<div class="media-review-note">${escapeHtml(media.notes || 'This source needs review before being treated as canonical form guidance.')}</div>`;
  const credit = [
    media.sourceName || ex.name,
    media.attribution || '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="media-coach-card">
      <div class="media-coach-title">GymBroBot form focus</div>
      <ul class="media-cue-list">
        ${cues.map(cue => `<li>${escapeHtml(cue)}</li>`).join('')}
      </ul>
      ${reviewNote}
      <div class="media-credit">
        ${escapeHtml(credit)}
        ${media.sourceUrl || media.url ? ` · <a href="${escapeHtml(media.sourceUrl || media.url)}" target="_blank" rel="noreferrer">credit</a>` : ''}
      </div>
    </div>
  `;
}

function renderMediaVisual(media, exName) {
  if (media?.mediaType === 'image_sequence' && Array.isArray(media.images) && media.images.length) {
    return `
      <div class="exercise-media-sequence" role="group" aria-label="${escapeHtml(media.sourceName || exName)} movement sequence">
        ${media.images.map((img, idx) => `
          <a class="exercise-media-frame" href="${escapeHtml(img.sourceUrl || img.url)}" target="_blank" rel="noreferrer">
            <figure>
              <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || `${media.sourceName || exName} frame ${idx + 1}`)}" loading="lazy" referrerpolicy="no-referrer">
              <figcaption>${escapeHtml(img.label || `Frame ${idx + 1}`)}</figcaption>
            </figure>
          </a>
        `).join('')}
      </div>
    `;
  }
  if (!media?.url) {
    return `
      <div class="exercise-media-empty">
        <div class="exercise-media-empty-title">${escapeHtml(media?.placeholderTitle || 'GIF capture needed')}</div>
        <div class="exercise-media-empty-note">${escapeHtml(media?.notes || 'No reviewed visual is attached yet.')}</div>
        ${media?.referenceUrl ? `
          <a class="exercise-media-reference" href="${escapeHtml(media.referenceUrl)}" target="_blank" rel="noreferrer">
            ${escapeHtml(media.referenceLabel || `Open ${exName} movement reference`)}
          </a>
        ` : ''}
      </div>
    `;
  }
  if (media.mediaType === 'image' || media.mediaType === 'gif') {
    return `
      <a class="exercise-media-link" href="${escapeHtml(media.url)}" target="_blank" rel="noreferrer">
        <img class="exercise-media-preview" src="${escapeHtml(media.url)}" alt="${escapeHtml(media.sourceName || exName)} form visual" loading="lazy" referrerpolicy="no-referrer">
      </a>
    `;
  }
  return `
    <a class="exercise-media-empty" href="${escapeHtml(media.url)}" target="_blank" rel="noreferrer">
      <div class="exercise-media-empty-title">Open visual source</div>
      <div class="exercise-media-empty-note">${escapeHtml(media.sourceName || exName)}</div>
    </a>
  `;
}

// Resolve the entity behind the media sheet from either the live workout
// session or the mobility routine, depending on sheet.source. Both share the
// { id, name, media } shape, so the sheet renders either unchanged.
function mediaEntityFor(sheet) {
  if (!sheet) return null;
  if (sheet.source === 'mobility') {
    return (currentMobilityRoutine().drills || []).find(d => d.id === sheet.exId) || null;
  }
  return state.session?.exercises?.find(x => x.id === sheet.exId) || null;
}

// Mobility coaching card — reuses the workout media-coach styling but with
// habit-checklist copy (no provider/match/approval review jargon).
function renderMobilityCoachingCard(drill, media) {
  const cues = Array.isArray(drill.cues) && drill.cues.length
    ? drill.cues
    : [drill.cue].filter(Boolean);
  const note = media?.notes || 'Use the visual for setup, then follow these cues slowly inside a pain-free range.';
  return `
    <div class="media-coach-card">
      <div class="media-coach-title">How to move</div>
      <ul class="media-cue-list">
        ${cues.map(c => `<li>${escapeHtml(c)}</li>`).join('')}
      </ul>
      <div class="media-review-note">${escapeHtml(note)}</div>
    </div>
  `;
}

function renderMediaSheet() {
  const sheet = state.mediaSheet;
  const isMobility = sheet?.source === 'mobility';
  const ex = mediaEntityFor(sheet);
  const baseMedia = ex?.media;
  const choices = mediaChoices(baseMedia);
  const choiceIdx = Math.min(Math.max(Number(sheet?.choiceIdx || 0), 0), Math.max(choices.length - 1, 0));
  const media = choices[choiceIdx]?.media || baseMedia;
  if (!ex || !media) {
    return `
      <div class="sheet-backdrop" data-action="close-media"></div>
      <div class="sheet media-sheet">
        <div class="grabber"></div>
        <h3>Form visual unavailable</h3>
        <button class="btn primary" data-action="close-media">Done</button>
      </div>
    `;
  }
  const sub = isMobility
    ? escapeHtml([ex.focus, ex.target].filter(Boolean).join(' · ') || 'Movement reference')
    : `${escapeHtml(mediaProviderLabel(media))} · ${escapeHtml(mediaMatchLabel(media))}`;
  return `
    <div class="sheet-backdrop" data-action="close-media"></div>
    <div class="sheet media-sheet">
      <div class="grabber"></div>
      <div class="media-sheet-head">
        <div>
          <h3>${escapeHtml(ex.name)}</h3>
          <div class="media-sheet-sub">${sub}</div>
        </div>
        <button class="media-close" data-action="close-media">Close</button>
      </div>
      ${choices.length > 1 ? `
        <div class="media-choice-row">
          ${choices.map((choice, idx) => `
            <button class="media-choice${idx === choiceIdx ? ' active' : ''}" data-action="select-media-source" data-choice-idx="${idx}">
              ${escapeHtml(choice.label)}
            </button>
          `).join('')}
        </div>
      ` : ''}
      ${renderMediaVisual(media, ex.name)}
      ${isMobility ? renderMobilityCoachingCard(ex, media) : renderMediaCoachingCard(ex, media)}
    </div>
  `;
}

// --- Active set ---
function renderWorkTimerCard(ex) {
  if (!ex || ex.measurement !== 'duration') return '';
  const timer = getActiveWorkTimer(ex);
  const previewDuration = Math.max(1, Math.round(Number(state.draft?.durationSeconds || ex.targetDuration || 30)));
  const remaining = timer ? workTimerRemaining(timer) : previewDuration;
  const duration = timer?.duration || previewDuration;
  const pct = duration > 0 ? (duration - remaining) / duration : 0;
  const deg = Math.min(360, Math.max(0, pct * 360));
  const running = !!timer?.running;
  const done = !!timer?.done;
  const segments = timer?.segments || workTimerSegments(ex);
  const segmentIndex = timer?.segmentIndex || 0;
  const segmentLabel = segments > 1
    ? `${workTimerSegmentName(ex, timer)} of ${segments}`
    : 'Timed set';
  const sub = done
    ? 'complete'
    : running
      ? 'running'
      : timer?.remaining != null && timer.remaining !== timer.duration
        ? 'paused'
        : 'ready';
  const primaryLabel = done ? 'Restart timer' : running ? 'Pause' : (timer ? 'Start timer' : 'Start timer');
  const ringColor = done ? 'var(--tg-success)' : running ? 'var(--tg-accent-strong)' : 'var(--color-divider)';
  return `
    <div class="work-timer-card" data-timer-running="${running ? '1' : '0'}" data-timer-done="${done ? '1' : '0'}">
      <div class="work-timer-top">
        <div>
          <div class="work-timer-eyebrow">${escapeHtml(segmentLabel)}</div>
          <div class="work-timer-status">${escapeHtml(sub)}</div>
        </div>
        <button class="btn ghost sm" data-action="reset-work-timer">Reset</button>
      </div>
      <div class="work-timer-ring" style="background:conic-gradient(${ringColor} 0 ${deg}deg, var(--tg-secondary) ${deg}deg 360deg);">
        <div class="work-timer-inner">
          <button class="work-timer-time" data-action="edit-duration">${fmtTime(remaining)}</button>
          <div class="work-timer-sub">of ${fmtTime(duration)}</div>
        </div>
      </div>
      <button class="btn primary work-timer-primary" data-action="toggle-work-timer">${primaryLabel}</button>
    </div>
  `;
}

function renderActive() {
  const ex = activeEx();
  if (!ex) { state.view = 'overview'; return renderOverview(); }
  const setNum = ex.sets.length + 1;
  const d = state.draft;
  const isTimed = ex.measurement === 'duration';
  const mode = d.assistanceMode || 'added';   // default
  const bwCap = !!ex.bodyweight_capable;

  // Circuit/rotate context — computed once and reused below.
  const circuit = isCircuit(ex);
  const rotate = isRotateSlot(ex);
  const members = circuit ? groupOrder(ex.supersetGroup) : [];
  const myIdx = circuit ? members.indexOf(ex.id) : -1;
  // In a circuit each "set" of the slot is a round, so word it that way.
  const progressLabel = circuit ? `Round ${setNum}/${ex.targetSets}` : `Set ${setNum}/${ex.targetSets}`;
  // Variant picker state — idx falls back to round-robin default.
  const variantIdx = rotate
    ? (Number.isInteger(d.variantIndex) ? d.variantIndex : defaultVariantIndex(ex))
    : -1;

  // Superset partner display
  const partner = findSupersetPartner(ex);
  const partnerEligible = !partner && state.session.exercises
    .find(e => e.id !== ex.id && isAdhocLinkable(e));

  // Coach note card: the full freeform note from the plan (ramp cues, PR
  // context, failure branches). Shown once, collapsed by default when long.
  const coachNoteCard = ex.coachNote
    ? (() => {
        const note = ex.coachNote;
        const long = note.length > 180;
        const expanded = !!state._expandedCoachNotes?.[ex.id];
        const shown = long && !expanded ? note.slice(0, 180).trim() + '…' : note;
        return `
          <div class="coach-note" data-action="${long ? 'toggle-coach-note' : ''}" data-ex-id="${ex.id}" style="margin:8px 12px;padding:10px 12px;background:var(--tg-secondary);border-radius:10px;font-size:13px;line-height:1.45;color:var(--tg-hint);">
            <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--tg-accent-strong);margin-bottom:4px;">Coach · Set ${setNum}/${ex.targetSets}</div>
            <div>${escapeHtml(shown)}</div>
            ${long ? `<div style="font-size:11px;margin-top:4px;color:var(--tg-accent);">${expanded ? '▲ show less' : '▼ show more'}</div>` : ''}
          </div>
        `;
      })()
    : '';

  // Round chip: "↻ Circuit · Round 1 of 3 · Slot 2 of 3" — only for circuits.
  const roundChip = circuit ? `
    <div class="round-row">
      <span class="round-chip">↻ Circuit · Round ${setNum} of ${ex.targetSets}</span>
      ${members.length > 1 ? `<span class="round-slot-meta">Slot ${myIdx + 1} of ${members.length}</span>` : ''}
    </div>
  ` : '';

  // Variant picker: replaces the exercise name for rotating slots. Chips
  // are tappable (data-action="set-variant"); suggested chip = round-robin
  // default highlighted; completed variants from earlier rounds are dimmed.
  const completedVariantIndexes = rotate
    ? new Set(ex.sets.map(s => s.variantIndex).filter(i => Number.isInteger(i)))
    : null;
  const variantPicker = rotate ? `
    <div class="variant-title">${escapeHtml(ex.name)}</div>
    <div class="variant-hint">⟳ Rotating slot · Pick this round's variant</div>
    <div class="variant-picker">
      ${ex.variants.map((v, i) => `
        <button class="variant-chip${i === variantIdx ? ' selected' : ''}${completedVariantIndexes.has(i) ? ' done' : ''}"
                data-action="set-variant" data-idx="${i}">
          ${escapeHtml(v.name)}
          <span class="tag">${i === variantIdx ? `Round ${setNum}` : `R${i + 1}`}</span>
        </button>
      `).join('')}
    </div>
  ` : '';

  return `
    <div class="tg-top">
      <button class="btn-link" data-action="back-to-overview">‹ Back</button>
      <span class="title">${escapeHtml(ex.name)} · ${progressLabel}</span>
      <button class="icon-btn" data-action="pause">⏸</button>
    </div>
    <div class="body">
      ${renderSessionSyncBanner()}
      ${renderTabs(ex)}
      ${roundChip}
      ${variantPicker}
      ${coachNoteCard}
      ${renderExerciseMediaCta(ex)}

      ${isTimed ? `
        <div class="section-label"><span>Duration</span></div>
        <div class="rep-counter">
          <button class="rep-btn" data-action="dec-duration">−5s</button>
          <div style="text-align:center">
            <div class="rep-value" data-action="edit-duration">${fmtTime(d.durationSeconds || 0)}</div>
            <div class="rep-value-label">TARGET ${fmtTime(ex.targetDuration || 30)}</div>
          </div>
          <button class="rep-btn" data-action="inc-duration">+5s</button>
        </div>
        ${renderWorkTimerCard(ex)}
      ` : (() => {
        // Prefer the coach's per-set rep target when available — set 3 might
        // prescribe 6-8 reps even if the overall exercise range is 8-10.
        const p = plannedSet(ex);
        const rLow = p?.repsLow ?? ex.targetRepsLow;
        const rHigh = p?.repsHigh ?? ex.targetRepsHigh;
        const repsTarget = rLow === rHigh ? `${rLow}` : `${rLow}–${rHigh}`;
        const rpeTarget = p?.rpe ? ` · RPE ${p.rpe}` : '';
        const repLabel = repLabelForExercise(ex);
        return `
        <div class="section-label"><span>${escapeHtml(repLabel)}</span></div>
        <div class="rep-counter">
          <button class="rep-btn" data-action="dec-reps">−</button>
          <div style="text-align:center">
            <div class="rep-value" data-action="edit-reps">${fmtNum(d.reps)}</div>
            <div class="rep-value-label">TARGET ${repsTarget} ${escapeHtml(repUnitForExercise(ex))}${targetRepSuffix(ex)}${rpeTarget}</div>
          </div>
          <button class="rep-btn" data-action="inc-reps">+</button>
        </div>
      `;})()}

      <div class="section-label"><span>Notes</span></div>
      <textarea class="set-note" data-action="set-note-input" placeholder="incline 9 @ 1.5 mph, 0.12 mi" rows="2">${escapeHtml(d.note || '')}</textarea>

      ${bwCap ? `
        <div class="section-label"><span>Mode</span></div>
        <div class="bw-toggle">
          <button class="bw-opt ${mode === 'added' ? 'on' : ''}" data-action="set-assistance" data-mode="added">
            <span class="title">BW + Weight</span>
            <span class="hint">Added plate/dip belt</span>
          </button>
          <button class="bw-opt ${mode === 'pure_bw' ? 'on' : ''}" data-action="set-assistance" data-mode="pure_bw">
            <span class="title">Pure BW</span>
            <span class="hint">No assistance or load</span>
          </button>
          <button class="bw-opt ${mode === 'assisted' ? 'on' : ''}" data-action="set-assistance" data-mode="assisted">
            <span class="title">Assisted</span>
            <span class="hint">Band / machine offload</span>
          </button>
        </div>
      ` : ''}

      ${ex.hideLoadInput ? '' : `
        <div class="section-label">
          <span>${mode === 'assisted' ? 'Assistance load' : 'Weight'}</span>
          ${(() => {
            // Coach prescription wins — "Coach: 185 lb" is more actionable than
            // "Last: 175 × 8" when the plan explicitly ramps the next set.
            const p = plannedSet(ex);
            if (p?.weight != null) {
              return `<span class="muted" style="text-transform:none;letter-spacing:0;font-size:11px;">Coach: ${plannedLoadLabel(ex, p)}${p.rpe ? ` @ RPE ${p.rpe}` : ''}</span>`;
            }
            if (ex.last) {
              return `<span class="muted" style="text-transform:none;letter-spacing:0;font-size:11px;">Last: ${fmtNum(ex.last.weight)} × ${ex.last.reps ?? fmtTime(ex.last.durationSeconds || 0)}</span>`;
            }
            return '';
          })()}
        </div>
        <div class="weight-readout ${mode === 'pure_bw' ? 'disabled' : ''}" ${mode === 'pure_bw' ? '' : 'data-action="edit-weight"'}>
          ${mode === 'assisted' ? '<span class="sign">−</span>' : ''}
          <span class="val">${mode === 'pure_bw' ? '—' : fmtNum(d.weight)}</span>
          <span class="unit">${mode === 'pure_bw' ? 'BW' : ex.unit}</span>
          <span class="sp"></span>
          <span class="tap-edit">${mode === 'pure_bw' ? 'bodyweight only' : 'tap to edit'}</span>
        </div>
        ${mode === 'pure_bw' ? '' : `
          <div class="plate-row">
            ${PLATE_CHIPS.map(p => `<button class="plate" data-action="add-plate" data-amount="${p}"><span class="sign">+</span>${p}</button>`).join('')}
            <button class="plate minus" data-action="clear-weight">Clear</button>
          </div>
        `}
      `}

      <div class="section-label">
        <span>RPE (optional)<span class="rpe-current">${d.rpe != null ? d.rpe.toFixed(1) : ''}</span></span>
        <button class="btn-link rpe-clear-btn" style="padding:0 4px;font-size:12px;${d.rpe == null ? 'display:none;' : ''}" data-action="clear-rpe">Clear</button>
      </div>
      <div class="rpe-wrap">
        <!-- Pointer events bound directly in bind(); no data-action here so
             the global click delegator doesn't fight the pointer handler. -->
        <div class="rpe-track">
          ${d.rpe != null ? `<div class="rpe-knob" style="left:${Math.max(0, Math.min(100, ((d.rpe - 5) / 5) * 100))}%"></div>` : ''}
        </div>
        <div class="rpe-labels">
          <span>5</span><span>6</span><span>7</span><span>8</span><span>9</span><span>10</span>
        </div>
      </div>

      ${partner ? (() => {
        const label = groupLabel(ex.supersetGroup);
        const kindWord = circuit ? 'Circuit' : 'Superset';
        const eyebrow = label ? `${kindWord} · ${label}` : `${kindWord} ${ex.supersetGroup}`;
        // In a circuit, unlinking mid-session breaks the whole rotation —
        // hide the unlink button so the user can't fat-finger it.
        const unlink = circuit
          ? ''
          : '<button class="btn ghost sm" data-action="unlink-superset">Unlink</button>';
        // "+ Add" button grows an existing group up to the 5-member cap.
        // Only surface when there's both room in the group AND an eligible
        // exercise in the session to add.
        const members = groupMembers(ex.supersetGroup);
        const hasRoom = members.length < 5;
        const hasEligible = state.session.exercises.some(e =>
          !members.includes(e.id) && isAdhocLinkable(e));
        const addMore = hasRoom && hasEligible
          ? '<button class="btn ghost sm" data-action="open-link-sheet" data-mode="grow">+ Add</button>'
          : '';
        return `
        <div class="ss-strip paired">
          <div class="ss-left">
            <div class="ss-eyebrow">${escapeHtml(eyebrow)}</div>
            <div class="ss-name">${escapeHtml(partner.name)} next · ${partner.sets.length}/${partner.targetSets}</div>
          </div>
          ${addMore}
          ${unlink}
        </div>
      `;})() : partnerEligible ? `
        <div class="ss-strip offer">
          <div class="ss-left">
            <div class="ss-eyebrow">Group (optional)</div>
            <div class="ss-name">Link 1–4 more exercises</div>
          </div>
          <button class="btn ghost sm" data-action="open-link-sheet" data-mode="new">Link…</button>
        </div>
      ` : ''}
    </div>
    <div class="bottom-bar">
      <button class="btn ghost sm" data-action="skip-set">Skip</button>
      <button class="btn success" data-action="complete-set">✓ Complete set</button>
    </div>
  `;
}

function renderTabs(currentEx) {
  // Next 2 incomplete, non-active exercises, in session order
  const others = state.session.exercises
    .filter(e => e.id !== currentEx.id && e.sets.length < e.targetSets && !e.skipped)
    .slice(0, 2);
  return `
    <div class="ex-tabs">
      <div class="ex-tab active" data-action="open-switcher"><span class="dot"></span>${escapeHtml(currentEx.name)}</div>
      ${others.map(o => `
        <div class="ex-tab" data-action="jump-to-exercise" data-ex-id="${o.id}">
          <span class="dot"></span>${escapeHtml(o.name)}
        </div>`).join('')}
      <div class="ex-tab add" data-action="open-switcher">+ Add</div>
    </div>
  `;
}

// --- Rest ---
function renderRest() {
  const ex = activeEx();
  if (!ex) { state.view = 'overview'; return renderOverview(); }
  const remaining = Math.max(0, Math.floor((state.rest.endsAt - Date.now()) / 1000));
  const pct = state.rest.duration > 0 ? (state.rest.duration - remaining) / state.rest.duration : 1;
  const deg = Math.min(360, pct * 360);
  const isDone = remaining <= 0;
  const setNum = ex.sets.length + 1;
  const ringColor = isDone ? 'var(--tg-success)' : 'var(--tg-accent-strong)';

  // Context for the up-next card: what you just did, target, trend vs last.
  // Trend compares against the PREVIOUS set's prescription (the one you just
  // did), not the overall exercise range — a ramp set of 6 reps at 190 lb
  // is "on target" even if the exercise band is 8-10.
  const justDid = ex.sets[ex.sets.length - 1];
  const lastSetIdx = ex.sets.length - 1;
  const lastPlanned = Array.isArray(ex.setPlan) ? ex.setPlan[lastSetIdx] : null;
  const trendLow = lastPlanned?.repsLow ?? ex.targetRepsLow;
  const trendHigh = lastPlanned?.repsHigh ?? ex.targetRepsHigh;
  let trend = null;
  if (justDid) {
    if (justDid.reps > trendHigh) trend = { cls: 'up', label: `▲ beat target (${trendLow}–${trendHigh})` };
    else if (justDid.reps >= trendLow) trend = { cls: 'flat', label: `on target (${trendLow}–${trendHigh})` };
    else trend = { cls: 'down', label: `▼ below target (${trendLow}–${trendHigh})` };
  }
  // Coach prescription for the next set (weight + reps + rpe) if the plan has
  // per-set entries. Falls back to the generic exercise target otherwise.
  const nextPlanned = Array.isArray(ex.setPlan) ? ex.setPlan[setNum - 1] : null;
  const nextWeight = nextPlanned?.weight != null ? nextPlanned.weight : ex.targetWeight;
  const nextLow = nextPlanned?.repsLow ?? ex.targetRepsLow;
  const nextHigh = nextPlanned?.repsHigh ?? ex.targetRepsHigh;
  const nextRepsStr = nextLow === nextHigh ? `${nextLow}` : `${nextLow}–${nextHigh}`;
  const nextRpeStr = nextPlanned?.rpe ? ` @ RPE ${nextPlanned.rpe}` : '';
  const nextLoadLabel = plannedLoadLabel(ex, nextPlanned, nextWeight);
  const nextTargetStr = nextLoadLabel
    ? `Target: ${nextLoadLabel} × ${nextRepsStr}${nextRpeStr}`
    : `Target: ${nextRepsStr}${nextRpeStr}`;
  const sessionProgress = `${ex.sets.length} / ${ex.targetSets} sets · ${state.session.exercises.filter(e => e.sets.length >= e.targetSets).length} / ${state.session.exercises.length} exercises`;
  const roundEditItems = completedRoundEditItems(ex);

  return `
    <div class="tg-top">
      <button class="btn-link" data-action="back-to-active">‹ Back</button>
      <span class="title">Rest · ${escapeHtml(ex.name)}</span>
      <button class="icon-btn" data-action="pause">⏸</button>
    </div>
    <div class="body">
      ${renderSessionSyncBanner()}
      <div class="rest-wrap">
        <div class="rest-ring" style="background: conic-gradient(${ringColor} 0 ${deg}deg, var(--tg-secondary) ${deg}deg 360deg);">
          <div class="rest-inner">
            <div class="rest-time" data-action="edit-rest">${fmtTime(remaining)}</div>
            <div class="rest-sub">${isDone ? 'ready' : `of ${fmtTime(state.rest.duration)}`}</div>
          </div>
        </div>
        ${(() => {
          // Card semantics: when there IS a just-did set (nearly always
          // during rest), the whole card is a big tap target that opens
          // the edit-set sheet — the common "wait I did 7 reps, not 8"
          // save. Advancing is done via the explicit "Start set N" CTA
          // below. Without a just-did set (edge case: entering rest from
          // somewhere without a completed set), the card still advances.
          const lastIdx = ex.sets.length - 1;
          const outerAction = justDid
            ? `data-action="open-edit-set" data-ex-id="${ex.id}" data-set-idx="${lastIdx}"`
            : `data-action="skip-rest"`;
          const headerLabel = justDid ? 'Review · up next' : 'Tap to start · up next';
          const justDidRow = justDid ? (() => {
            const isTimed = ex.measurement === 'duration';
            // Same bot-aware shape as the summary chip — "−20 × 6" for
            // assisted, "BW × 6" for pure bodyweight, "70 × 6" weighted, and
            // bare reps when there's no load to display (avoids the
            // "0 × 6" misread that pre-dated the parity fix).
            const load = loadLabelForSet(justDid);
            let label;
            if (isTimed) {
              const loadBit = load == null
                ? ''
                : load === 'BW' ? ` BW` : load.startsWith('−') ? ` ${load}` : ` +${load}`;
              label = `${fmtTime(justDid.durationSeconds || 0)}${loadBit}`;
            } else {
              label = load == null ? `${justDid.reps}` : `${load} × ${justDid.reps}`;
            }
            const rpeBit = formatRpeBit(justDid);
            return `
              <div class="body-row">
                <div class="you-did">
                  Just did: <span class="val">${label}${rpeBit}</span>
                </div>
                ${trend ? `<span class="trend ${trend.cls}">${trend.label}</span>` : ''}
              </div>
            `;
          })() : '';
          const cue = justDid
            ? `${sessionProgress} &nbsp;·&nbsp; Tap card to edit · use button below to advance`
            : `${sessionProgress} &nbsp;·&nbsp; Tap card to start →`;
          return `
            <div class="next-card ${justDid ? 'editable' : ''}" ${outerAction}>
              <div class="icon">${justDid ? '✎' : '▶'}</div>
              <div style="flex:1;min-width:0;">
                <div class="label">${headerLabel}</div>
                <div class="name">Set ${setNum} of ${ex.targetSets} · ${escapeHtml(ex.name)}</div>
                <div class="meta">${nextTargetStr}</div>
                ${justDidRow}
                <div class="tap-cue" style="margin-top:8px;">${cue}</div>
              </div>
            </div>
          `;
        })()}
        ${renderRestRoundEditList(roundEditItems)}
      </div>
    </div>
    <div class="bottom-bar">
      <button class="btn primary" data-action="skip-rest">${isDone ? '▶ ' : ''}Start set ${setNum}</button>
    </div>
  `;
}

// --- Paused ---
function renderPaused() {
  const ex = activeEx();
  return `
    <div class="tg-top"><span></span><span class="title">Paused</span><span></span></div>
    ${renderSessionSyncBanner()}
    <div class="paused-wrap">
      <div class="paused-icon">
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
      </div>
      <h2>Workout paused</h2>
      <div class="sub">Your set data is held. Resume whenever you're ready.</div>
      <div class="paused-stats">
        <div class="paused-stat"><div class="v">${fmtTime(elapsedSec())}</div><div class="l">Elapsed</div></div>
        ${ex ? `<div class="paused-stat"><div class="v">${ex.sets.length} / ${ex.targetSets}</div><div class="l">Current ex.</div></div>` : ''}
        <div class="paused-stat"><div class="v">${setsDone()}</div><div class="l">Sets done</div></div>
      </div>
    </div>
    <div class="bottom-bar" style="flex-direction:column;gap:8px;">
      <button class="btn primary" style="width:100%" data-action="resume">▶ Resume workout</button>
      <button class="btn danger" style="width:100%" data-action="end-session">End session</button>
    </div>
  `;
}

// --- Summary helpers ---
// Format the load portion of a chip for a logged set. Reads the bot-compatible
// shape stored on the set object:
//   - assisted (bw_capable, mode='assisted')      → "−<lbs>"  (real U+2212 minus)
//   - pure bodyweight (bw_capable, mode='pure_bw') → "BW"
//   - weighted (anything else, weight > 0)         → "<weight>"
//   - degenerate (weight=0, no mode)               → "" (omit)
// `weight=0` for assisted/pure_bw is a side-effect of how the local set is
// stored after persistSet (see complete-set in app.js); we route around it
// by reading `assistanceMode` and `assistanceLbs` instead. Returns null when
// there's no meaningful load to render.
function loadLabelForSet(set) {
  if (!set) return null;
  const mode = set.assistanceMode;
  if (mode === 'assisted') {
    const lbs = Number(set.assistanceLbs ?? set.weight ?? 0);
    if (Number.isFinite(lbs) && lbs > 0) return `−${fmtNum(lbs)}`;
    return null;
  }
  if (mode === 'pure_bw') return 'BW';
  const w = Number(set.weight);
  return Number.isFinite(w) && w > 0 ? fmtNum(w) : null;
}
function formatRpeBit(set) {
  return set?.rpe != null ? ` @ ${Number(set.rpe).toFixed(1)}` : ' @ RPE ?';
}

// Short single-word label for rotating-slot summary chips. Plan can supply
// an explicit `shortLabel` (best — picks the distinctive word for compound
// names like "Leg Lifts" → "Lifts"). Falls back to first word, which works
// for most pairs ("Flutter Kicks" → "Flutter").
function shortVariantLabel(v) {
  if (!v) return '';
  if (typeof v.shortLabel === 'string' && v.shortLabel.trim()) return v.shortLabel.trim();
  const first = String(v.name || '').trim().split(/\s+/)[0] || '';
  return first;
}

// Render the text inside a set chip. Rotate slots collapse to
// "<short> <reps> @ <rpe>" (weight omitted when 0, which is the common case
// for body-weight rotating slots). Non-rotate sets keep the original
// "<weight> × <reps> @ <rpe>" (or timed form) untouched.
function formatSummarySetLabel(ex, set) {
  const isTimed = ex.measurement === 'duration';
  const rpeBit = formatRpeBit(set);
  const load = loadLabelForSet(set);

  if (isRotateSlot(ex) && Number.isInteger(set.variantIndex)) {
    const variant = ex.variants[set.variantIndex];
    const short = shortVariantLabel(variant);
    if (isTimed) {
      // For timed sets, attach the load with a leading "+" or "−"; "BW" stands
      // alone (no sign — it isn't extra resistance).
      const loadBit = load == null
        ? ''
        : load === 'BW' ? ` BW` : load.startsWith('−') ? ` ${load}` : ` +${load}`;
      return `${short} ${fmtTime(set.durationSeconds || 0)}${loadBit}${rpeBit}`;
    }
    // Reps form: keep the existing "weight × reps" shape but substitute the
    // bot-aware load label, falling back to bare reps when no load fits
    // (pure BW circuits historically rendered just the rep count).
    const prefix = load == null ? '' : `${load} × `;
    return `${short} ${prefix}${set.reps}${rpeBit}`;
  }

  if (isTimed) {
    const loadBit = load == null
      ? ''
      : load === 'BW' ? ` BW` : load.startsWith('−') ? ` ${load}` : ` +${load}`;
    return `${fmtTime(set.durationSeconds || 0)}${loadBit}${rpeBit}`;
  }
  // Reps form. Pure BW renders "BW × 6"; assisted "−20 × 6"; weighted "70 × 6";
  // and degenerate (no load) collapses to bare reps so we never show "0 × 6".
  const prefix = load == null ? '' : `${load} × `;
  if (!prefix) return `${set.reps}${rpeBit}`;
  return `${prefix}${set.reps}${rpeBit}`;
}

function renderSummarySetChips(ex) {
  return ex.sets.map((set, i) => {
    const label = formatSummarySetLabel(ex, set);
    return `<span class="set-chip editable" data-action="open-edit-set" data-ex-id="${ex.id}" data-set-idx="${i}">${escapeHtml(label)}</span>`;
  }).join('');
}

function completedRoundEditItems(anchorEx) {
  if (!anchorEx?.supersetGroup) return [];
  const members = orderedGroupExercises(anchorEx.supersetGroup)
    .filter(m => !m.skipped && m.sets?.length);
  if (members.length < 2) return [];
  const roundIdx = Math.min(...members.map(m => m.sets.length)) - 1;
  if (roundIdx < 0) return [];
  return members
    .map(member => ({ ex: member, set: member.sets[roundIdx], setIdx: roundIdx }))
    .filter(item => item.set);
}

function renderRestRoundEditList(items) {
  if (!items || items.length < 2) return '';
  const roundNum = items[0].setIdx + 1;
  return `
    <div class="round-review">
      <div class="round-review-head">
        <div class="round-review-label">Round ${roundNum} review</div>
        <div class="round-review-hint">Tap any exercise to edit</div>
      </div>
      <div class="round-review-list">
        ${items.map(({ ex, set, setIdx }) => `
          <button class="round-review-row" data-action="open-edit-set" data-ex-id="${escapeHtml(ex.id)}" data-set-idx="${setIdx}">
            <span class="round-review-name">${escapeHtml(ex.name)}</span>
            <span class="round-review-set">${escapeHtml(formatSummarySetLabel(ex, set))}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

// Walk loggedExercises in order, emitting single-exercise blocks interleaved
// with group blocks. First sighting of a superset_group triggers the group
// block; later members are folded in. Preserves the plan's original ordering
// of group members.
function buildSummaryBlocks(loggedExercises) {
  const blocks = [];
  const seen = new Set();
  for (const ex of loggedExercises) {
    const gk = ex.supersetGroup;
    if (!gk) { blocks.push({ type: 'single', ex }); continue; }
    if (seen.has(gk)) continue;
    seen.add(gk);
    const order = groupOrder(gk);
    const members = loggedExercises
      .filter(e => e.supersetGroup === gk)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    if (members.length === 1) {
      // Degenerate group (partner skipped the whole workout): render as single.
      blocks.push({ type: 'single', ex: members[0] });
      continue;
    }
    const label = groupLabel(gk) || members.map(m => m.name).join(' + ');
    const rounds = members.reduce((mx, m) => Math.max(mx, m.sets.length), 0);
    blocks.push({ type: 'group', key: gk, label, members, rounds });
  }
  return blocks;
}

function renderSummaryExercise(ex) {
  return `
    <div class="summary-exercise">
      <div class="head">
        <div class="name">${escapeHtml(ex.name)}</div>
        <div class="meta">${ex.sets.length} / ${ex.targetSets} sets</div>
      </div>
      <div class="sets-row">${renderSummarySetChips(ex)}</div>
    </div>`;
}

function renderSummaryGroup(block) {
  return `
    <div class="summary-group">
      <div class="head">
        <div class="name">${escapeHtml(block.label)}</div>
        <div class="meta">${block.rounds} round${block.rounds === 1 ? '' : 's'}</div>
      </div>
      ${block.members.map(ex => `
        <div class="sub-ex">
          <div class="sub-name">${escapeHtml(ex.name)}</div>
          <div class="sets-row">${renderSummarySetChips(ex)}</div>
        </div>
      `).join('')}
    </div>`;
}

// --- Summary ---
function renderSummary() {
  const s = state.session;
  if (!s) { state.view = 'launch'; return renderLaunch(); }
  const totalSets = setsDone();
  const totalReps = s.exercises.reduce((sum, e) => sum + e.sets.reduce((ss, x) => ss + x.reps, 0), 0);
  const totalVolume = s.exercises.reduce(
    (sum, e) => sum + e.sets.reduce((ss, x) => ss + (x.weight || 0) * x.reps, 0),
    0
  );
  const loggedExercises = s.exercises.filter(e => e.sets.length > 0);

  return `
    <div class="tg-top"><span></span><span class="title">Session complete</span><span></span></div>
    <div class="body">
      ${renderSessionSyncBanner()}
      <div class="summary-hero">
        <h2>${escapeHtml(s.dayName)} · done</h2>
        <div class="sub">${fmtTime(elapsedSec())} elapsed · ${exercisesDone()} / ${s.exercises.length} exercises</div>
        <div class="summary-grid">
          <div class="summary-stat"><div class="v">${totalSets}</div><div class="l">Sets</div></div>
          <div class="summary-stat"><div class="v">${totalReps}</div><div class="l">Reps</div></div>
          <div class="summary-stat"><div class="v">${fmtNum(Math.round(totalVolume))}</div><div class="l">Volume lb</div></div>
        </div>
      </div>

      ${state.weighInThisSession
        ? `<div class="weighin-done">⚖️ Post-workout weight logged ✓</div>`
        : `<div class="weighin-prompt">
             <div class="wp-head">
               <span class="emoji">⚖️</span>
               <div>
                 <div class="wp-title">Log your post-workout weight?</div>
                 <div class="wp-sub">Hop on the scale after cleaning up — tap below to enter it.</div>
               </div>
             </div>
             <button class="btn primary" data-action="open-weighin" data-context="summary">Log weight now</button>
           </div>`}

      ${loggedExercises.length === 0
        ? `<div class="muted" style="text-align:center;padding:40px 20px;">No sets logged.</div>`
        : buildSummaryBlocks(loggedExercises).map(block =>
            block.type === 'group'
              ? renderSummaryGroup(block)
              : renderSummaryExercise(block.ex)
          ).join('')
      }
    </div>
    <div class="bottom-bar">
      <button class="btn ghost sm" data-action="reset-session">New session</button>
      <button class="btn primary" data-action="close-app">${currentAuthMode() === 'hmac' ? 'Close' : 'Return home'}</button>
    </div>
    <!-- Danger zone: a butt-dial here would wipe real training history, so
         the button is small, sits below the primary actions, and triggers
         an explicit confirm dialog. Only surfaced on the summary screen
         (post-complete) so it can't fire mid-session. -->
    <div style="text-align:center;padding:8px 16px 20px;">
      <button class="btn-link" data-action="delete-session"
              style="color:var(--color-low,#B14A3A);font-size:12px;">
        Delete this session
      </button>
    </div>
  `;
}

// --- Switcher sheet ---
function renderSwitcher() {
  const s = state.session;
  const q = (state._switcherSearch || '').toLowerCase().trim();
  const qCompact = compactExerciseLibraryText(q);
  const library = currentExerciseKb();
  const existingIds = new Set((s?.exercises || []).map(e => e.id));

  // Session exercises filtered by search
  const sessionMatches = (s?.exercises || []).filter(e => !q || compactExerciseLibraryText(e.name).includes(qCompact));

  // Full KB filtered by search (name / aliases / muscle / equipment)
  const kbMatches = library
    .filter(e => !existingIds.has(e.id))
    .filter(e => !q ||
      e.name.toLowerCase().includes(q) ||
      compactExerciseLibraryText(e.name).includes(qCompact) ||
      (e.aliases || []).some(alias => compactExerciseLibraryText(alias).includes(qCompact)) ||
      e.muscle.includes(q) ||
      (e.equipment || '').includes(q));

  // Curated "recent" list (only shown when no search active)
  const recent = adhocCandidates.filter(c => !existingIds.has(c.id));

  const noMatches = q && sessionMatches.length === 0 && kbMatches.length === 0;

  return `
    <div class="sheet-backdrop" data-action="close-switcher"></div>
    <div class="sheet">
      <div class="grabber"></div>
      <h3>Exercises</h3>
      <div class="search-box">
        <span class="muted">🔍</span>
        <input type="text" placeholder="Search ${library.length} exercises or add new" value="${escapeHtml(q)}" data-action="switcher-search" autocomplete="off" />
      </div>
      <div class="sheet-scroll">
        ${sessionMatches.length > 0 ? `
          <div class="group-label">In this session</div>
          ${sessionMatches.map(renderSheetRow).join('')}
        ` : ''}

        ${!q && recent.length > 0 ? `
          <div class="group-label">Recent · quick add</div>
          ${recent.map(c => renderKbRow(c, 'recent')).join('')}
        ` : ''}

        ${q ? `
          <div class="group-label">Matches${kbMatches.length ? ` (${kbMatches.length})` : ''}</div>
          ${kbMatches.slice(0, 20).map(c => renderKbRow(c, 'kb')).join('')}
        ` : `
          <div class="group-label">From library</div>
          ${kbMatches.slice(0, 8).map(c => renderKbRow(c, 'kb')).join('')}
        `}

        ${noMatches || q ? `
          <div class="sheet-row create" data-action="create-new" data-name="${escapeHtml(q || '')}">
            <div class="marker">✨</div>
            <div><div class="name">${q ? `Create "${escapeHtml(q)}" as new exercise` : 'Create new exercise'}</div><div class="meta">Custom · saves to session</div></div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}
function renderSheetRow(ex) {
  const active = ex.id === state.activeExerciseId;
  const done = ex.sets.length >= ex.targetSets;
  const status = done
    ? `Completed · ${ex.sets.length} / ${ex.targetSets}`
    : active
      ? `Active · set ${ex.sets.length + 1} / ${ex.targetSets}`
      : ex.sets.length > 0
        ? `${ex.sets.length} / ${ex.targetSets} sets done`
        : `${ex.targetSets} × ${ex.targetRepsLow}-${ex.targetRepsHigh}`;
  return `
    <div class="sheet-row ${active ? 'current' : ''}" data-action="jump-to-exercise" data-ex-id="${ex.id}">
      <div class="marker">${done ? '✓' : active ? '●' : '→'}</div>
      <div><div class="name">${escapeHtml(ex.name)}</div><div class="meta">${status}</div></div>
    </div>
  `;
}
function renderKbRow(item, type) {
  const meta = type === 'recent'
    ? `${item.category} · last ${item.lastDone}`
    : `${item.muscle} · ${item.equipment}${item.category === 'main' ? ' · main' : ''}`;
  return `
    <div class="sheet-row" data-action="add-from-kb" data-kb-id="${item.id}">
      <div class="marker">＋</div>
      <div><div class="name">${escapeHtml(item.name)}</div><div class="meta">${escapeHtml(meta)}</div></div>
    </div>
  `;
}

// --- Cardio sheet ---
// Bottom sheet for logging a cardio block (warmup / cardio / cooldown).
// mode='launch' starts a cardio-only session on commit; mode='inline'
// adds a block to the running session + posts to /cardio.
function renderCardioSheet() {
  const c = state.cardioSheet;
  const phase = c.phase || 'warmup';
  const activity = c.activityId || '';
  const mins = c.durationMin || 0;
  const note = c.note || '';
  const canCommit = activity && mins > 0;
  const isEdit = c.mode === 'edit';
  const title = c.mode === 'launch'
    ? 'Log cardio session'
    : isEdit
      ? 'Edit cardio block'
      : 'Add cardio block';
  return `
    <div class="sheet-backdrop" data-action="close-cardio"></div>
    <div class="sheet cardio-sheet">
      <div class="grabber"></div>
      <h3>${title}</h3>

      <div class="group-label">Phase</div>
      <div class="cardio-phase-row">
        ${CARDIO_PHASES.map(p => `
          <button class="phase-chip ${phase === p.id ? 'on' : ''}" data-action="set-cardio-phase" data-phase="${p.id}">${p.label}</button>
        `).join('')}
      </div>

      <div class="group-label">Activity</div>
      <div class="cardio-activity-grid">
        ${CARDIO_ACTIVITIES.map(a => `
          <button class="cardio-activity ${activity === a.id ? 'on' : ''}" data-action="set-cardio-activity" data-activity="${a.id}">
            <span class="emoji">${a.emoji}</span>
            <span class="label">${a.label}</span>
          </button>
        `).join('')}
      </div>

      <div class="group-label">Duration</div>
      <div class="cardio-duration" data-action="edit-cardio-duration">
        <span class="val">${mins || '0'}</span>
        <span class="unit">min</span>
        <span class="sp"></span>
        <span class="tap-edit">tap to edit</span>
      </div>

      <div class="group-label">Note (optional)</div>
      <input type="text" class="cardio-note" placeholder="incline 4 @ 3.5 mph" value="${escapeHtml(note)}" data-action="cardio-note-input" autocomplete="off" />

      <div class="cardio-foot">
        ${isEdit
          ? `<button class="btn danger sm" data-action="delete-cardio-block">Delete</button>
             <button class="btn ghost sm" data-action="close-cardio">Cancel</button>
             <button class="btn success" ${canCommit ? '' : 'disabled'} data-action="commit-cardio">✓ Save changes</button>`
          : `<button class="btn ghost sm" data-action="close-cardio">Cancel</button>
             <button class="btn success" ${canCommit ? '' : 'disabled'} data-action="commit-cardio">${c.mode === 'launch' ? 'Start & log' : '✓ Log block'}</button>`}
      </div>
    </div>
  `;
}

// --- Weigh-in sheet ---
// Logs a body-weight reading to the body_metrics table. Optionally linked
// to the current session (session_id → FK). Opened from home card, overview
// row, or the post-session prompt. History list (last 5) shown above input
// so the user has context (e.g. "186.4 → 185.9 is +0.5 lb drop").
function renderWeighInSheet() {
  const w = state.weighIn;
  const isSummary = w.context === 'summary';
  const activeSession = !!state.session;
  const display = w.weight === '' || w.weight == null ? '—' : fmtNum(Number(w.weight));
  const canCommit = Number.isFinite(Number(w.weight)) && Number(w.weight) > 0 && !w.saving;
  const history = (state.bodyWeights || []).slice(0, isSummary ? 3 : 5);
  const prev = history[0];
  let diffLine = '';
  if (Number.isFinite(Number(w.weight)) && Number(w.weight) > 0 && prev?.weight_lbs != null) {
    const d = Number(w.weight) - Number(prev.weight_lbs);
    const sign = d > 0 ? '+' : d < 0 ? '' : '±';
    const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    diffLine = `<span class="bw-diff ${cls}">${sign}${fmtNum(d)} lb vs last</span>`;
  }

  const historyMarkup = history.length > 0 ? `
    <div class="group-label">Recent</div>
    <div class="weighin-history ${isSummary ? 'compact' : ''}">
      ${history.map((h, i) => {
        const d = i < history.length - 1 && history[i+1]?.weight_lbs != null
          ? Number(h.weight_lbs) - Number(history[i+1].weight_lbs)
          : null;
        const tag = d == null ? '' : `<span class="bw-diff ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${d > 0 ? '+' : ''}${fmtNum(d)}</span>`;
        return `<div class="weighin-hist-row">
          <span class="v">${fmtNum(h.weight_lbs)} lb</span>
          <span class="when muted">${daysSince(h.timestamp) || ''}</span>
          ${tag}
        </div>`;
      }).join('')}
    </div>
  ` : '';

  const readoutMarkup = `
    <div class="group-label">Today's weight</div>
    <div class="weighin-readout" data-action="edit-weighin-value">
      <span class="val">${display}</span>
      <span class="unit">lb</span>
      <span class="sp"></span>
      <span class="tap-edit">tap to edit</span>
    </div>
    ${diffLine ? `<div class="weighin-diff-line">${diffLine}</div>` : ''}
  `;

  const linkMarkup = activeSession ? `
    <label class="weighin-link ${isSummary ? 'compact' : ''}">
      <input type="checkbox" data-action="toggle-weighin-link" ${w.linkToSession ? 'checked' : ''} />
      <span>Link to this session <span class="muted">(${state.session.dbSessionId ? '#' + state.session.dbSessionId : 'pre-save'})</span></span>
    </label>
  ` : '';

  const noteMarkup = isSummary ? '' : `
    <div class="group-label">Note (optional)</div>
    <input type="text" class="weighin-note" placeholder="fasted · morning · post-workout…" value="${escapeHtml(w.note || '')}" data-action="weighin-note-input" autocomplete="off" />
  `;

  const footerMarkup = `
    <div class="weighin-foot">
      <button class="btn ghost sm" data-action="close-weighin">${isSummary ? 'Skip' : 'Cancel'}</button>
      <button class="btn success" ${canCommit ? '' : 'disabled'} data-action="commit-weighin">
        ${w.saving ? 'Saving…' : '✓ Save weight'}
      </button>
    </div>
  `;

  return `
    <div class="sheet-backdrop" data-action="close-weighin"></div>
    <div class="sheet weighin-sheet ${isSummary ? 'summary-weighin-sheet' : ''}">
      <div class="grabber"></div>
      <h3>Body weight</h3>
      <div class="weighin-sub muted">Scale weight in lb. Logs to <code>body_metrics</code>.</div>

      ${isSummary
        ? `${readoutMarkup}${linkMarkup}${footerMarkup}${historyMarkup}`
        : `${historyMarkup}${readoutMarkup}${linkMarkup}${noteMarkup}${footerMarkup}`}
    </div>
  `;
}

// --- Link-superset sheet ---
// A minimal bottom sheet for linking 2-5 exercises into a superset / circuit.
// Entry points:
//   1. "Link…" button on the active view's Group offer strip (mode: 'new')
//   2. "+ Add" button on an already-paired strip (mode: 'grow') — grows the
//      existing group up to the 5-member cap.
// The anchor exercise (current ex for 'new', all existing members for 'grow')
// is always checked and locked. User toggles other eligible exercises to
// build the group. Kind is auto-classified from final count:
//   2 members = superset, 3-5 = circuit. Caller can't override kind — keeps
//   the UI as small as possible per user direction ("no new creation UI").
function renderLinkSheet() {
  const ls = state.linkSheet;
  if (!ls) return '';
  const s = state.session;
  if (!s) return '';
  const MAX = 5;

  // Locked members: anchor (new) or all existing group members (grow).
  const locked = new Set(ls.lockedIds || []);
  // Currently selected = locked + user's toggles.
  const selected = new Set([...locked, ...(ls.memberIds || [])]);

  // Eligible pool: exercises not in any group, not completed, not skipped.
  // Locked members are shown too (at the top) so the user sees who's
  // already in the group.
  const eligible = s.exercises.filter(e =>
    isAdhocLinkable(e, { lockedIds: locked })
  );

  const count = selected.size;
  const canConfirm = count >= 2 && count <= MAX;
  const kindWord = count >= 3 ? 'circuit' : count === 2 ? 'superset' : 'group';
  const btnLabel = canConfirm
    ? `Link ${count} exercise${count === 1 ? '' : 's'}`
    : count < 2
      ? 'Pick 1 more'
      : `Max ${MAX} — remove one`;

  const atCap = count >= MAX;

  const rows = eligible.map(e => {
    const isLocked = locked.has(e.id);
    const isSelected = selected.has(e.id);
    const disabled = isLocked || (atCap && !isSelected);
    const cls = ['link-row'];
    if (isSelected) cls.push('selected');
    if (isLocked) cls.push('locked');
    if (disabled && !isSelected) cls.push('disabled');
    // Flag exercises currently in another group so the user understands
    // confirming will migrate them out of that group. The migration is
    // handled in the confirm-link handler.
    const inOtherGroup = !isLocked && e.supersetGroup;
    if (inOtherGroup) cls.push('migrate');
    const action = disabled ? '' : 'data-action="toggle-link-member"';
    let meta;
    if (isLocked) {
      meta = ls.mode === 'grow' ? 'Already in group' : 'Current exercise';
    } else if (inOtherGroup) {
      const otherLabel = groupLabel(e.supersetGroup) || `group ${e.supersetGroup}`;
      meta = `In ${escapeHtml(otherLabel)} — will move`;
    } else {
      const reachedTarget = e.sets.length >= e.targetSets;
      meta = reachedTarget
        ? `${e.sets.length} sets logged · adding more`
        : `${e.targetSets} × ${e.targetRepsLow}–${e.targetRepsHigh}`;
    }
    return `
      <div class="${cls.join(' ')}" ${action} data-ex-id="${e.id}">
        <div class="link-check">${isSelected ? '☑' : '☐'}</div>
        <div class="link-body">
          <div class="link-name">${escapeHtml(e.name)}</div>
          <div class="link-meta">${meta}</div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="sheet-backdrop" data-action="close-link-sheet"></div>
    <div class="sheet link-sheet">
      <div class="grabber"></div>
      <h3>${ls.mode === 'grow' ? 'Add to group' : 'Link exercises'}</h3>
      <div class="link-sub">
        ${count === 2 ? 'Superset — alternate sets' : count >= 3 ? `Circuit — rotate through ${count}` : 'Pick 2–5 exercises'}
      </div>
      <div class="sheet-scroll link-list">
        ${rows || '<div class="muted" style="padding:24px 12px;text-align:center;">No eligible exercises</div>'}
      </div>
      <div class="link-footer">
        <button class="btn ghost" data-action="close-link-sheet">Cancel</button>
        <button class="btn primary ${canConfirm ? '' : 'disabled'}" data-action="confirm-link" ${canConfirm ? '' : 'disabled'}>
          ${btnLabel}
        </button>
      </div>
    </div>
  `;
}

// --- Edit-set sheet ---
// Opened by tapping a logged set chip on the summary screen or the
// "Just did: …" pill during rest. Patches the in-memory set AND
// PATCH/DELETEs the DB row when dbSetId is present (always true for
// sets that persisted cleanly; pending-queued sets have to be edited
// post-flush). Reuses the existing keypad for weight/reps/duration;
// RPE has a dedicated chip grid so taps always land on the right value.
function renderEditSetSheet() {
  const e = state.editSet;
  const ex = state.session?.exercises?.find(x => x.id === e.exId);
  const exName = ex ? ex.name : 'Set';
  const repLabel = repLabelForExercise(ex);
  const rpeOptions = [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
  const dbTag = e.dbSetId ? `#${e.dbSetId}` : 'pending';
  return `
    <div class="sheet-backdrop" data-action="close-edit-set"></div>
    <div class="sheet edit-set-sheet">
      <div class="grabber"></div>
      <h3>Edit set</h3>
      <div class="es-sub">${escapeHtml(exName)} · set ${e.setIdx + 1} · <span class="muted">${dbTag}</span></div>

      ${e.isTimed ? `
        <div class="edit-set-row" data-action="edit-set-duration">
          <span class="es-label">Duration</span>
          <span class="es-val">${fmtTime(e.durationSeconds || 0)}</span>
          <span class="tap-edit">tap to edit</span>
        </div>
      ` : `
        <div class="edit-set-row" data-action="edit-set-reps">
          <span class="es-label">${escapeHtml(repLabel)}</span>
          <span class="es-val">${fmtNum(e.reps ?? 0)}</span>
          <span class="tap-edit">tap to edit</span>
        </div>
      `}

      <div class="edit-set-row" data-action="edit-set-weight">
        <span class="es-label">${e.isTimed ? 'Added weight' : 'Weight'}</span>
        <span class="es-val">${fmtNum(e.weight ?? 0)}</span>
        <span class="es-unit">lb</span>
        <span class="tap-edit">tap to edit</span>
      </div>

      <div class="section-label" style="margin-top:14px;margin-bottom:6px;">
        <span>RPE</span>
        ${e.rpe != null ? `<button class="es-rpe-clear" data-action="edit-set-rpe-clear">Clear</button>` : ''}
      </div>
      <div class="es-rpe-grid">
        ${rpeOptions.map(v => `
          <button class="es-rpe-chip ${e.rpe === v ? 'on' : ''}" data-action="edit-set-rpe-chip" data-rpe="${v}">${v}</button>
        `).join('')}
      </div>

      <div class="section-label" style="margin-top:14px;margin-bottom:6px;">
        <span>Notes</span>
      </div>
      <textarea class="edit-set-note" data-action="edit-set-note-input" placeholder="incline 9 @ 1.5 mph, 0.12 mi" rows="2">${escapeHtml(e.note || '')}</textarea>

      <div class="edit-set-foot">
        <button class="btn danger sm" data-action="delete-logged-set"${e.saving ? ' disabled' : ''}>Delete</button>
        <button class="btn ghost sm" data-action="close-edit-set">Cancel</button>
        <button class="btn success" data-action="commit-edit-set"${e.saving ? ' disabled' : ''}>
          ${e.saving ? 'Saving…' : '✓ Save'}
        </button>
      </div>
    </div>
  `;
}

// --- Keypad ---
function renderKeypad() {
  const k = state.keypad;
  const ex = activeEx();
  const editEx = state.editSet
    ? state.session?.exercises?.find(item => item.id === state.editSet.exId)
    : null;
  const labels = {
    reps: repLabelForExercise(ex), weight: 'Weight', rest: 'Rest seconds',
    duration: 'Duration (sec)', 'cardio-min': 'Duration (min)',
    bodyweight: 'Body weight',
    'editset-weight': 'Weight',
    'editset-reps': repLabelForExercise(editEx),
    'editset-duration': 'Duration (sec)',
  };
  const units = {
    reps: repUnitForExercise(ex), weight: ex?.unit || 'lb', rest: 'sec',
    duration: 'sec', 'cardio-min': 'min',
    bodyweight: 'lb',
    'editset-weight': 'lb',
    'editset-reps': repUnitForExercise(editEx),
    'editset-duration': 'sec',
  };
  const quick = ['weight', 'editset-weight'].includes(k.target)
    ? [{ label: '+2.5', delta: 2.5 }, { label: '+1.25', delta: 1.25 }, { label: '×2', mul: 2 }, { label: '÷2', mul: 0.5 }]
    : ['reps', 'editset-reps'].includes(k.target)
      ? [{ label: '+1', delta: 1 }, { label: '+5', delta: 5 }, { label: '+10', delta: 10 }]
      : ['duration', 'editset-duration'].includes(k.target)
        ? [{ label: '+5', delta: 5 }, { label: '+15', delta: 15 }, { label: '+30', delta: 30 }, { label: '−5', delta: -5 }]
        : k.target === 'cardio-min'
          ? [{ label: '+1', delta: 1 }, { label: '+5', delta: 5 }, { label: '+10', delta: 10 }, { label: '−1', delta: -1 }]
          : k.target === 'bodyweight'
            ? [{ label: '+0.2', delta: 0.2 }, { label: '+0.5', delta: 0.5 }, { label: '−0.2', delta: -0.2 }, { label: '−0.5', delta: -0.5 }]
            : [{ label: '+30', delta: 30 }, { label: '+60', delta: 60 }, { label: '−30', delta: -30 }];
  const display = k.buffer === '' ? '0' : k.buffer;

  return `
    <div class="sheet-backdrop" data-action="close-keypad"></div>
    <div class="keypad">
      <div class="kp-readout">
        <span class="label">${labels[k.target] || 'Value'}</span>
        <span class="val">${display}</span>
        <span class="caret"></span>
        <span class="unit">${units[k.target] || ''}</span>
      </div>
      <div class="kp-quick">
        ${quick.map(c => c.mul != null
          ? `<button data-action="kp-mul" data-mul="${c.mul}">${c.label}</button>`
          : `<button data-action="kp-delta" data-delta="${c.delta}">${c.label}</button>`
        ).join('')}
        <button class="minus" data-action="kp-clear">Clear</button>
      </div>
      <div class="kp-grid">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="kp-key" data-action="kp-digit" data-digit="${n}">${n}</button>`).join('')}
        <button class="kp-key accent" data-action="kp-digit" data-digit=".">.</button>
        <button class="kp-key" data-action="kp-digit" data-digit="0">0</button>
        <button class="kp-key backspace" data-action="kp-backspace">⌫</button>
        <button class="kp-key commit" data-action="kp-commit">✓</button>
      </div>
    </div>
  `;
}

function updateRpeDom(rpe) {
  if (typeof $app === 'undefined' || !$app) return;
  const track = $app.querySelector('.rpe-track');
  const pct = rpe == null ? null : Math.max(0, Math.min(100, ((Number(rpe) - 5) / 5) * 100));
  let knob = $app.querySelector('.rpe-knob');
  if (track) {
    if (pct == null) {
      knob?.remove();
    } else {
      if (!knob) {
        knob = document.createElement('div');
        knob.className = 'rpe-knob';
        track.appendChild(knob);
      }
      knob.style.left = `${pct}%`;
    }
  }
  const label = $app.querySelector('.rpe-current');
  if (label) label.textContent = rpe == null ? '' : Number(rpe).toFixed(1);
  const clear = $app.querySelector('.rpe-clear-btn');
  if (clear) clear.style.display = rpe == null ? 'none' : '';
}

function supportItemById(id) {
  return (state.session?.supportCoaching || []).find(item => String(item.id) === String(id)) || null;
}

function supportExerciseFromItem(item) {
  const id = item.addedExerciseId || `support-ex-${Date.now().toString(36)}`;
  return {
    id,
    name: item.name,
    measurement: 'duration',
    targetSets: item.targetSets || 1,
    targetRepsLow: null,
    targetRepsHigh: null,
    targetDuration: item.targetDurationSeconds || 30,
    targetWeight: 0,
    unit: 'lb',
    sets: [],
    skipped: false,
    adhoc: true,
    block: 'prep',
    bodyweight_capable: true,
    coachNote: [item.note, ...(Array.isArray(item.cues) ? item.cues : [])].filter(Boolean).join(' '),
  };
}

function mobilityDrillById(id) {
  return currentMobilityRoutine().drills.find((d) => d.id === id)
    || MOBILITY_ROUTINE.drills.find((d) => d.id === id)
    || null;
}

function syncMobilityDrill(m, id, done) {
  if (!MOBILITY_REMOTE) return;
  const drill = mobilityDrillById(id);
  const syncSeq = ++_mobilityDrillSyncSeq;
  api.toggleMobilityDrill({
    date: m.date,
    drill_slug: id,
    completed: done,
    duration_seconds: done ? (drill?.defaultDurationSeconds || undefined) : undefined,
  })
    .then((sessionView) => {
      if (syncSeq !== _mobilityDrillSyncSeq) return null;
      applyMobilityRemoteState({ sessionView });
      scheduleMobilityMetaRefresh({ renderAfter: true });
      return null;
    })
    .catch((err) => {
      trackError('mobility.drill_sync', err);
      showToast('Mobility drill not synced');
    });
}

function setMobilityDrillDone(id, done, { source = 'checkbox', showUndo = false } = {}) {
  if (!id) return;
  const m = ensureMobilityState();
  if (done) m.done[id] = true;
  else delete m.done[id];
  m.completionTier = mobilityCompletionTier(m);
  saveMobilityLocal();
  haptic('light');
  track('mobility.drill_toggle', { drillId: id, done, source });
  syncMobilityDrill(m, id, done);
  if (done && showUndo) {
    showToast('Marked done', {
      action: 'undo-drill',
      actionLabel: 'Undo',
      drillId: id,
      durationMs: 3600,
    });
  } else {
    renderPreservingScroll();
  }
}

// ---------------------------------------------------------
// Actions
// ---------------------------------------------------------
function mobilityReturnView() {
  if (!state.session) return 'launch';
  if (state.session.completedLocally) return 'summary';
  if (state.mobilityReturnView === 'rest' && !state.rest) return 'active';
  return state.mobilityReturnView || (state.activeExerciseId ? 'active' : 'overview');
}
const actions = {
  // ---- Launch ----
  'start-todays-plan': async () => {
    const tp = currentTodaysPlan();
    if (!tp) { showToast('No plan for today'); return; }
    if (!await confirmStartNewSession('today plan start')) return;
    hapticNotify('success');
    track('launch.start_todays_plan', { planId: tp.id });
    startSession(tp);
  },
  'generate-day': async (_e, el) => {
    const dt = el.dataset.dayType;
    const plan = generateWorkout(dt);
    if (!plan) { showToast('Could not generate'); return; }
    if (!await confirmStartNewSession('generated workout start')) return;
    hapticNotify('success');
    track('launch.generate_day', { dayType: dt, exerciseCount: plan.exercises.length });
    startSession(plan);
  },
  'empty-session': async () => {
    if (!await confirmStartNewSession('empty session start')) return;
    haptic('light');
    track('launch.empty_session');
    startSession(null);
  },
  'open-browse': () => {
    state.view = 'browse';
    state.browsePlanId = null;
    haptic('light');
    track('nav.browse');
    renderPreservingScroll();
  },
  'back-to-launch': () => {
    state.view = 'launch';
    state.browsePlanId = null;
    haptic('light');
    renderPreservingScroll();
  },
  'view-saved': (_e, el) => {
    const id = el.dataset.planId;
    const plan = currentSavedPlans().find(p => String(p.id) === String(id));
    if (!plan) { showToast('Plan not found'); return; }
    state.browsePlanId = id;
    haptic('light');
    track('nav.saved_plan_detail', { planId: id, exerciseCount: plan.exercises?.length || 0 });
    renderPreservingScroll();
  },
  'back-to-browse-list': () => {
    state.browsePlanId = null;
    haptic('light');
    renderPreservingScroll();
  },
  'start-saved': async (_e, el) => {
    const id = el.dataset.planId;
    const plan = currentSavedPlans().find(p => String(p.id) === String(id));
    if (!plan) { showToast('Plan not found'); return; }
    if (!await confirmStartNewSession('saved plan start')) return;
    hapticNotify('success');
    track('launch.start_saved', { planId: id });
    startSession(plan);
  },
  'open-cardio-only': async () => {
    // Cardio-only session: start an empty session, then immediately open
    // the cardio sheet in 'launch' mode so the first block is logged.
    if (!await confirmStartNewSession('cardio-only start')) return;
    haptic('light');
    track('launch.cardio_only');
    startSession({ dayName: 'Cardio session', dayType: null, source: 'cardio-only' });
    state.cardioSheet = { mode: 'launch', phase: 'cardio', activityId: '', durationMin: 0, note: '' };
    _cardioSheetJustOpened = true;
    renderPreservingScroll();
  },

  // ---- Daily Mobility (habit checklist) ----
  'open-mobility': () => {
    const m = ensureMobilityState();
    if (state.view !== 'mobility') state.mobilityReturnView = state.view;
    state.view = 'mobility';
    haptic('light');
    track('mobility.open', { date: m.date, completed: !!m.completedAt, streak: m.streak || 0 });
    trackMobilityCatalogShown('open');
    renderPreservingScroll();
    refreshMobilityRemote({ renderAfter: true, silent: true });
  },
  'close-mobility': () => { state.view = mobilityReturnView(); haptic('light'); renderPreservingScroll(); },
  'mobility-home': () => { state.view = mobilityReturnView(); haptic('light'); renderPreservingScroll(); },
  'toggle-drill': (_e, el) => {
    const id = el.dataset.drillId;
    if (!id) return;
    const m = ensureMobilityState();
    const done = !m.done[id];
    setMobilityDrillDone(id, done, { source: 'checkbox', showUndo: done });
  },
  'undo-drill': (_e, el) => {
    const id = el.dataset.drillId || state.toast?.drillId;
    clearToast();
    setMobilityDrillDone(id, false, { source: 'undo' });
  },
  'set-knee-pain': (_e, el) => setMobilityScore('kneePain', el),
  'set-hip-stiffness': (_e, el) => setMobilityScore('hipStiffness', el),
  'complete-mobility': async () => {
    const m = ensureMobilityState();
    const routine = currentMobilityRoutine();
    const total = routine.drills.length;
    const done = drillsDoneCount(m);
    const coreDone = coreDrillsDoneCount(m, routine.drills);
    const availableCore = routine.drills.filter((d) => d.isCore !== false).length || MOBILITY_CORE_TARGET;
    const coreTotal = Math.min(MOBILITY_CORE_TARGET, availableCore);
    const coreMinutes = mobilityCoreMinutes(m, routine.drills);
    const tier = mobilityCompletionTier(m, routine.drills);
    if (tier === 'incomplete') {
      showToast('Log a score and finish 4 core drills first');
      hapticNotify('error');
      return;
    }
    const todayKey = mobilityTodayKey();
    const streak = nextMobilityStreak({
      prevStreak: m.streak || 0,
      lastCompletedDate: m.lastCompletedDate,
      todayKey,
      yesterdayKey: mobilityYesterdayKey(),
    });
    const points = mobilityPoints({
      coreDrillsDone: coreDone,
      coreMinutes,
      totalCoreDrills: coreTotal,
      kneePain: m.kneePain,
      hipStiffness: m.hipStiffness,
    });
    m.completedAt = new Date().toISOString();
    m.completionTier = tier;
    m.streak = streak;
    m.lastCompletedDate = todayKey;
    m.pointsEarned = points;
    saveMobilityLocal();
    hapticNotify('success');
    track('mobility.complete', { drillsDone: done, total, kneePain: m.kneePain, hipStiffness: m.hipStiffness, streak, points });
    await flushTelemetry();
    renderPreservingScroll();
    if (MOBILITY_REMOTE) {
      try {
        let sessionView = await api.saveMobilityCheckin({
          date: todayKey,
          knee_pain_score: m.kneePain,
          hip_groin_stiffness_score: m.hipStiffness,
          notes: 'miniapp',
        });
        for (const drill of routine.drills) {
          if (!m.done[drill.id]) continue;
          sessionView = await api.toggleMobilityDrill({
            date: todayKey,
            drill_slug: drill.id,
            completed: true,
            duration_seconds: drill.defaultDurationSeconds || undefined,
          });
        }
        applyMobilityRemoteState({ sessionView });
        cancelScheduledMobilityMetaRefresh();
        await refreshMobilityMeta({ renderAfter: true });
      } catch (err) {
        trackError('mobility.persist', err);
        showToast('Mobility check-in not synced to server');
      }
    }
  },
  'adjust-mobility': () => {
    const m = ensureMobilityState();
    m.completedAt = null;
    saveMobilityLocal();
    haptic('light');
    track('mobility.adjust');
    renderPreservingScroll();
  },
  'redeem-mobility-reward': async (_e, el) => {
    const rewardId = Number(el.dataset.rewardId);
    if (!Number.isFinite(rewardId) || rewardId <= 0) return;
    const m = ensureMobilityState();
    const reward = (m.rewards || []).find((r) => Number(r.id) === rewardId);
    if (!reward) {
      showToast('Reward not found');
      return;
    }
    const cost = Number(reward.cost_points || 0);
    if (Number(m.pointsBalance || 0) < cost) {
      showToast(`${Math.max(0, cost - Number(m.pointsBalance || 0))} pts to go`);
      return;
    }
    const ok = await new Promise((resolve) => {
      const msg = `Redeem ${reward.title} for ${cost} pts?`;
      if (tg?.showConfirm) tg.showConfirm(msg, (confirmed) => resolve(!!confirmed));
      else resolve(window.confirm(msg));
    });
    if (!ok) return;
    state.mobilityRewardRedeemingId = rewardId;
    haptic('light');
    track('mobility.reward_redeem_attempt', { rewardId, title: reward.title, cost, balance: m.pointsBalance || 0 });
    renderPreservingScroll();
    if (!MOBILITY_REMOTE) {
      state.mobilityRewardRedeemingId = null;
      showToast('Reward redemption needs server sync');
      return;
    }
    try {
      const result = await api.redeemMobilityReward(rewardId);
      const rewardsData = await api.mobilityRewards();
      applyMobilityRemoteState({ rewardsData });
      state.mobilityRewardRedeemingId = null;
      hapticNotify('success');
      track('mobility.reward_redeem_success', {
        rewardId,
        redemptionId: result?.redemptionId || null,
        balance: result?.balance ?? state.mobility?.pointsBalance ?? null,
      });
      await flushTelemetry();
      showToast('Reward redeemed');
      renderPreservingScroll();
    } catch (err) {
      state.mobilityRewardRedeemingId = null;
      track('mobility.reward_redeem_failed', { rewardId, message: err?.message || String(err) });
      await flushTelemetry();
      trackError('mobility.reward_redeem', err);
      showToast(err?.message || 'Reward redemption failed');
      renderPreservingScroll();
    }
  },

  // ---- Session controls ----
  'retry-sync': () => {
    retryPendingIfResumed('manual');
    renderPreservingScroll();
  },
  'end-session': async () => {
    if (setsDone() === 0 && !confirm('End session with no sets logged?')) return;
    clearRestTicker();
    state.view = 'summary';
    state.session.completedLocally = true;
    state.session.completionPending = true;
    seedSummaryWeighInPrompt();
    hapticNotify('success');
    track('session.end', {
      elapsedSec: elapsedSec(),
      setsDone: setsDone(),
      exercisesDone: exercisesDone(),
      cardioBlocks: state.session.cardioBlocks?.length || 0,
    });
    renderPreservingScroll();
    await retryPendingIfResumed('finish');
    // Final telemetry flush — catches anything still batched client-side.
    try { await flushTelemetry(); } catch (_) {}
  },
  'pause': () => {
    state.session.pausedAt = Date.now();
    if (state.rest) state.rest.remainingAtPause = Math.max(0, state.rest.endsAt - Date.now());
    pauseRunningWorkTimer();
    clearRestTicker();
    state.view = 'paused';
    haptic('light'); track('session.pause'); renderPreservingScroll();
  },
  'resume': () => {
    if (state.session.pausedAt) {
      state.session.accumulatedPaused += Date.now() - state.session.pausedAt;
      state.session.pausedAt = null;
    }
    if (state.rest?.remainingAtPause != null) {
      state.rest.endsAt = Date.now() + state.rest.remainingAtPause;
      delete state.rest.remainingAtPause;
      startRestTicker();
      state.view = 'rest';
    } else {
      state.view = state.activeExerciseId ? 'active' : 'overview';
    }
    haptic('light'); track('session.resume'); renderPreservingScroll();
  },

  'back-to-overview': () => { state.view = 'overview'; renderPreservingScroll(); },
  'back-to-active':   () => { state.view = 'active'; renderPreservingScroll(); },

  'toggle-coach-note': (_e, el) => {
    const id = el.dataset.exId;
    if (!id) return;
    if (!state._expandedCoachNotes) state._expandedCoachNotes = {};
    state._expandedCoachNotes[id] = !state._expandedCoachNotes[id];
    haptic('light');
    renderPreservingScroll();
  },

  'open-media': (_e, el) => {
    const id = el.dataset.exId;
    const source = el.dataset.mediaSource || 'session';
    const ex = source === 'mobility'
      ? (currentMobilityRoutine().drills || []).find(d => d.id === id)
      : state.session?.exercises?.find(x => x.id === id);
    if (!ex?.media) return;
    state.mediaSheet = { exId: id, choiceIdx: 0, source };
    _mediaSheetJustOpened = true;
    haptic('light');
    track('exercise.media_open', {
      exercise: ex.name,
      exId: id,
      source,
      provider: ex.media.provider,
      mediaType: ex.media.mediaType,
      matchQuality: ex.media.matchQuality,
    });
    renderPreservingScroll();
  },
  'close-media': () => { state.mediaSheet = null; renderPreservingScroll(); },
  'select-media-source': (_e, el) => {
    if (!state.mediaSheet) return;
    const choiceIdx = Number(el.dataset.choiceIdx);
    if (!Number.isFinite(choiceIdx)) return;
    state.mediaSheet.choiceIdx = choiceIdx;
    haptic('light');
    track('exercise.media_select', { exId: state.mediaSheet.exId, choiceIdx });
    renderPreservingScroll();
  },

  'jump-to-exercise': (_e, el) => {
    const id = el.dataset.exId;
    const ex = state.session.exercises.find(x => x.id === id);
    if (!ex) return;
    if (state.activeExerciseId !== id) pauseRunningWorkTimer();
    reanchorGroupOrderForManualJump(ex);
    state.activeExerciseId = id;
    state.draft = draftFor(ex);
    state.switcher = false;
    state.view = 'active';
    clearRestTicker();
    state.rest = null;
    haptic('light');
    track('exercise.jump', { exercise: ex.name, exId: id, setNum: ex.sets.length + 1 });
    renderPreservingScroll();
  },

  'open-switcher':  () => { state.switcher = true; state._switcherSearch = ''; _sheetJustOpened = true; track('switcher.open'); renderPreservingScroll(); },
  'close-switcher': () => { state.switcher = false; renderPreservingScroll(); },
  'switcher-search': (_e, el) => { state._switcherSearch = el.value; renderPreservingScroll(); },

  'add-from-kb': (_e, el) => {
    const id = el.dataset.kbId;
    // Try KB first (full defaults), fall back to adhocCandidates (sparse)
    const kb = currentExerciseKb().find(e => e.id === id);
    if (kb) {
      const isTimed = kb.measurement === 'duration';
      state.session.exercises.push({
        id: kb.id, name: kb.name, measurement: kb.measurement,
        targetSets: kb.defaults.sets,
        targetRepsLow: isTimed ? null : kb.defaults.repsLow,
        targetRepsHigh: isTimed ? null : kb.defaults.repsHigh,
        targetDuration: isTimed ? kb.defaults.durationSeconds : null,
        targetWeight: kb.defaults.weight,
        unit: 'lb',
        sets: [], skipped: false, adhoc: true,
        bilateral: kb.bilateral,
        bodyweight_capable: !!kb.bodyweight_capable,
        canonicalKey: kb.canonicalKey,
        media: kb.media || null,
      });
      track('exercise.add_from_kb', { exercise: kb.name, exId: kb.id, measurement: kb.measurement });
      actions['jump-to-exercise'](null, { dataset: { exId: kb.id } });
      showToast(`Added ${kb.name}`);
      return;
    }
    const cand = adhocCandidates.find(c => c.id === id);
    if (!cand) return;
    state.session.exercises.push({
      id: cand.id, name: cand.name, measurement: 'reps',
      targetSets: 3, targetRepsLow: 10, targetRepsHigh: 12,
      targetWeight: 0, unit: 'lb',
      sets: [], skipped: false, adhoc: true,
    });
    track('exercise.add_adhoc', { exercise: cand.name, exId: cand.id });
    actions['jump-to-exercise'](null, { dataset: { exId: cand.id } });
    showToast(`Added ${cand.name}`);
  },
  'create-new': (_e, el) => {
    const name = (el.dataset.name || '').trim() || `Custom ${Date.now().toString(36)}`;
    const id = 'custom-' + Date.now();
    state.session.exercises.push({
      id, name, measurement: 'reps',
      targetSets: 3, targetRepsLow: 8, targetRepsHigh: 12,
      targetWeight: 0, unit: 'lb',
      sets: [], skipped: false, adhoc: true,
    });
    track('exercise.create_new', { exercise: name, exId: id });
    actions['jump-to-exercise'](null, { dataset: { exId: id } });
    showToast(`Created ${name}`);
  },

  // ---- Set editing ----
  'inc-reps': () => { state.draft.reps = (state.draft.reps || 0) + 1; haptic('light'); renderPreservingScroll(); },
  'dec-reps': () => { state.draft.reps = Math.max(0, (state.draft.reps || 0) - 1); haptic('light'); renderPreservingScroll(); },
  'edit-reps': () => {
    state.keypad = { target: 'reps', buffer: String(state.draft.reps ?? ''), fresh: true };
    _keypadJustOpened = true;
    track('keypad.open', keypadTelemetryContext('reps'));
    renderPreservingScroll();
  },
  'edit-weight': () => {
    state.keypad = { target: 'weight', buffer: String(state.draft.weight ?? ''), fresh: true };
    _keypadJustOpened = true;
    track('keypad.open', keypadTelemetryContext('weight'));
    renderPreservingScroll();
  },

  // Duration mode (for timed exercises like weighted plank)
  'inc-duration': () => {
    state.draft.durationSeconds = (state.draft.durationSeconds || 0) + 5;
    syncWorkTimerDurationToDraft();
    haptic('light');
    renderPreservingScroll();
  },
  'dec-duration': () => {
    state.draft.durationSeconds = Math.max(0, (state.draft.durationSeconds || 0) - 5);
    syncWorkTimerDurationToDraft();
    haptic('light');
    renderPreservingScroll();
  },
  'edit-duration': () => {
    state.keypad = { target: 'duration', buffer: String(state.draft.durationSeconds ?? ''), fresh: true };
    _keypadJustOpened = true;
    track('keypad.open', keypadTelemetryContext('duration'));
    renderPreservingScroll();
  },
  'toggle-work-timer': () => {
    const ex = activeEx();
    if (!ex || ex.measurement !== 'duration') return;
    let timer = getActiveWorkTimer(ex);
    if (!timer || timer.done) {
      timer = createWorkTimer(ex);
      state.workTimer = timer;
    }
    if (timer.running) {
      timer.remaining = workTimerRemaining(timer);
      timer.running = false;
      timer.endsAt = null;
      clearWorkTimerTicker();
      track('work_timer.pause', { exercise: ex.name, exId: ex.id, setNum: timer.setNum, segment: timer.segmentIndex + 1, remaining: timer.remaining });
      haptic('light');
      renderPreservingScroll();
      return;
    }
    const remaining = Math.max(1, Math.round(timer.remaining || timer.duration || state.draft.durationSeconds || ex.targetDuration || 30));
    timer.remaining = remaining;
    timer.endsAt = Date.now() + remaining * 1000;
    timer.running = true;
    timer.started = true;
    timer.done = false;
    track('work_timer.start', { exercise: ex.name, exId: ex.id, setNum: timer.setNum, segment: timer.segmentIndex + 1, duration: timer.duration, remaining });
    haptic('light');
    startWorkTimerTicker();
    renderPreservingScroll();
  },
  'reset-work-timer': () => {
    const ex = activeEx();
    if (!ex || ex.measurement !== 'duration') return;
    state.workTimer = createWorkTimer(ex);
    clearWorkTimerTicker();
    haptic('light');
    track('work_timer.reset', { exercise: ex.name, exId: ex.id, setNum: state.workTimer.setNum, duration: state.workTimer.duration, segments: state.workTimer.segments });
    renderPreservingScroll();
  },

  // Bodyweight/assistance 3-way toggle
  'set-assistance': (_e, el) => {
    const mode = el.dataset.mode;
    if (!['added', 'pure_bw', 'assisted'].includes(mode)) return;
    state.draft.assistanceMode = mode;
    // Pure BW zeroes out the weight field; switching to added/assisted keeps it
    if (mode === 'pure_bw') state.draft.weight = 0;
    haptic('light');
    track('set.assistance_toggle', { mode, exercise: activeEx()?.name });
    renderPreservingScroll();
  },
  'set-note-input': (_e, el) => {
    if (!state.draft) return;
    state.draft.note = el.value;
  },

  // Rotating slot: tap a variant chip to override the round-robin default
  // for this round. variantIndex lives on draft so it persists across
  // re-renders; complete-set stamps it onto the logged set.
  'set-variant': (_e, el) => {
    const idx = parseInt(el.dataset.idx, 10);
    if (!Number.isInteger(idx) || !state.draft) return;
    const ex = activeEx();
    if (!isRotateSlot(ex)) return;
    if (idx < 0 || idx >= ex.variants.length) return;
    state.draft.variantIndex = idx;
    haptic('light');
    track('rotate.variant_picked', {
      slot: ex.id,
      variant: ex.variants[idx]?.name,
      round: ex.sets.length + 1,
      wasDefault: idx === defaultVariantIndex(ex),
    });
    renderPreservingScroll();
  },

  // Supersets — open the multi-pick link sheet (2-5 exercises).
  // mode='new': anchor = current exercise (locked).
  // mode='grow': anchor = all existing group members (locked).
  'open-link-sheet': (_e, el) => {
    const ex = activeEx();
    if (!ex) return;
    const mode = el.dataset.mode === 'grow' ? 'grow' : 'new';
    const lockedIds = mode === 'grow' && ex.supersetGroup
      ? [...groupMembers(ex.supersetGroup)]
      : [ex.id];
    state.linkSheet = { mode, anchorId: ex.id, lockedIds, memberIds: [] };
    _linkSheetJustOpened = true;
    track('superset.open-link-sheet', { mode, lockedCount: lockedIds.length });
    renderPreservingScroll();
  },
  'close-link-sheet': () => {
    state.linkSheet = null;
    renderPreservingScroll();
  },
  'toggle-link-member': (_e, el) => {
    const ls = state.linkSheet;
    if (!ls) return;
    const exId = el.dataset.exId;
    if (!exId) return;
    // Locked members can't be toggled off.
    if ((ls.lockedIds || []).includes(exId)) return;
    const idx = ls.memberIds.indexOf(exId);
    if (idx >= 0) ls.memberIds.splice(idx, 1);
    else {
      // Enforce cap (locked + user-selected <= 5) before adding.
      const totalIfAdded = (ls.lockedIds || []).length + ls.memberIds.length + 1;
      if (totalIfAdded > 5) { showToast('Max 5 exercises'); return; }
      ls.memberIds.push(exId);
    }
    haptic('light');
    renderPreservingSelectorScroll(['.link-list']);
  },
  'confirm-link': () => {
    const ls = state.linkSheet;
    if (!ls) return;
    const allIds = [...(ls.lockedIds || []), ...(ls.memberIds || [])];
    if (allIds.length < 2 || allIds.length > 5) return;

    const members = allIds
      .map(id => state.session.exercises.find(e => e.id === id))
      .filter(Boolean);
    if (members.length < 2) return;

    let group, label, isGrow;
    if (ls.mode === 'grow' && members[0].supersetGroup) {
      // Extend existing group: reuse its letter, refresh members + label.
      isGrow = true;
      group = members[0].supersetGroup;
      const existingLabel = groupLabel(group);
      // Detect auto-generated "name + name" labels (from prior ad-hoc link)
      // so they refresh when the roster grows. Plan-authored labels like
      // "Core" or user-edited ones don't match the old-members join pattern
      // and are preserved.
      const oldMembers = (ls.lockedIds || [])
        .map(id => state.session.exercises.find(e => e.id === id))
        .filter(Boolean);
      const oldAutoLabel = oldMembers.map(m => m.name).join(' + ').slice(0, 80);
      const isStaleAutoLabel = existingLabel && existingLabel === oldAutoLabel;
      label = (existingLabel && !isStaleAutoLabel)
        ? existingLabel
        : members.map(m => m.name).join(' + ').slice(0, 80);
    } else {
      isGrow = false;
      group = state.session.nextSupersetLetter || 'A';
      state.session.nextSupersetLetter = String.fromCharCode(group.charCodeAt(0) + 1);
      // Ad-hoc groups get a "name + name + …" label; keeps summary labelled.
      label = members.map(m => m.name).join(' + ').slice(0, 80);
    }

    // Cross-group migration: any member that already belongs to a DIFFERENT
    // group needs to be removed from that group BEFORE we stamp the new
    // membership. This is what makes "link incline + curl" work even when
    // curl was pre-grouped in the planner's Arm Finisher — the user's
    // intent is "I'm reorganizing on the fly," and the link sheet showed
    // that exercise with a "will move" hint, so we honor it.
    //
    // For each old group that loses a member:
    //   - if it still has 2+ members afterward → upsert via createSuperset
    //     so the server-side supersets row reflects the new (smaller) list
    //   - if it shrinks to <2 → dissolve locally (drop from session maps,
    //     unset .supersetGroup on the lone remaining member). The server-
    //     side row is left alone, matching how `unlink-superset` behaves
    //     (no DELETE endpoint yet; tracked as a future cleanup).
    const oldGroupTouched = new Map(); // groupKey -> Set of memberIds being removed
    for (const m of members) {
      if (m.supersetGroup && m.supersetGroup !== group) {
        if (!oldGroupTouched.has(m.supersetGroup)) {
          oldGroupTouched.set(m.supersetGroup, new Set());
        }
        oldGroupTouched.get(m.supersetGroup).add(m.id);
      }
    }
    const migratedFrom = []; // for the toast / telemetry
    for (const [oldGroup, removedIds] of oldGroupTouched) {
      const oldList = state.session.supersetGroups[oldGroup] || [];
      const survivors = oldList.filter(id => !removedIds.has(id));
      migratedFrom.push({ group: oldGroup, removed: [...removedIds], survivorCount: survivors.length });
      if (survivors.length >= 2) {
        // Old group still valid — refresh its membership server + client side.
        state.session.supersetGroups[oldGroup] = survivors;
        state.session.supersetOrders[oldGroup] = groupOrder(oldGroup).filter(id => survivors.includes(id));
        const newKind = survivors.length >= 3 ? 'circuit' : 'superset';
        state.session.supersetKinds[oldGroup] = newKind;
        const survivorNames = survivors
          .map(id => state.session.exercises.find(e => e.id === id)?.name)
          .filter(Boolean);
        const updatePayload = {
          superset_group: oldGroup,
          exercises: survivorNames,
          kind: newKind,
          label: state.session.supersetLabels[oldGroup] || survivorNames.join(' + ').slice(0, 80),
        };
        persistSupersetWrite(updatePayload);
      } else {
        // Old group dissolves: 0 or 1 survivor left.
        for (const id of oldList) {
          const e = state.session.exercises.find(x => x.id === id);
          if (e && removedIds.has(e.id) === false) {
            // Lone survivor — clear its group affiliation locally.
            delete e.supersetGroup;
          }
        }
        delete state.session.supersetGroups[oldGroup];
        delete state.session.supersetKinds?.[oldGroup];
        delete state.session.supersetLabels?.[oldGroup];
        delete state.session.supersetOrders?.[oldGroup];
      }
    }

    // Kind auto-classified from final size. 3+ = circuit, 2 = superset.
    const kind = members.length >= 3 ? 'circuit' : 'superset';

    // Stamp group on every member; update session maps. (For grow mode the
    // mutation is idempotent — members[0] is already in `group`.)
    for (const m of members) m.supersetGroup = group;
    state.session.supersetGroups[group] = members.map(m => m.id);
    state.session.supersetOrders[group] = members.map(m => m.id);
    state.session.supersetKinds[group] = kind;
    state.session.supersetLabels[group] = label;

    // Persist the payload before transport; server upserts session+group idempotently.
    const payload = {
      superset_group: group,
      exercises: members.map(m => m.name),
      kind,
      label,
    };
    track(isGrow ? 'superset.grow' : 'superset.link', {
      group, kind, count: members.length, exercises: members.map(m => m.id),
      migratedFrom: migratedFrom.length ? migratedFrom : undefined,
    });
    persistSupersetWrite(payload);
    state.linkSheet = null;
    const baseToast = isGrow
      ? `Group now ${members.length}`
      : `${kind[0].toUpperCase()}${kind.slice(1)} of ${members.length} linked`;
    showToast(migratedFrom.length ? `${baseToast} · regrouped` : baseToast);
    hapticNotify('success');
    renderPreservingScroll();
  },
  'unlink-superset': () => {
    const ex = activeEx();
    if (!ex?.supersetGroup) return;
    const group = ex.supersetGroup;
    const members = state.session.supersetGroups[group] || [];
    for (const id of members) {
      const e = state.session.exercises.find(x => x.id === id);
      if (e) delete e.supersetGroup;
    }
    delete state.session.supersetGroups[group];
    delete state.session.supersetKinds?.[group];
    delete state.session.supersetLabels?.[group];
    delete state.session.supersetOrders?.[group];
    track('superset.unlink', { group });
    showToast(`Unlinked ${group}`);
    haptic('light');
    renderPreservingScroll();
  },

  'add-plate': (_e, el) => {
    const amt = parseFloat(el.dataset.amount);
    state.draft.weight = Math.max(0, Math.round(((state.draft.weight || 0) + amt) * 100) / 100);
    track('weight.adjust', { exercise: activeEx()?.name, amount: amt, weight: state.draft.weight });
    haptic('light'); renderPreservingScroll();
  },
  'clear-weight': () => {
    state.draft.weight = 0;
    track('weight.clear', { exercise: activeEx()?.name });
    haptic('light');
    renderPreservingScroll();
  },

  // 'set-rpe' removed Apr 2026 — superseded by the pointerdown handler in
  // bind() so taps register on the first touch and slides track smoothly.
  'clear-rpe': () => {
    state.draft.rpe = null;
    updateRpeDom(null);
    saveSessionLocal();
  },

  'complete-set': async () => {
    const ex = activeEx();
    if (!ex) return;
    const isTimed = ex.measurement === 'duration';
    if (isTimed) {
      if (!state.draft.durationSeconds || state.draft.durationSeconds <= 0) {
        showToast('Need a duration'); return;
      }
      const activeTimer = getActiveWorkTimer(ex);
      if (activeTimer?.running) {
        showToast('Timer still running');
        return;
      }
      if (workTimerWasStarted(activeTimer) && !activeTimer.done) {
        showToast(activeTimer.segments > 1 ? 'Finish both timer rounds' : 'Timer not finished');
        return;
      }
    } else {
      if (!state.draft.reps || state.draft.reps <= 0) { showToast('Need at least 1 rep'); return; }
    }
    // For 'assisted' mode the weight input represents pounds of assistance,
    // not load — capture it under a distinct field and clear `weight` so the
    // local replay/summary logic reads zero (the user did bodyweight minus
    // assistance, no positive load).
    const draftMode = state.draft.assistanceMode || null;
    const draftWeight = state.draft.weight == null ? 0 : Number(state.draft.weight);
    const isAssistedMode = ex.bodyweight_capable && draftMode === 'assisted';
    const shouldClearWorkTimer = workTimerMatches(state.workTimer, ex);
    const loggedSet = {
      clientSetId: nextClientSetId(),
      reps: isTimed ? null : state.draft.reps,
      durationSeconds: isTimed ? state.draft.durationSeconds : null,
      weight: isAssistedMode ? 0 : draftWeight,
      assistanceLbs: isAssistedMode ? draftWeight : null,
      rpe: state.draft.rpe,
      note: cleanUserNote(state.draft.note),
      assistanceMode: draftMode,
      loggedAt: Date.now(),
      // Rotating slot: remember which variant this round actually used
      // so the summary chip can display "Flutter 30 @ 8.0" not the slot.
      variantIndex: isRotateSlot(ex) ? (state.draft.variantIndex ?? defaultVariantIndex(ex)) : null,
    };
    ex.sets.push(loggedSet);
    if (shouldClearWorkTimer) {
      state.workTimer = null;
      clearWorkTimerTicker();
    }
    hapticNotify('success');
    track('set.complete', {
      exercise: ex.name,
      exId: ex.id,
      setNum: ex.sets.length,
      reps: loggedSet.reps,
      durationSeconds: loggedSet.durationSeconds,
      weight: loggedSet.weight,
      rpe: loggedSet.rpe,
      hasNote: !!loggedSet.note,
      assistanceMode: loggedSet.assistanceMode,
      supersetGroup: ex.supersetGroup || null,
    });

    // Capture for payload before UI transitions mutate state
    const exForPayload = ex;
    const justFinished = ex.sets.length >= ex.targetSets;

    // Group-aware "done" check: a circuit/superset isn't actually done just
    // because THIS slot hit its targetSets — sibling slots may still owe
    // sets in a later round. Only kick to overview when EVERY member of
    // the group has reached its target (or was explicitly skipped).
    const groupExs = ex.supersetGroup ? orderedGroupExercises(ex.supersetGroup) : null;
    const groupFullyDone = groupExs
      ? groupExs.every(m => m.sets.length >= m.targetSets || m.skipped)
      : justFinished;
    const roundJustCompleted = ex.sets.length;
    const nextInRound = groupExs
      ? orderedPendingAfter(
          ex.supersetGroup,
          ex.id,
          m => !m.skipped && m.sets.length < roundJustCompleted && m.sets.length < m.targetSets
        )
      : null;

    if (groupFullyDone) {
      // Whole group done (or non-grouped exercise reached its target) — out
      // to overview. Don't auto-jump to summary when the last strength
      // exercise finishes; the user still needs space to add cooldown
      // cardio, log body weight, etc. They'll hit "End" explicitly when
      // ready. A distinct toast signals the milestone.
      state.activeExerciseId = null;
      state.draft = null;
      state.view = 'overview';
      if (exercisesDone() === state.session.exercises.length) {
        showToast('Strength done · add cooldown or tap End');
      } else {
        showToast(`${ex.name} complete`);
      }
    } else if (nextInRound) {
      // Mid-round rotation: follow the mutable group order, but only through
      // members that still owe the round just completed. Manual top-menu
      // jumps update that order, so linked work can follow the user instead
      // of dictating a fixed plan order.
      track('superset.jump_partner', { from: ex.id, to: nextInRound.id, group: ex.supersetGroup });
      state.activeExerciseId = nextInRound.id;
      state.draft = draftFor(nextInRound);
      state.view = 'active';
    } else if (groupExs) {
      // End of a circuit/superset round. Re-anchor activeExerciseId to the
      // first not-done member in the learned order for the next round, then
      // rest. This is what makes round 2 preserve a manual round-1 order like
      // plank → ab wheel → wood choppers.
      const candidates = groupExs.filter(m => !m.skipped && m.sets.length < m.targetSets);
      const minSets = candidates.length ? Math.min(...candidates.map(m => m.sets.length)) : null;
      const nextSlot = candidates.find(m => m.sets.length === minSets) || null;
      if (nextSlot && nextSlot.id !== ex.id) {
        track('superset.round_reanchor', { from: ex.id, to: nextSlot.id, group: ex.supersetGroup });
        state.activeExerciseId = nextSlot.id;
        state.draft = draftFor(nextSlot);
      }
      startRest(DEFAULT_REST_SECONDS);
    } else {
      startRest(DEFAULT_REST_SECONDS);
    }
    renderPreservingScroll();

    // Persist (async, fire-and-forget from the UI's perspective)
    await persistSet(exForPayload, loggedSet);
  },

  'skip-set': () => {
    const ex = activeEx();
    if (!ex) return;
    if (ex.sets.length === 0) ex.skipped = true;
    track('set.skip', { exercise: ex.name, exId: ex.id, hadSets: ex.sets.length });
    state.activeExerciseId = null;
    state.draft = null;
    state.view = 'overview';
    renderPreservingScroll();
  },

  // ---- Rest ----
  'rest-adjust': (_e, el) => {
    if (!state.rest) return;
    const delta = parseInt(el.dataset.delta, 10);
    state.rest.endsAt += delta * 1000;
    state.rest.duration = Math.max(0, state.rest.duration + delta);
    haptic('light');
    track('rest.adjust', { delta });
    renderPreservingScroll();
  },
  'skip-rest': () => {
    clearRestTicker();
    track('rest.skip');
    state.rest = null;
    const ex = activeEx();
    if (ex) state.draft = draftFor(ex);
    state.view = 'active';
    renderPreservingScroll();
  },
  'edit-rest': () => {
    if (!state.rest) return;
    const remaining = Math.max(0, Math.floor((state.rest.endsAt - Date.now()) / 1000));
    state.keypad = { target: 'rest', buffer: String(remaining), fresh: true };
    _keypadJustOpened = true;
    track('keypad.open', keypadTelemetryContext('rest'));
    renderPreservingScroll();
  },

  // ---- Keypad ----
  // These use partial updates (updateKeypadBuffer) instead of full render
  // so the panel doesn't replay its slide-up animation on every tap.
  'kp-digit': (_e, el) => {
    const d = el.dataset.digit;
    const k = state.keypad;
    if (k.fresh) { k.buffer = ''; k.fresh = false; }
    if (d === '.') {
      if (k.buffer.includes('.')) return;
      k.buffer = k.buffer === '' ? '0.' : k.buffer + '.';
    } else if (k.buffer === '0') {
      k.buffer = d;
    } else {
      k.buffer += d;
    }
    haptic('light'); updateKeypadBuffer();
  },
  'kp-delta': (_e, el) => {
    const k = state.keypad;
    const curr = parseFloat(k.buffer) || 0;
    k.buffer = String(Math.max(0, Math.round((curr + parseFloat(el.dataset.delta)) * 100) / 100));
    k.fresh = false;
    haptic('light'); updateKeypadBuffer();
  },
  'kp-mul': (_e, el) => {
    const k = state.keypad;
    const curr = parseFloat(k.buffer) || 0;
    k.buffer = String(Math.round(curr * parseFloat(el.dataset.mul) * 100) / 100);
    k.fresh = false;
    haptic('light'); updateKeypadBuffer();
  },
  'kp-clear': () => { state.keypad.buffer = ''; state.keypad.fresh = false; haptic('light'); updateKeypadBuffer(); },
  'kp-backspace': () => {
    const k = state.keypad;
    if (!k) return;
    if (k.fresh) {
      k.buffer = '';
      k.fresh = false;
    } else {
      k.buffer = String(k.buffer || '').slice(0, -1);
    }
    haptic('light');
    updateKeypadBuffer();
  },
  'kp-commit': () => {
    const k = state.keypad;
    const v = parseFloat(k.buffer);
    if (Number.isNaN(v) || v < 0) { showToast('Invalid value'); state.keypad = null; renderPreservingScroll(); return; }
    if (k.target === 'reps') state.draft.reps = Math.round(v);
    else if (k.target === 'weight') state.draft.weight = v;
    else if (k.target === 'duration') {
      state.draft.durationSeconds = Math.round(v);
      syncWorkTimerDurationToDraft();
    }
    else if (k.target === 'cardio-min' && state.cardioSheet) state.cardioSheet.durationMin = Math.round(v * 2) / 2;
    else if (k.target === 'bodyweight' && state.weighIn) state.weighIn.weight = Math.round(v * 10) / 10;
    // Edit-set sheet: keypad commits write back into state.editSet so the
    // sheet re-renders with the new value and Save sends them to the server.
    else if (k.target === 'editset-weight' && state.editSet) state.editSet.weight = v;
    else if (k.target === 'editset-reps' && state.editSet) state.editSet.reps = Math.round(v);
    else if (k.target === 'editset-duration' && state.editSet) state.editSet.durationSeconds = Math.round(v);
    else if (k.target === 'rest' && state.rest) {
      state.rest.endsAt = Date.now() + v * 1000;
      state.rest.duration = v;
    }
    track('keypad.commit', { ...keypadTelemetryContext(k.target), value: v });
    state.keypad = null;
    hapticNotify('success');
    renderPreservingScroll();
  },
  'close-keypad': () => { state.keypad = null; renderPreservingScroll(); },

  // ---- Cardio sheet ----
  'open-cardio-inline': () => {
    state.cardioSheet = { mode: 'inline', phase: 'cardio', activityId: '', durationMin: 0, note: '' };
    _cardioSheetJustOpened = true;
    track('cardio.sheet_open', { mode: 'inline' });
    haptic('light');
    renderPreservingScroll();
  },
  'log-support-cardio': (_e, el) => {
    const item = supportItemById(el.dataset.supportId);
    if (!item) return;
    state.cardioSheet = {
      mode: 'inline',
      phase: item.phase || 'warmup',
      activityId: item.activityId || 'treadmill',
      durationMin: item.durationMin || 3,
      note: item.note || item.name,
      supportId: item.id,
    };
    _cardioSheetJustOpened = true;
    track('support.cardio_open', { supportId: item.id, name: item.name });
    haptic('light');
    renderPreservingScroll();
  },
  'add-support-exercise': (_e, el) => {
    const item = supportItemById(el.dataset.supportId);
    if (!item || !state.session) return;
    if (item.addedExerciseId) {
      actions['jump-to-exercise'](null, { dataset: { exId: item.addedExerciseId } });
      return;
    }
    const ex = supportExerciseFromItem(item);
    item.addedExerciseId = ex.id;
    state.session.exercises.unshift(ex);
    track('support.exercise_add', { supportId: item.id, exercise: item.name, exId: ex.id });
    actions['jump-to-exercise'](null, { dataset: { exId: ex.id } });
    showToast(`Added ${item.name}`);
  },
  'close-cardio': () => { state.cardioSheet = null; renderPreservingScroll(); },
  'set-cardio-phase': (_e, el) => {
    if (!state.cardioSheet) return;
    state.cardioSheet.phase = el.dataset.phase;
    haptic('light'); renderPreservingScroll();
  },
  'set-cardio-activity': (_e, el) => {
    if (!state.cardioSheet) return;
    state.cardioSheet.activityId = el.dataset.activity;
    haptic('light'); renderPreservingScroll();
  },
  'edit-cardio-duration': () => {
    if (!state.cardioSheet) return;
    state.keypad = { target: 'cardio-min', buffer: String(state.cardioSheet.durationMin || ''), fresh: true };
    _keypadJustOpened = true;
    track('keypad.open', keypadTelemetryContext('cardio-min'));
    renderPreservingScroll();
  },
  'cardio-note-input': (_e, el) => {
    if (!state.cardioSheet) return;
    state.cardioSheet.note = el.value;
    // Don't re-render on every keystroke — it would steal focus/caret.
  },
  'commit-cardio': async () => {
    const c = state.cardioSheet;
    if (!c || !c.activityId || !c.durationMin) return;
    if (!state.session) { showToast('No session'); return; }

    // Server shape (mode + minutes map to cardio_blocks columns)
    const payload = {
      phase: c.phase,
      mode: c.activityId,
      minutes: c.durationMin,
      notes: c.note || null,
    };

    // EDIT path: replace the block in place, PATCH the DB row if we have one.
    if (c.mode === 'edit' && c.editingIndex != null) {
      const existing = state.session.cardioBlocks[c.editingIndex];
      if (!existing) { state.cardioSheet = null; renderPreservingScroll(); return; }
      const dbId = existing.dbId || c.dbId || null;
      state.session.cardioBlocks[c.editingIndex] = {
        ...existing,
        phase: c.phase,
        activity: c.activityId,
        durationSeconds: Math.round(c.durationMin * 60),
        notes: c.note || null,
      };
      hapticNotify('success');
      track('cardio.edit_commit', { idx: c.editingIndex, hasDbId: !!dbId });
      state.cardioSheet = null;
      renderPreservingScroll();
      if (dbId) {
        try { await api.updateCardio(dbId, payload); }
        catch (err) { trackError('cardio.edit_persist', err); showToast('Edit not saved: ' + (err?.message || 'network')); }
      }
      return;
    }

    // CREATE path
    const block = {
      phase: c.phase,
      activity: c.activityId,
      durationSeconds: Math.round(c.durationMin * 60),
      notes: c.note || null,
      dbId: null, // populated below on successful POST
    };
    state.session.cardioBlocks.push(block);
    const blockIndex = state.session.cardioBlocks.length - 1;
    hapticNotify('success');
    track('cardio.log', block);
    if (c.supportId) {
      const item = supportItemById(c.supportId);
      if (item) item.done = true;
    }
    state.cardioSheet = null;
    renderPreservingScroll();

    state.session.pendingCardio.push({ ...payload, client_write_id: nextClientSetId(), _blockIndex: blockIndex });
    saveSessionLocal();
    await retryPendingIfResumed('cardio_queued');
  },
  'open-cardio-edit': (_e, el) => {
    const idx = Number(el.dataset.idx);
    const block = state.session?.cardioBlocks?.[idx];
    if (!block) return;
    state.cardioSheet = {
      mode: 'edit',
      editingIndex: idx,
      dbId: block.dbId || null,
      phase: block.phase || 'cardio',
      activityId: block.activity || '',
      durationMin: Math.max(0.5, Math.round(((block.durationSeconds || 0) / 60) * 2) / 2),
      note: block.notes || '',
    };
    _cardioSheetJustOpened = true;
    track('cardio.edit_open', { idx, hasDbId: !!block.dbId });
    haptic('light');
    renderPreservingScroll();
  },
  'delete-cardio-block': async () => {
    const c = state.cardioSheet;
    if (!c || c.mode !== 'edit' || c.editingIndex == null) return;
    if (!confirm('Delete this cardio block?')) return;
    const block = state.session.cardioBlocks[c.editingIndex];
    state.session.cardioBlocks.splice(c.editingIndex, 1);
    const dbId = block?.dbId || c.dbId || null;
    track('cardio.edit_delete', { idx: c.editingIndex, hasDbId: !!dbId });
    state.cardioSheet = null;
    hapticNotify('warning');
    renderPreservingScroll();
    if (dbId) {
      try { await api.deleteCardio(dbId); }
      catch (err) { trackError('cardio.edit_delete_persist', err); showToast('Delete not synced: ' + (err?.message || 'network')); }
    }
  },

  // ---- Body-weight sheet ----
  'open-weighin': (_e, el) => {
    const context = el?.dataset?.context || (state.view === 'summary' ? 'summary' : state.view === 'launch' ? 'launch' : 'overview');
    const seed = latestBodyWeight()?.value ?? '';
    state.weighIn = {
      weight: seed,              // pre-filled with last weight for easy tweak
      linkToSession: state.session ? (context !== 'launch') : false,
      note: context === 'summary' ? 'post-workout' : '',
      saving: false,
      context,
    };
    _weighInSheetJustOpened = true;
    haptic('light');
    track('weighin.sheet_open', { context, hasHistory: state.bodyWeights.length > 0 });
    renderPreservingScroll();
  },
  'close-weighin': () => {
    if (state.weighIn?.context === 'summary') {
      track('weighin.skipped_at_summary');
    } else {
      track('weighin.closed');
    }
    state.weighIn = null;
    renderPreservingScroll();
  },
  'toggle-weighin-link': (e) => {
    if (!state.weighIn) return;
    state.weighIn.linkToSession = !!e.target.checked;
    haptic('light');
    // No re-render needed — checkbox updates visually on its own.
  },
  'edit-weighin-value': () => {
    if (!state.weighIn) return;
    const cur = state.weighIn.weight;
    state.keypad = {
      target: 'bodyweight',
      buffer: cur === '' || cur == null ? '' : String(cur),
      fresh: true,
    };
    _keypadJustOpened = true;
    track('keypad.open', keypadTelemetryContext('bodyweight'));
    renderPreservingScroll();
  },
  'weighin-note-input': (_e, el) => {
    if (!state.weighIn) return;
    state.weighIn.note = el.value;
    // No re-render — don't steal focus from the text field.
  },
  // ---- Edit completed set ----
  // Tapped from a summary chip or the rest-screen "Just did" pill.
  // data-ex-id identifies the exercise in state.session.exercises,
  // data-set-idx is the 0-based index into that exercise's sets array.
  'open-edit-set': (_e, el) => {
    const exId = el.dataset.exId;
    const setIdx = parseInt(el.dataset.setIdx, 10);
    if (!exId || !Number.isInteger(setIdx)) return;
    const ex = state.session?.exercises?.find(x => x.id === exId);
    if (!ex) return;
    const s = ex.sets?.[setIdx];
    if (!s) return;
    state.editSet = {
      exId,
      setIdx,
      weight: s.weight || 0,
      reps: s.reps ?? null,
      durationSeconds: s.durationSeconds ?? null,
      rpe: s.rpe ?? null,
      note: s.note || s.notes || '',
      isTimed: ex.measurement === 'duration',
      dbSetId: s.dbSetId || null,
      clientSetId: s.clientSetId || null,
      saving: false,
    };
    _editSetSheetJustOpened = true;
    haptic('light');
    track('editset.open', { exercise: ex.name, exId, setIdx, hasDbId: !!s.dbSetId });
    renderPreservingScroll();
  },
  'close-edit-set': () => {
    track('editset.closed');
    state.editSet = null;
    renderPreservingScroll();
  },
  'edit-set-weight': () => {
    if (!state.editSet) return;
    state.keypad = {
      target: 'editset-weight',
      buffer: String(state.editSet.weight || 0),
      fresh: true,
    };
    _keypadJustOpened = true;
    track('keypad.open', keypadTelemetryContext('editset-weight'));
    renderPreservingScroll();
  },
  'edit-set-reps': () => {
    if (!state.editSet) return;
    state.keypad = {
      target: 'editset-reps',
      buffer: String(state.editSet.reps || 0),
      fresh: true,
    };
    _keypadJustOpened = true;
    track('keypad.open', keypadTelemetryContext('editset-reps'));
    renderPreservingScroll();
  },
  'edit-set-duration': () => {
    if (!state.editSet) return;
    state.keypad = {
      target: 'editset-duration',
      buffer: String(state.editSet.durationSeconds || 0),
      fresh: true,
    };
    _keypadJustOpened = true;
    track('keypad.open', keypadTelemetryContext('editset-duration'));
    renderPreservingScroll();
  },
  'edit-set-rpe-chip': (_e, el) => {
    if (!state.editSet) return;
    const v = parseFloat(el.dataset.rpe);
    if (!Number.isFinite(v)) return;
    state.editSet.rpe = v;
    haptic('light');
    renderPreservingScroll();
  },
  'edit-set-rpe-clear': () => {
    if (!state.editSet) return;
    state.editSet.rpe = null;
    haptic('light');
    renderPreservingScroll();
  },
  'edit-set-note-input': (_e, el) => {
    if (!state.editSet) return;
    state.editSet.note = el.value;
  },
  'commit-edit-set': async () => {
    const e = state.editSet;
    if (!e) return;
    const ex = state.session?.exercises?.find(x => x.id === e.exId);
    if (!ex) { state.editSet = null; renderPreservingScroll(); return; }
    const s = ex.sets?.[e.setIdx];
    if (!s) { state.editSet = null; renderPreservingScroll(); return; }

    // Validate
    if (e.isTimed) {
      if (!e.durationSeconds || e.durationSeconds <= 0) { showToast('Need a duration'); return; }
    } else {
      if (e.reps == null || e.reps < 0) { showToast('Need a non-negative rep count'); return; }
    }

    // Apply locally first so the UI updates even if the network is slow.
    s.weight = e.weight || 0;
    if (e.isTimed) {
      s.durationSeconds = e.durationSeconds;
      s.reps = null;
    } else {
      s.reps = e.reps;
      s.durationSeconds = null;
    }
    s.rpe = e.rpe;
    s.note = cleanUserNote(e.note);

    track('editset.commit', {
      exercise: ex.name,
      exId: e.exId,
      setIdx: e.setIdx,
      hasDbId: !!e.dbSetId,
      weight: s.weight, reps: s.reps, rpe: s.rpe, durationSeconds: s.durationSeconds,
      hasNote: !!s.note,
    });

    if (!e.dbSetId) {
      const pending = state.session.pendingSets?.find(p => p.client_set_id && p.client_set_id === e.clientSetId);
      if (pending) {
        pending.weight = s.weight;
        pending.reps = e.isTimed ? null : s.reps;
        pending.rpe = s.rpe;
        pending.duration_seconds = e.isTimed ? s.durationSeconds : null;
        pending.measurement_type = e.isTimed ? 'duration_seconds' : 'reps';
        pending.notes = formatSetNotes(ex, s);
        track('editset.pending_updated', { exercise: ex.name, clientSetId: e.clientSetId });
      }
      showToast(pending ? 'Set updated · will sync' : 'Saved locally · will retry on reconnect');
      state.editSet = null;
      renderPreservingScroll();
      return;
    }

    state.editSet.saving = true;
    renderPreservingScroll();
    try {
      await api.updateSet(e.dbSetId, {
        weight: s.weight,
        reps: e.isTimed ? null : s.reps,
        rpe: s.rpe,
        duration_seconds: e.isTimed ? s.durationSeconds : null,
        notes: formatSetNotes(ex, s),
      });
      hapticNotify('success');
      showToast('Set updated');
      state.editSet = null;
    } catch (err) {
      trackError('editset.persist', err);
      showToast(err?.message || 'Failed to save edit');
      state.editSet.saving = false;
    }
    renderPreservingScroll();
  },
  'delete-logged-set': async () => {
    const e = state.editSet;
    if (!e) return;
    const ex = state.session?.exercises?.find(x => x.id === e.exId);
    if (!ex) { state.editSet = null; renderPreservingScroll(); return; }
    const s = ex.sets?.[e.setIdx];
    if (!s) { state.editSet = null; renderPreservingScroll(); return; }

    const msg = e.isTimed
      ? `Delete this ${fmtTime(s.durationSeconds || 0)} set?`
      : `Delete ${fmtNum(s.weight || 0)} × ${s.reps} ?`;
    const confirmed = await new Promise(resolve => {
      if (tg?.showConfirm) tg.showConfirm(msg, (ok) => resolve(!!ok));
      else resolve(window.confirm(msg));
    });
    if (!confirmed) return;

    haptic('heavy');
    track('editset.delete_attempt', { exercise: ex.name, exId: e.exId, setIdx: e.setIdx, hasDbId: !!e.dbSetId });

    // Remove locally first
    ex.sets.splice(e.setIdx, 1);

    if (!e.dbSetId) {
      if (e.clientSetId && state.session.pendingSets?.length) {
        state.session.pendingSets = state.session.pendingSets.filter(p => p.client_set_id !== e.clientSetId);
      }
      showToast('Set removed locally');
      state.editSet = null;
      renderPreservingScroll();
      return;
    }

    state.editSet.saving = true;
    renderPreservingScroll();
    try {
      await api.deleteSet(e.dbSetId);
      hapticNotify('success');
      showToast('Set deleted');
      track('editset.deleted', { dbSetId: e.dbSetId });
      state.editSet = null;
    } catch (err) {
      trackError('editset.delete', err);
      // Put the set back so state matches the DB.
      ex.sets.splice(e.setIdx, 0, s);
      showToast(err?.message || 'Failed to delete');
      state.editSet.saving = false;
    }
    renderPreservingScroll();
  },

  'commit-weighin': async () => {
    const w = state.weighIn;
    if (!w) return;
    const value = Number(w.weight);
    if (!Number.isFinite(value) || value <= 0) { showToast('Enter a weight'); return; }
    state.weighIn.saving = true;
    renderPreservingScroll();

    const payload = {
      weight_lbs: value,
      session_id: w.linkToSession && state.session?.dbSessionId ? state.session.dbSessionId : null,
      notes: (w.note || (w.linkToSession ? 'post-workout · miniapp' : 'miniapp')).slice(0, 200),
      timestamp: new Date().toISOString(),
    };
    track('weighin.submit', {
      value,
      linked: !!payload.session_id,
      context: w.context,
    });
    try {
      const res = await api.logWeight(payload);
      // Prepend the new reading to state.bodyWeights so subsequent renders
      // (e.g. reopening the home card) show the fresh value immediately.
      state.bodyWeights = [
        {
          id: res?.entryId || Date.now(),
          timestamp: payload.timestamp,
          session_id: res?.linked_to_session === false ? null : payload.session_id,
          weight_lbs: value,
        },
        ...(state.bodyWeights || []),
      ].slice(0, 10);
      if (payload.session_id != null) {
        state.weighInThisSession = res?.linked_to_session !== false;
      }
      hapticNotify('success');
      showToast(`Weight saved · ${fmtNum(value)} lb`);
      track('weighin.persisted', { entryId: res?.entryId, value, linked: res?.linked_to_session !== false && payload.session_id != null });
      state.weighIn = null;
    } catch (err) {
      trackError('weighin.persist', err);
      showToast(err?.message || 'Failed to save weight');
      state.weighIn.saving = false;
    }
    renderPreservingScroll();
  },

  // ---- End-of-session ----
  'reset-session': () => { if (hasUnsyncedWorkout()) { showToast('Reconnect to sync this workout before starting another'); return; } resetToLaunch(); haptic('light'); renderPreservingScroll(); },
  'delete-session': async () => {
    // Destructive: hard-deletes the session + all its sets, cardio blocks,
    // supersets, and linked weigh-in from the DB. Guarded by an explicit
    // confirm dialog. Only callable from the summary screen.
    const s = state.session;
    if (!s) return;
    const setsCount = s.exercises?.reduce((n, e) => n + (e.sets?.length || 0), 0) || 0;
    const cardioCount = s.cardioBlocks?.length || 0;
    const msg =
      `Delete this session?\n\n` +
      `This permanently removes ${setsCount} set${setsCount === 1 ? '' : 's'}` +
      `${cardioCount ? ` and ${cardioCount} cardio block${cardioCount === 1 ? '' : 's'}` : ''}` +
      `${state.weighInThisSession ? ' and the weigh-in' : ''}` +
      ` from your training history. Can't be undone.`;
    // Prefer Telegram's native confirm popup (matches system UI) when
    // available; fall back to browser confirm() for desktop/dev preview.
    const confirmed = await new Promise(resolve => {
      if (tg?.showConfirm) {
        tg.showConfirm(msg, (ok) => resolve(!!ok));
      } else {
        resolve(window.confirm(msg));
      }
    });
    if (!confirmed) return;
    haptic('heavy');
    track('session.delete_attempt', {
      dbSessionId: s.dbSessionId || null,
      setsCount,
      cardioCount,
      hasWeighIn: !!state.weighInThisSession,
    });
    // If the session never made it to the DB (offline / pre-POST), just
    // reset locally — nothing to delete server-side.
    if (!s.dbSessionId) {
      resetToLaunch();
      showToast('Session discarded');
      renderPreservingScroll();
      return;
    }
    try {
      const res = await api.deleteSession(s.dbSessionId);
      track('session.deleted', {
        dbSessionId: s.dbSessionId,
        setsDeleted: res?.setsDeleted,
        cardioDeleted: res?.cardioDeleted,
        bodyMetricsDeleted: res?.bodyMetricsDeleted,
      });
      resetToLaunch();
      showToast('Session deleted');
      renderPreservingScroll();
    } catch (err) {
      trackError('session.delete', err);
      console.warn('deleteSession', err);
      showToast(`Delete failed: ${err?.message || 'unknown'}`);
    }
  },
  'close-app': async () => {
    try { assertDurable(); } catch(e) { showToast(e.message); return; }
    track('app.close');
    // Flush before close; visibilitychange handler also tries, but being
    // explicit here means we don't depend on the browser firing it.
    void flushTelemetry().catch(() => {});
    // If the session is already complete (summary view), clear the
    // persisted snapshot so re-opening the Mini App later goes to launch
    // instead of resurrecting a stale "Session complete" screen.
    if ((state.session?.completedLocally || state.view === 'summary') && !hasUnsyncedWorkout()) resetToLaunch();
    if (currentAuthMode() === 'hmac' && tg?.close) tg.close();
    else if (window.parent !== window) {
      renderPreservingScroll();
      window.parent.postMessage({ type: 'workout:home' }, location.origin);
    } else location.assign('/today');
  },
};

// ---------------------------------------------------------
// Partial DOM updates
// These update just the changing text/style on the live screen,
// without replacing innerHTML. Critical to avoid:
//   - replaying slide-up animations on overlays
//   - detaching elements mid-tap (which can drop the first touch before
//     the delegated click handler sees it)
// ---------------------------------------------------------
function updateElapsedDisplay() {
  const el = $app.querySelector('.session-head .timer');
  if (el) el.innerHTML = `<span class="live-dot"></span>Live · ${fmtTime(elapsedSec())} elapsed`;
}

function updateRestTimer() {
  if (!state.rest) return;
  const ex = activeEx();
  if (!ex) return;
  const remaining = Math.max(0, Math.floor((state.rest.endsAt - Date.now()) / 1000));
  const pct = state.rest.duration > 0 ? (state.rest.duration - remaining) / state.rest.duration : 1;
  const deg = Math.min(360, pct * 360);
  const isDone = remaining <= 0;
  const setNum = ex.sets.length + 1;

  const timeEl = $app.querySelector('.rest-time');
  const ringEl = $app.querySelector('.rest-ring');
  const subEl = $app.querySelector('.rest-sub');
  const primaryBtn = $app.querySelector('.bottom-bar .btn.primary');

  if (timeEl) timeEl.textContent = fmtTime(remaining);
  if (ringEl) {
    const color = isDone ? 'var(--tg-success)' : 'var(--tg-accent-strong)';
    ringEl.style.background = `conic-gradient(${color} 0 ${deg}deg, var(--tg-secondary) ${deg}deg 360deg)`;
  }
  if (subEl) subEl.textContent = isDone ? 'ready' : `of ${fmtTime(state.rest.duration)}`;
  if (primaryBtn) primaryBtn.textContent = `${isDone ? '▶ ' : ''}Start set ${setNum}`;
}

function updateWorkTimerDisplay() {
  const ex = activeEx();
  const timer = getActiveWorkTimer(ex);
  if (!ex || !timer) return;
  const remaining = workTimerRemaining(timer);
  const duration = timer.duration || Math.max(1, Number(state.draft?.durationSeconds || ex.targetDuration || 30));
  const pct = duration > 0 ? (duration - remaining) / duration : 0;
  const deg = Math.min(360, Math.max(0, pct * 360));
  const done = !!timer.done;
  const running = !!timer.running;
  const ringColor = done ? 'var(--tg-success)' : running ? 'var(--tg-accent-strong)' : 'var(--color-divider)';
  const timeEl = $app.querySelector('.work-timer-time');
  const ringEl = $app.querySelector('.work-timer-ring');
  const subEl = $app.querySelector('.work-timer-sub');
  const statusEl = $app.querySelector('.work-timer-status');
  const eyebrowEl = $app.querySelector('.work-timer-eyebrow');
  const primaryBtn = $app.querySelector('.work-timer-primary');
  const card = $app.querySelector('.work-timer-card');
  if (timeEl) timeEl.textContent = fmtTime(remaining);
  if (ringEl) ringEl.style.background = `conic-gradient(${ringColor} 0 ${deg}deg, var(--tg-secondary) ${deg}deg 360deg)`;
  if (subEl) subEl.textContent = `of ${fmtTime(duration)}`;
  if (statusEl) statusEl.textContent = done ? 'complete' : running ? 'running' : 'paused';
  if (eyebrowEl) {
    const segments = timer.segments || workTimerSegments(ex);
    eyebrowEl.textContent = segments > 1 ? `${workTimerSegmentName(ex, timer)} of ${segments}` : 'Timed set';
  }
  if (primaryBtn) primaryBtn.textContent = done ? 'Restart timer' : running ? 'Pause' : 'Start timer';
  if (card) {
    card.dataset.timerRunning = running ? '1' : '0';
    card.dataset.timerDone = done ? '1' : '0';
  }
}

function updateKeypadBuffer() {
  const el = $app.querySelector('.kp-readout .val');
  if (!el || !state.keypad) return;
  el.textContent = state.keypad.buffer === '' ? '0' : state.keypad.buffer;
}

// ---------------------------------------------------------
// Rest ticker
// ---------------------------------------------------------
let restTickHandle = null;
let workTimerTickHandle = null;
function startRest(seconds) {
  state.rest = { endsAt: Date.now() + seconds * 1000, duration: seconds };
  state.view = 'rest';
  track('rest.start', { seconds });
  startRestTicker();
}
function startRestTicker() {
  clearRestTicker();
  restTickHandle = setInterval(() => {
    if (!state.rest || (state.view !== 'rest' && !(state.view === 'mobility' && state.mobilityReturnView === 'rest'))) { clearRestTicker(); return; }
    const remaining = state.rest.endsAt - Date.now();
    if (remaining <= 0 && !state.rest._firedDone) {
      state.rest._firedDone = true;
      fireTimerEndAlert('rest');
    }
    updateRestTimer();
  }, 500);
}
function clearRestTicker() {
  if (restTickHandle) { clearInterval(restTickHandle); restTickHandle = null; }
}

function startWorkTimerTicker() {
  clearWorkTimerTicker();
  workTimerTickHandle = setInterval(() => {
    const ex = activeEx();
    const timer = getActiveWorkTimer(ex);
    if (!timer || !timer.running) { clearWorkTimerTicker(); return; }
    const remaining = workTimerRemaining(timer);
    if (remaining <= 0) {
      const completedSegment = timer.segmentIndex;
      timer.running = false;
      timer.endsAt = null;
      timer.remaining = 0;
      vibrateWorkTimerDone();
      const isLast = completedSegment >= (timer.segments || 1) - 1;
      track('work_timer.done', {
        exercise: ex.name,
        exId: ex.id,
        setNum: timer.setNum,
        segment: completedSegment + 1,
        segments: timer.segments || 1,
      });
      if (isLast) {
        timer.done = true;
        showToast(`${ex.name} timer complete`, { durationMs: 2600 });
      } else {
        const doneLabel = workTimerSegmentName(ex, timer);
        timer.segmentIndex = completedSegment + 1;
        timer.remaining = timer.duration;
        showToast(`${doneLabel} done · switch sides`, { durationMs: 3200 });
      }
      clearWorkTimerTicker();
      renderPreservingScroll();
      return;
    }
    timer.remaining = remaining;
    updateWorkTimerDisplay();
  }, 250);
}

function clearWorkTimerTicker() {
  if (workTimerTickHandle) { clearInterval(workTimerTickHandle); workTimerTickHandle = null; }
}

// Overview elapsed-time tick — surgical update only; skipped when no session
setInterval(() => {
  if (state.view === 'overview' && state.session && !state.session.pausedAt) updateElapsedDisplay();
}, 1000);

// ---------------------------------------------------------
// Sync pin — small colored dot in the top-right corner of #app that
// reflects DB-sync state: idle (green), syncing (amber), error (red).
// Rendered outside the view() HTML so it survives re-renders; we just
// re-append it after innerHTML swaps.
// ---------------------------------------------------------
let _syncPin = null;
function ensureSyncPin() {
  if (!_syncPin) {
    _syncPin = document.createElement('div');
    _syncPin.className = 'sync-pin idle';
    _syncPin.title = 'Sync: idle';
  }
  if (_syncPin.parentNode !== $app) $app.appendChild(_syncPin);
  return _syncPin;
}
function applySyncState(s) {
  const pin = ensureSyncPin();
  pin.className = `sync-pin ${s.status}`;
  const titles = {
    idle: s.lastSyncAt ? `Synced` : 'Ready',
    syncing: 'Syncing…',
    error: s.message ? `Sync error · ${s.message}` : 'Sync error',
  };
  pin.title = titles[s.status] || s.status;
}

// ---------------------------------------------------------
// Event delegation + render
// ---------------------------------------------------------
const $app = document.getElementById('app');

function currentViewportSize() {
  const width = Math.round(window.innerWidth || document.documentElement?.clientWidth || 0);
  const height = Math.round(tg?.viewportHeight || window.innerHeight || document.documentElement?.clientHeight || 0);
  return { width, height };
}

function isTextEntryElement(el) {
  const tag = String(el?.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable === true;
}

function isTextEntryFocused() {
  return _textEntryFocused || isTextEntryElement(document.activeElement);
}

function deviceLandscapeState() {
  const orientation = globalThis.screen?.orientation;
  const type = String(orientation?.type || '').toLowerCase();
  if (type.includes('landscape')) return true;
  if (type.includes('portrait')) return false;

  const angle = Number(orientation?.angle);
  if (Number.isFinite(angle)) return Math.abs(angle) % 180 === 90;

  const legacyOrientation = Number(window.orientation);
  if (Number.isFinite(legacyOrientation)) return Math.abs(legacyOrientation) % 180 === 90;

  const screenWidth = Number(globalThis.screen?.width);
  const screenHeight = Number(globalThis.screen?.height);
  if (Number.isFinite(screenWidth) && Number.isFinite(screenHeight) && screenWidth > 0 && screenHeight > 0) {
    if (screenWidth > screenHeight) return true;
    if (screenHeight > screenWidth) return false;
  }
  return null;
}

function isMobileLikeViewport(width, height) {
  const maxSide = Math.max(width, height);
  const minSide = Math.min(width, height);
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
  return Boolean(tg)
    || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
    || minSide <= 600
    || maxSide <= 950;
}

function isPortraitViewport() {
  const { width, height } = currentViewportSize();
  return height >= width;
}

function shouldBlockLandscapeViewport() {
  const { width, height } = currentViewportSize();
  if (!width || !height || width <= height) return false;
  if (!isMobileLikeViewport(width, height)) return false;
  const deviceLandscape = deviceLandscapeState();
  if (deviceLandscape === false) return false;
  // The iOS/Telegram keyboard shrinks portrait viewport height enough that
  // width can exceed height. Keep focused inputs stable in that state.
  if (isTextEntryFocused() && deviceLandscape !== true) return false;
  return true;
}

function requestPortraitLockIfPossible() {
  const { width, height } = currentViewportSize();
  if (!isMobileLikeViewport(width, height)) return;

  // Telegram's Bot API 8.0 lockOrientation() locks the current mode, so only
  // call it while the Mini App is already portrait. Browser orientation.lock()
  // can request portrait explicitly, but is best-effort across WebViews.
  if (isPortraitViewport() && tg?.lockOrientation && !_telegramPortraitLocked) {
    try {
      tg.lockOrientation();
      _telegramPortraitLocked = true;
      track('orientation.lock', { mode: 'telegram-current-portrait' });
    } catch (err) {
      track('orientation.lock_blocked', { mode: 'telegram', message: err?.message || String(err) });
    }
  }

  const orientation = globalThis.screen?.orientation;
  if (orientation?.lock && !_screenPortraitLockAttempted) {
    _screenPortraitLockAttempted = true;
    Promise.resolve(orientation.lock('portrait'))
      .then(() => track('orientation.lock', { mode: 'screen-orientation' }))
      .catch((err) => track('orientation.lock_blocked', { mode: 'screen-orientation', message: err?.message || String(err) }));
  }
}

function syncViewportVars() {
  const h = Math.round(tg?.viewportHeight || window.innerHeight || 0);
  if (h > 0) document.documentElement.style.setProperty('--miniapp-vh', `${h}px`);
}

function syncOrientationGuard({ renderOnChange = false } = {}) {
  const active = shouldBlockLandscapeViewport();
  document.documentElement?.classList?.toggle('portrait-guard-active', active);
  if (active && !_portraitGuardTracked) {
    const { width, height } = currentViewportSize();
    track('orientation.landscape_guard', { width, height, tg: !!tg });
    _portraitGuardTracked = true;
  }
  if (state.portraitGuardActive === active) return;
  state.portraitGuardActive = active;
  if (renderOnChange) renderPreservingScroll();
}

function syncViewportAndOrientation(opts = {}) {
  syncViewportVars();
  requestPortraitLockIfPossible();
  syncOrientationGuard(opts);
}

function render() {
  // Preserve search-box focus/caret across re-renders
  const active = document.activeElement;
  const searchFocused = active?.dataset?.action === 'switcher-search';
  const caret = searchFocused ? active.selectionStart : null;

  // Persist the live session to localStorage on every render so a Telegram
  // WebView dismiss, phone lock, or tab crash doesn't lose your workout.
  // Serialization is defensive — errors swallowed so a persistence hiccup
  // never blocks rendering.
  saveSessionLocal();

  $app.innerHTML = view();
  bind();
  applySyncState(getSyncState());

  // Apply one-shot entrance animations only when a flag is set.
  // Without this, any re-render while an overlay is open would replay
  // slideUp/fadeIn and cause visible "jumping."
  if (state.switcher && _sheetJustOpened) {
    $app.querySelector('.sheet')?.classList.add('just-opened');
    $app.querySelector('.sheet-backdrop')?.classList.add('just-opened');
  }
  if (state.cardioSheet && _cardioSheetJustOpened) {
    $app.querySelector('.cardio-sheet')?.classList.add('just-opened');
    $app.querySelector('.sheet-backdrop')?.classList.add('just-opened');
  }
  if (state.mediaSheet && _mediaSheetJustOpened) {
    $app.querySelector('.media-sheet')?.classList.add('just-opened');
    $app.querySelector('.sheet-backdrop')?.classList.add('just-opened');
  }
  if (state.weighIn && _weighInSheetJustOpened) {
    const sheet = $app.querySelector('.weighin-sheet');
    sheet?.classList.add('just-opened');
    if (state.weighIn.context === 'summary' && sheet) sheet.scrollTop = 0;
    $app.querySelector('.sheet-backdrop')?.classList.add('just-opened');
  }
  if (state.editSet && _editSetSheetJustOpened) {
    $app.querySelector('.edit-set-sheet')?.classList.add('just-opened');
    $app.querySelector('.sheet-backdrop')?.classList.add('just-opened');
  }
  if (state.linkSheet && _linkSheetJustOpened) {
    $app.querySelector('.link-sheet')?.classList.add('just-opened');
    $app.querySelector('.sheet-backdrop')?.classList.add('just-opened');
  }
  if (state.keypad && _keypadJustOpened) {
    $app.querySelector('.keypad')?.classList.add('just-opened');
  }
  if (state.toast && _toastJustShown) {
    $app.querySelector('.toast')?.classList.add('just-shown');
  }
  _sheetJustOpened = false;
  _cardioSheetJustOpened = false;
  _mediaSheetJustOpened = false;
  _weighInSheetJustOpened = false;
  _editSetSheetJustOpened = false;
  _linkSheetJustOpened = false;
  _keypadJustOpened = false;
  _toastJustShown = false;

  if (searchFocused) {
    const newInput = $app.querySelector('input[data-action="switcher-search"]');
    if (newInput) {
      newInput.focus();
      if (caret != null) try { newInput.setSelectionRange(caret, caret); } catch (_) {}
    }
  }
}

function renderPreservingScroll() {
  const scrollSelectors = [
    '.body',
    '.sheet',
    '.cardio-sheet',
    '.media-sheet',
    '.weighin-sheet',
    '.edit-set-sheet',
    '.link-sheet',
  ];
  const scrolls = scrollSelectors
    .map(selector => {
      const el = $app.querySelector(selector);
      return el ? { selector, top: el.scrollTop, left: el.scrollLeft } : null;
    })
    .filter(Boolean);
  const winX = typeof window.scrollX === 'number' ? window.scrollX : 0;
  const winY = typeof window.scrollY === 'number' ? window.scrollY : 0;
  const restore = () => {
    for (const item of scrolls) {
      const el = $app.querySelector(item.selector);
      if (!el) continue;
      el.scrollTop = item.top;
      el.scrollLeft = item.left;
    }
    if (typeof window.scrollTo === 'function') window.scrollTo(winX, winY);
  };
  render();
  restore();
  if (typeof setTimeout === 'function') setTimeout(restore, 0);
}

function bind() {
  $app.onclick = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(e, el); }
  };
  bindTextEntry('input[data-action="switcher-search"]', 'switcher-search');
  bindTextEntry('input[data-action="cardio-note-input"]', 'cardio-note-input');
  bindTextEntry('textarea[data-action="set-note-input"]', 'set-note-input');
  bindTextEntry('textarea[data-action="edit-set-note-input"]', 'edit-set-note-input');
  bindTextEntry('input[data-action="weighin-note-input"]', 'weighin-note-input');

  // RPE slider: pointer-based drag/tap. The previous click-only handler
  // needed 2-3 taps on live hardware because the 10px visual track was
  // nearly impossible to hit with a thumb. The CSS now gives us a 40px
  // hit zone; we also switch to pointerdown so the first touch registers
  // immediately (no 300ms click delay) and we can track a slide.
  //
  // Move/up live on `document`, not the track, so dragging keeps working
  // even when the pointer leaves the hit zone.
  const rpeTrack = $app.querySelector('.rpe-track');
  if (rpeTrack) {
    const rectRef = () => {
      // Re-query each event: rpeTrack itself may have been replaced by
      // render(), and its rect changes on scroll/keyboard.
      const el = $app.querySelector('.rpe-track') || rpeTrack;
      return el.getBoundingClientRect();
    };
    const setFromClientX = (clientX) => {
      const rect = rectRef();
      if (rect.width <= 0) return;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const rpe = Math.round((5 + pct * 5) * 2) / 2; // 5..10 in 0.5 steps
      if (state.draft.rpe !== rpe) {
        state.draft.rpe = rpe;
        updateRpeDom(rpe);
      }
    };
    let dragging = false;
    const onMove = (e) => { if (dragging) setFromClientX(e.clientX); };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      saveSessionLocal();
    };
    rpeTrack.addEventListener('pointerdown', (e) => {
      dragging = true;
      setFromClientX(e.clientX);
      haptic('light');
      e.preventDefault();
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  }
}

function bindTextEntry(selector, actionName) {
  const fields = $app.querySelectorAll(selector);
  if (!fields.length) return;
  const stopDelegatedClick = (e) => e.stopPropagation();
  fields.forEach((field) => {
    field.oninput = (e) => actions[actionName](e, e.target);
    field.onclick = stopDelegatedClick;
    field.onpointerdown = stopDelegatedClick;
    field.onmousedown = stopDelegatedClick;
    field.ontouchstart = stopDelegatedClick;
    field.onfocus = () => {
      _textEntryFocused = true;
      try { tg?.disableVerticalSwipes?.(); } catch (_) {}
    };
    field.onblur = () => {
      setTimeout(() => { _textEntryFocused = isTextEntryElement(document.activeElement); }, 80);
    };
  });
}

// ---------------------------------------------------------
// Init
// ---------------------------------------------------------
window.addEventListener('error', (e) => {
  trackError('window.error', e.error || new Error(e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  trackError('unhandled.rejection', e.reason);
});

initTelegram();
syncViewportAndOrientation({ renderOnChange: false });
function handleViewportOrOrientationChange() {
  syncViewportAndOrientation({ renderOnChange: true });
}
window.addEventListener('resize', handleViewportOrOrientationChange);
window.addEventListener('orientationchange', () => {
  setTimeout(handleViewportOrOrientationChange, 120);
});
tg?.onEvent?.('viewportChanged', handleViewportOrOrientationChange);
onSyncChange(applySyncState);
window.addEventListener('pointerdown', unlockTimerAudio, { passive: true });
window.addEventListener('touchstart', unlockTimerAudio, { passive: true });
window.addEventListener('keydown', unlockTimerAudio);

// Restore any in-progress session BEFORE first render so the UI doesn't
// flash the launch screen on reopen. If restored, also restart the rest
// ticker (restoreSessionFromLocal can't touch the DOM-reliant ticker).
state.bootstrap = cachedRead('/bootstrap');
const cachedCatalog = cachedRead(`/mobility/catalog?date=${encodeURIComponent(mobilityTodayKey())}`);
if (Array.isArray(cachedCatalog?.drills)) state.mobilityCatalog = cachedCatalog.drills.map(apiDrillToCard);
const restored = restoreSessionFromLocal();

// Load today's mobility checklist so the launch card shows "done today" +
// streak immediately (and rolls the day over if it changed since last open).
if (MOBILITY_ENABLED) { try { state.mobility = loadMobilityLocal(); } catch (_) {} }

// First-party routes can open a focused workflow while the same Mini App URL
// remains fully compatible with Telegram launches. A restored workout always
// wins so a deep link can never hide an in-progress session.
const requestedStartupView = new URLSearchParams(location.search).get('view');
if (requestedStartupView === 'mobility' && MOBILITY_ENABLED) {
  state.mobilityReturnView = state.view;
  state.view = 'mobility';
}

track('app.boot', {
  ua: navigator.userAgent?.slice(0, 120),
  tg: !!tg,
  path: location.pathname,
  restored,
  mobilityDone: !!state.mobility?.completedAt,
  authMode: currentAuthMode?.() || 'unknown',
  source: new URLSearchParams(location.search).get('source') || (tg ? 'telegram' : 'direct'),
});
render();
if (MOBILITY_ENABLED) {
  refreshMobilityRemote({ renderAfter: true, silent: true });
}

if (restored && state.rest?.endsAt && state.rest.endsAt > Date.now()) {
  startRestTicker();
}
if (restored && state.workTimer?.running && state.workTimer.endsAt && state.workTimer.endsAt > Date.now()) {
  startWorkTimerTicker();
}

// Retry any pending queues as soon as we think we're online again —
// covers the phone-in-gym case where the Telegram WebView comes back
// after a WiFi/LTE hiccup.
const retryPendingIfResumed = singleFlight(retryPendingIfResumedOnce);
async function retryPendingIfResumedOnce(reason = 'resume') {
  if (!state.session) return false;
  const pending = pendingWriteCounts(state.session);
  const needsSession = !state.session.dbSessionId;
  if (!needsSession && pending.total === 0 && !state.session.completionPending) return true;
  track('connectivity.retry', {
    reason,
    sets: pending.sets,
    cardio: pending.cardio,
    supersets: pending.supersets,
    missingSession: needsSession,
  });
  if (needsSession) {
    const created = await ensureDbSession(`retry:${reason}`);
    if (!created) {
      renderPreservingScroll();
      return false;
    }
  }
  await Promise.allSettled([
    flushPendingSets(),
    flushPendingCardio(),
    flushPendingSupersets(),
  ]);
  if (state.session?.completionPending && state.session.dbSessionId && pendingWriteCounts(state.session).total === 0) {
    try {
      await api.updateSession(state.session.dbSessionId, { status: 'completed' });
      state.session.completionPending = false;
    } catch (err) { trackError('session.end', err); }
  }
  renderPreservingScroll();
  return true;
}

function hasUnsyncedWorkout() {
  return !!state.session && (state.session.completionPending || !state.session.dbSessionId || pendingWriteCounts(state.session).total > 0);
}

window.addEventListener('online', () => {
  track('connectivity.online');
  retryPendingIfResumed();
  refreshMobilityRemote({ renderAfter: true });
  loadBootstrap();
});
window.addEventListener('offline', () => {
  track('connectivity.offline');
  showToast('Offline — logs will sync when you reconnect');
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    track('visibility.resume');
    // Re-verify the restore is still valid; in case localStorage was
    // purged while we were backgrounded.
    if (!state.session) {
      const r = restoreSessionFromLocal();
      if (r) renderPreservingScroll();
    }
    retryPendingIfResumed();
    refreshMobilityRemote({ renderAfter: true });
  }
});

// Load today's plan + saved plans from DB in the background.
// If it fails, we stay on mock data and the user sees a red sync pin.
loadBootstrap();

// Same-origin shell controls preserve the live frame and workout state.
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type === 'workout:mobility' && MOBILITY_ENABLED) actions['open-mobility']();
});
let lastScrollElement = null;
let lastScrollTop = 0;
document.addEventListener('scroll', (event) => {
  const el = event.target;
  if (!(el instanceof Element) || !el.classList.contains('body')) return;
  if (lastScrollElement !== el) { lastScrollElement = el; lastScrollTop = 0; }
  const delta = el.scrollTop - lastScrollTop;
  if (Math.abs(delta) < 24) return;
  lastScrollTop = el.scrollTop;
  if (window.parent !== window) window.parent.postMessage({ type: 'workout:scroll', direction: delta > 0 ? 'down' : 'up' }, location.origin);
}, true);
// Local candidate: periodic retry removed; explicit boot/online/visibility/click retries retained.
if (restored) retryPendingIfResumed('boot');
