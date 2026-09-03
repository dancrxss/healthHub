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

/** Digest budget. The API prompt is built from this, so it is a hard cap. Per kind
 * (PLAN.md C2.2, C2.2/C2.3 amendment 2 — grew to fit `historyByGroup` on every
 * kind, plus the full `library` on plan/chat). */
const DIGEST_MAX_BYTES = { daily: 4500, session: 4500, plan: 9000, chat: 9000 };
/** Ranked-exercise list cap per kind. 'chat' matches 'plan' — a chat digest is
 * not backed by the group top-up `library` gives, so it gets the wider window
 * below instead (amendment 2). */
const DIGEST_EXERCISE_CAP = { daily: 12, session: 12, plan: 20, chat: 20 };
const DIGEST_EXERCISE_FLOOR = 4;
/** How far back `rankedExercises` looks, anchored at the last session. 'chat'
 * is a full year (52 weeks) — the digest's `library` already carries a
 * complete exercise inventory, but the ranked list is what carries recent
 * proposals/e1RM, so it must not silently exclude anything trained this year
 * (amendment 2 — this was the direct cause of the coach denying it could see
 * legs/back/biceps history that was simply outside the old 8-week window). */
const DIGEST_WINDOW_WEEKS = { daily: 8, session: 8, plan: 16, chat: 52 };
const DIGEST_SESSION_EXERCISE_CAP = 8;
const DIGEST_SESSION_EXERCISE_FLOOR = 3;
const DIGEST_SET_CAP = 6;
const DIGEST_NOTE_CHARS = 160;
/** Below this many trained exercises, a plan digest is topped up from the library. */
const PLAN_MIN_EXERCISES = 8;
/** Hard cap on a 'plan' digest's exercise list, after the group top-up, before the shrink loop. */
const DIGEST_PLAN_HARD_CAP = 30;
/** Per-group top-up: at most this many not-already-present library exercises per included/emphasised group. */
const DIGEST_GROUP_TOP_UP = 4;
/** `chat.recent`: initial cap, and the shrink-loop floor. */
const DIGEST_CHAT_RECENT_CAP = 6;
const DIGEST_CHAT_RECENT_FLOOR = 3;
const DIGEST_CHAT_MESSAGE_CHARS = 1200;
const DIGEST_CHAT_TURN_CHARS = 400;
/** `memory`: the shrink-loop floor (items are stored capped at 20; no floor otherwise). */
const DIGEST_MEMORY_FLOOR = 10;
/** `historyByGroup[g].top`: how many exerciseIds it carries per group before the shrink loop trims it. */
const DIGEST_HISTORY_TOP_N = 3;

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

/** Exercise types measured in seconds, not reps: cardio, time, weight_time (PLAN.md C2.2). */
const DURATION_TYPES = ['cardio', 'time', 'weight_time'];

/**
 * True for a duration-measured exercise type (cardio, time, weight_time) —
 * these log `targetDurationSec`/`durationSeconds` instead of reps. Mirrors
 * the identically-named check in `js/coach-api.js`.
 * @param {string} exerciseType
 * @returns {boolean}
 */
export function isDurationType(exerciseType) {
  return DURATION_TYPES.includes(normalizeExerciseType(exerciseType));
}

/** A "plannable" exercise: either logs reps or logs a duration. Excludes
 * distance-only and notes-only types, which the digest never proposes. */
