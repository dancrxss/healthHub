// Pure derived-metric functions over plain data arrays. No IndexedDB, no DOM,
// no imports from db.js — these run identically in the browser and in Node
// (tests), and are the logic the frozen query layer (queries.js) delegates to.
// Part of the pinned contract: signatures and return shapes are fixed.
//
// Conventions:
// - "dataset" means { workouts: WorkoutRecord[], sets: SetRecord[],
//   exercises: ExerciseRecord[] } (shapes per db.js).
// - Warmup sets (isWarmup === true) are EXCLUDED from PRs and volume,
//   per the spec. They still count towards "the workout happened" for
//   frequency, and appear in session listings.
// - Cardio sets (setType === 'cardio') are likewise EXCLUDED from PRs and
//   volume (they carry no weight/reps load). Like warmups, they still count
//   towards frequency and appear in session listings. setType absent ⇒
//   'strength'.
// - Estimated 1RM is Epley: weightKg * (1 + reps / 30).
// - ISO weeks are formatted 'YYYY-Www' (e.g. '2026-W30'), ISO 8601 week
//   numbering (weeks start Monday; week 1 contains the first Thursday).

/** Epley estimated 1RM. reps >= 1. @returns {number} */
export function epley1RM(weightKg, reps) {
  return weightKg * (1 + reps / 30);
}

/** ISO-8601 week id for an ISO date string. @returns {string} 'YYYY-Www' */
export function isoWeekOf(isoDate) {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Shift to the Thursday of the current ISO week (Mon=0..Sun=6).
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  // Thursday of ISO week 1 is in the same week as Jan 4th.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const ftDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

// ---- internal helpers (not exported; kept pure) ----

/** Map of workout id -> workout record. */
function workoutIndex(dataset) {
  const map = new Map();
  for (const w of dataset.workouts || []) map.set(w.id, w);
  return map;
}

/** Map of exercise id -> muscleGroup. */
function exerciseMuscleIndex(dataset) {
  const map = new Map();
  for (const e of dataset.exercises || []) map.set(e.id, e.muscleGroup);
  return map;
}

/** Distinct muscle groups present in the dataset's exercise library, sorted. */
function muscleGroupsOf(dataset) {
  return [...new Set((dataset.exercises || []).map((e) => e.muscleGroup))].sort();
}

/** Monday (UTC Date) of the ISO week containing an ISO date. */
function mondayOfISOWeek(isoDate) {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum);
  return date;
}

/** Ordered (oldest first) list of the trailing `weeks` ISO week ids incl. today's. */
function weekRange(weeks, today) {
  const monday = mondayOfISOWeek(today);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(monday.getTime() - i * 7 * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    out.push(isoWeekOf(iso));
  }
  return out;
}

/** Sort comparator: newest workout first (by date, then startedAt). */
function byWorkoutNewest(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const as = a.startedAt || '';
  const bs = b.startedAt || '';
  if (as !== bs) return as < bs ? 1 : -1;
  return 0;
}

/**
 * Most recent FINISHED workout (finishedAt != null) containing exerciseId,
 * with that exercise's sets ordered by setNumber (warmups included).
 * @returns {{workout: WorkoutRecord, sets: SetRecord[]}|null}
 */
export function lastSessionFrom(dataset, exerciseId) {
  const setsByWorkout = new Map();
  for (const s of dataset.sets || []) {
    if (s.exerciseId !== exerciseId) continue;
    if (!setsByWorkout.has(s.workoutId)) setsByWorkout.set(s.workoutId, []);
    setsByWorkout.get(s.workoutId).push(s);
  }
  const candidates = (dataset.workouts || []).filter(
    (w) => w.finishedAt != null && setsByWorkout.has(w.id)
  );
  if (candidates.length === 0) return null;
  candidates.sort(byWorkoutNewest);
  const workout = candidates[0];
  const sets = setsByWorkout.get(workout.id).slice().sort((a, b) => a.setNumber - b.setNumber);
  return { workout, sets };
}

/**
 * Workouts with date >= sinceDate (inclusive), newest first, each with all
 * its sets ordered by exerciseId then setNumber.
 * @returns {Array<{workout: WorkoutRecord, sets: SetRecord[]}>}
 */
