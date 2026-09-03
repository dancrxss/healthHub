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
  putExercise,
  getMeta, setMeta,
  putCoachPlan, getCoachPlan, listCoachPlans,
  putCoachInsight, getCoachInsight, listCoachInsights,
  clearCoachData as dbClearCoachData,
  listHealthSamples,
  putChatMessage, listChatMessages,
  MUSCLE_GROUPS,
} from './db.js';
import { getStringSetting, setStringSetting } from './settings.js';
import { uid, nowISO, todayISO } from './util.js';
import {
  buildDigest, nextPlanSession, COACH_ENGINE_VERSION,
  currentPlanWeek, projectPlanWeek, projectedSessions, recentPRs,
} from './coach-engine.js';
import {
  callCoach, testApiKey, COACH_MODEL, estimateCostUsd, userMessageFor,
} from './coach-api.js';
import { healthAvailable, getHealthState, getHealthSummary } from './health.js';

const DAY_MS = 86400000;
const GOALS = ['return-from-injury', 'build-muscle', 'get-stronger', 'general-fitness'];
const SPLITS = ['auto', 'full-body', 'upper-lower', 'ppl'];
const GROUP_PREFS = ['auto', 'include', 'emphasise', 'avoid'];
const MEMORY_MAX = 20;
const CHAT_RECENT = 6;

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
/** Deep-merges the nested v2 fields so a partial patch never wipes a sibling. */
export async function saveProfile(profile) {
  const prev = (await getMeta('coach.profile')) || {};
  const patch = profile || {};
  const merged = {
    ...prev, ...patch,
    cardio: { ...(prev.cardio || {}), ...(patch.cardio || {}) },
    core: { ...(prev.core || {}), ...(patch.core || {}) },
    groupPrefs: { ...(prev.groupPrefs || {}), ...(patch.groupPrefs || {}) },
    updatedAt: nowISO(),
  };
  const clean = sanitiseProfile(merged);
  await setMeta('coach.profile', clean);
  notify();
  return clean;
}
/** Profile v2 (PLAN.md C2.1). Tolerates v1 records and junk; every field optional. */
export function sanitiseProfile(p) {
  const int = (v, lo, hi, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 600) : null);
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : []);
  const groupPrefs = {};
  if (p.groupPrefs && typeof p.groupPrefs === 'object') {
    for (const [g, v] of Object.entries(p.groupPrefs)) {
      if (MUSCLE_GROUPS.includes(g) && GROUP_PREFS.includes(v) && v !== 'auto') groupPrefs[g] = v;
    }
  }
  const cardio = p.cardio && typeof p.cardio === 'object' ? p.cardio : {};
  return {
    version: 2,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : nowISO(),
    injuryNotes: str(p.injuryNotes),
    goal: GOALS.includes(p.goal) ? p.goal : 'return-from-injury',
    daysPerWeek: int(p.daysPerWeek, 1, 7, 3),
    sessionMinutes: int(p.sessionMinutes, 20, 120, 60),
    equipmentNotes: str(p.equipmentNotes),
    returnDate: /^\d{4}-\d{2}-\d{2}$/.test(p.returnDate || '') ? p.returnDate : null,
    avoidExerciseIds: ids(p.avoidExerciseIds),
    split: SPLITS.includes(p.split) ? p.split : 'auto',
    groupPrefs,
    cardio: {
      include: cardio.include === true,
      minutesPerSession: int(cardio.minutesPerSession, 5, 30, 10),
      standaloneDay: cardio.standaloneDay === true,
      exerciseIds: ids(cardio.exerciseIds),
    },
    core: { include: !!(p.core && p.core.include === true) },
    favouriteExerciseIds: ids(p.favouriteExerciseIds),
    notes: str(p.notes),
  };
}

// ----------------------------------------------------------------------------
// Coach memory — short durable facts the coach has learned (meta coach.memory).
// Sent with every request; user-editable in the plan builder. Model text is
// data: clipped, capped, never rendered as HTML.
// ----------------------------------------------------------------------------
const clipText = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