function isPlannableType(exerciseType) {
  return isRepType(exerciseType) || isDurationType(exerciseType);
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
 * Which programme week (1-based) a plan is on today.
 *
 * `plan.lineageStart` (programme day 1, copied on every revision) wins; a
 * plan predating Phase C2 has none, so `plan.createdAt` (date part) stands
 * in. Clamped to `[1, plan.weeks || 1]` — a plan never projects past its own
 * length, and a plan with no `weeks` at all behaves as a single-week plan
 * rather than dividing by zero.
 *
 * @param {{lineageStart?: string, createdAt?: string, weeks?: number}|null} plan
 * @param {string} today ISO date
 * @returns {number}
 */
export function currentPlanWeek(plan, today) {
  if (!plan) return 1;
  const start = plan.lineageStart || String(plan.createdAt || today).slice(0, 10);
  const weeks = Number.isFinite(plan.weeks) && plan.weeks > 0 ? plan.weeks : 1;
  const week = Math.floor((dayNum(today) - dayNum(start)) / 7) + 1;
  return Math.min(weeks, Math.max(1, week));
}

/**
 * Project one PlanExercise's targets forward from `plan.baseWeek` (the
 * programme week the STORED targets describe) to `week`, applying its own
 * `progression` step. A PlanExercise with no `progression` (v1 plans, or a
 * v2 exercise the model left unset) projects flat — every step multiplier
 * below is `0` in that case.
 *
 * A `null` or `0` stored target (no weight to load, no duration set) is left
 * exactly as stored — there is nothing to step forward. Reps are capped at
 * 30; weight rounds to the nearest 0.5 kg. Everything else on the exercise
 * (`exerciseId`, `targetRpe`, `purpose`, `goal`, `note`, `progression`
 * itself) passes through untouched.
 *
 * @param {Object} pe PlanExercise
 * @param {number} week
 * @param {number} baseWeek
 * @param {boolean} isDeload
 * @returns {Object} a NEW PlanExercise-shaped object; `pe` is never mutated
 */
function projectPlanExercise(pe, week, baseWeek, isDeload) {
  const prog = pe && pe.progression && typeof pe.progression === 'object' ? pe.progression : null;
  const everyWeeks = prog && Number.isFinite(prog.everyWeeks) && prog.everyWeeks > 0 ? prog.everyWeeks : 1;
  const steps = Math.max(0, Math.floor((week - baseWeek) / everyWeeks));

  const weightStep = prog && Number.isFinite(prog.weightStepKg) ? prog.weightStepKg : 0;
  const repStep = prog && Number.isFinite(prog.repStep) ? prog.repStep : 0;
  const durationStep = prog && Number.isFinite(prog.durationStepSec) ? prog.durationStepSec : 0;

  const baseWeightKg = pe.targetWeightKg;
  let targetWeightKg =
    baseWeightKg == null || baseWeightKg === 0 ? baseWeightKg : roundStep(baseWeightKg + steps * weightStep, 0.5, 'near');

  const capRep = (v) => (v == null ? null : Math.min(30, v));
  const targetRepsLow = pe.targetRepsLow == null ? null : capRep(pe.targetRepsLow + steps * repStep);
  const targetRepsHigh = pe.targetRepsHigh == null ? null : capRep(pe.targetRepsHigh + steps * repStep);
  const targetDurationSec = pe.targetDurationSec == null ? null : pe.targetDurationSec + steps * durationStep;

  let targetSets = pe.targetSets;
  if (isDeload) {
    if (targetWeightKg != null) targetWeightKg = roundStep(targetWeightKg * DELOAD_MULTIPLIER, 2.5, 'down');
    targetSets = Math.max(1, targetSets - 1);
  }

  return { ...pe, targetSets, targetRepsLow, targetRepsHigh, targetWeightKg, targetDurationSec };
}

/**
 * Project every session of a plan onto one programme week — the later weeks
 * a plan only ever describes implicitly, via each exercise's `progression`.
 *
 * `isPast` (`week < plan.baseWeek`) reports the stored targets unchanged —
 * `baseWeek` describes what was ACTUALLY prescribed for that already-lived
 * week, not a re-derived projection of it. `isDeload` is true exactly on
 * `plan.overview.deloadWeek` (and never for a past week): every exercise's
 * weight drops 10% (rounded down to 2.5 kg) and every exercise loses one set
 * (minimum one), reps and duration unchanged.
 *
 * @param {Object|null} plan CoachPlanRecord
 * @param {number} week 1-based programme week
 * @returns {{week: number, isPast: boolean, isDeload: boolean, sessions: Array<Object>}}
 */
export function projectPlanWeek(plan, week) {
  const baseWeek = plan && Number.isFinite(plan.baseWeek) && plan.baseWeek > 0 ? plan.baseWeek : 1;
  const deloadWeek = plan && plan.overview && Number.isFinite(plan.overview.deloadWeek) ? plan.overview.deloadWeek : null;
  const isPast = week < baseWeek;
  const isDeload = !isPast && deloadWeek != null && week === deloadWeek;
  const sessions = planSessionsSorted(plan).map((s) => ({
    id: s.id,
    order: s.order,
    name: s.name,
    focus: s.focus == null ? null : s.focus,
    brief: Array.isArray(s.brief) ? s.brief.slice() : [],
    exercises: (Array.isArray(s.exercises) ? s.exercises : []).map((pe) => projectPlanExercise(pe, week, baseWeek, isDeload)),
  }));
  return { week, isPast, isDeload, sessions };
}

/**
 * The sessions of a plan, projected onto today's programme week. Every
 * `plan.sessions` read outside the coach's own storage layer goes through
 * this — the Coach root, the plan screen, the Log start-choice, `#/copy/plan`
 * and the workout ghost override alike (PLAN.md C2.5).
 *
 * @param {Object|null} plan
 * @param {string} today ISO date
 * @returns {Array<Object>} `[]` for a null plan.
 */
export function projectedSessions(plan, today) {
  if (!plan) return [];
  return projectPlanWeek(plan, currentPlanWeek(plan, today)).sessions;
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
 * The "ghost" reference sets a planned exercise autofills from: ALWAYS an
 * array (length `max(1, min(8, targetSets))` — even a misconfigured
 * `targetSets: 0` still shows one set to beat), except for a null
 * `planExercise` itself, which has no target sets to speak of.
 *
 * A duration exercise (`targetDurationSec > 0`) autofills the time only —
 * weight and reps stay 0. Otherwise the top of the rep range is used
 * deliberately — the placeholder should show the number to beat, not the
 * number to settle for.
 *
 * @param {{targetSets: number, targetRepsHigh?: number, targetWeightKg?: number|null,
 *   targetDurationSec?: number|null}|null} planExercise
 * @returns {Array<{weightKg: number, reps: number, durationSeconds: number|null,
 *   distanceM: null, kcal: null}>}
 */
export function planRefSets(planExercise) {
  if (!planExercise) return [];
  const rawSets = Math.round(Number(planExercise.targetSets)) || 0;
  const n = Math.max(1, Math.min(8, rawSets));
  const out = [];
  if (Number(planExercise.targetDurationSec) > 0) {
    const durationSeconds = Math.round(Number(planExercise.targetDurationSec));
    for (let i = 0; i < n; i++) out.push({ weightKg: 0, reps: 0, durationSeconds, distanceM: null, kcal: null });
    return out;
  }
  const reps = Math.max(0, Math.round(Number(planExercise.targetRepsHigh) || 0));
  const weightKg = planExercise.targetWeightKg == null ? 0 : Number(planExercise.targetWeightKg);
  for (let i = 0; i < n; i++) out.push({ weightKg, reps, durationSeconds: null, distanceM: null, kcal: null });
  return out;
}

/**
 * PRs (best estimated 1RM) set within the trailing `days` days — the "since
 * you last opened the app" list a Home tab shows. Only rep-type exercises
 * are scored (an e1RM needs weight and reps); duration types have no PR
 * concept here. `prsFrom` already excludes warmups and cardio sets.
 *
 * Sorted newest first, then by name, then by id — deterministic even when
 * two PRs land on the same date.
 *
 * @param {Object} dataset
 * @param {{today: string, days?: number}} opts
 * @returns {Array<{exerciseId: string, name: string, kind: 'e1rm', value: number, date: string}>}
 */
export function recentPRs(dataset, opts = {}) {
  const { today, days = 7 } = opts;
  const from = addDays(today, -days);
  const out = [];
  for (const ex of dataset.exercises || []) {
    if (!ex || !isRepType(ex.exerciseType)) continue;
    const best = prsFrom(dataset, ex.id).bestE1RM;
    if (!best || !best.date) continue;
    if (best.date < from || best.date > today) continue;
    out.push({ exerciseId: ex.id, name: ex.name, kind: 'e1rm', value: round1(best.value), date: best.date });
  }
  out.sort((a, b) => {
    if (a.date !== b.date) return a.date > b.date ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.exerciseId < b.exerciseId ? -1 : 1;
  });
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

/**
 * `historyByGroup` (PLAN.md C2.2/C2.3 amendment 2): the WHOLE log, ALL TIME,
 * summarised per muscle group — deliberately unbounded by the ranked
 * exercise window above, so a group trained months ago never disappears from
 * the digest. Only groups with at least one finished-session hard set appear
 * at all; `top` is at most `DIGEST_HISTORY_TOP_N` exerciseIds, by session
 * count then recency then id — the same ranking `rankedExercises` uses, just
 * with no window and no rep-type-only filter (a group's `top` can include a
 * duration-type exercise, since it only needs `isHardSet`, which already
 * excludes cardio-tagged sets — the same exclusion every hard-set count in
 * this file uses).
 *
 * @param {Object} dataset
 * @returns {Object<string, {sessions: number, last: string, top: string[]}>}
 *   keyed by muscle group, in MUSCLE_GROUPS order; a group with no history at
 *   all is simply absent.
 */
function historyByGroupOf(dataset) {
  const exercises = exerciseIndex(dataset);
  const workouts = finishedWorkoutIndex(dataset);
  const groupWorkouts = new Map(); // group -> Set<workoutId>
  const groupLast = new Map(); // group -> latest date
  const groupExerciseStats = new Map(); // group -> Map(exerciseId -> {sessions:Set, lastDate})
  for (const s of dataset.sets || []) {
    if (!isHardSet(s)) continue;
    const w = workouts.get(s.workoutId);
    if (!w) continue;
    const ex = exercises.get(s.exerciseId);
    const group = ex ? ex.muscleGroup : null;
    if (group == null) continue;
    if (!groupWorkouts.has(group)) {
      groupWorkouts.set(group, new Set());
      groupExerciseStats.set(group, new Map());
    }
    groupWorkouts.get(group).add(w.id);
    if (!groupLast.has(group) || w.date > groupLast.get(group)) groupLast.set(group, w.date);
    const stats = groupExerciseStats.get(group);
    let st = stats.get(s.exerciseId);
    if (!st) {
      st = { sessions: new Set(), lastDate: w.date };
      stats.set(s.exerciseId, st);
    }
    st.sessions.add(w.id);
    if (w.date > st.lastDate) st.lastDate = w.date;
  }
  const out = {};
  for (const group of MUSCLE_GROUPS) {
    if (!groupWorkouts.has(group)) continue;
    const top = [...groupExerciseStats.get(group).entries()]
      .map(([id, st]) => ({ id, count: st.sessions.size, lastDate: st.lastDate }))
      .sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count;
        if (a.lastDate !== b.lastDate) return a.lastDate < b.lastDate ? 1 : -1;
        return a.id < b.id ? -1 : 1;
      })
      .slice(0, DIGEST_HISTORY_TOP_N)
      .map((e) => e.id);
    out[group] = { sessions: groupWorkouts.get(group).size, last: groupLast.get(group), top };
  }
  return out;
}

/**
 * `library` (kinds 'plan'/'chat' only, PLAN.md C2.2/C2.3 amendment 2): every
 * plannable-or-known exercise the app has, grouped by muscle group, as
 * compact `id|Name` (or `id|Name|type` when the type is not the default
 * `weight_reps`) strings — so a plan/chat reply may reference ANY library
 * exercise, not just a recently-trained one. `notes`-type exercises are
 * excluded (nothing to plan or log a target for). Sorted by MUSCLE_GROUPS
 * order then exercise name then id; a group with nothing in the library is
 * simply absent.
 *
 * @param {Object} dataset
 * @returns {Object<string, string[]>}
 */
function buildLibrary(dataset) {
  const byGroup = new Map();
  for (const exRec of dataset.exercises || []) {
    if (!exRec) continue;
    const type = normalizeExerciseType(exRec.exerciseType);
    if (type === 'notes') continue;
    if (!byGroup.has(exRec.muscleGroup)) byGroup.set(exRec.muscleGroup, []);
    byGroup.get(exRec.muscleGroup).push(exRec);
  }
  const out = {};
  for (const group of MUSCLE_GROUPS) {
    const list = byGroup.get(group);
    if (!list || !list.length) continue;
    list.sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.id < b.id ? -1 : 1));
    out[group] = list.map((exRec) => {
      const type = normalizeExerciseType(exRec.exerciseType);
      return type === 'weight_reps' ? `${exRec.id}|${exRec.name}` : `${exRec.id}|${exRec.name}|${type}`;
    });
  }
  return out;
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