export function recentWorkoutsFrom(dataset, sinceDate) {
  const setsByWorkout = new Map();
  for (const s of dataset.sets || []) {
    if (!setsByWorkout.has(s.workoutId)) setsByWorkout.set(s.workoutId, []);
    setsByWorkout.get(s.workoutId).push(s);
  }
  const workouts = (dataset.workouts || [])
    .filter((w) => w.date >= sinceDate)
    .slice()
    .sort(byWorkoutNewest);
  return workouts.map((workout) => {
    const sets = (setsByWorkout.get(workout.id) || []).slice().sort((a, b) => {
      if (a.exerciseId !== b.exerciseId) return a.exerciseId < b.exerciseId ? -1 : 1;
      return a.setNumber - b.setNumber;
    });
    return { workout, sets };
  });
}

/**
 * PRs for an exercise, warmups excluded.
 * byReps: for each rep count 1–10 where at least one working set exists, the
 * heaviest weight achieved AT THAT EXACT rep count (ties → earliest date).
 * bestE1RM: the single working set (any rep count) with the highest Epley
 * estimate, or null if no working sets.
 *
 * Added 13 Oct 2026 (additive — the two fields above are unchanged). byReps
 * reads badly as a records list: a single low-rep grinder shows up as "the
 * 3-rep record" and anything over 10 reps is missing. These are the records a
 * lifter actually recognises, each one a real set that was logged:
 * heaviest: the heaviest weight lifted, with the MOST reps done at it.
 * bestSet:  the single set with the highest weight × reps.
 * mostReps: the most reps in one set (ties → the heavier one).
 * byWeight: for every weight used, the most reps done at it — heaviest first.
 * Ties everywhere keep the earliest set.
 *
 * For exercises that are not rep-based (holds, carries, cardio) the fields
 * above are empty, so three more records are taken over every non-warm-up set
 * regardless of type: longest (durationSeconds), furthest (distanceM) and
 * mostKcal — each null when that field was never logged.
 * @returns {{
 *   byReps: Array<{reps:number, weightKg:number, date:string, setId:string}>,
 *   bestE1RM: {value:number, weightKg:number, reps:number, date:string, setId:string}|null,
 *   heaviest: {weightKg:number, reps:number, date:string, setId:string}|null,
 *   bestSet: {loadKg:number, weightKg:number, reps:number, date:string, setId:string}|null,
 *   mostReps: {reps:number, weightKg:number, date:string, setId:string}|null,
 *   byWeight: Array<{weightKg:number, reps:number, date:string, setId:string}>,
 *   longest: {durationSeconds:number, weightKg:number, date:string, setId:string}|null,
 *   furthest: {distanceM:number, weightKg:number, date:string, setId:string}|null,
 *   mostKcal: {kcal:number, date:string, setId:string}|null
 * }}
 */
