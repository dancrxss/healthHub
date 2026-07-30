// ============================================================================
// stats-data.js — the metric layer behind the Statistics screens: turns raw
// db.js records into chartable time series and pie breakdowns. Additive and
// SEPARATE from the frozen query contract in queries.js (getLastSession,
// getRecentWorkouts, getPRs, getWeeklyVolume, getTrainingFrequency stay
// untouched — the MCP contract must not drift).
//
// Domain rules (pinned — CLAUDE.md §10):
// - Warm-up sets are EXCLUDED from every strength metric unless
//   opts.includeWarmup (a chart display choice; the frozen queries and PR
//   logic never include them).
// - Cardio sets (setType 'cardio') are excluded from strength metrics
//   (volume, e1RM, weights, reps…); cardio metrics (cardioTime,
//   cardioDistance, kcal) read duration/distance/kcal from ALL sets carrying
//   those fields (cardio and timed strength work alike).
// - e1RM is Epley via calc.js — do not re-derive the formula here.
// - Only FINISHED workouts (finishedAt != null) count anywhere.
// - opts.countUnilateralTwice doubles volume/reps contributions from
//   exercises with isUnilateral === true (RepCount parity), volume/reps
//   metrics only.
// - Bodyweight comes from WorkoutRecord.bodyweightKg (sparse — buckets
//   without a value are omitted, not zero-filled).
// ============================================================================

import { epley1RM } from './calc.js';
import { todayISO } from './util.js';
import { listWorkouts, listSetsForWorkout, listExercises } from './db.js';

// Metric catalogues. `unit` is a display hint ('kg' converts per the user's
// display-unit setting AT THE UI LAYER — series values here are ALWAYS kg).
// `agg` documents the per-bucket aggregation so the UI can label sensibly.

/** Overall (whole-training-history) metrics. */
export const OVERALL_METRICS = [
  { id: 'duration', label: 'Workout Duration', unit: 'min', agg: 'avg' },
  { id: 'volume', label: 'Volume', unit: 'kg', agg: 'sum' },
  { id: 'sets', label: 'Total Sets', unit: '', agg: 'sum' },
  { id: 'reps', label: 'Total Reps', unit: '', agg: 'sum' },
  { id: 'repsPerSet', label: 'Reps per Set', unit: '', agg: 'avg' },
  { id: 'bodyweight', label: 'Bodyweight', unit: 'kg', agg: 'last' },
  { id: 'workouts', label: 'Number of Workouts', unit: '', agg: 'count' },
  { id: 'cardioTime', label: 'Cardio Time', unit: 'min', agg: 'sum' },
  { id: 'cardioDistance', label: 'Cardio Distance', unit: 'm', agg: 'sum' },
  { id: 'kcal', label: 'Calories (logged)', unit: 'kcal', agg: 'sum' },
];

/** Per-exercise metrics (scope.id = exerciseId). */
export const EXERCISE_METRICS = [
  { id: 'e1rm', label: 'Estimated 1 Rep Max', unit: 'kg', agg: 'max' },
  { id: 'e1rmPerBw', label: 'Est. 1 Rep Max / BW', unit: '', agg: 'max' },
  { id: 'volume', label: 'Volume', unit: 'kg', agg: 'sum' },
  { id: 'maxWeight', label: 'Max Weight', unit: 'kg', agg: 'max' },
  { id: 'avgWeight', label: 'Avg. Weight', unit: 'kg', agg: 'avg' },
  { id: 'totalReps', label: 'Total Reps', unit: '', agg: 'sum' },
  { id: 'totalSets', label: 'Total Sets', unit: '', agg: 'sum' },
  { id: 'repsPerSet', label: 'Reps per Set', unit: '', agg: 'avg' },
  { id: 'maxReps', label: 'Max Reps', unit: '', agg: 'max' },
  { id: 'workouts', label: 'Number of Workouts', unit: '', agg: 'count' },
];