/** A working set of a duration-measured exercise: not a warmup, some time logged.
 * Deliberately NOT `isHardSet` — cardio sets carry `setType: 'cardio'`, which
 * `isHardSet` excludes on purpose (hard-set counts stay rep-based everywhere
 * else: `hardSetsByGroup`/`muscleBalance` are UNCHANGED by this). This is
 * only ever used to find plan-digest history for a duration-type exercise. */
function isDurationHardSet(s) {
  return !!s && s.isWarmup !== true && Number(s.durationSeconds) > 0;
}

/** Finished sessions containing duration sets of one exercise, NEWEST first. */
function sessionsForDurationExercise(dataset, exerciseId) {
  const byWorkout = new Map();
  for (const s of dataset.sets || []) {
    if (s.exerciseId !== exerciseId || !isDurationHardSet(s)) continue;
    if (!byWorkout.has(s.workoutId)) byWorkout.set(s.workoutId, []);
    byWorkout.get(s.workoutId).push(s);
  }
  const out = [];
  for (const w of finishedWorkoutsAsc(dataset)) {
    const sets = byWorkout.get(w.id);
    if (!sets || !sets.length) continue;
    out.push({ workout: w, sets });
  }
  out.reverse(); // newest first
  return out;
}

/**
 * Compact digest entry for a duration-measured exercise (cardio/time/
 * weight_time) — trained or not, plan kind only. Mirrors `untrainedEntry`'s
 * "omit rather than null" rule: `lastDate`/`lastDurationSec`/`weeksSince`
 * only appear once there is history.
 *
 * proposal.durationSec is `profile.cardio.minutesPerSession × 60` for cardio,
 * or the exercise's own last duration (else a 45 s default) for time/weight_time.
 */
