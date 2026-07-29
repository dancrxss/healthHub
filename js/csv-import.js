// ============================================================================
// csv-import.js — generic workout-CSV → healthHub records. PURE MODULE: no
// DOM, no IndexedDB, no imports other than exercise-types.js. The Profile
// screen owns the UI (file picker, preview sheet) and db.bulkImport owns
// persistence; everything in here is deterministic data-in/data-out so the
// browser unit suite can cover it directly.
//
// Design rules (pinned by the orchestrator — do not change signatures):
//
// - GENERIC parsing: RFC 4180 (quoted fields, "" escapes, embedded commas and
//   newlines, CRLF/LF), delimiter sniffed from the header line (comma /
//   semicolon / tab). Columns are recognised by HEADER SYNONYMS, not position,
//   so any sane export shape maps — the reference file is
//   sample/export_29 Jul 2026.csv (RepCount: "Workout Start,Workout End,
//   Exercise,Weight,Reps,Notes,Kcal,Distance,Duration,Category,Name,
//   Bodyweight") but Strong/Hevy-style headers must work too.
// - DETERMINISTIC ids from natural keys (no uuid, no hashing): re-importing
//   the same file produces byte-identical records, so bulkImport upserts in
//   place and the import is idempotent. Never delete anything.
// - All weights stored in kg (numeric). If the weight HEADER names lb/lbs,
//   convert (× 1/2.20462, round 2 dp). Decimal commas ("12,5") accepted.
// - NEGATIVE weights mean assisted bodyweight (RepCount convention): store
//   Math.abs(), and infer exerciseType 'bw_assisted_reps' for new exercises.
// - Durations are seconds; "mm:ss" / "h:mm:ss" strings also accepted.
// - Warmup sets: only if a warmup column exists (isWarmup false otherwise) —
//   the PR/volume exclusion rules downstream depend on this being honest.
// - Timestamps: the export's times are local wall-clock, so emitted ISO
//   datetimes are NAKED (no Z / offset) — new Date() then reads them as local,
//   matching how the app displays them. Set completedAt is synthesised: sets
//   spread evenly across the workout's start→end window in row order (start +
//   (i+1)·window/(n+1)); no end ⇒ 3-minute spacing, finishedAt = start + 60 min.
// ============================================================================

import { normalizeExerciseType, setTypeFor } from './exercise-types.js';

/**
 * The logical fields a column can map to. detectColumns matches case- and
 * space-insensitively against synonym lists per field (e.g. weight: 'weight',
 * 'weight (kg)', 'kg', 'weight (lb)', 'lbs'…; start: 'workout start', 'date',
 * 'start time'…). A file is importable when it maps `exercise`, `start`, and
 * at least one of weight / reps / duration.
 * @typedef {'start'|'end'|'exercise'|'weight'|'reps'|'notes'|'kcal'|'distance'|
 *           'duration'|'category'|'name'|'bodyweight'|'setNumber'|'warmup'|'rpe'} ImportField
 */

/**
 * Parse CSV text into rows of raw string fields. RFC 4180: quoted fields,
 * doubled-quote escapes, embedded delimiters/newlines inside quotes, CRLF and
 * LF endings, trailing newline optional. Wholly-empty rows are dropped.
 * @param {string} text
 * @param {','|';'|'\t'} [delimiter] default: sniffDelimiter on the first line
 * @returns {string[][]}
 */
export function parseCSV(text, delimiter) {
  throw new Error('csv-import: not implemented');
}

/**
 * Sniff the delimiter from the header line: the candidate (, ; \t) with the
 * most occurrences OUTSIDE quoted regions. Ties/none default to ','.
 * @param {string} headerLine
 * @returns {','|';'|'\t'}
 */
export function sniffDelimiter(headerLine) {
  throw new Error('csv-import: not implemented');
}

/**
 * Map a header row onto logical import fields by synonym.
 * @param {string[]} headerRow
 * @returns {{
 *   map: Partial<Record<ImportField, number>>,  // field -> column index
 *   unrecognised: string[],                     // headers nothing matched
 *   weightUnit: 'kg'|'lb',                      // from the weight header text
 * }}
 */
export function detectColumns(headerRow) {
  throw new Error('csv-import: not implemented');
}

/**
 * Build a complete, ready-to-persist import plan from raw CSV text.
 *
 * Exercise resolution: names are matched trim/case-insensitively against
 * `existingExercises` (seed AND custom — the user's library). Unmatched names
 * become NEW custom ExerciseRecords with id `import-<kebab-name>`,
 * equipment 'other', muscleGroup from the category column (mapped onto
 * MUSCLE_GROUPS values, with sensible synonyms; unknown/blank → 'other') and
 * exerciseType inferred from that exercise's rows in priority order:
 *   category 'cardio' → 'cardio';  any negative weight → 'bw_assisted_reps';
 *   reps+weight → 'weight_reps';  reps only → 'reps';
 *   duration+distance → 'cardio';  duration only → 'time';  else 'weight_reps'.
 * createdAt = first occurrence's date at T00:00:00 (deterministic).
 *
 * Workout grouping: rows sharing a start timestamp (plus name, when present)
 * are one workout. id `import-w-<YYYYMMDD-HHMM>[-<kebab-name>]` (collisions
 * within one file get a -2, -3… suffix in first-seen order — still
 * deterministic for the same file). date = start date; name / bodyweightKg
 * from their columns (null when absent); notes null (row notes belong to the
 * SETS); entries[] in first-appearance order, supersetGroup/note null;
 * finishedAt from end (fallback start + 60 min).
 *
 * Sets: id `import-s-<workout-key>-<kebab-exercise>-<setNumber>`; setNumber
 * from its column when present, else a per-workout-per-exercise running
 * counter from 1. setType via setTypeFor(resolved exercise type); cardio sets
 * force weightKg 0 / reps 0 (db.js contract) with duration/distance/kcal
 * carried; strength sets carry weightKg (abs, kg), reps, rpe, notes, isWarmup,
 * and duration/distance/kcal when their columns hold values.
 *
 * Rows with no exercise name or an unparseable start date are skipped and
 * counted (a sample lands in warnings). Duplicate-day detection: any imported
 * workout whose date already carries a workout in `existingWorkouts` (by
 * `date`, excluding ids starting 'import-') is listed in collidingWorkoutIds —
 * the UI decides whether to drop them before persisting; the records
 * themselves stay pure db.js shapes with NO extra fields.
 *
 * @param {string} text                      raw CSV file contents
 * @param {ExerciseRecord[]} existingExercises  current library (db.listExercises())
 * @param {WorkoutRecord[]} existingWorkouts    current workouts (db.listWorkouts('0000'))
 * @returns {{
 *   ok: boolean,
 *   error: string|null,          // set when !ok: what failed + what WAS recognised
 *   exercises: ExerciseRecord[], // NEW custom exercises only (never existing ones)
 *   workouts: WorkoutRecord[],
 *   sets: SetRecord[],
 *   collidingWorkoutIds: string[],
 *   stats: {
 *     rows: number, skippedRows: number,
 *     workouts: number, sets: number,
 *     newExercises: number, matchedExercises: number,
 *     firstDate: string|null, lastDate: string|null,  // ISO dates
 *   },
 *   warnings: string[],
 * }}
 */
export function buildImportPlan(text, existingExercises, existingWorkouts) {
  throw new Error('csv-import: not implemented');
}
