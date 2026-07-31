// Apple Health bridge. The ONLY file that touches
// window.Capacitor.Plugins.HealthKit (PLAN.md §"Phase N", N2).
//
// Everything here is progressive enhancement: in the PWA there is no Capacitor
// and no plugin, so every entry point is a cheap no-op and the web app behaves
// exactly as it did before. Health data is on-device only — it is written to the
// local `health` store and never leaves the phone.
//
// Layering, so the logic is testable under plain `node` with no IndexedDB and no
// Capacitor:
//   - the pure section (validation, sleep-night aggregation, weight trend,
//     cardio kcal) works on plain arrays and is exported for tests/health.test.mjs;
//   - the impure section (plugin calls, meta flags, store writes) wraps it.
//
// Sample shapes and the permitted type list are pinned in db.js
// (HealthSampleRecord / HEALTH_TYPES) — this file never invents a type.

import {
  HEALTH_TYPES,
  putHealthSamples,
  listHealthSamples,
  getLatestHealthSample,
  clearHealthSamples,
  getMeta,
  setMeta,
} from './db.js';
import { todayISO } from './util.js';

/** Backfill window handed to the plugin. Per-type caps are the plugin's job. */
const BACKFILL_DAYS = 365;
/** Burst window for update notifications — a 365-day backfill arrives as many
 *  batches and must not re-render the stats screen once per batch. */
const NOTIFY_DEBOUNCE_MS = 300;

const DAY_MS = 86400000;
const SLEEP_WINDOW_MS = 24 * 3600 * 1000;
/** Sleep stages that count as actually asleep. 'inBed' and 'awake' do not. */
const ASLEEP_STAGES = ['asleepCore', 'asleepDeep', 'asleepREM'];

// ---------------------------------------------------------------------------
// Pure logic (no DOM, no IndexedDB, no Capacitor — safe to unit test in Node)
// ---------------------------------------------------------------------------

/**
 * Minimal shape check on a sample arriving from the plugin. We trust the plugin
 * for units, but not for structure: a malformed record would poison the store
 * (keyPath 'id') or the by-type-start index.
 * @returns {boolean}
 */
export function isValidSample(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.id !== 'string' || s.id === '') return false;
  if (!HEALTH_TYPES.includes(s.type)) return false;
  if (typeof s.startedAt !== 'string' || !Number.isFinite(Date.parse(s.startedAt))) return false;
  return true;
}

/**
 * Split a delivered batch into storable records and a dropped count. Invalid
 * samples are discarded silently per-record (the caller logs one warn per batch)
 * — one bad sample must never cost us the other 499.
 * Normalises a missing/unparseable endedAt to startedAt so downstream date maths
 * (sleep windows) can rely on it; everything else is stored verbatim, which is
 * what keeps re-delivery an idempotent upsert.
 * @param {any[]} samples
 * @returns {{valid: Object[], dropped: number}}
 */
export function validateSamples(samples) {
  const valid = [];
  let dropped = 0;
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!isValidSample(s)) {
      dropped += 1;
      continue;
    }
    const endedAt = typeof s.endedAt === 'string' && Number.isFinite(Date.parse(s.endedAt))
      ? s.endedAt
      : s.startedAt;
    valid.push({ ...s, endedAt });
  }
  return { valid, dropped };
}

/**
 * Strict numeric coercion for sample values. Deliberately NOT `Number(v)`:
 * Number(null) and Number('') are 0, which would turn a missing reading into a
 * real-looking zero (a 0 kg bodyweight, a 0 kcal day).
 * @returns {number|null}
 */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Local calendar date (YYYY-MM-DD) of an ISO datetime. */
