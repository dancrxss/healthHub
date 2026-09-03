// ============================================================================
// coach.js — the Coach orchestrator (Phase C, PLAN.md §"Phase C" C4).
//
// Owns the two triggers (daily summary on the first open of a day; session
// feedback + plan revision when a workout is finished), the idempotency gates,
// a single queue so two coach calls never run at once, the offline retry slot,
// and every read of coach state the screens need. Everything the model
// returns is stored in IndexedDB, so the Coach tab renders offline and never
// re-calls just to display.
//
// No key ⇒ nothing here ever touches the network. Apple Health values reach
// the digest only when meta `coach.shareRecovery === true` (default off by
// absence — CLAUDE.md §10). The engine does the maths; the API client does the
// wire; this file only decides WHEN and stores WHAT came back.
// ============================================================================

import {
  listWorkouts, listAllSets, listExercises, getWorkout,
  getMeta, setMeta,
  putCoachPlan, getCoachPlan, listCoachPlans,
  putCoachInsight, getCoachInsight, listCoachInsights,
  clearCoachData as dbClearCoachData,
  listHealthSamples,
} from './db.js';
import { getStringSetting, setStringSetting } from './settings.js';
import { uid, nowISO, todayISO } from './util.js';
import { buildDigest, nextPlanSession, COACH_ENGINE_VERSION } from './coach-engine.js';
import {
  callCoach, testApiKey, COACH_MODEL, estimateCostUsd, userMessageFor,
} from './coach-api.js';
import { healthAvailable, getHealthState, getHealthSummary } from './health.js';

const DAY_MS = 86400000;
const GOALS = ['return-from-injury', 'build-muscle', 'get-stronger', 'general-fitness'];

// ----------------------------------------------------------------------------
// Key + consent (synchronous key check — route() hides the tab without an await)
// ----------------------------------------------------------------------------
export function hasApiKey() {
  return getStringSetting('coachApiKey') !== '';
}
/** The Coach is "enabled" exactly when a key exists. */
export function coachEnabled() {
  return hasApiKey();
}
export function setApiKey(key) {
  setStringSetting('coachApiKey', key);
  authFailed = false; // a new key deserves a fresh attempt
  notify();
}
/** 'sk-ant-…4f2c' for display; never the key itself. */
export function apiKeyMasked() {
  const k = getStringSetting('coachApiKey');
  if (!k) return '';
  if (k.length <= 12) return '…' + k.slice(-2);
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}
/** @returns {Promise<{ok: true}>} throws CoachApiError on a bad key */
export function checkApiKey(key) {
  return testApiKey(key || getStringSetting('coachApiKey'));
}

export async function getShareRecovery() {
  return (await getMeta('coach.shareRecovery')) === true;
}
export async function setShareRecovery(on) {
  await setMeta('coach.shareRecovery', on === true);
  notify();
}

// ----------------------------------------------------------------------------
// Profile
// ----------------------------------------------------------------------------
/** @returns {Promise<Object|null>} the coach.profile meta record, validated */
export async function getProfile() {
  const p = await getMeta('coach.profile');
  return p && typeof p === 'object' ? sanitiseProfile(p) : null;
}
export async function saveProfile(profile) {
  const clean = sanitiseProfile({ ...(await getMeta('coach.profile')), ...profile, updatedAt: nowISO() });
  await setMeta('coach.profile', clean);
  notify();
  return clean;
}
function sanitiseProfile(p) {
  const int = (v, lo, hi, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 600) : null);
  return {
    version: 1,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : nowISO(),
    injuryNotes: str(p.injuryNotes),
    goal: GOALS.includes(p.goal) ? p.goal : 'return-from-injury',
    daysPerWeek: int(p.daysPerWeek, 1, 7, 3),
    sessionMinutes: int(p.sessionMinutes, 20, 120, 60),
    equipmentNotes: str(p.equipmentNotes),
    returnDate: /^\d{4}-\d{2}-\d{2}$/.test(p.returnDate || '') ? p.returnDate : null,
    avoidExerciseIds: Array.isArray(p.avoidExerciseIds) ? p.avoidExerciseIds.filter((x) => typeof x === 'string') : [],
  };
}

// ----------------------------------------------------------------------------
// Subscribers (mirrors onHealthUpdate)
// ----------------------------------------------------------------------------
const listeners = new Set();
let notifyTimer = null;
export function onCoachUpdate(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notify() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    for (const cb of listeners) { try { cb(); } catch (e) { console.error('coach listener', e); } }
  }, 50);
}