function durationEntry(dataset, exercise, { today, profile }) {
  const type = normalizeExerciseType(exercise.exerciseType);
  const sessions = sessionsForDurationExercise(dataset, exercise.id);
  const last = sessions[0] || null;
  const lastDurationSec = last ? Math.max(...last.sets.map((s) => Number(s.durationSeconds) || 0)) : null;

  const entry = { id: exercise.id, name: exercise.name, group: exercise.muscleGroup, type };
  if (last) {
    entry.lastDate = last.workout.date;
    entry.lastDurationSec = lastDurationSec;
    entry.weeksSince = Math.floor(Math.max(0, dayNum(today) - dayNum(last.workout.date)) / 7);
  }
  entry.proposal =
    type === 'cardio'
      ? {
          durationSec:
            (profile && profile.cardio && Number.isFinite(profile.cardio.minutesPerSession) ? profile.cardio.minutesPerSession : 10) *
            60,
          sets: 1,
          rule: 'duration',
        }
      : { durationSec: lastDurationSec || 45, sets: 3, rule: 'duration' };
  return entry;
}

/** Trained-or-not digest entry for one library exercise, routed by type. */
function planExerciseEntry(dataset, exercise, { today, profile, gap }) {
  const type = normalizeExerciseType(exercise.exerciseType);
  if (isDurationType(type)) return durationEntry(dataset, exercise, { today, profile });
  return sessionsForExercise(dataset, exercise.id).length
    ? trainedEntry(dataset, exercise.id, { today, profile, gap })
    : untrainedEntry(exercise);
}