function localDateOf(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Aggregate last night's sleep from sleepAnalysis samples.
 *
 * Apple delivers sleep as many short stage segments; a "night" here is simply
 * every segment that ENDED in the last 24 hours, which handles naps, split
 * nights and a late lie-in without needing a session-stitching heuristic.
 *
 * 'inBed' is excluded from totalAsleepSeconds (it overlaps the asleep stages and
 * would double-count); it is not reported at all. Returns null when nothing is
 * in the window, and also when the window contains only inBed/awake time — a
 * night we can't say anything about should render as "no data", not "0h".
 *
 * @param {Object[]} samples sleepAnalysis HealthSampleRecords (any order)
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {{totalAsleepSeconds:number, deepSeconds:number, remSeconds:number,
 *            coreSeconds:number, awakeSeconds:number, endedAt:string}|null}
 */
export function sleepNightFrom(samples, now = Date.now()) {
  const cutoff = now - SLEEP_WINDOW_MS;
  const byStage = { asleepCore: 0, asleepDeep: 0, asleepREM: 0, awake: 0 };
  let latestEnd = null;
  let counted = 0;

  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || s.type !== 'sleepAnalysis') continue;
    const endIso = s.endedAt ?? s.startedAt;
    const end = Date.parse(endIso);
    if (!Number.isFinite(end) || end < cutoff) continue;
    const stage = s.meta?.stage;
    const seconds = num(s.value);
    if (seconds === null || seconds < 0) continue;
    counted += 1;
    if (latestEnd === null || end > latestEnd.at) latestEnd = { at: end, iso: endIso };
    if (stage in byStage) byStage[stage] += seconds;
    // 'inBed' (and anything unrecognised) is deliberately ignored.
  }

  if (!counted || latestEnd === null) return null;
  const totalAsleepSeconds = ASLEEP_STAGES.reduce((sum, st) => sum + byStage[st], 0);
  if (totalAsleepSeconds === 0) return null;

  return {
    totalAsleepSeconds,
    deepSeconds: byStage.asleepDeep,
    remSeconds: byStage.asleepREM,
    coreSeconds: byStage.asleepCore,
    awakeSeconds: byStage.awake,
    endedAt: latestEnd.iso,
  };
}

/**
 * Latest bodyweight plus the trend line the stats screen plots.
 * Trend is the last `days` days, oldest→newest (chart order); latestKg is the
 * newest reading whether or not it falls inside that window, so a stale weight
 * still shows a number rather than nothing.
 * @param {Object[]} samples bodyMass HealthSampleRecords (any order)
 * @returns {{latestKg:number, at:string, trend:Array<{at:string, kg:number}>}|null}
 */
export function weightTrendFrom(samples, now = Date.now(), days = 30) {
  const usable = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && s.type === 'bodyMass' && num(s.value) !== null
      && Number.isFinite(Date.parse(s.startedAt)))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (!usable.length) return null;

  const cutoff = now - days * DAY_MS;
  const trend = usable
    .filter((s) => Date.parse(s.startedAt) >= cutoff)
    .map((s) => ({ at: s.startedAt, kg: num(s.value) }));
  const latest = usable[usable.length - 1];
  return { latestKg: num(latest.value), at: latest.startedAt, trend };
}

/**
 * Today's active energy, from the daily-total samples the plugin writes with
 * deterministic ids (`activeEnergy-YYYY-MM-DD`). Matches on the id first and
 * falls back to the sample's local date.
 * @returns {{kcal:number}|null}
 */
export function activeEnergyTodayFrom(samples, localDate) {
  const wanted = `activeEnergy-${localDate}`;
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || s.type !== 'activeEnergy') continue;
    const kcal = num(s.value);
    if (kcal === null) continue;
    if (s.id === wanted || localDateOf(s.startedAt) === localDate) return { kcal };
  }
  return null;
}

/**
 * Total energy for an HKWorkout, summed from the session's cardio sets.
 * Strength sets carry no kcal, so a pure lifting session sums to zero — return
 * null there and let HealthKit compute nothing rather than record a 0 kcal
 * workout.
 * @param {Object[]} sets SetRecords
 * @returns {number|null}
 */
