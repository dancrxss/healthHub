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

/**
 * Compute a chartable time series.
 *
 * Buckets: groupBy 'day' = calendar day, 'week' = ISO week (calc.js
 * isoWeekOf), 'month' = calendar month, 'year' = calendar year. Buckets with
 * no qualifying data are OMITTED except 'workouts'-style counts where a gap
 * genuinely means zero — then include zero buckets between the first and last
 * non-empty bucket so lines don't lie. Points ascend by t (bucket start, epoch
 * ms, local). label is short axis text ('6 Mar', 'W31', 'Mar 2026', '2026' by
 * groupBy).
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
  throw new Error('stats-data: not implemented');
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
  throw new Error('stats-data: not implemented');
}
