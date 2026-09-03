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
//   Coach additions (C2.4, 3 Sep 2026, additive):
//   {string|null} targets      free text, the regions/qualities this exercise
//                               hits (e.g. "upper chest, front delts"); absent/
//                               null for exercises with none recorded
//   {'user'|'coach'|null} createdBy   who created this exercise; absent ⇒ user
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
//   Phase C additions (3 Sep 2026, optional):
//   {string|null} planId          CoachPlanRecord this session was started from
//   {string|null} planSessionId   PlanSession id ('ps-N') within that plan —
//                                 when set, the workout screen shows the plan's
//                                 targets as the grey placeholders instead of
//                                 last session's sets
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
//
// Phase C — Coach (3 Sep 2026, DB_VERSION 3, additive: two new stores only).
// Neither record carries syncedAt — cloud sync is cancelled. Contract pinned in
// PLAN.md §"Phase C" C1.
//
// @typedef {Object} CoachPlanRecord   store 'coachPlans'
//   {string} id
//   {number} version        1-based, monotonic; revisions are NEW records
//   {string} createdAt      ISO datetime
//   {'created'|'revised'|'manual'} source
//   {string|null} basedOnWorkoutId   the session whose feedback triggered a revision
//   {string|null} rationale
//   {number} weeks
//   {Array<PlanSession>} sessions
//   PlanSession:  {id:'ps-N' (assigned locally), order:number, name:string,
//                  focus:string|null, exercises:Array<PlanExercise>}
//   PlanExercise: {exerciseId, targetSets, targetRepsLow, targetRepsHigh,
//                  targetWeightKg:number|null, targetRpe:number|null, note:string|null}
//
//   Phase C2 (3 Sep 2026, additive): planVersion:2, lineageStart 'YYYY-MM-DD'
//   (programme day 1, copied on revision), baseWeek (programme week the stored
//   targets describe), weeks 6–8, overview {points[], muscleFocus[{group,why}],
//   progression[], deloadWeek|null}, weekNotes [{week, focus, points[]}];
//   sessions gain brief[]; exercises gain targetDurationSec|null, purpose, goal,
//   progression {weightStepKg|null, repStep|null, durationStepSec|null, everyWeeks}.
//   Later weeks are PROJECTED by coach-engine.js, never stored.
//
// @typedef {Object} CoachChatMessage   store 'coachChat' (DB v4, Phase C2)
//   {string} id
//   {'home'|'plan'} thread
//   {'user'|'coach'} role
//   {string} createdAt      ISO datetime
//   {string|null} text      the user's message
//   {string[]|null} points  the coach's reply bullets
//   {string|null} planId    plan in force after this message
//   {{plan:boolean, profile:boolean, memory:boolean}|null} changed
//   {string|null} error     user-facing message when the call failed
//   {boolean} pending       true while the user's message awaits a reply
//
// @typedef {Object} CoachInsightRecord   store 'coachInsights'
//   {string} id             'daily-YYYY-MM-DD' | 'session-<workoutId>' — deterministic,
//                           so re-running is an idempotent upsert
//   {'daily'|'session'} kind
//   {string} createdAt      ISO datetime
//   {string} date           ISO date the insight is about
//   {string|null} workoutId
//   {string} model          e.g. 'claude-sonnet-5'
//   {string} engineVersion  coach-engine.js COACH_ENGINE_VERSION
//   {Object} metrics        the local engine output that was sent (drill-down
//                           screens render from this, offline)
//   {Object} narrative      the parsed, validated model reply
//   {string|null} planId    plan in force after this insight
//   {{inputTokens:number, outputTokens:number}} usage

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
export const DB_VERSION = 4;