export function cardioKcalFrom(sets) {
  let total = 0;
  for (const s of Array.isArray(sets) ? sets : []) {
    if (!s || s.setType !== 'cardio') continue;
    const kcal = num(s.kcal);
    if (kcal !== null && kcal > 0) total += kcal;
  }
  return total > 0 ? total : null;
}

// ---------------------------------------------------------------------------
// Plugin plumbing
// ---------------------------------------------------------------------------

/** The plugin object, or undefined off-native. */
function hk() {
  if (typeof window === 'undefined') return undefined;
  return window.Capacitor?.Plugins?.HealthKit;
}

/**
 * True only inside the native shell with the HealthKit plugin registered.
 * Every public entry point gates on this — in the browser PWA it is false and
 * nothing else in this module runs.
 * @returns {boolean}
 */
export function healthAvailable() {
  if (typeof window === 'undefined') return false;
  return !!window.Capacitor?.isNativePlatform?.() && !!window.Capacitor?.Plugins?.HealthKit;
}

/** Whether the user has been through the connect flow. */
async function isConnected() {
  return (await getMeta('healthConnected')) === true;
}

// ---- update notifications --------------------------------------------------

const subscribers = new Set();
let notifyTimer = null;

/**
 * Subscribe to "new health data landed". Fires after each stored batch,
 * debounced so a backfill's hundreds of batches coalesce into a few renders.
 * @param {() => void} cb
 * @returns {() => void} unsubscribe
 */
export function onHealthUpdate(cb) {
  if (typeof cb !== 'function') return () => {};
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function notifyUpdate() {
  if (notifyTimer !== null) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const cb of [...subscribers]) {
      try {
        cb();
      } catch (err) {
        console.error('[health] update subscriber threw', err);
      }
    }
  }, NOTIFY_DEBOUNCE_MS);
}

// ---- sample events ---------------------------------------------------------

let listenerHandle = null;

/**
 * Handler for the plugin's `samples` event: {type, samples, done}.
 * Never throws — a bad batch must not kill the listener for the session.
 */