export async function getMemory() {
  const m = await getMeta('coach.memory');
  return Array.isArray(m) ? m.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string') : [];
}
async function writeMemory(items) {
  const capped = items.slice(-MEMORY_MAX);
  await setMeta('coach.memory', capped);
  notify();
  return capped;
}
/** @returns {Promise<Object|null>} the new item, or null when a duplicate/empty */
export async function addMemory(text, source = 'user') {
  const t = clipText(text, 160);
  if (!t) return null;
  const items = await getMemory();
  if (items.some((m) => m.text.toLowerCase() === t.toLowerCase())) return null;
  const item = { id: `m-${uid().slice(0, 8)}`, text: t, addedAt: nowISO(), source };
  await writeMemory([...items, item]);
  return item;
}
export async function removeMemory(id) {
  const items = await getMemory();
  const next = items.filter((m) => m.id !== id);
  if (next.length !== items.length) await writeMemory(next);
  return next.length !== items.length;
}
/** Apply a chat reply's memoryUpdates. @returns {Promise<{added:number, removed:number}>} */
export async function applyMemoryUpdates(updates, source) {
  if (!updates || typeof updates !== 'object') return { added: 0, removed: 0 };
  let items = await getMemory();
  const removeIds = new Set(Array.isArray(updates.removeIds) ? updates.removeIds : []);
  const before = items.length;
  items = items.filter((m) => !removeIds.has(m.id));
  const removed = before - items.length;
  let added = 0;
  for (const raw of (Array.isArray(updates.add) ? updates.add : []).slice(0, 5)) {
    const t = clipText(raw, 160);
    if (!t || items.some((m) => m.text.toLowerCase() === t.toLowerCase())) continue;
    items.push({ id: `m-${uid().slice(0, 8)}`, text: t, addedAt: nowISO(), source });
    added += 1;
  }
  if (added || removed) await writeMemory(items);
  return { added, removed };
}
const memoryForDigest = (items) => items.map((m) => ({ id: m.id, text: m.text }));

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
    const [health, plan, memory] = await Promise.all([buildHealthInput(), getCurrentPlan(), getMemory()]);
    const digest = buildDigest({ dataset, profile, today, health, plan, kind: 'daily', memory: memoryForDigest(memory) });
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
    const [health, plan, memory] = await Promise.all([buildHealthInput(), getCurrentPlan(), getMemory()]);
    const digest = buildDigest({ dataset, profile, today, health, workoutId, plan, kind: 'session', memory: memoryForDigest(memory) });
    try {
      const { narrative, usage } = await callCoach({ kind: 'session', digest, apiKey: apiKeyOrThrow() });
      const idMap = await materialiseNewExercises(narrative);
      const rewritten = rewriteNewExerciseIds(narrative, idMap);
      let planId = plan ? plan.id : null;
      if (rewritten.plan) {
        const revised = await storePlan(rewritten.plan, { source: 'revised', basedOnWorkoutId: workoutId, today });
        planId = revised.id;
      }
      const insight = {
        id: `session-${workoutId}`, kind: 'session', createdAt: nowISO(), date: workout.date, workoutId,
        model: COACH_MODEL, engineVersion: COACH_ENGINE_VERSION,
        metrics: stripDigest(digest), narrative: rewritten, planId, usage,
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
    const [health, memory] = await Promise.all([buildHealthInput(), getMemory()]);
    const digest = buildDigest({ dataset, profile, today, health, plan: null, kind: 'plan', memory: memoryForDigest(memory) });
    try {
      const { narrative, usage } = await callCoach({ kind: 'plan', digest, apiKey: apiKeyOrThrow() });
      const idMap = await materialiseNewExercises(narrative);
      const rewritten = rewriteNewExerciseIds(narrative, idMap);
      const plan = await storePlan(rewritten, { source: 'created', basedOnWorkoutId: null, today });
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

/**
 * Persist a validated PLAN object as the next plan version and point at it.
 * Phase C2: a 'created' plan starts a new lineage (week 1 = today); a
 * revision keeps the lineage and describes the CURRENT week (baseWeek), so
 * later weeks project from what the person is actually lifting now.
 */
async function storePlan(planObj, { source, basedOnWorkoutId, today = todayISO() }) {
  const [latest] = await listCoachPlans({ limit: 1 });
  const fresh = source === 'created' || !latest;
  const lineageStart = fresh ? today : (latest.lineageStart || (latest.createdAt || today).slice(0, 10));
  const baseWeek = fresh ? 1 : currentPlanWeek({ ...latest, lineageStart }, today);
  const weeks = Math.max(Number(planObj.weeks) || 6, baseWeek);
  const record = {
    id: uid(),
    version: latest ? latest.version + 1 : 1,
    createdAt: nowISO(),
    source,
    basedOnWorkoutId,
    planVersion: 2,
    lineageStart,
    baseWeek,
    weeks,
    rationale: planObj.rationale || null, // v1 field — null for v2 plans
    overview: planObj.overview || null,
    weekNotes: Array.isArray(planObj.weekNotes) ? planObj.weekNotes : [],
    sessions: planObj.sessions.map((s, i) => ({
      id: `ps-${i + 1}`, order: i + 1, name: s.name, focus: s.focus ?? null,
      brief: Array.isArray(s.brief) ? s.brief : [],
      exercises: s.exercises.map((e) => ({
        exerciseId: e.exerciseId, targetSets: e.targetSets,
        targetRepsLow: e.targetRepsLow ?? null, targetRepsHigh: e.targetRepsHigh ?? null,
        targetWeightKg: e.targetWeightKg ?? null, targetDurationSec: e.targetDurationSec ?? null,
        targetRpe: e.targetRpe ?? null, purpose: e.purpose ?? null, goal: e.goal ?? null,
        note: e.note ?? null, progression: e.progression ?? null,
      })),
    })),
  };
  await putCoachPlan(record);
  await setMeta('coach.currentPlanId', record.id);
  return record;
}

// ----------------------------------------------------------------------------
// Coach-created exercises (C2.4) — the coach can create exercises the library
// lacks (`narrative.newExercises`, coach-api.js) rather than being limited to
// what already exists. Every kind that can carry a plan/planChanges/better/
// worse goes through this pair before the narrative is stored.
// ----------------------------------------------------------------------------

/**
 * Reuse an existing exercise with the same name (case-insensitive) or create
 * one (`createdBy: 'coach'`) for each `narrative.newExercises` entry.
 * `parseResponse` has already validated/clamped every field, so this trusts
 * them as-is. Newly created records are added to the in-memory `existing`
 * list too, so two new exercises in the same reply that share a name (the
 * model should already have deduped, but belt-and-braces) still collapse to
 * one record.
 * @returns {Promise<Map<string,string>>} `new:<key>` → real exercise id; the
 *   returned Map also carries a non-standard `.createdCount` (exercises
 *   actually created, as opposed to matched to an existing one) for callers
 *   that report it (`sendChat`'s `changed.exercises`).
 */
async function materialiseNewExercises(narrative) {
  const idMap = new Map();
  idMap.createdCount = 0;
  const entries = Array.isArray(narrative && narrative.newExercises) ? narrative.newExercises : [];
  if (entries.length === 0) return idMap;
  const existing = await listExercises();
  for (const ne of entries) {
    if (!ne || typeof ne.key !== 'string' || !ne.key || !ne.name) continue;
    const nameLower = ne.name.toLowerCase();
    const match = existing.find((e) => e.name.toLowerCase() === nameLower);
    if (match) {
      idMap.set(`new:${ne.key}`, match.id);
      continue;
    }
    const record = {
      id: uid(),
      name: ne.name,
      muscleGroup: ne.muscleGroup,
      equipment: ne.equipment,
      exerciseType: ne.exerciseType,
      isCustom: true,
      isUnilateral: false,
      targets: ne.targets || null,
      createdBy: 'coach',
      createdAt: nowISO(),
    };
    await putExercise(record);
    existing.push(record); // so a later duplicate in the same batch matches it, not creates a second
    idMap.set(`new:${ne.key}`, record.id);
    idMap.createdCount += 1;
  }
  return idMap;
}

/** Rewrite a `new:<key>` exerciseId to its real id; anything else passes through. */
function rewritePlanSessions(sessions, rewriteId) {
  return sessions.map((s) => ({
    ...s,
    exercises: s.exercises.map((e) => ({ ...e, exerciseId: rewriteId(e.exerciseId) })),
  }));
}

/**
 * Resolve every `new:<key>` exerciseId in a narrative to the real id
 * `materialiseNewExercises` created/matched, before the narrative reaches
 * `storePlan`/`putCoachInsight`/`putChatMessage`. Handles both shapes: a bare
 * plan object (kind 'plan', where the narrative IS the plan) and a session/
 * chat narrative (`.plan`, `.planChanges`, `.better`, `.worse`).
 */
function rewriteNewExerciseIds(narrative, idMap) {
  if (!narrative || !idMap || idMap.size === 0) return narrative;
  const rewriteId = (id) => (idMap.has(id) ? idMap.get(id) : id);
  const out = { ...narrative };
  if (Array.isArray(out.sessions)) out.sessions = rewritePlanSessions(out.sessions, rewriteId);
  if (out.plan && Array.isArray(out.plan.sessions)) {
    out.plan = { ...out.plan, sessions: rewritePlanSessions(out.plan.sessions, rewriteId) };
  }
  if (Array.isArray(out.planChanges)) out.planChanges = out.planChanges.map((c) => ({ ...c, exerciseId: rewriteId(c.exerciseId) }));
  if (Array.isArray(out.better)) out.better = out.better.map((b) => ({ ...b, exerciseId: rewriteId(b.exerciseId) }));
  if (Array.isArray(out.worse)) out.worse = out.worse.map((w) => ({ ...w, exerciseId: rewriteId(w.exerciseId) }));
  return out;
}

// ----------------------------------------------------------------------------
// Chat — two threads ('home' feedback, 'plan' changes) sharing the memory.
// ----------------------------------------------------------------------------
let chatInFlight = false;
export function chatBusy() { return chatInFlight; }

/** Map a chat reply's profilePatch onto the profile shape saveProfile expects. */
function profileFromPatch(patch) {
  if (!patch || typeof patch !== 'object') return null;
  const out = {};
  for (const k of ['daysPerWeek', 'sessionMinutes', 'injuryNotes', 'equipmentNotes', 'notes', 'split']) {
    if (patch[k] !== null && patch[k] !== undefined) out[k] = patch[k];
  }
  if (typeof patch.cardioInclude === 'boolean') out.cardio = { include: patch.cardioInclude };
  if (typeof patch.coreInclude === 'boolean') out.core = { include: patch.coreInclude };
  return Object.keys(out).length ? out : null;
}

/**
 * Send one message to the coach on a thread. The user message is stored at
 * once (pending) so the panel can show it while the call queues; the reply
 * (or a user-facing error) is stored as the coach message. Resolves to the
 * coach message; rejects only when there is no key or a chat is in flight.
 */
export async function sendChat(thread, text) {
  const t = clipText(text, 1200);
  if (!t) return null;
  if (!hasApiKey()) { const e = new Error('No API key'); e.code = 'auth'; throw e; }
  if (chatInFlight) { const e = new Error('The coach is still replying.'); e.code = 'busy'; throw e; }
  chatInFlight = true;
  const userMsg = {
    id: uid(), thread, role: 'user', createdAt: nowISO(), text: t, points: null,
    planId: null, changed: null, error: null, pending: true,
  };
  await putChatMessage(userMsg);
  notify();
  try {
    return await enqueue('chat', async () => {
      const [profile, dataset, health, plan, memory, history] = await Promise.all([
        getProfile(), loadDataset(), buildHealthInput(), getCurrentPlan(), getMemory(),
        listChatMessages({ thread, limit: CHAT_RECENT * 2 + 2 }),
      ]);
      const today = todayISO();
      const recent = history
        .filter((m) => m.id !== userMsg.id && !m.pending && !m.error && (m.text || (m.points && m.points.length)))
        .slice(0, CHAT_RECENT)
        .reverse()
        .map((m) => ({ role: m.role, text: m.role === 'user' ? m.text : m.points.join(' ') }));
      const digest = buildDigest({
        dataset, profile, today, health, plan, kind: 'chat',
        memory: memoryForDigest(memory), chat: { thread, recent, message: t },
      });
      const base = { id: uid(), thread, role: 'coach', createdAt: nowISO(), text: null, pending: false };
      try {
        const { narrative, usage } = await callCoach({ kind: 'chat', digest, apiKey: apiKeyOrThrow() });
        const idMap = await materialiseNewExercises(narrative);
        const rewritten = rewriteNewExerciseIds(narrative, idMap);
        const changed = { plan: false, profile: false, memory: false, exercises: idMap.createdCount };
        let planId = plan ? plan.id : null;
        const mem = await applyMemoryUpdates(rewritten.memoryUpdates, `chat-${thread}`);
        changed.memory = mem.added + mem.removed > 0;
        const patch = profileFromPatch(rewritten.profilePatch);
        if (patch) { await saveProfile(patch); changed.profile = true; }
        const changes = Array.isArray(rewritten.planChanges) ? rewritten.planChanges : [];
        if (rewritten.plan && (thread === 'plan' || changes.length > 0)) {
          const rec = await storePlan(rewritten.plan, { source: 'revised', basedOnWorkoutId: null, today });
          planId = rec.id;
          changed.plan = true;
        }
        await putChatMessage({ ...userMsg, pending: false });
        const coachMsg = { ...base, points: rewritten.reply, planId, changed, error: null, planChanges: changes };
        await putChatMessage(coachMsg);
        await recordUsage(usage);
        await setMeta('coach.lastError', null);
        notify();
        return coachMsg;
      } catch (err) {
        await putChatMessage({ ...userMsg, pending: false });
        const coachMsg = { ...base, points: null, planId: null, changed: null, error: userMessageFor(err), planChanges: [] };
        await putChatMessage(coachMsg);
        await recordError(err);
        return coachMsg;
      }
    });
  } finally {
    chatInFlight = false;
    notify();
  }
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
/** One "is there anything to do?" pass: flush the retry slot, then the date-gated daily. */
async function tick() {
  if (!hasApiKey()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  try {
    await flushPending();
    await runDaily();
  } catch (e) { console.error('coach: tick failed', e); }
}
/**
 * Called from ui.js init() (fire-and-forget) and again from Settings after a
 * key is saved. Listeners are registered once; every call runs a tick, which
 * the idempotency gates make cheap.
 */
export async function initCoach() {
  if (!initialised) {
    initialised = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { tick(); });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
    }
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
  const today = todayISO();
  const dataset = await loadDataset();
  let nextSession = null;
  let currentWeek = null;
  let projected = null;
  if (plan) {
    const next = nextPlanSession(plan, finishedNewestFirst(dataset.workouts));
    currentWeek = currentPlanWeek(plan, today);
    projected = projectPlanWeek(plan, currentWeek);
    nextSession = next ? (projected.sessions.find((s) => s.id === next.id) || next) : null;
  }
  const latestDaily = dailies[0] || null;
  const memory = await getMemory();
  return {
    enabled, hasProfile: !!profile, profile, plan, nextSession, currentWeek, projected,
    todayInsight: latestDaily && latestDaily.date === today ? latestDaily : null,
    latestDaily, latestSession: sessions[0] || null,
    pending: pending || null, lastError: lastError || null, unreadAt: unreadAt || null,
    usageTotals: usageTotals || null, shareRecovery, running,
    memoryCount: memory.length,
    recentPRs: recentPRs(dataset, { today, days: 7 }),
    chatBusy: chatInFlight,
  };
}

/** The current-week projection of the plan in force (or [] without one). */
export async function currentPlanSessions() {
  const plan = await getCurrentPlan();
  return plan ? projectedSessions(plan, todayISO()) : [];
}

/** Settings → Coach → Clear. Keeps the recovery consent; optionally the key. */
export async function clearCoachData({ keepKey = true } = {}) {
  await dbClearCoachData();
  if (!keepKey) setStringSetting('coachApiKey', '');
  authFailed = false;
  notify();
}