// Object stores (all keyPath 'id' except meta, keyPath 'key'):
//   exercises
//   workouts   — index 'by-date' on `date`
//   sets       — index 'by-workout' on `workoutId`, index 'by-exercise' on `exerciseId`
//   templates
//   meta       — key/value: settings, seed flag ({ key, value })
//   health     — index 'by-type-start' on ['type', 'startedAt']  (DB v2, additive)
//   coachPlans    — index 'by-created' on `createdAt`                (DB v3, additive)
//   coachInsights — index 'by-kind-created' on ['kind', 'createdAt'],
//                   index 'by-workout' on `workoutId`                 (DB v3, additive)
//   coachChat     — index 'by-thread-created' on ['thread', 'createdAt'] (DB v4, additive)

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
      if (!db.objectStoreNames.contains('coachPlans')) {
        const s = db.createObjectStore('coachPlans', { keyPath: 'id' });
        s.createIndex('by-created', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('coachInsights')) {
        const s = db.createObjectStore('coachInsights', { keyPath: 'id' });
        s.createIndex('by-kind-created', ['kind', 'createdAt'], { unique: false });
        s.createIndex('by-workout', 'workoutId', { unique: false });
      }
      if (!db.objectStoreNames.contains('coachChat')) {
        const s = db.createObjectStore('coachChat', { keyPath: 'id' });
        s.createIndex('by-thread-created', ['thread', 'createdAt'], { unique: false });
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
/** Every set in the store (single-user scale). Used by the coach engine's
 * dataset loader — one getAll instead of one transaction per workout. */
export async function listAllSets() {
  return getAllRecords('sets');
}

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

// ---- Coach (Phase C: plans + insights) ----
// Dedicated puts — no syncedAt (putRecord would add one). Upserts only.

/** Newest-first cursor read over an index, bounded. */
async function listByIndexDesc(storeName, indexName, range, limit) {
  const db = await openDb();
  const idx = db.transaction(storeName).objectStore(storeName).index(indexName);
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

/** @param {CoachPlanRecord} plan @returns {Promise<CoachPlanRecord>} */
export async function putCoachPlan(plan) {
  const db = await openDb();
  const t = db.transaction('coachPlans', 'readwrite');
  t.objectStore('coachPlans').put(plan);
  await txDone(t);
  return plan;
}
/** @returns {Promise<CoachPlanRecord|undefined>} */
export function getCoachPlan(id) {
  return getRecord('coachPlans', id);
}
/** Newest first (by createdAt), bounded. @returns {Promise<CoachPlanRecord[]>} */
export function listCoachPlans({ limit = 50 } = {}) {
  return listByIndexDesc('coachPlans', 'by-created', null, limit);
}

/** @param {CoachInsightRecord} insight @returns {Promise<CoachInsightRecord>} */
export async function putCoachInsight(insight) {
  const db = await openDb();
  const t = db.transaction('coachInsights', 'readwrite');
  t.objectStore('coachInsights').put(insight);
  await txDone(t);
  return insight;
}
/** @returns {Promise<CoachInsightRecord|undefined>} */
export function getCoachInsight(id) {
  return getRecord('coachInsights', id);
}
/**
 * Insights of one kind, newest first, bounded.
 * @param {{kind: 'daily'|'session', limit?: number}} opts
 * @returns {Promise<CoachInsightRecord[]>}
 */
export function listCoachInsights({ kind, limit = 50 }) {
  const range = IDBKeyRange.bound([kind, '0000'], [kind, '\uffff']);
  return listByIndexDesc('coachInsights', 'by-kind-created', range, limit);
}
/** @returns {Promise<CoachInsightRecord|undefined>} the session insight for a workout */
export async function getCoachInsightForWorkout(workoutId) {
  const rows = await getAllByIndex('coachInsights', 'by-workout', workoutId);
  return rows[0];
}

// ---- Coach chat (Phase C2) ----
/** @param {CoachChatMessage} msg */
export async function putChatMessage(msg) {
  const db = await openDb();
  const t = db.transaction('coachChat', 'readwrite');
  t.objectStore('coachChat').put(msg);
  await txDone(t);
  return msg;
}
/**
 * Messages of one thread, NEWEST first, bounded.
 * @param {{thread: 'home'|'plan', limit?: number}} opts
 * @returns {Promise<CoachChatMessage[]>}
 */
export function listChatMessages({ thread, limit = 60 }) {
  const range = IDBKeyRange.bound([thread, '0000'], [thread, '\uffff']);
  return listByIndexDesc('coachChat', 'by-thread-created', range, limit);
}
/** Clear one thread, or every thread when `thread` is null. USER-INITIATED ONLY. */
export async function clearChat(thread = null) {
  const db = await openDb();
  const t = db.transaction('coachChat', 'readwrite');
  const store = t.objectStore('coachChat');
  if (thread == null) {
    store.clear();
  } else {
    const req = store.index('by-thread-created').openCursor(IDBKeyRange.bound([thread, '0000'], [thread, '\uffff']));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  }
  return txDone(t);
}

/**
 * Remove ALL coach plans, insights and chat, plus the coach.* meta keys. USER-INITIATED
 * ONLY (Settings → Coach → Clear coach data) — the same sanctioned exception as
 * clearHealthSamples. Never touches workouts, sets, exercises or templates.
 */
export async function clearCoachData() {
  const db = await openDb();
  const t = db.transaction(['coachPlans', 'coachInsights', 'coachChat', 'meta'], 'readwrite');
  t.objectStore('coachPlans').clear();
  t.objectStore('coachInsights').clear();
  t.objectStore('coachChat').clear();
  const meta = t.objectStore('meta');
  const req = meta.openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    if (typeof cursor.key === 'string' && cursor.key.startsWith('coach.') && cursor.key !== 'coach.shareRecovery') {
      cursor.delete();
    }
    cursor.continue();
  };
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