export function prsFrom(dataset, exerciseId) {
  const workouts = workoutIndex(dataset);
  // Working sets for this exercise, decorated with their workout date, sorted
  // ascending by (date, setNumber) so the FIRST occurrence at any tie is earliest.
  // reps >= 1: untouched blank sets and time/distance-only sets store reps 0
  // and must not manufacture an Epley estimate (w × (1 + 0/30) = w).
  const working = (dataset.sets || [])
    .filter((s) => s.exerciseId === exerciseId && s.isWarmup !== true && s.setType !== 'cardio' && s.reps >= 1)
    .map((s) => ({ set: s, date: (workouts.get(s.workoutId) || {}).date || '' }))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.set.setNumber - b.set.setNumber;
    });

  const byRepsMap = new Map(); // reps -> {reps, weightKg, date, setId}
  const byWeightMap = new Map(); // weightKg -> {weightKg, reps, date, setId}
  let bestE1RM = null;
  let heaviest = null;
  let bestSet = null;
  let mostReps = null;
  for (const { set, date } of working) {
    const reps = set.reps;
    const w = Number(set.weightKg) || 0;
    const here = { weightKg: w, reps, date, setId: set.id };
    const atWeight = byWeightMap.get(w);
    if (!atWeight || reps > atWeight.reps) byWeightMap.set(w, here);
    if (!heaviest || w > heaviest.weightKg || (w === heaviest.weightKg && reps > heaviest.reps)) heaviest = here;
    if (!bestSet || w * reps > bestSet.loadKg) bestSet = { loadKg: w * reps, ...here };
    if (!mostReps || reps > mostReps.reps || (reps === mostReps.reps && w > mostReps.weightKg)) {
      mostReps = { reps, weightKg: w, date, setId: set.id };
    }
    if (reps >= 1 && reps <= 10) {
      const existing = byRepsMap.get(reps);
      // Strictly heavier wins; equal weight keeps the earlier (already-first) one.
      if (!existing || set.weightKg > existing.weightKg) {
        byRepsMap.set(reps, { reps, weightKg: set.weightKg, date, setId: set.id });
      }
    }
    const e = epley1RM(set.weightKg, reps);
    // Strictly greater wins; ties keep the earlier date (processed first).
    if (!bestE1RM || e > bestE1RM.value) {
      bestE1RM = { value: e, weightKg: set.weightKg, reps, date, setId: set.id };
    }
  }

  const byReps = [...byRepsMap.values()].sort((a, b) => a.reps - b.reps);
  const byWeight = [...byWeightMap.values()].sort((a, b) => b.weightKg - a.weightKg);

  // Type-agnostic records (time / distance / kcal), over every non-warm-up set.
  let longest = null;
  let furthest = null;
  let mostKcal = null;
  const anySets = (dataset.sets || [])
    .filter((s) => s.exerciseId === exerciseId && s.isWarmup !== true)
    .map((s) => ({ set: s, date: (workouts.get(s.workoutId) || {}).date || '' }))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.set.setNumber - b.set.setNumber;
    });
  for (const { set, date } of anySets) {
    const dur = Number(set.durationSeconds) || 0;
    const dist = Number(set.distanceM) || 0;
    const kcal = Number(set.kcal) || 0;
    const w = Number(set.weightKg) || 0;
    if (dur > 0 && (!longest || dur > longest.durationSeconds)) longest = { durationSeconds: dur, weightKg: w, date, setId: set.id };
    if (dist > 0 && (!furthest || dist > furthest.distanceM)) furthest = { distanceM: dist, weightKg: w, date, setId: set.id };
    if (kcal > 0 && (!mostKcal || kcal > mostKcal.kcal)) mostKcal = { kcal, date, setId: set.id };
  }

  return { byReps, bestE1RM, heaviest, bestSet, mostReps, byWeight, longest, furthest, mostKcal };
}

/** A set row the user has actually filled in (not an untouched blank). */
function isLoggedSet(s) {
  return (Number(s.reps) || 0) > 0 || (Number(s.weightKg) || 0) > 0
    || (Number(s.durationSeconds) || 0) > 0 || (Number(s.distanceM) || 0) > 0
    || (Number(s.kcal) || 0) > 0;
}

/**
 * Session-by-session progress for one exercise: ONE point per finished
 * workout, taken from that session's TOP SET — the first working set done
 * (lowest setNumber; warm-ups and untouched blank rows skipped). Later sets
 * are ignored on purpose: sessions differ in how many sets they have, so the
 * first working set is the like-for-like comparison.
 *
 * Works for every exercise type — a field the type does not log is null.
 * loadKg = weightKg × reps (null without reps); e1rm is Epley (null without
 * reps). Cardio sets are included here: this is a progress view, not a
 * PR/volume calculation.
 *
 * @returns {Array<{workoutId:string, date:string, t:number, setId:string,
 *   weightKg:number, reps:number, loadKg:number|null, e1rm:number|null,
 *   durationSeconds:number|null, distanceM:number|null, kcal:number|null}>}
 *   oldest first (by workout start)
 */
export function topSetSeriesFrom(dataset, exerciseId) {
  const workouts = workoutIndex(dataset);
  const firstByWorkout = new Map(); // workoutId -> first logged working set
  for (const s of dataset.sets || []) {
    if (s.exerciseId !== exerciseId || s.isWarmup === true || !isLoggedSet(s)) continue;
    const w = workouts.get(s.workoutId);
    if (!w || w.finishedAt == null) continue;
    const cur = firstByWorkout.get(s.workoutId);
    if (!cur || s.setNumber < cur.setNumber) firstByWorkout.set(s.workoutId, s);
  }
  const pos = (n) => ((Number(n) || 0) > 0 ? Number(n) : null);
  const out = [];
  for (const [workoutId, s] of firstByWorkout) {
    const w = workouts.get(workoutId);
    const started = w.startedAt ? new Date(w.startedAt).getTime() : NaN;
    const t = Number.isFinite(started) ? started : new Date(`${w.date}T00:00:00`).getTime();
    const weightKg = Number(s.weightKg) || 0;
    const reps = Number(s.reps) || 0;
    out.push({
      workoutId,
      date: w.date,
      t,
      setId: s.id,
      weightKg,
      reps,
      loadKg: reps >= 1 ? weightKg * reps : null,
      e1rm: reps >= 1 ? epley1RM(weightKg, reps) : null,
      durationSeconds: pos(s.durationSeconds),
      distanceM: pos(s.distanceM),
      kcal: pos(s.kcal),
    });
  }
  out.sort((a, b) => (a.t !== b.t ? a.t - b.t : (a.setId < b.setId ? -1 : 1)));
  return out;
}