/** Per-category metrics (scope.id = muscleGroup). */
export const CATEGORY_METRICS = [
  { id: 'volume', label: 'Volume', unit: 'kg', agg: 'sum' },
  { id: 'sets', label: 'Total Sets', unit: '', agg: 'sum' },
  { id: 'reps', label: 'Total Reps', unit: '', agg: 'sum' },
  { id: 'workouts', label: 'Number of Workouts', unit: '', agg: 'count' },
];

// ---- internal helpers (pure unless noted) ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GROUP_BYS = ['day', 'week', 'month', 'year'];
const CATALOGUES = { overall: OVERALL_METRICS, exercise: EXERCISE_METRICS, category: CATEGORY_METRICS };

/** Catalogue entry for a scope+metric, or null when the pair is unknown. */
function metricMeta(scopeKind, metricId) {
  return (CATALOGUES[scopeKind] || []).find((m) => m.id === metricId) || null;
}

/** [y, m, d] from an ISO date/datetime string. */
function ymd(iso) {
  return String(iso).slice(0, 10).split('-').map(Number);
}

/** Local ISO date (YYYY-MM-DD) for a Date — matches util.todayISO(). */
function isoOf(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Earliest workout date a range admits: today minus 3/6/12 calendar months.
 * '0000' (the db.js "everything" sentinel) for 'all' or anything unknown.
 */
function rangeStart(range, today = todayISO()) {
  const months = range === '3m' ? 3 : range === '6m' ? 6 : range === '1y' ? 12 : 0;
  if (!months) return '0000';
  const [y, m, d] = ymd(today);
  const date = new Date(y, m - 1, d);
  date.setMonth(date.getMonth() - months);
  return isoOf(date);
}

/** Bucket start for a workout date: epoch ms of local midnight. */
function bucketStart(isoDate, groupBy) {
  const [y, m, d] = ymd(isoDate);
  if (groupBy === 'year') return new Date(y, 0, 1).getTime();
  if (groupBy === 'month') return new Date(y, m - 1, 1).getTime();
  if (groupBy === 'week') {
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); // back to Monday
    return date.getTime();
  }
  return new Date(y, m - 1, d).getTime();
}

/**
 * Axis text for a bucket start — ALWAYS a real date, never a week number:
 * day '6 Mar' | week '3 Aug' (the Monday it begins, per bucketStart) |
 * month 'Mar 2026' | year '2026'. A week number tells you nothing at a
 * glance; the date it starts on does.
 */