/**
 * A muscle group is "of interest" per the athlete's profile — shared between
 * `extendPlanExercises` (the group top-up) and `buildDigest`'s shrink loop
 * (a `library` group of interest is never dropped under size pressure).
 */
function groupIsOfInterest(profile, group) {
  const groupPrefs = profile && profile.groupPrefs && typeof profile.groupPrefs === 'object' ? profile.groupPrefs : {};
  const pref = groupPrefs[group];
  if (pref === 'include' || pref === 'emphasise') return true;
  if (group === 'abs' && profile && profile.core && profile.core.include === true) return true;
  if (group === 'cardio' && profile && profile.cardio && profile.cardio.include === true) return true;
  return false;
}

/**
 * Extends a 'plan' digest's exercise list (PLAN.md C2.2):
 *  - every `profile.favouriteExerciseIds` not already present is added first
 *    (so the hard cap below never crowds a favourite out for a low-priority
 *    group top-up);
 *  - then, for every muscle group the athlete asked for — `groupPrefs[g]`
 *    'include'/'emphasise', plus 'abs' when `core.include`, plus 'cardio'
 *    when `cardio.include` — up to 4 library exercises of that group not
 *    already present are added, ordered favourites first (`cardio.exerciseIds`
 *    count as favourites within the cardio group specifically), then seed
 *    (`isCustom === false`) before custom, then name;
 *  - `groupPrefs[g] === 'avoid'` then strips EVERY exercise of that group,
 *    including ones the ranked/favourite/other-group passes already added;
 *  - the result is capped at 30 entries total.
 * Duration-type exercises are only ever added here — never by the
 * rep-type-only `rankedExercises`/`libraryTopUp` used for every kind.
 */