// ----------------------------------------------------------------------------
// Data loading
// ----------------------------------------------------------------------------
/** {workouts, sets, exercises} — the engine's input. Exported for the Coach
 * screens, whose drill-downs compute live from the engine (offline). */
export async function loadDataset() {
  const [workouts, sets, exercises] = await Promise.all([listWorkouts('0000'), listAllSets(), listExercises()]);
  return { workouts, sets, exercises };
}

/** Finished workouts newest first — the shape nextPlanSession wants. */
function finishedNewestFirst(workouts) {
  return workouts.filter((w) => w.finishedAt).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export async function getCurrentPlan() {
  const id = await getMeta('coach.currentPlanId');
  if (id) {
    const p = await getCoachPlan(id);
    if (p) return p;
  }
  const [latest] = await listCoachPlans({ limit: 1 });
  return latest || null;
}

/**
 * The four derived recovery values — and only with consent. Returns null when
 * consent is off, Health is unavailable/not connected, or nothing is stored.
 */
async function buildHealthInput() {
  if (!(await getShareRecovery())) return null;
  if (!healthAvailable()) return null;
  const state = await getHealthState();
  if (!state.connected) return null;
  const summary = await getHealthSummary();
  if (!summary) return null;
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const [hrv30, rhr30] = await Promise.all([
    listHealthSamples('hrv', { since, limit: 200 }),
    listHealthSamples('restingHeartRate', { since, limit: 200 }),
  ]);
  const mean = (rows) => {
    const vals = rows.map((r) => Number(r.value)).filter(Number.isFinite);
    return vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  const trend = summary.weight && summary.weight.trend && summary.weight.trend.length >= 2 ? summary.weight.trend : null;
  const weightTrend30dPct = trend
    ? Math.round(((trend[trend.length - 1].kg - trend[0].kg) / trend[0].kg) * 1000) / 10
    : null;
  const health = {
    sleepH: summary.sleepLastNight ? round1(summary.sleepLastNight.totalAsleepSeconds / 3600) : null,
    hrvMs: summary.hrv ? round1(summary.hrv.ms) : null,
    hrvBaselineMs: mean(hrv30),
    restingHr: summary.restingHr ? Math.round(summary.restingHr.bpm) : null,
    restingHrBaseline: mean(rhr30),
    weightKg: summary.weight ? round1(summary.weight.latestKg) : null,
    weightTrend30dPct,
  };
  return Object.values(health).some((v) => v !== null) ? health : null;
}
const round1 = (n) => Math.round(n * 10) / 10;

// ----------------------------------------------------------------------------
// The queue. Coach calls run strictly one after another; the idempotency
// gates inside each runner make a queued duplicate a no-op.
// ----------------------------------------------------------------------------
let chain = Promise.resolve();
let running = null; // 'daily' | 'session' | 'plan' | null
let authFailed = false; // stop hammering a rejected key until it changes

function enqueue(kind, fn) {
  const run = chain.then(async () => {
    running = kind;
    notify();
    try { return await fn(); } finally { running = null; notify(); }
  });
  chain = run.catch(() => {});
  return run;
}

async function recordUsage(usage) {
  const totals = (await getMeta('coach.usageTotals')) || { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  totals.calls += 1;
  totals.inputTokens += usage.inputTokens || 0;
  totals.outputTokens += usage.outputTokens || 0;
  totals.estimatedCostUsd = Math.round((totals.estimatedCostUsd + estimateCostUsd(usage)) * 10000) / 10000;
  await setMeta('coach.usageTotals', totals);
}

async function recordError(err) {
  const code = err && err.code ? err.code : 'unknown';
  if (code === 'auth') authFailed = true;
  if (code !== 'offline') console.error('coach:', code, err && err.detail ? err.detail : err);
  await setMeta('coach.lastError', { code, message: userMessageFor(err), at: nowISO() });
  notify();
}
export async function dismissError() {
  await setMeta('coach.lastError', null);
  notify();
}

function apiKeyOrThrow() {
  const key = getStringSetting('coachApiKey');
  if (!key) { const e = new Error('No API key'); e.code = 'auth'; throw e; }
  return key;
}

// ----------------------------------------------------------------------------
// Runners
// ----------------------------------------------------------------------------
/**
 * Daily summary — once per local date. Returns the insight (fresh or the
 * existing one), or null when skipped (no key, no profile, already done).
 */
export function runDaily({ force = false } = {}) {
  return enqueue('daily', async () => {
    if (!hasApiKey() || (authFailed && !force)) return null;
    const today = todayISO();
    if (!force && (await getMeta('coach.lastDailyDate')) === today) {
      return (await getCoachInsight(`daily-${today}`)) || null;
    }
    const profile = await getProfile();
    if (!profile) return null; // the Coach tab asks for a profile first
    const dataset = await loadDataset();
    if (!dataset.workouts.some((w) => w.finishedAt)) return null; // nothing to summarise yet
    const [health, plan] = await Promise.all([buildHealthInput(), getCurrentPlan()]);
    const digest = buildDigest({ dataset, profile, today, health, plan, kind: 'daily' });
    try {
      const { narrative, usage } = await callCoach({ kind: 'daily', digest, apiKey: apiKeyOrThrow() });
      const insight = {
        id: `daily-${today}`, kind: 'daily', createdAt: nowISO(), date: today, workoutId: null,
        model: COACH_MODEL, engineVersion: COACH_ENGINE_VERSION,
        metrics: stripDigest(digest), narrative, planId: plan ? plan.id : null, usage,
      };
      await putCoachInsight(insight);
      await setMeta('coach.lastDailyDate', today);
      await setMeta('coach.lastError', null);
      await setMeta('coach.unreadAt', nowISO());
      await recordUsage(usage);
      notify();
      return insight;
    } catch (err) {
      await recordError(err);
      if (isRetryable(err)) await setMeta('coach.pending', { kind: 'daily', queuedAt: nowISO() });
      return null;
    }
  });
}

/**
 * Session feedback + plan revision in ONE call. Idempotent per workout.
 * Returns the insight, or null when skipped.
 */
export function runSessionFeedback(workoutId, { force = false } = {}) {
  return enqueue('session', async () => {
    if (!hasApiKey() || (authFailed && !force)) return null;
    const existing = await getCoachInsight(`session-${workoutId}`);
    if (existing && !force) return existing;
    const workout = await getWorkout(workoutId);
    if (!workout || !workout.finishedAt) return null;
    const profile = await getProfile();
    if (!profile) return null;
    const dataset = await loadDataset();
    const today = todayISO();
    const [health, plan] = await Promise.all([buildHealthInput(), getCurrentPlan()]);
    const digest = buildDigest({ dataset, profile, today, health, workoutId, plan, kind: 'session' });
    try {
      const { narrative, usage } = await callCoach({ kind: 'session', digest, apiKey: apiKeyOrThrow() });
      let planId = plan ? plan.id : null;
      if (narrative.plan) {
        const revised = await storePlan(narrative.plan, { source: 'revised', basedOnWorkoutId: workoutId });
        planId = revised.id;
      }
      const insight = {
        id: `session-${workoutId}`, kind: 'session', createdAt: nowISO(), date: workout.date, workoutId,
        model: COACH_MODEL, engineVersion: COACH_ENGINE_VERSION,
        metrics: stripDigest(digest), narrative, planId, usage,
      };
      await putCoachInsight(insight);
      await setMeta('coach.pending', null);
      await setMeta('coach.lastError', null);
      await setMeta('coach.unreadAt', nowISO());
      await recordUsage(usage);
      notify();
      return insight;
    } catch (err) {
      await recordError(err);
      if (isRetryable(err)) await setMeta('coach.pending', { kind: 'session', workoutId, queuedAt: nowISO() });
      return null;
    }
  });
}

/**
 * Build a brand-new plan from history + profile (setup sheet, "Regenerate").
 * Rejects (with a CoachApiError) rather than returning null, so the button
 * that called it can show the message.
 */
export function createPlan(profileInput = null) {
  return enqueue('plan', async () => {
    const profile = profileInput ? await saveProfile(profileInput) : await getProfile();
    if (!profile) { const e = new Error('Tell the coach about yourself first.'); e.code = 'request'; throw e; }
    const dataset = await loadDataset();
    const today = todayISO();
    const health = await buildHealthInput();
    const digest = buildDigest({ dataset, profile, today, health, plan: null, kind: 'plan' });
    try {
      const { narrative, usage } = await callCoach({ kind: 'plan', digest, apiKey: apiKeyOrThrow() });
      const plan = await storePlan(narrative, { source: 'created', basedOnWorkoutId: null });
      await setMeta('coach.lastError', null);
      await setMeta('coach.unreadAt', nowISO());
      await recordUsage(usage);
      notify();
      return plan;
    } catch (err) {
      await recordError(err);
      throw err;
    }
  });
}

/** Persist a validated PLAN object as the next plan version and point at it. */
async function storePlan(planObj, { source, basedOnWorkoutId }) {
  const [latest] = await listCoachPlans({ limit: 1 });
  const record = {
    id: uid(),
    version: latest ? latest.version + 1 : 1,
    createdAt: nowISO(),
    source,
    basedOnWorkoutId,
    rationale: planObj.rationale || null,
    weeks: planObj.weeks,
    sessions: planObj.sessions.map((s, i) => ({
      id: `ps-${i + 1}`, order: i + 1, name: s.name, focus: s.focus ?? null,
      exercises: s.exercises.map((e) => ({
        exerciseId: e.exerciseId, targetSets: e.targetSets, targetRepsLow: e.targetRepsLow,
        targetRepsHigh: e.targetRepsHigh, targetWeightKg: e.targetWeightKg ?? null,
        targetRpe: e.targetRpe ?? null, note: e.note ?? null,
      })),
    })),
  };
  await putCoachPlan(record);
  await setMeta('coach.currentPlanId', record.id);
  return record;
}

/** The digest minus the bulky plan echo — that lives in coachPlans already. */
function stripDigest(digest) {
  const { plan, ...rest } = digest;
  return rest;
}
function isRetryable(err) {
  return !!err && (err.code === 'offline' || err.retryable === true);
}

// ----------------------------------------------------------------------------
// Triggers
// ----------------------------------------------------------------------------
/** From finishFlow — never awaited by the caller, never throws. */
export function onWorkoutFinished(workoutId) {
  if (!hasApiKey()) return Promise.resolve(null);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return setMeta('coach.pending', { kind: 'session', workoutId, queuedAt: nowISO() })
      .then(() => { notify(); return null; })
      .catch(() => null);
  }
  return runSessionFeedback(workoutId).catch((e) => { console.error('coach: session feedback failed', e); return null; });
}

async function flushPending() {
  const pending = await getMeta('coach.pending');
  if (!pending) return;
  if (pending.kind === 'session' && pending.workoutId) {
    await runSessionFeedback(pending.workoutId);
  } else {
    await setMeta('coach.pending', null); // a stale daily is superseded by the date gate below
  }
}

let initialised = false;
/** Called once from ui.js init(); fire-and-forget. */
export async function initCoach() {
  if (initialised) return;
  initialised = true;
  const tick = async () => {
    if (!hasApiKey()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      await flushPending();
      await runDaily();
    } catch (e) { console.error('coach: tick failed', e); }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { tick(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  }
  await tick();
}

// ----------------------------------------------------------------------------
// Read model for the screens
// ----------------------------------------------------------------------------
export async function markCoachRead() {
  if (await getMeta('coach.unreadAt')) { await setMeta('coach.unreadAt', null); notify(); }
}

/**
 * Everything the Coach tab needs in one read — all from IndexedDB, no network.
 * @returns {Promise<{enabled:boolean, hasProfile:boolean, profile:Object|null,
 *   plan:Object|null, nextSession:Object|null, todayInsight:Object|null,
 *   latestDaily:Object|null, latestSession:Object|null, pending:Object|null,
 *   lastError:Object|null, unreadAt:string|null, usageTotals:Object|null,
 *   shareRecovery:boolean, running:string|null}>}
 */
export async function getCoachState() {
  const enabled = coachEnabled();
  const [profile, plan, dailies, sessions, pending, lastError, unreadAt, usageTotals, shareRecovery] = await Promise.all([
    getProfile(), getCurrentPlan(),
    listCoachInsights({ kind: 'daily', limit: 1 }), listCoachInsights({ kind: 'session', limit: 1 }),
    getMeta('coach.pending'), getMeta('coach.lastError'), getMeta('coach.unreadAt'),
    getMeta('coach.usageTotals'), getShareRecovery(),
  ]);
  let nextSession = null;
  if (plan) {
    const workouts = await listWorkouts('0000');
    nextSession = nextPlanSession(plan, finishedNewestFirst(workouts));
  }
  const latestDaily = dailies[0] || null;
  return {
    enabled, hasProfile: !!profile, profile, plan, nextSession,
    todayInsight: latestDaily && latestDaily.date === todayISO() ? latestDaily : null,
    latestDaily, latestSession: sessions[0] || null,
    pending: pending || null, lastError: lastError || null, unreadAt: unreadAt || null,
    usageTotals: usageTotals || null, shareRecovery, running,
  };
}

/** Settings → Coach → Clear. Keeps the recovery consent; optionally the key. */
export async function clearCoachData({ keepKey = true } = {}) {
  await dbClearCoachData();
  if (!keepKey) setStringSetting('coachApiKey', '');
  authFailed = false;
  notify();
}