function bucketLabel(t, groupBy) {
  const date = new Date(t);
  if (groupBy === 'year') return String(date.getFullYear());
  if (groupBy === 'month') return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  // week buckets start on their Monday, so the same day/month form reads as
  // "week beginning 3 Aug".
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** The next bucket start after t (calendar arithmetic, so DST-safe). */
function nextBucket(t, groupBy) {
  const date = new Date(t);
  if (groupBy === 'year') date.setFullYear(date.getFullYear() + 1);
  else if (groupBy === 'month') date.setMonth(date.getMonth() + 1);
  else if (groupBy === 'week') date.setDate(date.getDate() + 7);
  else date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** 'chest' -> 'Chest' (muscle groups are stored as lower-case ids). */
function titleCase(s) {
  const str = String(s || '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Load everything the metric layer needs for a range: FINISHED workouts
 * (oldest first), all their sets, and the exercise library. One pass per
 * computeSeries/categoryBreakdown call — never per bucket.
 */
async function loadDataset(range) {
  const workouts = (await listWorkouts(rangeStart(range))).filter((w) => w.finishedAt != null);
  workouts.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return String(a.startedAt || '') < String(b.startedAt || '') ? -1 : 1;
  });
  const sets = [];
  for (const w of workouts) {
    for (const s of await listSetsForWorkout(w.id)) sets.push(s);
  }
  const exercises = new Map((await listExercises()).map((e) => [e.id, e]));
  const workoutById = new Map(workouts.map((w) => [w.id, w]));
  return { workouts, sets, exercises, workoutById };
}

/**
 * Does a set count towards the strength metrics (volume, sets, reps, weights,
 * e1RM)? Cardio sets carry no load; warmups are out unless the chart asks for
 * them; reps < 1 means an untouched or time/distance-only set, which would
 * otherwise manufacture zero-weight averages and Epley estimates out of
 * nothing (the same rule calc.js prsFrom applies). Note prsFrom caps reps at
 * 10 only for the per-rep PR table — its bestE1RM has no cap, so neither
 * does the e1RM series here.
 */
function isStrengthSet(set, includeWarmup) {
  if (set.setType === 'cardio') return false;
  if (!includeWarmup && set.isWarmup === true) return false;
  return Number(set.reps) >= 1;
}

/** Empty accumulator for one bucket. */
function newBucket(t) {
  return {
    t,
    workouts: new Set(),       // every finished workout in the bucket
    scopeWorkouts: new Set(),  // …those that contributed a qualifying set
    durationSum: 0,
    durationCount: 0,
    bodyweight: null,
    bodyweightAt: null,
    volume: 0,
    reps: 0,
    sets: 0,
    weightSum: 0,
    maxWeight: null,
    maxReps: null,
    maxE1rm: null,
    maxE1rmPerBw: null,
    cardioMin: 0,
    cardioMinCount: 0,
    distanceM: 0,
    distanceCount: 0,
    kcal: 0,
    kcalCount: 0,
  };
}

/** Accumulate a dataset into buckets for one scope. @returns {Map<number, object>} */
function collect(data, { scope, groupBy, includeWarmup, countUnilateralTwice }) {
  const buckets = new Map();
  const bucketFor = (isoDate) => {
    const t = bucketStart(isoDate, groupBy);
    let b = buckets.get(t);
    if (!b) {
      b = newBucket(t);
      buckets.set(t, b);
    }
    return b;
  };

  for (const w of data.workouts) {
    const b = bucketFor(w.date);
    b.workouts.add(w.id);
    const started = Date.parse(w.startedAt);
    const finished = Date.parse(w.finishedAt);
    if (Number.isFinite(started) && Number.isFinite(finished) && finished > started) {
      b.durationSum += (finished - started) / 60000;
      b.durationCount += 1;
    }
    // Bodyweight is sparse: keep the last logged value in the bucket.
    if (Number.isFinite(w.bodyweightKg)) {
      const at = String(w.startedAt || w.date);
      if (b.bodyweightAt === null || at >= b.bodyweightAt) {
        b.bodyweight = w.bodyweightKg;
        b.bodyweightAt = at;
      }
    }
  }

  for (const s of data.sets) {
    const w = data.workoutById.get(s.workoutId);
    if (!w) continue;
    const b = bucketFor(w.date);
    const ex = data.exercises.get(s.exerciseId);

    // Duration/distance/kcal come from EVERY set carrying them — a timed
    // strength hold is cardio time just like a treadmill run.
    if (Number.isFinite(s.durationSeconds) && s.durationSeconds > 0) {
      b.cardioMin += s.durationSeconds / 60;
      b.cardioMinCount += 1;
    }
    if (Number.isFinite(s.distanceM) && s.distanceM > 0) {
      b.distanceM += s.distanceM;
      b.distanceCount += 1;
    }
    if (Number.isFinite(s.kcal) && s.kcal > 0) {
      b.kcal += s.kcal;
      b.kcalCount += 1;
    }

    if (scope.kind === 'exercise' && s.exerciseId !== scope.id) continue;
    if (scope.kind === 'category' && (!ex || ex.muscleGroup !== scope.id)) continue;
    if (!isStrengthSet(s, includeWarmup)) continue;

    const reps = Number(s.reps);
    const weightKg = Number.isFinite(s.weightKg) ? s.weightKg : 0;
    // RepCount parity: a unilateral exercise did the work twice over. The
    // doubling applies to volume/reps only, never to counts or maxima.
    const factor = countUnilateralTwice && ex && ex.isUnilateral === true ? 2 : 1;
    b.volume += weightKg * reps * factor;
    b.reps += reps * factor;
    b.sets += 1;
    b.weightSum += weightKg;
    b.maxWeight = b.maxWeight === null ? weightKg : Math.max(b.maxWeight, weightKg);
    b.maxReps = b.maxReps === null ? reps : Math.max(b.maxReps, reps);
    const e1rm = epley1RM(weightKg, reps);
    b.maxE1rm = b.maxE1rm === null ? e1rm : Math.max(b.maxE1rm, e1rm);
    if (Number.isFinite(w.bodyweightKg) && w.bodyweightKg > 0) {
      const ratio = e1rm / w.bodyweightKg;
      b.maxE1rmPerBw = b.maxE1rmPerBw === null ? ratio : Math.max(b.maxE1rmPerBw, ratio);
    }
    b.scopeWorkouts.add(w.id);
  }

  return buckets;
}

/** A bucket's value for a metric, or null when the bucket has no data for it. */
function valueOf(b, scopeKind, metricId) {
  switch (metricId) {
    case 'duration': return b.durationCount ? b.durationSum / b.durationCount : null;
    case 'volume': return b.sets ? b.volume : null;
    case 'sets': case 'totalSets': return b.sets ? b.sets : null;
    case 'reps': case 'totalReps': return b.sets ? b.reps : null;
    case 'repsPerSet': return b.sets ? b.reps / b.sets : null;
    case 'bodyweight': return b.bodyweight;
    case 'workouts': return scopeKind === 'overall' ? b.workouts.size : b.scopeWorkouts.size;
    case 'cardioTime': return b.cardioMinCount ? b.cardioMin : null;
    case 'cardioDistance': return b.distanceCount ? b.distanceM : null;
    case 'kcal': return b.kcalCount ? b.kcal : null;
    case 'e1rm': return b.maxE1rm;
    case 'e1rmPerBw': return b.maxE1rmPerBw;
    case 'maxWeight': return b.maxWeight;
    case 'avgWeight': return b.sets ? b.weightSum / b.sets : null;
    case 'maxReps': return b.maxReps;
    default: return null;
  }
}

/**
 * Counts are the one place an empty bucket means a truthful zero: trim the
 * leading/trailing empties, then fill the interior gaps so a rest week reads
 * as 0 instead of vanishing. The iteration cap is pure paranoia — it can only
 * bite on an absurd date span.
 */
function zeroFill(points, groupBy) {
  let lo = 0;
  while (lo < points.length && points[lo].value === 0) lo += 1;
  let hi = points.length - 1;
  while (hi >= lo && points[hi].value === 0) hi -= 1;
  const kept = points.slice(lo, hi + 1);
  if (kept.length === 0) return [];

  const out = [];
  const end = kept[kept.length - 1].t;
  let t = kept[0].t;
  let i = 0;
  for (let guard = 0; guard < 20000 && t <= end; guard += 1) {
    if (i < kept.length && kept[i].t === t) {
      out.push(kept[i]);
      i += 1;
    } else {
      out.push({ t, label: bucketLabel(t, groupBy), value: 0 });
    }
    t = nextBucket(t, groupBy);
  }
  return out;
}

/**
 * Compute a chartable time series.
 *
 * Buckets: groupBy 'day' = calendar day, 'week' = ISO week (calc.js
 * Monday-anchored), 'month' = calendar month, 'year' = calendar year. Buckets with
 * no qualifying data are OMITTED except 'workouts'-style counts where a gap
 * genuinely means zero — then include zero buckets between the first and last
 * non-empty bucket so lines don't lie. Points ascend by t (bucket start, epoch
 * ms, local). label is short axis text, always a real date — '6 Mar' (day),
 * '3 Aug' (week, its Monday), 'Mar 2026' (month), '2026' (year).
 *
 * range: trailing window ending today — '3m' | '6m' | '1y' | 'all'.
 *
 * @param {{
 *   scope: {kind: 'overall'|'exercise'|'category', id?: string},
 *   metric: string,                       // an id from the matching catalogue
 *   groupBy: 'day'|'week'|'month'|'year',
 *   range: '3m'|'6m'|'1y'|'all',
 *   includeWarmup?: boolean,
 *   countUnilateralTwice?: boolean,
 * }} q
 * @returns {Promise<{points: Array<{t: number, label: string, value: number}>, unit: string}>}
 */
export async function computeSeries(q) {
  const scope = q && q.scope ? q.scope : { kind: 'overall' };
  const meta = metricMeta(scope.kind, q && q.metric);
  // A stored module can outlive its metric (scope switched, catalogue edited):
  // an empty series charts as "no data" rather than throwing at the UI.
  if (!meta) return { points: [], unit: '' };
  const groupBy = GROUP_BYS.includes(q.groupBy) ? q.groupBy : 'week';

  const data = await loadDataset(q.range);
  const buckets = collect(data, {
    scope,
    groupBy,
    includeWarmup: q.includeWarmup === true,
    countUnilateralTwice: q.countUnilateralTwice === true,
  });

  let points = [...buckets.values()]
    .map((b) => ({ t: b.t, label: bucketLabel(b.t, groupBy), value: valueOf(b, scope.kind, meta.id) }))
    .filter((p) => p.value !== null && Number.isFinite(p.value))
    .sort((a, b) => a.t - b.t);
  if (meta.agg === 'count') points = zeroFill(points, groupBy);

  return { points, unit: meta.unit };
}

/**
 * Composition breakdown for pie charts: how a metric splits across muscle
 * groups over a range. metric ∈ {'volume','sets','reps','workouts'} (workouts
 * = sessions touching the group, so slices can exceed the session total).
 * Slices sorted descending, zero slices omitted.
 *
 * @param {{
 *   metric: string,
 *   range: '3m'|'6m'|'1y'|'all',
 *   includeWarmup?: boolean,
 *   countUnilateralTwice?: boolean,
 * }} q
 * @returns {Promise<{slices: Array<{label: string, value: number}>, unit: string}>}
 */
export async function categoryBreakdown(q) {
  const meta = CATEGORY_METRICS.find((m) => m.id === (q && q.metric));
  if (!meta) return { slices: [], unit: '' };
  const includeWarmup = q.includeWarmup === true;
  const countUnilateralTwice = q.countUnilateralTwice === true;

  const data = await loadDataset(q.range);
  const totals = new Map(); // muscleGroup -> { volume, sets, reps, workouts }
  for (const s of data.sets) {
    const w = data.workoutById.get(s.workoutId);
    if (!w) continue;
    const ex = data.exercises.get(s.exerciseId);
    if (!ex) continue;
    if (!isStrengthSet(s, includeWarmup)) continue;
    const group = ex.muscleGroup || 'other';
    let acc = totals.get(group);
    if (!acc) {
      acc = { volume: 0, sets: 0, reps: 0, workouts: new Set() };
      totals.set(group, acc);
    }
    const reps = Number(s.reps);
    const weightKg = Number.isFinite(s.weightKg) ? s.weightKg : 0;
    const factor = countUnilateralTwice && ex.isUnilateral === true ? 2 : 1;
    acc.volume += weightKg * reps * factor;
    acc.reps += reps * factor;
    acc.sets += 1;
    acc.workouts.add(w.id);
  }

  const slices = [...totals.entries()]
    .map(([group, acc]) => ({
      label: titleCase(group),
      value: meta.id === 'workouts' ? acc.workouts.size : acc[meta.id],
    }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  return { slices, unit: meta.unit };
}