function extendPlanExercises(dataset, entries, { today, profile, gap, avoid }) {
  let out = entries.slice();
  const present = new Set(out.map((e) => e.id));
  const favourites = new Set(profile && Array.isArray(profile.favouriteExerciseIds) ? profile.favouriteExerciseIds : []);
  const cardioFavourites = new Set(
    profile && profile.cardio && Array.isArray(profile.cardio.exerciseIds) ? profile.cardio.exerciseIds : []
  );
  const groupPrefs = profile && profile.groupPrefs && typeof profile.groupPrefs === 'object' ? profile.groupPrefs : {};
  const exercises = exerciseIndex(dataset);

  for (const id of favourites) {
    if (present.has(id) || avoid.has(id)) continue;
    const exRec = exercises.get(id);
    if (!exRec || !isPlannableType(exRec.exerciseType)) continue;
    out.push(planExerciseEntry(dataset, exRec, { today, profile, gap }));
    present.add(id);
  }

  for (const group of MUSCLE_GROUPS) {
    if (!groupIsOfInterest(profile, group)) continue;
    const favSet = group === 'cardio' ? new Set([...favourites, ...cardioFavourites]) : favourites;
    const candidates = (dataset.exercises || [])
      .filter((e) => e && e.muscleGroup === group && !avoid.has(e.id) && !present.has(e.id) && isPlannableType(e.exerciseType))
      .slice()
      .sort((a, b) => {
        const af = favSet.has(a.id) ? 0 : 1;
        const bf = favSet.has(b.id) ? 0 : 1;
        if (af !== bf) return af - bf;
        const ac = a.isCustom === true ? 1 : 0;
        const bc = b.isCustom === true ? 1 : 0;
        if (ac !== bc) return ac - bc;
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });
    for (const cand of candidates.slice(0, DIGEST_GROUP_TOP_UP)) {
      out.push(planExerciseEntry(dataset, cand, { today, profile, gap }));
      present.add(cand.id);
    }
  }

  const avoidGroups = new Set(Object.entries(groupPrefs).filter(([, v]) => v === 'avoid').map(([g]) => g));
  if (avoidGroups.size) out = out.filter((e) => !avoidGroups.has(e.group));

  return out.length > DIGEST_PLAN_HARD_CAP ? out.slice(0, DIGEST_PLAN_HARD_CAP) : out;
}

/**
 * `profile` as it appears in the digest. Tolerates a v1 profile or null:
 * every v2-only field (`split`, `groupPrefs`, `cardio`, `core`) is simply
 * omitted rather than sent as an empty/default value the model would have
 * to learn means nothing.
 */
function buildProfileDigest(dataset, profile, avoid) {
  const out = {
    goal: (profile && profile.goal) || 'general-fitness',
    daysPerWeek: profile && Number.isFinite(profile.daysPerWeek) ? profile.daysPerWeek : 3,
    sessionMinutes: profile && Number.isFinite(profile.sessionMinutes) ? profile.sessionMinutes : null,
    injuryNotes: clip(profile && profile.injuryNotes),
    equipmentNotes: clip(profile && profile.equipmentNotes),
    avoid: [...avoid].sort(),
  };
  if (profile && profile.split && profile.split !== 'auto') out.split = profile.split;
  if (profile && profile.groupPrefs && typeof profile.groupPrefs === 'object') {
    const gp = {};
    for (const [g, v] of Object.entries(profile.groupPrefs)) {
      if (v && v !== 'auto') gp[g] = v;
    }
    if (Object.keys(gp).length) out.groupPrefs = gp;
  }
  if (profile && profile.cardio && profile.cardio.include === true) {
    out.cardio = {
      include: true,
      minutesPerSession: Number.isFinite(profile.cardio.minutesPerSession) ? profile.cardio.minutesPerSession : 10,
      standaloneDay: profile.cardio.standaloneDay === true,
      exerciseIds: Array.isArray(profile.cardio.exerciseIds) ? [...profile.cardio.exerciseIds].sort() : [],
    };
  }
  if (profile && profile.core && profile.core.include === true) out.core = { include: true };
  const favIds = profile && Array.isArray(profile.favouriteExerciseIds) ? profile.favouriteExerciseIds : [];
  const exercises = exerciseIndex(dataset);
  out.favourites = favIds.map((id) => exercises.get(id)).filter(Boolean).map((e) => ({ id: e.id, name: e.name }));
  out.notes = clip(profile && profile.notes);
  return out;
}

/**
 * Plan echo for a 'daily'/'session'/'chat' digest: NOT the stored plan —
 * the CURRENT WEEK's projection (`projectPlanWeek`), slimmed to just enough
 * to keep the model consistent with what the athlete will actually see
 * (`purpose`/`goal`/`note`/`progression`/`brief` are dropped; the model gets
 * projected numbers, not the recipe that produced them).
 */
function slimPlan(plan, today) {
  if (!plan) return null;
  const currentWeek = currentPlanWeek(plan, today);
  const deloadWeek = plan.overview && Number.isFinite(plan.overview.deloadWeek) ? plan.overview.deloadWeek : null;
  const projected = projectPlanWeek(plan, currentWeek);
  return {
    version: plan.version,
    weeks: plan.weeks,
    baseWeek: plan.baseWeek || 1,
    currentWeek,
    deloadWeek,
    sessions: projected.sessions.map((s) => ({
      id: s.id,
      name: s.name,
      exercises: (s.exercises || []).map((e) => ({
        exerciseId: e.exerciseId,
        targetSets: e.targetSets,
        targetRepsLow: e.targetRepsLow,
        targetRepsHigh: e.targetRepsHigh,
        targetWeightKg: e.targetWeightKg == null ? null : round1(e.targetWeightKg),
        targetDurationSec: e.targetDurationSec == null ? null : e.targetDurationSec,
      })),
    })),
  };
}