async function handleSamplesEvent(payload) {
  try {
    const { valid, dropped } = validateSamples(payload?.samples);
    if (dropped) {
      console.warn(`[health] dropped ${dropped} invalid ${payload?.type ?? 'unknown'} sample(s)`);
    }
    if (valid.length) await putHealthSamples(valid);
    await setMeta('healthLastSyncAt', new Date().toISOString());
    notifyUpdate();
  } catch (err) {
    console.error('[health] failed to store sample batch', err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wire the plugin event listener and resume delta sync. Called once from ui.js
 * at startup; idempotent, and a no-op in the PWA.
 * @returns {Promise<void>}
 */
export async function initHealth() {
  if (!healthAvailable() || listenerHandle) return;
  const plugin = hk();
  try {
    listenerHandle = await plugin.addListener('samples', handleSamplesEvent);
  } catch (err) {
    console.error('[health] could not register samples listener', err);
    return;
  }
  if (await isConnected()) {
    // Anchors live in the plugin, so this resumes where we left off rather than
    // re-importing a year of data on every cold start.
    try {
      await plugin.startSync({ backfillDays: BACKFILL_DAYS });
    } catch (err) {
      console.error('[health] startSync failed on init', err);
    }
  }
}

/**
 * Present the HealthKit permission sheet and begin the backfill. Read denials
 * are invisible by design — we record that the user connected, never that they
 * granted anything.
 * @returns {Promise<void>}
 */
export async function connectHealth() {
  if (!healthAvailable()) return;
  const plugin = hk();
  await plugin.requestAuthorization();
  await setMeta('healthConnected', true);
  await plugin.startSync({ backfillDays: BACKFILL_DAYS });
  notifyUpdate();
}

/**
 * Stop syncing. With {purge: true} also deletes the imported copy — the
 * user-initiated exception to the never-delete rule (see clearHealthSamples).
 * @param {{purge?: boolean}} [opts]
 * @returns {Promise<void>}
 */
export async function disconnectHealth({ purge = false } = {}) {
  const plugin = hk();
  if (plugin) {
    try {
      await plugin.stopSync();
    } catch (err) {
      console.error('[health] stopSync failed', err);
    }
  }
  await setMeta('healthConnected', false);
  if (purge) await clearHealthSamples();
  await setMeta('healthLastSyncAt', null);
  notifyUpdate();
}

/**
 * Manual "Sync now". Cheap: the plugin's anchored queries turn this into a
 * delta after the first backfill.
 * @returns {Promise<void>}
 */
export async function syncNow() {
  if (!healthAvailable() || !(await isConnected())) return;
  await hk().startSync({ backfillDays: BACKFILL_DAYS });
}

/**
 * Settings-screen state.
 * @returns {Promise<{available: boolean, connected: boolean, lastSyncAt: string|null}>}
 */
export async function getHealthState() {
  const available = healthAvailable();
  const connected = (await getMeta('healthConnected')) === true;
  const lastSyncAt = (await getMeta('healthLastSyncAt')) ?? null;
  return { available, connected, lastSyncAt };
}

/**
 * Write a finished gym session to Apple Health. Opt-out via the
 * `healthWriteWorkouts` meta flag (absent ⇒ on).
 * Never throws: finishing a workout must not fail because HealthKit hiccupped.
 * @param {Object} workout WorkoutRecord
 * @param {Object[]} sets SetRecords for that workout
 * @returns {Promise<void>}
 */
export async function saveWorkoutToHealth(workout, sets = []) {
  try {
    if (!healthAvailable()) return;
    if (!(await isConnected())) return;
    if ((await getMeta('healthWriteWorkouts')) === false) return;
    await hk().saveWorkout({
      name: workout?.name ?? null,
      startedAt: workout?.startedAt,
      endedAt: workout?.finishedAt,
      kcal: cardioKcalFrom(sets),
    });
  } catch (err) {
    console.error('[health] saveWorkout failed', err);
  }
}

/**
 * The derived read model the stats screen renders. Derived, never stored.
 * Returns null when not connected (the section is hidden entirely); individual
 * fields are null when that metric has no data, which the UI reports as
 * "No data found", never as "you blocked this".
 * @returns {Promise<Object|null>}
 */
export async function getHealthSummary() {
  if (!(await isConnected())) return null;

  const now = Date.now();
  // Sleep segments are matched on endedAt, so pull a wider startedAt window than
  // the 24h we actually report and let sleepNightFrom do the filtering.
  const sleepSince = new Date(now - 2 * DAY_MS).toISOString();

  const [weights, rhr, hrvSample, vo2, sleepSamples, energySamples] = await Promise.all([
    listHealthSamples('bodyMass', { limit: 200 }),
    getLatestHealthSample('restingHeartRate'),
    getLatestHealthSample('hrv'),
    getLatestHealthSample('vo2max'),
    listHealthSamples('sleepAnalysis', { since: sleepSince, limit: 500 }),
    listHealthSamples('activeEnergy', { limit: 7 }),
  ]);

  const point = (s) => (s ? num(s.value) : null);

  const rhrValue = point(rhr);
  const hrvValue = point(hrvSample);
  const vo2Value = point(vo2);

  return {
    weight: weightTrendFrom(weights, now),
    restingHr: rhrValue === null ? null : { bpm: rhrValue, at: rhr.startedAt },
    hrv: hrvValue === null ? null : { ms: hrvValue, at: hrvSample.startedAt },
    vo2max: vo2Value === null ? null : { value: vo2Value, at: vo2.startedAt },
    sleepLastNight: sleepNightFrom(sleepSamples, now),
    activeEnergyToday: activeEnergyTodayFrom(energySamples, todayISO()),
  };
}
