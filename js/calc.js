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
// - Estimated 1RM is Epley: weightKg * (1 + reps / 30).
// - ISO weeks are formatted 'YYYY-Www' (e.g. '2026-W30'), ISO 8601 week
//   numbering (weeks start Monday; week 1 contains the first Thursday).

/** Epley estimated 1RM. reps >= 1. @returns {number} */
export function epley1RM(weightKg, reps) { throw new Error('TODO: implement'); }

/** ISO-8601 week id for an ISO date string. @returns {string} 'YYYY-Www' */
export function isoWeekOf(isoDate) { throw new Error('TODO: implement'); }

/**
 * Most recent FINISHED workout (finishedAt != null) containing exerciseId,
 * with that exercise's sets ordered by setNumber (warmups included).
 * @returns {{workout: WorkoutRecord, sets: SetRecord[]}|null}
 */
export function lastSessionFrom(dataset, exerciseId) { throw new Error('TODO: implement'); }

/**
 * Workouts with date >= sinceDate (inclusive), newest first, each with all
 * its sets ordered by exerciseId then setNumber.
 * @returns {Array<{workout: WorkoutRecord, sets: SetRecord[]}>}
 */
export function recentWorkoutsFrom(dataset, sinceDate) { throw new Error('TODO: implement'); }

/**
 * PRs for an exercise, warmups excluded.
 * byReps: for each rep count 1–10 where at least one working set exists, the
 * heaviest weight achieved AT THAT EXACT rep count (ties → earliest date).
 * bestE1RM: the single working set (any rep count) with the highest Epley
 * estimate, or null if no working sets.
 * @returns {{
 *   byReps: Array<{reps:number, weightKg:number, date:string, setId:string}>,
 *   bestE1RM: {value:number, weightKg:number, reps:number, date:string, setId:string}|null
 * }}
 */
export function prsFrom(dataset, exerciseId) { throw new Error('TODO: implement'); }

/**
 * Σ(weightKg × reps) per muscle group per ISO week, warmups excluded, for the
 * trailing `weeks` ISO weeks INCLUDING the week containing `today`.
 * Every week in the range appears (zero-filled), oldest first.
 * @param {string} today ISO date the range is anchored to
 * @returns {Array<{isoWeek:string, perMuscleGroup:Object<string,number>}>}
 */
export function weeklyVolumeFrom(dataset, weeks, today) { throw new Error('TODO: implement'); }

/**
 * Training frequency per ISO week for the trailing `weeks` weeks including
 * the week containing `today`, oldest first, zero-filled.
 * sessionsTotal counts distinct workouts that week; perMuscleGroup counts
 * distinct workouts that week containing at least one set (warmups included)
 * for an exercise of that muscle group.
 * @returns {Array<{isoWeek:string, sessionsTotal:number, perMuscleGroup:Object<string,number>}>}
 */
export function trainingFrequencyFrom(dataset, weeks, today) { throw new Error('TODO: implement'); }