/**
 * The complete, JSON-serialisable payload sent to the model. Deterministic:
 * the same inputs always produce a deep-equal object.
 *
 * Size: `JSON.stringify(digest).length` is guaranteed below the per-kind
 * budget (`daily`/`session` 4500, `plan`/`chat` 9000 — PLAN.md C2.2/C2.3
 * amendment 2). Shrunk deterministically in this order: the exercise list
 * (floor 4), the session's exercise list (floor 3), the attached plan
 * dropped, `chat.recent` cut to 3 turns, `memory` cut to the 10 most recent,
 * `historyByGroup[*].top` dropped from every group, then — 'plan'/'chat'
 * only, and only once every earlier lever is exhausted — `library` groups the
 * profile has no interest in are dropped largest-first; a 'plan' digest never
 * loses `library` entirely (the smallest group, if none are of interest, is
 * kept back), a 'chat' digest may.
 *
 * The RANKED exercise window (`exercises[]`) is anchored to the LAST TRAINING
 * SESSION, not to today, so a layoff never empties the list: 8 weeks back for
 * 'daily'/'session' (≤ 12 exercises), 16 weeks for 'plan' (≤ 20, before the
 * group top-up can take it to 30), 52 weeks for 'chat' (≤ 20) — a chat digest
 * has no group top-up to fall back on, so its own window is wide enough that
 * a muscle group trained within the last year is never silently excluded.
 * For kind 'plan' with fewer than 8 trained exercises in the window the list
 * is topped up with untrained library exercises so the model has something
 * to build a plan out of; `extendPlanExercises` then layers on favourites and
 * the per-group top-up described there.
 *
 * `historyByGroup` is present on EVERY kind and is NOT windowed at all — it
 * summarises the WHOLE log, all time, per muscle group (`{sessions, last,
 * top}`), so a group the ranked window above has aged out of (trained months
 * ago, say) still shows up as "the person has trained this" rather than
 * looking untouched. `library` (kinds 'plan'/'chat' only) is the complete
 * exercise inventory grouped by muscle group as compact `id|Name[|type]`
 * strings, so a plan/chat reply may reference any exercise the app knows.
 *
 * `recovery` appears only when `health` is passed (the caller passes it only
 * with the athlete's consent) and then carries exactly its seven fields.
 * `memory` is always present (`[]` when none). `chat` appears only for
 * kind 'chat'.
 *
 * @param {{dataset: Object, profile?: Object|null, today: string,
 *   health?: Object|null, workoutId?: string|null, plan?: Object|null,
 *   kind: 'daily'|'session'|'plan'|'chat', memory?: Array<{id: string, text: string}>|null,
 *   chat?: {thread: 'home'|'plan', recent: Array<{role: string, text: string}>, message: string}|null}} args
 * @returns {Object}
 */
