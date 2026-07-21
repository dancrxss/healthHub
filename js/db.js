// Data layer: IndexedDB schema + repository functions.
// This file is part of the pinned contract (see PLAN.md). Signatures, store
// names, indexes and record shapes are fixed — do not change them without
// flagging it to the orchestrator.
//
// Record shapes (per gym-tracker-spec.md — every record also carries
// `syncedAt: string|null`, set to null on any local write, used for delta sync):
//
// @typedef {Object} ExerciseRecord
//   {string} id            uuid (seed exercises use stable "seed-<slug>" ids)
//   {string} name          e.g. "Barbell Bench Press"
//   {string} muscleGroup   one of MUSCLE_GROUPS
//   {string} equipment     one of EQUIPMENT
//   {boolean} isCustom
//   {string} createdAt     ISO datetime
//   {string|null} syncedAt
//
// @typedef {Object} WorkoutRecord
//   {string} id
//   {string} date          ISO date (YYYY-MM-DD) — the training day
//   {string} startedAt     ISO datetime
//   {string|null} finishedAt   null while in progress
//   {string|null} templateId
//   {string|null} notes
//   {string|null} syncedAt
//
// @typedef {Object} SetRecord
//   {string} id
//   {string} workoutId
//   {string} exerciseId
//   {number} setNumber     1-based order within exercise within workout
//   {number} weightKg      0 for pure bodyweight; added load if weighted
//   {number} reps
//   {number|null} rpe      6–10 or null
//   {boolean} isWarmup     excluded from PR/volume calcs
//   {string} completedAt   ISO datetime — drives the auto rest timer
//   {string|null} syncedAt
//
// @typedef {Object} TemplateRecord
//   {string} id
//   {string} name          e.g. "Push Day A"
//   {Array<{exerciseId:string, targetSets:number, targetRepsLow:number,
//           targetRepsHigh:number}>} entries   ordered
//   {string|null} syncedAt

export const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'other'];
export const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'other'];

export const DB_NAME = 'healthhub';
export const DB_VERSION = 1;

// Object stores (all keyPath 'id' except meta, keyPath 'key'):
//   exercises
//   workouts   — index 'by-date' on `date`
//   sets       — index 'by-workout' on `workoutId`, index 'by-exercise' on `exerciseId`
//   templates
//   meta       — key/value: settings, seed flag ({ key, value })

/** Open (and on first run / version bump, create) the database. Cached. */
export async function openDb() {
  throw new Error('TODO: implement');
}

// ---- Exercises ----
/** Upsert. Sets syncedAt = null. Returns the stored record. */
export async function putExercise(exercise) { throw new Error('TODO: implement'); }
/** @returns {Promise<ExerciseRecord|undefined>} */
export async function getExercise(id) { throw new Error('TODO: implement'); }
/** All exercises, sorted by name. */
export async function listExercises() { throw new Error('TODO: implement'); }

// ---- Workouts ----
export async function putWorkout(workout) { throw new Error('TODO: implement'); }
export async function getWorkout(id) { throw new Error('TODO: implement'); }
/** Workouts with date >= sinceDate (ISO date, inclusive; pass '0000' for all), newest first. */
export async function listWorkouts(sinceDate) { throw new Error('TODO: implement'); }
/** Deletes the workout AND all its sets (user-initiated delete only). */
export async function deleteWorkout(id) { throw new Error('TODO: implement'); }

// ---- Sets ----
export async function putSet(set) { throw new Error('TODO: implement'); }
export async function getSet(id) { throw new Error('TODO: implement'); }
/** All sets for a workout, ordered by exerciseId then setNumber. */
export async function listSetsForWorkout(workoutId) { throw new Error('TODO: implement'); }
/** All sets for an exercise across all workouts. */
export async function listSetsForExercise(exerciseId) { throw new Error('TODO: implement'); }
export async function deleteSet(id) { throw new Error('TODO: implement'); }

// ---- Templates ----
export async function putTemplate(template) { throw new Error('TODO: implement'); }
export async function getTemplate(id) { throw new Error('TODO: implement'); }
export async function listTemplates() { throw new Error('TODO: implement'); }

// ---- Meta (settings, seed flag) ----
/** @returns {Promise<any|undefined>} the stored value for key */
export async function getMeta(key) { throw new Error('TODO: implement'); }
export async function setMeta(key, value) { throw new Error('TODO: implement'); }