/**
 * Σ(weightKg × reps) per muscle group per ISO week, warmups excluded, for the
 * trailing `weeks` ISO weeks INCLUDING the week containing `today`.
 * Every week in the range appears (zero-filled), oldest first.
 * @param {string} today ISO date the range is anchored to
 * @returns {Array<{isoWeek:string, perMuscleGroup:Object<string,number>}>}
 */
export function weeklyVolumeFrom(dataset, weeks, today) {
  const weekIds = weekRange(weeks, today);
  const groups = muscleGroupsOf(dataset);
  const workouts = workoutIndex(dataset);
  const muscleOf = exerciseMuscleIndex(dataset);

  const byWeek = new Map();
  for (const wk of weekIds) {
    const per = {};
    for (const g of groups) per[g] = 0;
    byWeek.set(wk, per);
  }

  for (const s of dataset.sets || []) {
    if (s.isWarmup === true) continue;
    if (s.setType === 'cardio') continue;
    const workout = workouts.get(s.workoutId);
    if (!workout) continue;
    const wk = isoWeekOf(workout.date);
    const per = byWeek.get(wk);
    if (!per) continue;
    const group = muscleOf.get(s.exerciseId);
    if (group == null || !(group in per)) continue;
    per[group] += s.weightKg * s.reps;
  }

  return weekIds.map((isoWeek) => ({ isoWeek, perMuscleGroup: byWeek.get(isoWeek) }));
}

/**
 * Training frequency per ISO week for the trailing `weeks` weeks including
 * the week containing `today`, oldest first, zero-filled.
 * sessionsTotal counts distinct workouts that week; perMuscleGroup counts
 * distinct workouts that week containing at least one set (warmups included)
 * for an exercise of that muscle group.
 * @returns {Array<{isoWeek:string, sessionsTotal:number, perMuscleGroup:Object<string,number>}>}
 */
export function trainingFrequencyFrom(dataset, weeks, today) {
  const weekIds = weekRange(weeks, today);
  const weekSet = new Set(weekIds);
  const groups = muscleGroupsOf(dataset);
  const muscleOf = exerciseMuscleIndex(dataset);

  // Distinct workouts per week (sessionsTotal).
  const totalByWeek = new Map(); // wk -> Set(workoutId)
  // Distinct workouts per week per muscle group.
  const groupByWeek = new Map(); // wk -> { group -> Set(workoutId) }
  for (const wk of weekIds) {
    totalByWeek.set(wk, new Set());
    const g = {};
    for (const grp of groups) g[grp] = new Set();
    groupByWeek.set(wk, g);
  }

  for (const w of dataset.workouts || []) {
    const wk = isoWeekOf(w.date);
    if (weekSet.has(wk)) totalByWeek.get(wk).add(w.id);
  }

  const workouts = workoutIndex(dataset);
  for (const s of dataset.sets || []) {
    // Warmups still count towards frequency.
    const workout = workouts.get(s.workoutId);
    if (!workout) continue;
    const wk = isoWeekOf(workout.date);
    if (!weekSet.has(wk)) continue;
    const group = muscleOf.get(s.exerciseId);
    const g = groupByWeek.get(wk);
    if (group != null && g[group]) g[group].add(s.workoutId);
  }

  return weekIds.map((isoWeek) => {
    const per = {};
    const g = groupByWeek.get(isoWeek);
    for (const grp of groups) per[grp] = g[grp].size;
    return {
      isoWeek,
      sessionsTotal: totalByWeek.get(isoWeek).size,
      perMuscleGroup: per,
    };
  });
}
