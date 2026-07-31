// Data layer: IndexedDB schema + repository functions.
// This file is part of the pinned contract (see PLAN.md). Signatures, store
// names, indexes and record shapes are fixed — do not change them without
// flagging it to the orchestrator.
//
// Record shapes (per gym-tracker-spec.md — every record also carries
// `syncedAt: string|null`, set to null on any local write, used for delta sync):
//
// Schema v2 (22 July 2026, PLAN.md §"Phase 1.5") is ALL ADDITIVE: DB_VERSION
// stays 1 — no store/index changes, records are schemaless so new fields just
// appear on new/updated records. Every added field is optional with a stated
// default, so legacy v1 records keep working unchanged.
//
// @typedef {Object} ExerciseRecord
//   {string} id            uuid (seed exercises use stable "seed-<slug>" ids)
//   {string} name          e.g. "Barbell Bench Press"
//   {string} muscleGroup   one of MUSCLE_GROUPS
//   {string} equipment     one of EQUIPMENT
//   {boolean} isCustom
//   {string} createdAt     ISO datetime
//   {string|null} syncedAt
//   v2 additions:
//   {'strength'|'cardio'} exerciseType   absent ⇒ 'strength'
//   {boolean} isUnilateral               absent ⇒ false ("Single Leg / Single Arm")
//
// @typedef {Object} WorkoutRecord
//   {string} id
//   {string} date          ISO date (YYYY-MM-DD) — the training day
//   {string} startedAt     ISO datetime
//   {string|null} finishedAt   null while in progress
//   {string|null} templateId
//   {string|null} notes
//   {string|null} syncedAt
//   v2 additions:
//   {string|null} name          display name; null ⇒ derived from startedAt hour
//   {number|null} bodyweightKg  logged bodyweight for the session
//   {Array<{exerciseId:string, supersetGroup:number|null, note:string|null}>|null} entries
//                               ordered exercise list (exists before any set is
//                               logged); null/absent ⇒ legacy workout, derive
//                               order from sets' completedAt. Consecutive entries
//                               sharing a supersetGroup integer are one superset.
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
//   v2 additions (all optional):
//   {'strength'|'cardio'} setType   absent ⇒ 'strength'
//   {string|null} notes
//   {number|null} durationSeconds   cardio field
//   {number|null} distanceM         cardio field
//   {number|null} kcal              cardio field
//   Cardio sets store weightKg: 0, reps: 0 so legacy code paths stay safe.
//
// @typedef {Object} TemplateRecord
//   {string} id
//   {string} name          e.g. "Push Day A"
//   {Array<{exerciseId:string, targetSets:number, targetRepsLow:number,
//           targetRepsHigh:number}>} entries   ordered
//   {string|null} syncedAt
//
// @typedef {Object} HealthSampleRecord  (schema v3, 31 Jul 2026 — DB_VERSION 2,
// additive: new 'health' store only, existing stores untouched. No syncedAt —
// cloud sync is cancelled and health data never leaves the device.)
//   {string} id        HealthKit sample UUID, or a deterministic derived id for
//                      daily aggregates (e.g. "activeEnergy-2026-07-31") —
//                      either way re-import is an idempotent upsert
//   {string} type      one of HEALTH_TYPES
//   {string} startedAt ISO datetime
//   {string} endedAt   ISO datetime (== startedAt for point samples)
//   {number|null} value  canonical unit per type (see HEALTH_TYPES)
//   {string|null} unit   canonical unit label, e.g. 'kg', 'bpm', 'ms', 'kcal'
//   {Object|null} meta   type-specific extras:
//     workout: {activityType:string, kcal:number|null, avgHeartRate:number|null,
//               distanceM:number|null}   (value = duration in seconds)
//     sleepAnalysis: {stage:'inBed'|'asleepCore'|'asleepDeep'|'asleepREM'|'awake'}
//                                        (value = duration in seconds)

export const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'biceps', 'triceps', 'abs', 'cardio', 'accessory', 'rehab', 'other'];
export const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'other'];

// Apple Health sample types we store, with their canonical value unit. This is
// the FULL permitted read set (CLAUDE.md §10) — adding a type is a flagged
// change, there and here.
//   workout           value = duration seconds
//   heartRate         bpm
//   restingHeartRate  bpm
//   hrv               ms (SDNN)
//   vo2max            ml/kg/min
//   bodyMass          kg
//   bodyFatPct        percent (0–100)
//   sleepAnalysis     value = duration seconds (stage in meta)
//   activeEnergy      kcal (stored as one daily-total sample per day)
export const HEALTH_TYPES = ['workout', 'heartRate', 'restingHeartRate', 'hrv', 'vo2max', 'bodyMass', 'bodyFatPct', 'sleepAnalysis', 'activeEnergy'];

export const DB_NAME = 'healthhub';
export const DB_VERSION = 2;