export function buildDigest(args) {
  const {
    dataset, profile = null, today, health = null, workoutId = null, plan = null, kind = 'daily', memory = null, chat = null,
  } = args || {};

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
  if (kind === 'plan') {
    entries = extendPlanExercises(dataset, entries, { today, profile, gap, avoid });
  }

  const sessionBlock =
    kind === 'session' && workoutId ? sessionDiff(dataset, workoutId) : null;

  const memoryFull = Array.isArray(memory)
    ? memory.filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, text: clip(String(m.text || ''), 200) }))
    : [];
  const chatRecentFull =
    kind === 'chat' && chat && Array.isArray(chat.recent)
      ? chat.recent
          .slice(-DIGEST_CHAT_RECENT_CAP)
          .map((m) => ({ role: m && m.role, text: clip(String((m && m.text) || ''), DIGEST_CHAT_TURN_CHARS) }))
      : [];
  const chatMessage = kind === 'chat' && chat ? clip(String(chat.message || ''), DIGEST_CHAT_MESSAGE_CHARS) : '';
  const chatThread = kind === 'chat' && chat ? chat.thread : null;

  // historyByGroup — every kind (amendment 2): the whole log, all time, so a
  // group trained outside the ranked-exercise window above is never invisible.
  const historyFull = historyByGroupOf(dataset);
  const historyGroupOrder = Object.keys(historyFull);

  // library — kinds 'plan'/'chat' only: the full inventory, so a reply may
  // name any exercise the app knows, not just a recently-trained one. Groups
  // the profile has no interest in are the only ones the shrink loop may drop.
  const libraryFull = kind === 'plan' || kind === 'chat' ? buildLibrary(dataset) : null;
  const libraryGroupOrder = libraryFull ? Object.keys(libraryFull) : [];
  const protectedLibraryGroups = new Set(libraryGroupOrder.filter((g) => groupIsOfInterest(profile, g)));
  const droppableLibraryGroups = libraryGroupOrder
    .filter((g) => !protectedLibraryGroups.has(g))
    .map((g) => ({ g, size: JSON.stringify(libraryFull[g]).length }))
    .sort((a, b) => (b.size !== a.size ? b.size - a.size : a.g < b.g ? -1 : 1))
    .map((e) => e.g);
  // A 'plan' digest must never lose its library entirely: when every group is
  // droppable (none of interest), the smallest one — last after the largest-
  // first drop order above — is kept back. 'chat' has no such floor.
  const libraryAllDroppable = protectedLibraryGroups.size === 0 && libraryGroupOrder.length > 0;
  const maxLibraryDropCount =
    kind === 'plan' && libraryAllDroppable ? Math.max(0, droppableLibraryGroups.length - 1) : droppableLibraryGroups.length;

  const base = {
    schemaVersion: 1,
    kind,
    today,
    profile: buildProfileDigest(dataset, profile, avoid),
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

  const assemble = (exerciseCount, sessionExerciseCount, includePlan, chatRecentCount, memoryCount, dropHistoryTop, libraryDropCount) => {
    const out = { ...base, exercises: entries.slice(0, exerciseCount) };
    out.historyByGroup = {};
    for (const group of historyGroupOrder) {
      const h = historyFull[group];
      out.historyByGroup[group] = dropHistoryTop
        ? { sessions: h.sessions, last: h.last }
        : { sessions: h.sessions, last: h.last, top: h.top };
    }
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
    out.plan = kind === 'plan' || !includePlan ? null : slimPlan(plan, today);
    out.memory = memoryCount < memoryFull.length ? memoryFull.slice(-memoryCount) : memoryFull;
    if (kind === 'chat') {
      out.chat = { thread: chatThread, recent: chatRecentFull.slice(-chatRecentCount), message: chatMessage };
    }
    if (kind === 'plan' || kind === 'chat') {
      const dropped = new Set(droppableLibraryGroups.slice(0, libraryDropCount));
      out.library = {};
      for (const group of libraryGroupOrder) {
        if (dropped.has(group)) continue;
        out.library[group] = libraryFull[group];
      }
    }
    return out;
  };

  // Shrink deterministically until the payload fits the budget.
  let exerciseCount = entries.length;
  let sessionExerciseCount = sessionBlock ? Math.min(sessionBlock.exercises.length, DIGEST_SESSION_EXERCISE_CAP) : 0;
  let includePlan = true;
  let chatRecentCount = DIGEST_CHAT_RECENT_CAP;
  let memoryCount = memoryFull.length;
  let dropHistoryTop = false;
  let libraryDropCount = 0;
  const maxBytes = DIGEST_MAX_BYTES[kind] || DIGEST_MAX_BYTES.daily;
  let digest = assemble(exerciseCount, sessionExerciseCount, includePlan, chatRecentCount, memoryCount, dropHistoryTop, libraryDropCount);
  while (JSON.stringify(digest).length >= maxBytes) {
    if (exerciseCount > DIGEST_EXERCISE_FLOOR) exerciseCount -= 1;
    else if (sessionExerciseCount > DIGEST_SESSION_EXERCISE_FLOOR) sessionExerciseCount -= 1;
    else if (includePlan && kind !== 'plan' && plan) includePlan = false;
    else if (kind === 'chat' && chatRecentCount > DIGEST_CHAT_RECENT_FLOOR) chatRecentCount = DIGEST_CHAT_RECENT_FLOOR;
    else if (memoryCount > DIGEST_MEMORY_FLOOR) memoryCount = DIGEST_MEMORY_FLOOR;
    else if (!dropHistoryTop) dropHistoryTop = true;
    else if ((kind === 'plan' || kind === 'chat') && libraryDropCount < maxLibraryDropCount) libraryDropCount += 1;
    else break;
    digest = assemble(exerciseCount, sessionExerciseCount, includePlan, chatRecentCount, memoryCount, dropHistoryTop, libraryDropCount);
  }
  return digest;
}
