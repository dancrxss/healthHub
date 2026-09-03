// ============================================================================
// coach-engine.js — the Coach's pure local analysis engine.
//
// EVERY NUMBER IN THIS FILE IS AN EVIDENCE-INFORMED COACHING HEURISTIC, NOT
// MEDICAL ADVICE. The weekly set bands, the return ramp, the detraining curve,
// the double-progression rules and the load flags are rules of thumb drawn from
// mainstream strength-training practice. They are not a diagnosis, not a
// prescription, and not a substitute for a physiotherapist or a doctor —
// especially while returning from injury. The constants are pinned in
// PLAN.md §"Phase C — Coach", C2; changing one is a flagged change.
//
// Purity contract (same as js/calc.js):
//   - no DOM, no IndexedDB, no network, no Date.now();
//   - `today` (ISO date 'YYYY-MM-DD') is always injected, exactly like
//     `weeklyVolumeFrom(dataset, weeks, today)`;
//   - runs unchanged under Node with zero dependencies;
//   - same inputs ⇒ deep-equal output. Everything is sorted explicitly; we
//     never rely on the insertion order of an input array or a Map.
//
// Vocabulary:
//   dataset  = { workouts: WorkoutRecord[], sets: SetRecord[],
//                exercises: ExerciseRecord[] }  (shapes per js/db.js)
//   hard set = !isWarmup && setType !== 'cardio' && reps >= 1
//              (the same exclusion prsFrom/weeklyVolumeFrom use). Warmups and
//              cardio sets are excluded from EVERY count in this file: hard
//              sets, volume, e1RM, PRs, RPE means.
//   Only FINISHED workouts (finishedAt != null) count anywhere. An in-progress
//   workout is not training that happened yet.
//   All weights are kg. Estimated 1RM is Epley: w × (1 + reps/30).
//
// UK English throughout.
// ============================================================================

import { epley1RM, isoWeekOf, prsFrom, lastSessionFrom } from './calc.js';
import { MUSCLE_GROUPS } from './db.js';
import { normalizeExerciseType, fieldsForType } from './exercise-types.js';

/** Engine identity, stored on every CoachInsightRecord. */
export const COACH_ENGINE_VERSION = 'coach-engine-1';

/**
 * Weekly hard-set bands per muscle group (PLAN.md C2).
 * `scored: false` means "never raise a flag for this group" — accessory is
 * advisory and rehab is the physio's business, not the coach's. cardio/other
 * carry no band at all (min/max null) and report status 'unscored'.
 * @type {Object<string, {min: number|null, max: number|null, scored: boolean}>}
 */
export const SET_TARGETS = {
  chest: { min: 10, max: 20, scored: true },
  back: { min: 10, max: 20, scored: true },
  legs: { min: 12, max: 22, scored: true },
  shoulders: { min: 8, max: 16, scored: true },
  biceps: { min: 6, max: 16, scored: true },
  triceps: { min: 6, max: 16, scored: true },
  abs: { min: 4, max: 12, scored: true },
  accessory: { min: 0, max: 12, scored: false },
  rehab: { min: 0, max: 20, scored: false },
  cardio: { min: null, max: null, scored: false },
  other: { min: null, max: null, scored: false },
};

/** Band multiplier by week since return, index `min(weeksTrained - 1, 5)`. */
export const RAMP_FACTORS = [0.4, 0.5, 0.65, 0.8, 0.9, 1.0];

/**
 * Fraction of the pre-layoff working weight to restart at, by weeks off.
 * `maxWeeksOff: null` is the open-ended final band.
 * @type {Array<{maxWeeksOff: number|null, factor: number}>}
 */
export const START_FACTORS = [
  { maxWeeksOff: 2, factor: 0.95 },
  { maxWeeksOff: 4, factor: 0.85 },
  { maxWeeksOff: 8, factor: 0.75 },
  { maxWeeksOff: 16, factor: 0.65 },
  { maxWeeksOff: null, factor: 0.6 },
];

/** Every flag code `loadFlags` can emit. */
export const FLAG_CODES = [
  'volume-spike',
  'group-volume-spike',
  'rpe-creep',
  'e1rm-regression',
  'no-rest-day',
  'frequency-drop',
  'return-ramp',
  'low-hrv',
  'elevated-rhr',
  'short-sleep',
  'weight-drop',
];

// ---------------------------------------------------------------------------
// Tunables (heuristics — see the header)
// ---------------------------------------------------------------------------

/** A break of this many days or more ends a training block. */
const GAP_DAYS = 10;
/** Gap status bands, in days since the last session. */
const LAYOFF_DAYS = 10;
const LONG_LAYOFF_DAYS = 20;
/** Weeks of history the layoff restart weight is read from. */
const PRE_GAP_WEEKS = 12;

/** Spike thresholds: ratio of this week to the mean of the prior three. */
const SPIKE_WATCH = 1.3;
const SPIKE_WARN = 1.5;
/** A spike needs a meaningful base to be a spike at all. */
const SPIKE_MIN_PRIOR_MEAN = 4;

/** RPE creep: mean up this much on the prior three weeks AND at least this high. */
const RPE_CREEP_DELTA = 0.75;
const RPE_CREEP_FLOOR = 8.5;
const RPE_CREEP_MIN_SETS = 6;

/** e1RM regression: this much down on the previous session for the same lift. */
const E1RM_REGRESSION_PCT = 0.05;

/** Consecutive training days before we mention a rest day. */
const NO_REST_WATCH_DAYS = 4;
const NO_REST_WARN_DAYS = 6;

/** Frequency drop: sessions below this fraction of the pro-rata expectation. */
const FREQUENCY_DROP_RATIO = 0.6;
const FREQUENCY_MIN_PRIOR_MEAN = 2;

/** Health thresholds (all consent-gated by the caller). */
const LOW_HRV_RATIO = 0.8;
const ELEVATED_RHR_DELTA = 5;
const SHORT_SLEEP_HOURS = 6;
const WEIGHT_DROP_PCT = -2;

/** Weight rounding step by equipment. */
const STEP_BY_EQUIPMENT = { barbell: 2.5, machine: 2.5, cable: 2.5, dumbbell: 2, bodyweight: 0, other: 2.5 };
/** Lightest sensible working weight by equipment. */
const FLOOR_BY_EQUIPMENT = { barbell: 20, machine: 2.5, cable: 2.5, dumbbell: 2, bodyweight: 0, other: 2.5 };

/** Rep ranges. Barbell/machine work is treated as the heavy compound lane. */
const RANGE_HEAVY = { low: 6, high: 10 };
const RANGE_LIGHT = { low: 8, high: 12 };

/** Double progression steps. */
const PROGRESSION_MULTIPLIER = 1.025;
const DELOAD_MULTIPLIER = 0.9;
const RPE_EASY_CEILING = 8;
const RPE_GRIND_FLOOR = 9.5;
const BELOW_RANGE_SESSIONS_TO_DELOAD = 3;
/** Cap on weight added to one exercise inside one ISO week. */
const WEEKLY_WEIGHT_CAP = 1.05;

/** Default working sets, and the reduced count during ramp weeks 1–2. */
const DEFAULT_SETS = 3;
const RAMP_SETS = 2;
const RAMP_SETS_UNTIL_WEEK = 2;