// Object stores (all keyPath 'id' except meta, keyPath 'key'):
//   exercises
//   workouts   — index 'by-date' on `date`
//   sets       — index 'by-workout' on `workoutId`, index 'by-exercise' on `exerciseId`
//   templates
//   meta       — key/value: settings, seed flag ({ key, value })
//   health     — index 'by-type-start' on ['type', 'startedAt']  (DB v2, additive)

let _dbName = DB_NAME;
let _dbPromise = null;

/**
 * TEST-ONLY hook: override the IndexedDB database name and reset the cached
 * connection, so the browser test suite can open a throwaway database. Not part
 * of the production contract — do not use in app code.
 */
export function _setDbNameForTests(name) {
  _dbName = name;
  _dbPromise = null;
}

/** Promisify an IDBRequest. */
function pr(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolve when a transaction commits (or reject on error/abort). */
function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Open (and on first run / version bump, create) the database. Cached. */
export async function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(_dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('exercises')) {
        db.createObjectStore('exercises', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('workouts')) {
        const s = db.createObjectStore('workouts', { keyPath: 'id' });
        s.createIndex('by-date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('sets')) {
        const s = db.createObjectStore('sets', { keyPath: 'id' });
        s.createIndex('by-workout', 'workoutId', { unique: false });
        s.createIndex('by-exercise', 'exerciseId', { unique: false });
      }
      if (!db.objectStoreNames.contains('templates')) {
        db.createObjectStore('templates', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('health')) {
        const s = db.createObjectStore('health', { keyPath: 'id' });
        s.createIndex('by-type-start', ['type', 'startedAt'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

/** Store a record (with syncedAt reset to null) and return it. */
async function putRecord(storeName, record) {
  const db = await openDb();
  const rec = { ...record, syncedAt: null };
  const t = db.transaction(storeName, 'readwrite');
  t.objectStore(storeName).put(rec);
  await txDone(t);
  return rec;
}

async function getRecord(storeName, id) {
  const db = await openDb();
  return pr(db.transaction(storeName).objectStore(storeName).get(id));
}

async function getAllRecords(storeName) {
  const db = await openDb();
  return pr(db.transaction(storeName).objectStore(storeName).getAll());
}

async function getAllByIndex(storeName, indexName, key) {
  const db = await openDb();
  return pr(
    db.transaction(storeName).objectStore(storeName).index(indexName).getAll(IDBKeyRange.only(key))
  );
}

async function deleteRecord(storeName, id) {
  const db = await openDb();
  const t = db.transaction(storeName, 'readwrite');
  t.objectStore(storeName).delete(id);
  return txDone(t);
}

// ---- Exercises ----
/** Upsert. Sets syncedAt = null. Returns the stored record. */
export async function putExercise(exercise) {
  return putRecord('exercises', exercise);
}
/** @returns {Promise<ExerciseRecord|undefined>} */
export async function getExercise(id) {
  return getRecord('exercises', id);
}
/**
 * Delete an exercise. User-initiated only; callers must ensure it is a custom
 * exercise with no logged sets (the UI gates on both) — seed data and anything
 * referenced by history must never be deleted.
 */
export async function deleteExercise(id) {
  return deleteRecord('exercises', id);
}
/** All exercises, sorted by name. */
export async function listExercises() {
  const all = await getAllRecords('exercises');
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Workouts ----
export async function putWorkout(workout) {
  return putRecord('workouts', workout);
}
export async function getWorkout(id) {
  return getRecord('workouts', id);
}
/** Workouts with date >= sinceDate (ISO date, inclusive; pass '0000' for all), newest first. */
export async function listWorkouts(sinceDate) {
  const db = await openDb();
  const idx = db.transaction('workouts').objectStore('workouts').index('by-date');
  const results = [];
  return new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.lowerBound(sinceDate), 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}
/** Deletes the workout AND all its sets (user-initiated delete only). */
export async function deleteWorkout(id) {
  const db = await openDb();
  const t = db.transaction(['workouts', 'sets'], 'readwrite');
  t.objectStore('workouts').delete(id);
  const idx = t.objectStore('sets').index('by-workout');
  const req = idx.openKeyCursor(IDBKeyRange.only(id));
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      t.objectStore('sets').delete(cursor.primaryKey);
      cursor.continue();
    }
  };
  return txDone(t);
}

// ---- Sets ----
export async function putSet(set) {
  return putRecord('sets', set);
}
export async function getSet(id) {
  return getRecord('sets', id);
}
/** All sets for a workout, ordered by exerciseId then setNumber. */
export async function listSetsForWorkout(workoutId) {
  const all = await getAllByIndex('sets', 'by-workout', workoutId);
  return all.sort((a, b) => {
    if (a.exerciseId !== b.exerciseId) return a.exerciseId < b.exerciseId ? -1 : 1;
    return a.setNumber - b.setNumber;
  });
}
/** All sets for an exercise across all workouts. */
export async function listSetsForExercise(exerciseId) {
  return getAllByIndex('sets', 'by-exercise', exerciseId);
}
export async function deleteSet(id) {
  return deleteRecord('sets', id);
}

// ---- Templates ----
export async function putTemplate(template) {
  return putRecord('templates', template);
}
export async function getTemplate(id) {
  return getRecord('templates', id);
}
export async function listTemplates() {
  const all = await getAllRecords('templates');
  return all.sort((a, b) => a.name.localeCompare(b.name));
}
/** Delete a template. User-initiated only (Routines tab, after confirm). */
export async function deleteTemplate(id) {
  return deleteRecord('templates', id);
}

// ---- Bulk import (additive API, 29 Jul 2026 — used by js/csv-import.js) ----
/**
 * Bulk upsert for the CSV importer. Batches puts into chunked readwrite
 * transactions so thousands of records don't pay one transaction each.
 * Upsert-only — never deletes; existing ids are overwritten in place, which is
 * what makes a re-import of the same file a no-op. Every record is stored with
 * syncedAt: null (same rule as putRecord). onProgress(done, total) fires after
 * each committed chunk.
 * @param {{exercises?: ExerciseRecord[], workouts?: WorkoutRecord[], sets?: SetRecord[]}} payload
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{exercises: number, workouts: number, sets: number}>} counts written
 */
export async function bulkImport({ exercises = [], workouts = [], sets = [] }, onProgress = null) {
  const db = await openDb();
  const total = exercises.length + workouts.length + sets.length;
  let done = 0;
  const CHUNK = 500;
  for (const [storeName, records] of [['exercises', exercises], ['workouts', workouts], ['sets', sets]]) {
    for (let i = 0; i < records.length; i += CHUNK) {
      const slice = records.slice(i, i + CHUNK);
      const t = db.transaction(storeName, 'readwrite');
      const store = t.objectStore(storeName);
      for (const r of slice) store.put({ ...r, syncedAt: null });
      await txDone(t);
      done += slice.length;
      if (onProgress) onProgress(done, total);
    }
  }
  return { exercises: exercises.length, workouts: workouts.length, sets: sets.length };
}

// ---- Health samples (Apple Health import — DB v2, 31 Jul 2026) ----
/**
 * Bulk upsert of HealthSampleRecords, chunked like bulkImport. Idempotent:
 * ids are HK UUIDs / deterministic aggregate ids, so re-delivery overwrites in
 * place. Never deletes. Records are stored verbatim (no syncedAt).
 * @param {HealthSampleRecord[]} samples
 * @returns {Promise<number>} count written
 */
export async function putHealthSamples(samples) {
  const db = await openDb();
  const CHUNK = 500;
  for (let i = 0; i < samples.length; i += CHUNK) {
    const t = db.transaction('health', 'readwrite');
    const store = t.objectStore('health');
    for (const s of samples.slice(i, i + CHUNK)) store.put(s);
    await txDone(t);
  }
  return samples.length;
}

/**
 * Samples of one type, newest-first, bounded (defensive LIMIT per §6.3 intent).
 * @param {string} type one of HEALTH_TYPES
 * @param {{since?: string, limit?: number}} [opts] since = ISO datetime lower
 *   bound on startedAt (inclusive); limit defaults to 500
 * @returns {Promise<HealthSampleRecord[]>}
 */
export async function listHealthSamples(type, { since = '0000', limit = 500 } = {}) {
  const db = await openDb();
  const idx = db.transaction('health').objectStore('health').index('by-type-start');
  const range = IDBKeyRange.bound([type, since], [type, '￿']);
  const results = [];
  return new Promise((resolve, reject) => {
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/** Newest sample of a type, or undefined. */
export async function getLatestHealthSample(type) {
  const rows = await listHealthSamples(type, { limit: 1 });
  return rows[0];
}

/**
 * Remove ALL imported health samples. USER-INITIATED ONLY — the confirm sheet
 * behind Settings → Apple Health → Disconnect ("also remove imported data").
 * The never-delete rule covers imports/sync; an owner explicitly discarding
 * their own imported copy is the sanctioned exception, mirroring deleteWorkout.
 */
export async function clearHealthSamples() {
  const db = await openDb();
  const t = db.transaction('health', 'readwrite');
  t.objectStore('health').clear();
  return txDone(t);
}

// ---- Meta (settings, seed flag) ----
/** @returns {Promise<any|undefined>} the stored value for key */
export async function getMeta(key) {
  const rec = await getRecord('meta', key);
  return rec ? rec.value : undefined;
}
export async function setMeta(key, value) {
  const db = await openDb();
  const t = db.transaction('meta', 'readwrite');
  t.objectStore('meta').put({ key, value });
  await txDone(t);
  return value;
}