/** Digest budget. The API prompt is built from this, so it is a hard cap. */
const DIGEST_MAX_BYTES = 4000;
const DIGEST_EXERCISE_CAP = { daily: 12, session: 12, plan: 20 };
const DIGEST_EXERCISE_FLOOR = 4;
const DIGEST_WINDOW_WEEKS = { daily: 8, session: 8, plan: 16 };
const DIGEST_SESSION_EXERCISE_CAP = 8;
const DIGEST_SESSION_EXERCISE_FLOOR = 3;
const DIGEST_SET_CAP = 6;
const DIGEST_NOTE_CHARS = 160;
/** Below this many trained exercises, a plan digest is topped up from the library. */
const PLAN_MIN_EXERCISES = 8;

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Small pure helpers (not exported)
// ---------------------------------------------------------------------------

/** Whole days since the epoch for an ISO date — safe for differences. */
function dayNum(isoDate) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** ISO date `n` days after `isoDate` (n may be negative). */
function addDays(isoDate, n) {
  const d = new Date((dayNum(isoDate) + n) * DAY_MS);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Monday (ISO date) of the ISO week containing `isoDate`. */
function mondayOf(isoDate) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Mon = 0
  return addDays(isoDate, -dow);
}

/** Trailing `weeks` ISO week ids ending with the week containing `today`. */
function weekRange(weeks, today) {
  const monday = mondayOf(today);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) out.push(isoWeekOf(addDays(monday, -i * 7)));
  return out;
}

function round1(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
}
function round2(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}
function round3(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000;
}

/** Round to a weight step. mode: 'down' | 'up' | 'near'. */
function roundStep(value, step, mode = 'near') {
  if (!step) return round1(value);
  const n = value / step;
  const r = mode === 'down' ? Math.floor(n + 1e-9) : mode === 'up' ? Math.ceil(n - 1e-9) : Math.round(n);
  return round1(r * step);
}

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** A hard (working) set: not a warmup, not cardio, at least one rep. */
function isHardSet(s) {
  return !!s && s.isWarmup !== true && s.setType !== 'cardio' && Number(s.reps) >= 1;
}

/** Map id -> finished WorkoutRecord. */
function finishedWorkoutIndex(dataset) {
  const map = new Map();
  for (const w of dataset.workouts || []) if (w && w.finishedAt != null) map.set(w.id, w);
  return map;
}

/** Map id -> ExerciseRecord. */
function exerciseIndex(dataset) {
  const map = new Map();
  for (const e of dataset.exercises || []) if (e) map.set(e.id, e);
  return map;
}

/** All finished workouts, oldest first, tie-broken by startedAt then id. */
function finishedWorkoutsAsc(dataset) {
  return (dataset.workouts || [])
    .filter((w) => w && w.finishedAt != null)
    .slice()
    .sort(compareWorkoutAsc);
}

function compareWorkoutAsc(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const as = a.startedAt || '';
  const bs = b.startedAt || '';
  if (as !== bs) return as < bs ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Hard sets grouped by workout id (sorted by setNumber then id inside each). */
function hardSetsByWorkout(dataset) {
  const map = new Map();
  for (const s of dataset.sets || []) {
    if (!isHardSet(s)) continue;
    if (!map.has(s.workoutId)) map.set(s.workoutId, []);
    map.get(s.workoutId).push(s);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.setNumber !== b.setNumber ? a.setNumber - b.setNumber : a.id < b.id ? -1 : 1));
  }
  return map;
}

/**
 * Finished sessions containing hard sets of one exercise, NEWEST first.
 * @returns {Array<{workout: Object, sets: Object[]}>}
 */
function sessionsForExercise(dataset, exerciseId) {
  const byWorkout = new Map();
  for (const s of dataset.sets || []) {
    if (s.exerciseId !== exerciseId || !isHardSet(s)) continue;
    if (!byWorkout.has(s.workoutId)) byWorkout.set(s.workoutId, []);
    byWorkout.get(s.workoutId).push(s);
  }
  const out = [];
  for (const w of finishedWorkoutsAsc(dataset)) {
    const sets = byWorkout.get(w.id);
    if (!sets || !sets.length) continue;
    out.push({
      workout: w,
      sets: sets.slice().sort((a, b) => (a.setNumber !== b.setNumber ? a.setNumber - b.setNumber : a.id < b.id ? -1 : 1)),
    });
  }
  out.reverse(); // newest first
  return out;
}

/** Best Epley estimate across a list of sets, or null. */
function bestE1rmOf(sets) {
  let best = null;
  for (const s of sets) {
    const e = epley1RM(s.weightKg, s.reps);
    if (best === null || e > best) best = e;
  }
  return best;
}

/** The set with the highest Epley estimate (ties → lowest setNumber). */
function topSetOf(sets) {
  let best = null;
  let bestE = -Infinity;
  for (const s of sets) {
    const e = epley1RM(s.weightKg, s.reps);
    if (e > bestE) {
      bestE = e;
      best = s;
    }
  }
  return best;
}

/** `{w, r, rpe}` view of a set, or null. */
function setView(s) {
  return s ? { w: round1(s.weightKg), r: s.reps, rpe: s.rpe == null ? null : round1(s.rpe) } : null;
}

/** Mean RPE across sets that carry one, or null. */
function avgRpeOf(sets) {
  const vals = sets.filter((s) => s.rpe != null && Number.isFinite(Number(s.rpe))).map((s) => Number(s.rpe));
  return vals.length ? round2(mean(vals)) : null;
}

/** Σ weight × reps. */
function volumeOf(sets) {
  return sets.reduce((sum, s) => sum + s.weightKg * s.reps, 0);
}

/** Exercise types that log reps — the only ones the progression engine scores. */
function isRepType(exerciseType) {
  return fieldsForType(normalizeExerciseType(exerciseType)).includes('reps');
}

/** True for bodyweight-ish exercises, where the bar weight is not the lever. */
function isBodyweightish(exercise) {
  const type = normalizeExerciseType(exercise ? exercise.exerciseType : null);
  if (type === 'reps' || type.startsWith('bw_')) return true;
  return (exercise && exercise.equipment) === 'bodyweight';
}

function stepFor(exercise) {
  if (isBodyweightish(exercise)) return 0;
  const eq = (exercise && exercise.equipment) || 'other';
  return STEP_BY_EQUIPMENT[eq] != null ? STEP_BY_EQUIPMENT[eq] : 2.5;
}

function floorFor(exercise) {
  if (isBodyweightish(exercise)) return 0;
  const eq = (exercise && exercise.equipment) || 'other';
  return FLOOR_BY_EQUIPMENT[eq] != null ? FLOOR_BY_EQUIPMENT[eq] : 2.5;
}

function rangeFor(exercise) {
  if (isBodyweightish(exercise)) return RANGE_LIGHT;
  const eq = (exercise && exercise.equipment) || 'other';
  return eq === 'barbell' || eq === 'machine' ? RANGE_HEAVY : RANGE_LIGHT;
}

function startFactorFor(weeksOff) {
  const w = weeksOff == null ? 999 : weeksOff;
  for (const band of START_FACTORS) {
    if (band.maxWeeksOff === null || w <= band.maxWeeksOff) return band.factor;
  }
  return START_FACTORS[START_FACTORS.length - 1].factor;
}

/** Ramp multiplier for the weekly bands. Only the return-from-injury goal ramps. */
function rampFactorFor(profile, weeksTrained) {
  if (!profile || profile.goal !== 'return-from-injury') return 1;
  if (weeksTrained == null) return RAMP_FACTORS[0];
  const idx = Math.min(Math.max(Math.round(weeksTrained) - 1, 0), RAMP_FACTORS.length - 1);
  return RAMP_FACTORS[idx];
}

/**
 * Weeks (1-based) since the athlete returned to training.
 * `profile.returnDate` wins when set; otherwise the current block's first
 * finished session (the one after the most recent gap ≥ GAP_DAYS) is the start.
 * 0 while the athlete is currently inside a gap — they have not returned yet.
 * null when there is no finished training at all.
 * @returns {number|null}
 */
function weeksSinceReturn(dataset, profile, today) {
  if (profile && profile.returnDate) {
    const days = dayNum(today) - dayNum(profile.returnDate);
    return Math.max(1, Math.floor(Math.max(0, days) / 7) + 1);
  }
  const finished = finishedWorkoutsAsc(dataset);
  if (!finished.length) return null;
  const last = finished[finished.length - 1];
  if (dayNum(today) - dayNum(last.date) >= GAP_DAYS) return 0;
  let blockStart = finished[0].date;
  for (let i = 1; i < finished.length; i++) {
    if (dayNum(finished[i].date) - dayNum(finished[i - 1].date) >= GAP_DAYS) blockStart = finished[i].date;
  }
  return Math.max(1, Math.floor((dayNum(today) - dayNum(blockStart)) / 7) + 1);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * The weekly hard-set band for every muscle group, after the return ramp and
 * the low-frequency scaling.
 *
 * The ramp applies only when `profile.goal === 'return-from-injury'`; callers
 * derive `weeksTrained` from `profile.returnDate` when it is set, otherwise
 * from the first finished workout after the most recent gap ≥ 10 days (this is
 * exactly what `trainingGap().weeksTrained` reports).
 *
 * min rounds DOWN and max rounds UP so a rounded band never gets narrower than
 * the raw one. `max` is additionally scaled ×0.85 when `daysPerWeek <= 3` —
 * three sessions is not enough room for a top-of-band week.
 *
 * @param {{goal?: string, daysPerWeek?: number}|null} profile
 * @param {number|null} [weeksTrained] 1-based week since return; null ⇒ no ramp
 * @returns {Object<string, {min: number|null, max: number|null, scored: boolean}>}
 */
export function setTargetsFor(profile, weeksTrained) {
  const ramp = rampFactorFor(profile, weeksTrained == null ? null : weeksTrained);
  const daysPerWeek = profile && Number.isFinite(profile.daysPerWeek) ? profile.daysPerWeek : 3;
  const maxScale = daysPerWeek <= 3 ? 0.85 : 1;
  const out = {};
  for (const group of MUSCLE_GROUPS) {
    const band = SET_TARGETS[group] || { min: null, max: null, scored: false };
    if (band.min === null || band.max === null) {
      out[group] = { min: null, max: null, scored: false };
      continue;
    }
    out[group] = {
      min: Math.floor(band.min * ramp),
      max: Math.ceil(band.max * ramp * maxScale),
      scored: band.scored,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weekly hard sets
// ---------------------------------------------------------------------------

/**
 * Hard sets per muscle group per ISO week, for the trailing `weeks` weeks
 * INCLUDING the week containing `today`, oldest first, zero-filled for every
 * MUSCLE_GROUP. Finished workouts only; warmups and cardio sets never count.
 *
 * @param {{workouts: Object[], sets: Object[], exercises: Object[]}} dataset
 * @param {number} weeks
 * @param {string} today ISO date
 * @returns {Array<{isoWeek: string, perGroup: Object<string, number>}>}
 */
export function hardSetsByGroup(dataset, weeks, today) {
  const weekIds = weekRange(weeks, today);
  const byWeek = new Map();
  for (const wk of weekIds) {
    const per = {};
    for (const g of MUSCLE_GROUPS) per[g] = 0;
    byWeek.set(wk, per);
  }
  const workouts = finishedWorkoutIndex(dataset);
  const exercises = exerciseIndex(dataset);
  for (const s of dataset.sets || []) {
    if (!isHardSet(s)) continue;
    const w = workouts.get(s.workoutId);
    if (!w) continue;
    const per = byWeek.get(isoWeekOf(w.date));
    if (!per) continue;
    const ex = exercises.get(s.exerciseId);
    const group = ex ? ex.muscleGroup : null;
    if (group == null || !(group in per)) continue;
    per[group] += 1;
  }
  return weekIds.map((isoWeek) => ({ isoWeek, perGroup: byWeek.get(isoWeek) }));
}

/** Trend label + fraction for one series (last week vs mean of the prior ones). */
function trendOf(weekly) {
  const last = weekly.length ? weekly[weekly.length - 1] : 0;
  const prior = weekly.slice(0, -1).slice(-3);
  const priorMean = prior.length ? mean(prior) : null;
  if (priorMean === null) return { trend: 'flat', trendPct: null, priorMean: null };
  if (priorMean === 0) {
    return last > 0
      ? { trend: 'up', trendPct: null, priorMean: 0 }
      : { trend: 'flat', trendPct: 0, priorMean: 0 };
  }
  const pct = (last - priorMean) / priorMean;
  const trend = pct >= 0.15 ? 'up' : pct <= -0.15 ? 'down' : 'flat';
  return { trend, trendPct: round3(pct), priorMean };
}

/**
 * Muscle-group balance for the current ISO week against the weekly band.
 *
 * status: 'untrained' (0 sets) · 'under' (< 0.75 × min) · 'over' (> max) ·
 * 'on' otherwise · 'unscored' for groups with no band (cardio, other).
 * Note `scored: false` groups (accessory, rehab) still get a status — it is
 * information for the athlete — they are simply never turned into a flag.
 *
 * trend compares the current ISO week with the mean of the prior three;
 * ±15% ⇒ up/down, otherwise flat.
 *
 * @param {Object} dataset
 * @param {{weeks?: number, today: string, profile?: Object|null}} opts
 * @returns {Array<{group: string, sets: number, min: number|null, max: number|null,
 *   status: string, trend: string, trendPct: number|null, weekly: number[]}>}
 *   sorted in MUSCLE_GROUPS order.
 */
export function muscleBalance(dataset, opts = {}) {
  const { weeks = 4, today, profile = null } = opts;
  const series = hardSetsByGroup(dataset, weeks, today);
  const targets = setTargetsFor(profile, weeksSinceReturn(dataset, profile, today));
  return MUSCLE_GROUPS.map((group) => {
    const weekly = series.map((w) => w.perGroup[group] || 0);
    const sets = weekly.length ? weekly[weekly.length - 1] : 0;
    const band = targets[group] || { min: null, max: null };
    const { trend, trendPct } = trendOf(weekly);
    let status;
    if (band.min === null || band.max === null) status = 'unscored';
    else if (sets === 0) status = 'untrained';
    else if (sets < band.min * 0.75) status = 'under';
    else if (sets > band.max) status = 'over';
    else status = 'on';
    return { group, sets, min: band.min, max: band.max, status, trend, trendPct, weekly };
  });
}

// ---------------------------------------------------------------------------
// Training gap
// ---------------------------------------------------------------------------

/**
 * How long since the last finished session, and how much of the previous block
 * is likely to have decayed.
 *
 * status: 'active' (< 10 days) · 'layoff' (10–20) · 'long-layoff' (> 20).
 * detrainingPct = min(0.35, 0.02 × max(0, weeksOff − 2)).
 * weeksTrained: 1-based week of the CURRENT training block; 0 while inside a
 * gap (not returned yet); null when nothing has ever been finished.
 * With no history at all we report 'long-layoff' with detrainingPct 0 — there
 * is no block to have decayed.
 *
 * @param {Object} dataset
 * @param {string} today ISO date
 * @returns {{daysSinceLastSession: number|null, weeksOff: number|null,
 *   status: 'active'|'layoff'|'long-layoff', detrainingPct: number,
 *   lastSessionDate: string|null, weeksTrained: number|null}}
 */
export function trainingGap(dataset, today) {
  const finished = finishedWorkoutsAsc(dataset);
  if (!finished.length) {
    return {
      daysSinceLastSession: null,
      weeksOff: null,
      status: 'long-layoff',
      detrainingPct: 0,
      lastSessionDate: null,
      weeksTrained: null,
    };
  }
  const lastSessionDate = finished[finished.length - 1].date;
  const days = Math.max(0, dayNum(today) - dayNum(lastSessionDate));
  const weeksOff = Math.floor(days / 7);
  const status = days > LONG_LAYOFF_DAYS ? 'long-layoff' : days >= LAYOFF_DAYS ? 'layoff' : 'active';
  const detrainingPct = round3(Math.min(0.35, 0.02 * Math.max(0, weeksOff - 2)));
  return {
    daysSinceLastSession: days,
    weeksOff,
    status,
    detrainingPct,
    lastSessionDate,
    weeksTrained: weeksSinceReturn(dataset, null, today),
  };
}

// ---------------------------------------------------------------------------
// Session diff
// ---------------------------------------------------------------------------

/** Ordered exercise ids for a workout: `entries` order, else first-set order. */
function exerciseOrderFor(workout, sets) {
  const present = new Set(sets.map((s) => s.exerciseId));
  const out = [];
  if (Array.isArray(workout.entries)) {
    for (const e of workout.entries) {
      if (e && present.has(e.exerciseId) && !out.includes(e.exerciseId)) out.push(e.exerciseId);
    }
  }
  const rest = [...present].filter((id) => !out.includes(id));
  const firstAt = new Map();
  for (const s of sets) {
    const at = s.completedAt || '';
    const cur = firstAt.get(s.exerciseId);
    if (cur === undefined || at < cur) firstAt.set(s.exerciseId, at);
  }
  rest.sort((a, b) => {
    const av = firstAt.get(a) || '';
    const bv = firstAt.get(b) || '';
    if (av !== bv) return av < bv ? -1 : 1;
    return a < b ? -1 : 1;
  });
  return out.concat(rest);
}

/** Verdict from the e1RM and volume movement. See the thresholds inline. */
function verdictFor({ e1rm, e1rmPrev, volumeKg, volumePrevKg, reps, repsPrev }) {
  const e1Pct = e1rmPrev != null && e1rmPrev > 0 && e1rm != null ? (e1rm - e1rmPrev) / e1rmPrev : null;
  // Bodyweight work sits at weight 0, so volume is 0 too — fall back to reps.
  const volPct =
    volumePrevKg > 0
      ? (volumeKg - volumePrevKg) / volumePrevKg
      : repsPrev > 0
        ? (reps - repsPrev) / repsPrev
        : null;
  if (e1Pct !== null && e1Pct >= 0.02) return 'better';
  if ((e1Pct === null || Math.abs(e1Pct) < 0.02) && volPct !== null && volPct >= 0.05) return 'better';
  if (e1Pct !== null && e1Pct <= -0.02) return 'worse';
  if (volPct !== null && volPct <= -0.1) return 'worse';
  return 'same';
}

/**
 * What changed in one session, exercise by exercise, against the most recent
 * earlier FINISHED session containing that exercise.
 *
 * Verdict: 'new' with no previous session; 'better' when e1RM is up ≥ 2%, or
 * e1RM is flat (±2%) and volume is up ≥ 5%; 'worse' when e1RM is down ≥ 2% or
 * volume is down ≥ 10%; 'same' otherwise. Warmup and cardio sets are excluded
 * from every number here.
 *
 * @param {Object} dataset
 * @param {string} workoutId
 * @returns {{workoutId: string, date: string, name: string, durationMin: number|null,
 *   hardSets: number, volumeKg: number, avgRpe: number|null, exercises: Array<Object>}|null}
 *   null when the workout does not exist.
 */
export function sessionDiff(dataset, workoutId) {
  const workout = (dataset.workouts || []).find((w) => w && w.id === workoutId);
  if (!workout) return null;
  const exercises = exerciseIndex(dataset);
  const allSets = (dataset.sets || []).filter((s) => s.workoutId === workoutId);
  const hard = allSets.filter(isHardSet).sort((a, b) => (a.setNumber !== b.setNumber ? a.setNumber - b.setNumber : a.id < b.id ? -1 : 1));

  const durationMin =
    workout.finishedAt && workout.startedAt
      ? Math.max(0, Math.round((Date.parse(workout.finishedAt) - Date.parse(workout.startedAt)) / 60000))
      : null;

  // "Previous" = the newest finished workout containing that exercise that
  // started strictly before this one (lastSessionFrom semantics, time-boxed).
  const priorDataset = {
    workouts: (dataset.workouts || []).filter(
      (w) => w.finishedAt != null && w.id !== workoutId && (w.startedAt || w.date) < (workout.startedAt || workout.date)
    ),
    sets: dataset.sets || [],
    exercises: dataset.exercises || [],
  };

  const out = [];
  for (const exId of exerciseOrderFor(workout, hard)) {
    const mine = hard.filter((s) => s.exerciseId === exId);
    if (!mine.length) continue;
    const ex = exercises.get(exId) || null;
    const prevSession = lastSessionFrom(priorDataset, exId);
    const prevHard = prevSession ? prevSession.sets.filter(isHardSet) : [];

    const volumeKg = volumeOf(mine);
    const volumePrevKg = prevHard.length ? volumeOf(prevHard) : null;
    const e1rm = bestE1rmOf(mine);
    const e1rmPrev = prevHard.length ? bestE1rmOf(prevHard) : null;
    const top = topSetOf(mine);
    const prevTop = prevHard.length ? topSetOf(prevHard) : null;

    let repsAtSameWeight = null;
    if (top && prevTop && top.weightKg === prevTop.weightKg) {
      const bestReps = (list, w) => Math.max(...list.filter((s) => s.weightKg === w).map((s) => s.reps));
      repsAtSameWeight = { reps: bestReps(mine, top.weightKg), prevReps: bestReps(prevHard, prevTop.weightKg) };
    }

    const verdict = !prevHard.length
      ? 'new'
      : verdictFor({
          e1rm,
          e1rmPrev,
          volumeKg,
          volumePrevKg: volumePrevKg || 0,
          reps: mine.reduce((n, s) => n + s.reps, 0),
          repsPrev: prevHard.reduce((n, s) => n + s.reps, 0),
        });

    out.push({
      id: exId,
      name: ex ? ex.name : exId,
      group: ex ? ex.muscleGroup : null,
      verdict,
      volumeKg: round1(volumeKg),
      volumePrevKg: volumePrevKg == null ? null : round1(volumePrevKg),
      e1rm: round1(e1rm),
      e1rmPrev: e1rmPrev == null ? null : round1(e1rmPrev),
      topSet: setView(top),
      prevTop: setView(prevTop),
      repsAtSameWeight,
      avgRpe: avgRpeOf(mine),
      prevAvgRpe: prevHard.length ? avgRpeOf(prevHard) : null,
      sets: mine.slice(0, DIGEST_SET_CAP).map(setView),
    });
  }

  return {
    workoutId,
    date: workout.date,
    name: workout.name || workout.date,
    durationMin,
    hardSets: hard.length,
    volumeKg: round1(volumeOf(hard)),
    avgRpe: avgRpeOf(hard),
    exercises: out,
  };
}

// ---------------------------------------------------------------------------
// Load flags
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { warn: 0, watch: 1, info: 2 };

/** Per-ISO-week totals for the trailing `weeks` weeks, oldest first. */
function weeklyTotals(dataset, weeks, today) {
  const weekIds = weekRange(weeks, today);
  const idx = new Map(weekIds.map((wk, i) => [wk, i]));
  const rows = weekIds.map((isoWeek) => ({
    isoWeek,
    sessions: 0,
    hardSets: 0,
    volumeKg: 0,
    rpeSum: 0,
    rpeCount: 0,
  }));
  const workouts = finishedWorkoutIndex(dataset);
  for (const w of workouts.values()) {
    const i = idx.get(isoWeekOf(w.date));
    if (i !== undefined) rows[i].sessions += 1;
  }
  for (const s of dataset.sets || []) {
    if (!isHardSet(s)) continue;
    const w = workouts.get(s.workoutId);
    if (!w) continue;
    const i = idx.get(isoWeekOf(w.date));
    if (i === undefined) continue;
    rows[i].hardSets += 1;
    rows[i].volumeKg += s.weightKg * s.reps;
    if (s.rpe != null && Number.isFinite(Number(s.rpe))) {
      rows[i].rpeSum += Number(s.rpe);
      rows[i].rpeCount += 1;
    }
  }
  return rows;
}

/** Longest run of consecutive finished training days ending in the last week. */
function consecutiveTrainingDays(dataset, today) {
  const dates = [...new Set(finishedWorkoutsAsc(dataset).map((w) => w.date))].sort();
  if (!dates.length) return null;
  let bestRun = null;
  let runStart = dates[0];
  let runLen = 1;
  for (let i = 1; i <= dates.length; i++) {
    const contiguous = i < dates.length && dayNum(dates[i]) - dayNum(dates[i - 1]) === 1;
    if (contiguous) {
      runLen += 1;
      continue;
    }
    const end = dates[i - 1];
    // Only runs touching the last 7 days are worth mentioning.
    if (dayNum(today) - dayNum(end) <= 7 && (bestRun === null || runLen > bestRun.days)) {
      bestRun = { days: runLen, from: runStart, to: end };
    }
    if (i < dates.length) {
      runStart = dates[i];
      runLen = 1;
    }
  }
  return bestRun;
}

/**
 * Overreaching / under-recovery signals for the current ISO week.
 *
 * All thresholds are pinned in PLAN.md C2. Health flags are only produced when
 * the relevant `health` fields are non-null — the caller is responsible for
 * only passing `health` at all when the athlete has consented to share it.
 * Sorted by severity (warn, watch, info) then code.
 *
 * @param {Object} dataset
 * @param {{today: string, health?: Object|null, profile?: Object|null}} opts
 * @returns {Array<{code: string, severity: 'info'|'watch'|'warn', detail: Object}>}
 */
export function loadFlags(dataset, opts = {}) {
  const { today, health = null, profile = null } = opts;
  const flags = [];
  const rows = weeklyTotals(dataset, 4, today);
  const cur = rows[rows.length - 1];
  const prior = rows.slice(0, -1);
  const priorMeanSets = mean(prior.map((r) => r.hardSets));

  // --- volume-spike -------------------------------------------------------
  if (priorMeanSets !== null && priorMeanSets >= SPIKE_MIN_PRIOR_MEAN) {
    const ratio = cur.hardSets / priorMeanSets;
    if (ratio > SPIKE_WATCH) {
      flags.push({
        code: 'volume-spike',
        severity: ratio > SPIKE_WARN ? 'warn' : 'watch',
        detail: { ratio: round3(ratio), sets: cur.hardSets, priorMean: round1(priorMeanSets) },
      });
    }
  }

  // --- group-volume-spike (scored groups only) ----------------------------
  const groupSeries = hardSetsByGroup(dataset, 4, today);
  for (const group of MUSCLE_GROUPS) {
    if (!SET_TARGETS[group] || !SET_TARGETS[group].scored) continue;
    const weekly = groupSeries.map((w) => w.perGroup[group] || 0);
    const groupPrior = mean(weekly.slice(0, -1));
    const sets = weekly[weekly.length - 1];
    if (groupPrior === null || groupPrior < SPIKE_MIN_PRIOR_MEAN) continue;
    const ratio = sets / groupPrior;
    if (ratio > SPIKE_WATCH) {
      flags.push({
        code: 'group-volume-spike',
        severity: ratio > SPIKE_WARN ? 'warn' : 'watch',
        detail: { group, ratio: round3(ratio), sets, priorMean: round1(groupPrior) },
      });
    }
  }

  // --- rpe-creep ----------------------------------------------------------
  if (cur.rpeCount >= RPE_CREEP_MIN_SETS) {
    const curMean = cur.rpeSum / cur.rpeCount;
    const priorCount = prior.reduce((n, r) => n + r.rpeCount, 0);
    const priorRpeMean = priorCount ? prior.reduce((n, r) => n + r.rpeSum, 0) / priorCount : null;
    if (priorRpeMean !== null && curMean >= priorRpeMean + RPE_CREEP_DELTA && curMean >= RPE_CREEP_FLOOR) {
      flags.push({
        code: 'rpe-creep',
        severity: 'watch',
        detail: { mean: round2(curMean), priorMean: round2(priorRpeMean), sets: cur.rpeCount },
      });
    }
  }

  // --- e1rm-regression ----------------------------------------------------
  const curWeek = isoWeekOf(today);
  const regressed = [];
  for (const ex of (dataset.exercises || []).slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const sessions = sessionsForExercise(dataset, ex.id);
    if (sessions.length < 2) continue;
    if (isoWeekOf(sessions[0].workout.date) !== curWeek) continue;
    const now = bestE1rmOf(sessions[0].sets);
    const before = bestE1rmOf(sessions[1].sets);
    if (!before || before <= 0 || now == null) continue;
    const pct = (now - before) / before;
    if (pct <= -E1RM_REGRESSION_PCT) regressed.push({ id: ex.id, pct: round3(pct) });
  }
  if (regressed.length) {
    regressed.sort((a, b) => (a.pct !== b.pct ? a.pct - b.pct : a.id < b.id ? -1 : 1));
    flags.push({
      code: 'e1rm-regression',
      severity: regressed.length >= 3 ? 'warn' : 'watch',
      detail: { count: regressed.length, worstPct: regressed[0].pct, exerciseIds: regressed.slice(0, 3).map((r) => r.id) },
    });
  }

  // --- no-rest-day --------------------------------------------------------
  const run = consecutiveTrainingDays(dataset, today);
  if (run && run.days >= NO_REST_WATCH_DAYS) {
    flags.push({
      code: 'no-rest-day',
      severity: run.days >= NO_REST_WARN_DAYS ? 'warn' : 'watch',
      detail: { days: run.days, from: run.from, to: run.to },
    });
  }

  // --- frequency-drop -----------------------------------------------------
  // The current ISO week is usually partial, so compare against a pro-rata
  // expectation rather than a whole week's worth of sessions.
  const priorMeanSessions = mean(prior.map((r) => r.sessions));
  if (priorMeanSessions !== null && priorMeanSessions >= FREQUENCY_MIN_PRIOR_MEAN) {
    const elapsed = Math.min(7, dayNum(today) - dayNum(mondayOf(today)) + 1);
    const expected = (priorMeanSessions * elapsed) / 7;
    if (expected > 0 && cur.sessions < FREQUENCY_DROP_RATIO * expected) {
      flags.push({
        code: 'frequency-drop',
        severity: 'info',
        detail: { sessions: cur.sessions, expected: round1(expected), priorMean: round1(priorMeanSessions) },
      });
    }
  }

  // --- return-ramp --------------------------------------------------------
  const gap = trainingGap(dataset, today);
  const weeksTrained = weeksSinceReturn(dataset, profile, today);
  if (gap.status !== 'active' || (weeksTrained != null && weeksTrained <= 6)) {
    flags.push({
      code: 'return-ramp',
      severity: 'info',
      detail: {
        status: gap.status,
        weeksOff: gap.weeksOff,
        weeksTrained,
        rampFactor: rampFactorFor(profile, weeksTrained),
        detrainingPct: gap.detrainingPct,
      },
    });
  }

  // --- health -------------------------------------------------------------
  if (health) {
    if (health.hrvMs != null && health.hrvBaselineMs != null && health.hrvBaselineMs > 0) {
      const ratio = health.hrvMs / health.hrvBaselineMs;
      if (ratio < LOW_HRV_RATIO) {
        flags.push({
          code: 'low-hrv',
          severity: 'watch',
          detail: { hrvMs: round1(health.hrvMs), baselineMs: round1(health.hrvBaselineMs), ratio: round3(ratio) },
        });
      }
    }
    if (health.restingHr != null && health.restingHrBaseline != null) {
      const delta = health.restingHr - health.restingHrBaseline;
      if (delta >= ELEVATED_RHR_DELTA) {
        flags.push({
          code: 'elevated-rhr',
          severity: 'watch',
          detail: { restingHr: round1(health.restingHr), baseline: round1(health.restingHrBaseline), delta: round1(delta) },
        });
      }
    }
    if (health.sleepH != null && health.sleepH < SHORT_SLEEP_HOURS) {
      flags.push({ code: 'short-sleep', severity: 'watch', detail: { sleepH: round1(health.sleepH) } });
    }
    if (health.weightTrend30dPct != null && health.weightTrend30dPct < WEIGHT_DROP_PCT) {
      flags.push({
        code: 'weight-drop',
        severity: 'watch',
        detail: { trendPct: round1(health.weightTrend30dPct), weightKg: health.weightKg == null ? null : round1(health.weightKg) },
      });
    }
  }

  flags.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const ag = (a.detail && a.detail.group) || '';
    const bg = (b.detail && b.detail.group) || '';
    return ag < bg ? -1 : ag > bg ? 1 : 0;
  });
  return flags;
}

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

/** The heaviest working weight of a session and the reps/RPE achieved on it. */
function topWorkingSetsOf(sets) {
  const topWeight = Math.max(...sets.map((s) => s.weightKg));
  const top = sets.filter((s) => s.weightKg === topWeight);
  const rpes = top.filter((s) => s.rpe != null).map((s) => Number(s.rpe));
  return {
    weightKg: topWeight,
    reps: Math.min(...top.map((s) => s.reps)),
    maxRpe: rpes.length ? Math.max(...rpes) : null,
  };
}

/**
 * What to put on the bar next for one exercise.
 *
 * rule:
 *   'first-time'              no history at all;
 *   'layoff-restart'          coming back from a gap — START_FACTORS × the
 *                             median working weight of the highest-e1RM session
 *                             in the 12 weeks before the gap, rounded DOWN;
 *   'double-progression-up'   top of the range on every working set at RPE ≤ 8
 *                             (or unrecorded) — add ×1.025, at least one step;
 *   'double-progression-reps' inside the range — hold the weight, chase one
 *                             more rep (repsLow = achieved + 1);
 *   'double-progression-hold' short of the range once or twice, or RPE ≥ 9.5;
 *   'deload'                  short of the range three sessions running — −10%;
 *   'unscored'                the exercise type logs no reps (cardio, time,
 *                             distance and notes types) — nothing to progress.
 *
 * Weight rounding steps come from `exercise.equipment`: 2.5 kg for barbell,
 * machine and cable, 2 kg for dumbbells, none for bodyweight work. Increases
 * are additionally capped at +5% on the exercise's first working weight of the
 * current ISO week.
 *
 * @param {Object} dataset
 * @param {string} exerciseId
 * @param {{today: string, profile?: Object|null, gap?: Object|null}} opts
 * @returns {{weightKg: number|null, repsLow: number|null, repsHigh: number|null,
 *   sets: number, rule: string}|null} null when the exercise is not in the library.
 */
export function progressionFor(dataset, exerciseId, opts = {}) {
  const { today, profile = null } = opts;
  const exercise = exerciseIndex(dataset).get(exerciseId) || null;
  if (!exercise) return null;

  if (!isRepType(exercise.exerciseType)) {
    return { weightKg: null, repsLow: null, repsHigh: null, sets: 1, rule: 'unscored' };
  }

  const gap = opts.gap || trainingGap(dataset, today);
  const weeksTrained = weeksSinceReturn(dataset, profile, today);
  const ramping = (profile && profile.goal === 'return-from-injury') || gap.status !== 'active';
  const rampWeek = gap.status !== 'active' ? 1 : Math.max(1, weeksTrained || 1);
  const sets = ramping && rampWeek <= RAMP_SETS_UNTIL_WEEK ? RAMP_SETS : DEFAULT_SETS;

  const range = rangeFor(exercise);
  const step = stepFor(exercise);
  const floor = floorFor(exercise);
  const bodyweight = isBodyweightish(exercise);

  const sessions = sessionsForExercise(dataset, exerciseId);
  if (!sessions.length) {
    return { weightKg: bodyweight ? 0 : floor, repsLow: range.low, repsHigh: range.high, sets, rule: 'first-time' };
  }

  // --- coming back from a break ------------------------------------------
  if (gap.status !== 'active') {
    const windowStart = addDays(gap.lastSessionDate, -PRE_GAP_WEEKS * 7);
    const inWindow = sessions.filter((s) => s.workout.date >= windowStart && s.workout.date <= gap.lastSessionDate);
    const pool = inWindow.length ? inWindow : sessions;
    let best = null;
    let bestE = -Infinity;
    for (const s of pool) {
      const e = bestE1rmOf(s.sets);
      // Strictly greater wins and the pool is newest-first, so the most
      // recent of equally strong sessions is the reference.
      if (e != null && e > bestE) {
        bestE = e;
        best = s;
      }
    }
    const reference = median((best || sessions[0]).sets.map((s) => s.weightKg)) || 0;
    const factor = startFactorFor(gap.weeksOff);
    const raw = reference * factor;
    const weightKg = bodyweight ? 0 : Math.max(floor, roundStep(raw, step, 'down'));
    return { weightKg, repsLow: range.low, repsHigh: range.high, sets, rule: 'layoff-restart' };
  }

  // --- active: double progression ----------------------------------------
  const last = topWorkingSetsOf(sessions[0].sets);

  // How many of the most recent sessions in a row fell short of the range?
  let belowRun = 0;
  for (const s of sessions) {
    if (topWorkingSetsOf(s.sets).reps < range.low) belowRun += 1;
    else break;
  }

  if (last.reps >= range.high && (last.maxRpe === null || last.maxRpe <= RPE_EASY_CEILING)) {
    if (bodyweight) {
      // Nothing to load — extend the rep target instead.
      return {
        weightKg: 0,
        repsLow: last.reps + 1,
        repsHigh: Math.max(range.high, last.reps + 3),
        sets,
        rule: 'double-progression-reps',
      };
    }
    let next = roundStep(last.weightKg * PROGRESSION_MULTIPLIER, step, 'near');
    if (next <= last.weightKg) next = round1(last.weightKg + step);
    // +5%/week cap, measured from the first working weight of this ISO week.
    const thisWeek = sessions.filter((s) => isoWeekOf(s.workout.date) === isoWeekOf(today));
    if (thisWeek.length) {
      const weekStart = topWorkingSetsOf(thisWeek[thisWeek.length - 1].sets).weightKg;
      // The cap limits how much is added ACROSS a week; a single minimum
      // step is always allowed, or a 2 kg dumbbell jump could never happen.
      const cap = Math.max(round1(last.weightKg + step), roundStep(weekStart * WEEKLY_WEIGHT_CAP, step, 'down'));
      if (next > cap) next = cap;
    }
    return { weightKg: Math.max(floor, next), repsLow: range.low, repsHigh: range.high, sets, rule: 'double-progression-up' };
  }

  if (belowRun >= BELOW_RANGE_SESSIONS_TO_DELOAD) {
    const weightKg = bodyweight ? 0 : Math.max(floor, roundStep(last.weightKg * DELOAD_MULTIPLIER, step, 'down'));
    return { weightKg, repsLow: range.low, repsHigh: range.high, sets, rule: 'deload' };
  }

  if (last.maxRpe !== null && last.maxRpe >= RPE_GRIND_FLOOR) {
    return { weightKg: bodyweight ? 0 : last.weightKg, repsLow: range.low, repsHigh: range.high, sets, rule: 'double-progression-hold' };
  }

  if (last.reps >= range.low) {
    return {
      weightKg: bodyweight ? 0 : last.weightKg,
      repsLow: Math.min(last.reps + 1, range.high),
      repsHigh: range.high,
      sets,
      rule: 'double-progression-reps',
    };
  }

  return { weightKg: bodyweight ? 0 : last.weightKg, repsLow: range.low, repsHigh: range.high, sets, rule: 'double-progression-hold' };
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

/** Plan sessions sorted by `order`, ties by id — never by array position. */
function planSessionsSorted(plan) {
  const sessions = (plan && Array.isArray(plan.sessions) ? plan.sessions : []).slice();
  sessions.sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 0;
    const bo = Number.isFinite(b.order) ? b.order : 0;
    if (ao !== bo) return ao - bo;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
  return sessions;
}

/**
 * The plan session to run next: the one after the newest finished workout that
 * was tagged with a `planSessionId` still present in the plan, wrapping round
 * the end. Falls back to the first session when nothing matches.
 *
 * @param {{sessions: Array<{id: string, order: number}>}|null} plan
 * @param {Array<{workout: Object, sets: Object[]}|Object>} recentWorkouts
 *   newest first — accepts both the `getRecentWorkouts` wrapper shape and plain
 *   WorkoutRecords. Sorted defensively either way.
 * @returns {Object|null} the PlanSession, or null when the plan has none.
 */
export function nextPlanSession(plan, recentWorkouts) {
  const sessions = planSessionsSorted(plan);
  if (!sessions.length) return null;

  const workouts = (Array.isArray(recentWorkouts) ? recentWorkouts : [])
    .map((r) => (r && r.workout ? r.workout : r))
    .filter((w) => w && w.finishedAt != null)
    .sort((a, b) => -compareWorkoutAsc(a, b)); // newest first

  const byId = new Map(sessions.map((s, i) => [s.id, i]));
  for (const w of workouts) {
    const idx = byId.get(w.planSessionId);
    if (idx !== undefined) return sessions[(idx + 1) % sessions.length];
  }
  return sessions[0];
}

/**
 * The "ghost" reference sets a planned exercise autofills from. The top of the
 * rep range is used deliberately — the placeholder should show the number to
 * beat, not the number to settle for.
 *
 * @param {{targetSets: number, targetRepsHigh: number, targetWeightKg: number|null}|null} planExercise
 * @returns {Array<{weightKg: number, reps: number, durationSeconds: null, distanceM: null, kcal: null}>}
 */
export function planRefSets(planExercise) {
  if (!planExercise) return [];
  const n = Math.max(0, Math.min(8, Math.round(Number(planExercise.targetSets) || 0)));
  const reps = Math.max(0, Math.round(Number(planExercise.targetRepsHigh) || 0));
  const weightKg = planExercise.targetWeightKg == null ? 0 : Number(planExercise.targetWeightKg);
  const out = [];
  for (let i = 0; i < n; i++) out.push({ weightKg, reps, durationSeconds: null, distanceM: null, kcal: null });
  return out;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

function clip(text, max = DIGEST_NOTE_CHARS) {
  if (text == null) return null;
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Rank exercises by sessions in the window, then recency, then id. */
function rankedExercises(dataset, { anchor, weeks, avoid }) {
  const from = addDays(anchor, -weeks * 7);
  const exercises = exerciseIndex(dataset);
  const workouts = finishedWorkoutIndex(dataset);
  const stats = new Map(); // exerciseId -> {sessions:Set, lastDate}
  for (const s of dataset.sets || []) {
    if (!isHardSet(s)) continue;
    const w = workouts.get(s.workoutId);
    if (!w || w.date < from || w.date > anchor) continue;
    const ex = exercises.get(s.exerciseId);
    if (!ex || !isRepType(ex.exerciseType)) continue;
    if (avoid.has(s.exerciseId)) continue;
    let st = stats.get(s.exerciseId);
    if (!st) {
      st = { sessions: new Set(), lastDate: w.date };
      stats.set(s.exerciseId, st);
    }
    st.sessions.add(w.id);
    if (w.date > st.lastDate) st.lastDate = w.date;
  }
  return [...stats.entries()]
    .map(([id, st]) => ({ id, count: st.sessions.size, lastDate: st.lastDate }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.lastDate !== b.lastDate) return a.lastDate < b.lastDate ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });
}

/** Untrained library exercises used to top up a plan digest. */
function libraryTopUp(dataset, { avoid, exclude }) {
  const groupRank = new Map(MUSCLE_GROUPS.map((g, i) => [g, i]));
  return (dataset.exercises || [])
    .filter((e) => e && !avoid.has(e.id) && !exclude.has(e.id) && isRepType(e.exerciseType))
    .slice()
    .sort((a, b) => {
      const ac = a.isCustom === true ? 1 : 0;
      const bc = b.isCustom === true ? 1 : 0;
      if (ac !== bc) return ac - bc; // seed exercises first
      const ag = groupRank.has(a.muscleGroup) ? groupRank.get(a.muscleGroup) : MUSCLE_GROUPS.length;
      const bg = groupRank.has(b.muscleGroup) ? groupRank.get(b.muscleGroup) : MUSCLE_GROUPS.length;
      if (ag !== bg) return ag - bg;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}

/** Full digest entry for an exercise with history. */
function trainedEntry(dataset, exerciseId, { today, profile, gap }) {
  const ex = exerciseIndex(dataset).get(exerciseId);
  const sessions = sessionsForExercise(dataset, exerciseId);
  const last = sessions[0] || null;
  const prev = sessions[1] || null;
  const prs = prsFrom(dataset, exerciseId);
  const top = last ? topSetOf(last.sets) : null;
  return {
    id: exerciseId,
    name: ex ? ex.name : exerciseId,
    group: ex ? ex.muscleGroup : null,
    type: normalizeExerciseType(ex ? ex.exerciseType : null),
    lastDate: last ? last.workout.date : null,
    workWeightKg: last ? round1(median(last.sets.map((s) => s.weightKg))) : null,
    topReps: top ? top.reps : null,
    e1rm: last ? round1(bestE1rmOf(last.sets)) : null,
    e1rmPrev: prev ? round1(bestE1rmOf(prev.sets)) : null,
    bestE1rm: prs.bestE1RM ? round1(prs.bestE1RM.value) : null,
    weeksSince: last ? Math.floor(Math.max(0, dayNum(today) - dayNum(last.workout.date)) / 7) : null,
    proposal: progressionFor(dataset, exerciseId, { today, profile, gap }),
  };
}

/**
 * Compact digest entry for a library exercise that has never been trained.
 *
 * Everything absent here is absent BY DEFAULT, not by accident: the seven
 * history fields (`lastDate`, `workWeightKg`, `topReps`, `e1rm`, `e1rmPrev`,
 * `bestE1rm`, `weeksSince`) and a null `proposal.weightKg` are omitted rather
 * than serialised as nulls, and `type` is omitted when it is the default
 * `weight_reps`. Twenty entries carrying eight explicit nulls apiece do not fit
 * the 4 kB budget, and "no history keys" says "never trained" unambiguously.
 */
function untrainedEntry(exercise) {
  const bodyweight = isBodyweightish(exercise);
  const range = rangeFor(exercise);
  const type = normalizeExerciseType(exercise.exerciseType);
  const entry = { id: exercise.id, name: exercise.name, group: exercise.muscleGroup };
  if (type !== 'weight_reps') entry.type = type;
  entry.proposal = { repsLow: range.low, repsHigh: range.high, sets: DEFAULT_SETS, rule: 'first-time' };
  if (bodyweight) entry.proposal.weightKg = 0;
  return entry;
}

/** Plan, stripped of `note` fields so it fits the digest budget. */
function slimPlan(plan) {
  if (!plan) return null;
  return {
    version: plan.version,
    sessions: planSessionsSorted(plan).map((s) => ({
      id: s.id,
      order: s.order,
      name: s.name,
      focus: s.focus == null ? null : clip(s.focus, 60),
      exercises: (s.exercises || []).map((e) => ({
        exerciseId: e.exerciseId,
        targetSets: e.targetSets,
        targetRepsLow: e.targetRepsLow,
        targetRepsHigh: e.targetRepsHigh,
        targetWeightKg: e.targetWeightKg == null ? null : round1(e.targetWeightKg),
        targetRpe: e.targetRpe == null ? null : e.targetRpe,
      })),
    })),
  };
}

/**
 * The complete, JSON-serialisable payload sent to the model. Deterministic:
 * the same inputs always produce a deep-equal object.
 *
 * Size: `JSON.stringify(digest).length` is guaranteed below 4000. The exercise
 * list is trimmed first (down to a floor of 4), then the session's exercise
 * list (floor 3), then the attached plan is dropped — in that order.
 *
 * The exercise window is anchored to the LAST TRAINING SESSION, not to today,
 * so a layoff never empties the list: 8 weeks back for 'daily'/'session'
 * (≤ 12 exercises), 16 weeks for 'plan' (≤ 20). For kind 'plan' with fewer
 * than 8 trained exercises in the window the list is topped up with untrained
 * library exercises so the model has something to build a plan out of.
 *
 * `recovery` appears only when `health` is passed (the caller passes it only
 * with the athlete's consent) and then carries exactly its seven fields.
 *
 * @param {{dataset: Object, profile?: Object|null, today: string,
 *   health?: Object|null, workoutId?: string|null, plan?: Object|null,
 *   kind: 'daily'|'session'|'plan'}} args
 * @returns {Object}
 */
export function buildDigest(args) {
  const { dataset, profile = null, today, health = null, workoutId = null, plan = null, kind = 'daily' } = args || {};

  const goal = (profile && profile.goal) || 'general-fitness';
  const daysPerWeek = profile && Number.isFinite(profile.daysPerWeek) ? profile.daysPerWeek : 3;
  const avoid = new Set((profile && profile.avoidExerciseIds) || []);

  const gap = trainingGap(dataset, today);
  const balance = muscleBalance(dataset, { weeks: 4, today, profile });
  const flags = loadFlags(dataset, { today, health, profile });
  const totals = weeklyTotals(dataset, 1, today)[0];

  const anchor = gap.lastSessionDate || today;
  const windowWeeks = DIGEST_WINDOW_WEEKS[kind] || DIGEST_WINDOW_WEEKS.daily;
  const ranked = rankedExercises(dataset, { anchor, weeks: windowWeeks, avoid });
  const cap = DIGEST_EXERCISE_CAP[kind] || DIGEST_EXERCISE_CAP.daily;

  let entries = ranked.slice(0, cap).map((r) => trainedEntry(dataset, r.id, { today, profile, gap }));
  if (kind === 'plan' && entries.length < PLAN_MIN_EXERCISES) {
    const exclude = new Set(entries.map((e) => e.id));
    for (const ex of libraryTopUp(dataset, { avoid, exclude })) {
      if (entries.length >= cap) break;
      entries.push(untrainedEntry(ex));
    }
  }

  const sessionBlock =
    kind === 'session' && workoutId ? sessionDiff(dataset, workoutId) : null;

  const base = {
    schemaVersion: 1,
    kind,
    today,
    profile: {
      goal,
      daysPerWeek,
      sessionMinutes: profile && Number.isFinite(profile.sessionMinutes) ? profile.sessionMinutes : null,
      injuryNotes: clip(profile && profile.injuryNotes),
      equipmentNotes: clip(profile && profile.equipmentNotes),
      avoid: [...avoid].sort(),
    },
    gap,
    week: {
      isoWeek: totals.isoWeek,
      sessions: totals.sessions,
      hardSets: totals.hardSets,
      volumeKg: round1(totals.volumeKg),
      avgRpe: totals.rpeCount ? round2(totals.rpeSum / totals.rpeCount) : null,
    },
    // cardio/other carry no band, so they say nothing useful here.
    balance: balance
      .filter((b) => b.min !== null)
      .map((b) => ({ g: b.group, sets: b.sets, min: b.min, max: b.max, status: b.status, trend: b.trend })),
    flags,
  };

  const assemble = (exerciseCount, sessionExerciseCount, includePlan) => {
    const out = { ...base, exercises: entries.slice(0, exerciseCount) };
    if (health) {
      out.recovery = {
        sleepH: round1(health.sleepH),
        hrvMs: round1(health.hrvMs),
        hrvBaselineMs: round1(health.hrvBaselineMs),
        restingHr: round1(health.restingHr),
        restingHrBaseline: round1(health.restingHrBaseline),
        weightKg: round1(health.weightKg),
        weightTrend30dPct: round3(health.weightTrend30dPct),
      };
    }
    if (sessionBlock) {
      out.session = {
        workoutId: sessionBlock.workoutId,
        date: sessionBlock.date,
        name: sessionBlock.name,
        durationMin: sessionBlock.durationMin,
        hardSets: sessionBlock.hardSets,
        volumeKg: sessionBlock.volumeKg,
        avgRpe: sessionBlock.avgRpe,
        exercises: sessionBlock.exercises.slice(0, sessionExerciseCount).map((e) => ({
          id: e.id,
          name: e.name,
          verdict: e.verdict,
          volumeKg: e.volumeKg,
          volumePrevKg: e.volumePrevKg,
          e1rm: e.e1rm,
          e1rmPrev: e.e1rmPrev,
          sets: e.sets.slice(0, DIGEST_SET_CAP),
          prevTop: e.prevTop,
        })),
      };
    }
    out.plan = kind === 'plan' || !includePlan ? null : slimPlan(plan);
    return out;
  };

  // Shrink deterministically until the payload fits the budget.
  let exerciseCount = entries.length;
  let sessionExerciseCount = sessionBlock ? Math.min(sessionBlock.exercises.length, DIGEST_SESSION_EXERCISE_CAP) : 0;
  let includePlan = true;
  let digest = assemble(exerciseCount, sessionExerciseCount, includePlan);
  while (JSON.stringify(digest).length >= DIGEST_MAX_BYTES) {
    if (exerciseCount > DIGEST_EXERCISE_FLOOR) exerciseCount -= 1;
    else if (sessionExerciseCount > DIGEST_SESSION_EXERCISE_FLOOR) sessionExerciseCount -= 1;
    else if (includePlan && kind !== 'plan' && plan) includePlan = false;
    else break;
    digest = assemble(exerciseCount, sessionExerciseCount, includePlan);
  }
  return digest;
}
