#!/usr/bin/env node
'use strict';

// Standalone one-off RepCount CSV → healthHub JSON import scaffold.
//
// Usage:
//   node import-repcount.js <path-to.csv> [--out repcount-import.json]
//
// This is a Node script, NOT part of the PWA. It reads a RepCount CSV export,
// groups rows into workouts/sets matching the record shapes in js/db.js, and
// writes a single JSON file: { exercises: [], workouts: [], sets: [] }. That
// file is a paste/upload seam for the app to import later — this script never
// touches IndexedDB.
//
// Node built-ins ONLY: fs, path, crypto. No npm packages, no installs.
//
// Idempotency: every generated id is a deterministic sha1 hash of a stable
// natural key (date + workout name, date + workout + exercise + set number,
// or exercise name for customs). Re-running against the same CSV produces
// byte-identical JSON — arrays are explicitly sorted and object keys are
// always written in the same order, so this does not depend on Map/object
// insertion order or on directory/OS iteration order.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// ============================================================================
//  mapRow(row) — THE ONLY FUNCTION TO EDIT WHEN THE REAL REPCOUNT EXPORT
//  ARRIVES.
//
//  The real RepCount CSV export format is UNKNOWN at the time this scaffold
//  was written (per gym-tracker-spec.md open question 2). Everything below
//  assumes a PLAUSIBLE, invented column layout:
//
//    Date, Workout, Exercise, Set, Weight (kg), Reps, RPE, Warmup, Notes
//
//  `row` is a plain object keyed by the CSV header row exactly as written
//  (whatever case/spacing RepCount actually uses). ALL column-name and
//  column-format interpretation lives here — nowhere else in this file reads
//  `row` directly. When the real export is pulled, only this function (and,
//  if headers differ, the constant below) should need to change.
// ============================================================================

/** Header names this scaffold expects, exactly as they appear in the sample. */
const COLUMNS = {
  date: 'Date',
  workout: 'Workout',
  exercise: 'Exercise',
  set: 'Set',
  weightKg: 'Weight (kg)',
  reps: 'Reps',
  rpe: 'RPE',
  warmup: 'Warmup',
  notes: 'Notes',
};

/**
 * Map one raw CSV row (header → string value) to a normalised row.
 * @param {Object<string,string>} row
 * @returns {{
 *   date: string,            ISO date YYYY-MM-DD
 *   workout: string,         workout/session label, e.g. "Push Day A"
 *   exercise: string,        exercise name as written in the export
 *   setNumber: number|null,  null means "use row order within this exercise"
 *   weightKg: number,
 *   reps: number,
 *   rpe: number|null,
 *   isWarmup: boolean,
 *   notes: string|null,
 * }}
 */
function mapRow(row) {
  const rawDate = (row[COLUMNS.date] || '').trim();
  // RepCount's export is assumed to already use ISO dates (YYYY-MM-DD). If
  // the real export uses e.g. "13/07/2026" or "Jul 13, 2026", convert it here.
  const date = rawDate;

  const workout = (row[COLUMNS.workout] || '').trim();
  const exercise = (row[COLUMNS.exercise] || '').trim();

  const rawSet = (row[COLUMNS.set] || '').trim();
  const setNumber = rawSet === '' ? null : parseInt(rawSet, 10);

  const rawWeight = (row[COLUMNS.weightKg] || '').trim();
  const weightKg = rawWeight === '' ? 0 : parseFloat(rawWeight);

  const rawReps = (row[COLUMNS.reps] || '').trim();
  const reps = rawReps === '' ? 0 : parseInt(rawReps, 10);

  const rawRpe = (row[COLUMNS.rpe] || '').trim();
  const rpe = rawRpe === '' ? null : parseFloat(rawRpe);

  const rawWarmup = (row[COLUMNS.warmup] || '').trim().toLowerCase();
  const isWarmup = rawWarmup === 'yes' || rawWarmup === 'true' || rawWarmup === '1';

  const rawNotes = (row[COLUMNS.notes] || '').trim();
  const notes = rawNotes === '' ? null : rawNotes;

  return { date, workout, exercise, setNumber, weightKg, reps, rpe, isWarmup, notes };
}

// ============================================================================
//  End of mapRow / column mapping. Everything below is generic plumbing that
//  should NOT need to change when the real export format lands.
// ============================================================================
// ---------------------------------------------------------------------------

// ---- Tiny inline CSV parser -------------------------------------------------
// Handles quoted fields, embedded commas inside quotes, escaped quotes ("")
// inside quoted fields, and both CRLF and LF line endings (including a
// quoted field that itself contains a literal newline).

/** @returns {string[][]} array of rows, each an array of raw string fields */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Look ahead for \n to consume CRLF as one line break.
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Final field/row if the file doesn't end with a newline.
  if (field !== '' || row.length > 0) {
    endRow();
  }

  // Drop trailing wholly-empty rows (e.g. a trailing blank line).
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parse CSV text into an array of header-keyed row objects. */
function parseCsvToObjects(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  const out = [];
  for (let r = 1; r < rows.length; r += 1) {
    const raw = rows[r];
    const obj = {};
    for (let c = 0; c < header.length; c += 1) {
      obj[header[c]] = raw[c] !== undefined ? raw[c] : '';
    }
    out.push(obj);
  }
  return out;
}

// ---- Deterministic ids ------------------------------------------------------

function sha1(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

function kebabCase(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function workoutIdFor(date, workoutName) {
  return `w-${sha1(`${date}|${workoutName.toLowerCase()}`)}`;
}

function setIdFor(date, workoutName, exerciseName, setNumber) {
  return `s-${sha1(`${date}|${workoutName.toLowerCase()}|${exerciseName.toLowerCase()}|${setNumber}`)}`;
}

function customExerciseIdFor(exerciseName) {
  return `custom-${sha1(exerciseName.trim().toLowerCase())}`;
}

// ---- Seed exercise matching --------------------------------------------------
//
// Exercises are deduped by name: if a CSV exercise name case-insensitively
// matches a name in js/seed.js's SEED_EXERCISES, we reuse that seed id and do
// NOT emit a new exercise record (it already exists once the app is seeded).
// Anything that doesn't match becomes a new custom exercise record, with a
// deterministic id derived from its name (so re-running the importer never
// mints a second copy of the same "unknown" exercise).
//
// js/seed.js is an ES module (import/export syntax) with no package.json
// declaring "type": "module" anywhere in this repo. Node's dynamic import()
// still loads plain ESM-syntax .js files like this correctly (verified: it
// does NOT require require()/CommonJS parsing), and js/seed.js's only import
// (js/db.js) is import-safe — db.js only *defines* functions; nothing at its
// module top level touches IndexedDB. So the dynamic import below works in
// practice. If it ever fails (moved files, a future package.json flips module
// resolution, etc.) we fall back gracefully: every exercise is treated as
// unmatched/custom rather than guessing at a seed id we can't verify exists.
async function loadSeedExerciseNameMap() {
  const map = new Map(); // lowercased name -> seed id
  try {
    const seedModuleUrl = require('node:url').pathToFileURL(
      path.join(__dirname, 'js', 'seed.js')
    ).href;
    const seedModule = await import(seedModuleUrl);
    for (const ex of seedModule.SEED_EXERCISES || []) {
      map.set(ex.name.toLowerCase(), ex.id);
    }
  } catch (err) {
    process.stderr.write(
      `Warning: could not import js/seed.js for name-matching (${err.message}). ` +
        `All exercises will be imported as new custom exercises.\n`
    );
  }
  return map;
}

// ---- Main --------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  let out = 'repcount-import.json';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) {
    throw new Error('Usage: node import-repcount.js <path-to.csv> [--out repcount-import.json]');
  }
  return { csvPath: positional[0], outPath: out };
}

async function main() {
  const { csvPath, outPath } = parseArgs(process.argv.slice(2));

  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsvToObjects(text);

  const seedNameMap = await loadSeedExerciseNameMap();

  // date + workout name -> { id, date, workoutName, notesSet }
  const workoutsById = new Map();
  // lowercased custom exercise name -> ExerciseRecord
  const customExercisesByName = new Map();
  // per (workoutId + exerciseName) running counter, used when the CSV's Set
  // column is blank — falls back to row order within that exercise.
  const autoSetNumber = new Map();
  const sets = [];

  rows.forEach((raw, rowIndex) => {
    const mapped = mapRow(raw);
    if (!mapped.date || !mapped.workout || !mapped.exercise) return; // skip blank/malformed rows

    const workoutId = workoutIdFor(mapped.date, mapped.workout);
    if (!workoutsById.has(workoutId)) {
      workoutsById.set(workoutId, {
        id: workoutId,
        date: mapped.date,
        workoutName: mapped.workout,
        notesSet: new Set(),
      });
    }
    const workoutEntry = workoutsById.get(workoutId);
    if (mapped.notes) workoutEntry.notesSet.add(mapped.notes);

    // Resolve exerciseId: seed match (case-insensitive) or deterministic custom.
    const lowerName = mapped.exercise.toLowerCase();
    let exerciseId = seedNameMap.get(lowerName);
    if (!exerciseId) {
      exerciseId = customExerciseIdFor(mapped.exercise);
      if (!customExercisesByName.has(lowerName)) {
        customExercisesByName.set(lowerName, {
          id: exerciseId,
          name: mapped.exercise,
          // The CSV export has no muscle-group/equipment columns for unknown
          // exercises; 'other'/'other' is the safe default until Dan
          // reclassifies it in the app.
          muscleGroup: 'other',
          equipment: 'other',
          isCustom: true,
          // Deterministic (not "now"): the date of this exercise's first
          // occurrence in the CSV, so re-running produces the same value.
          createdAt: `${mapped.date}T00:00:00.000Z`,
          syncedAt: null,
        });
      }
    }

    // setNumber: prefer the CSV's Set column; otherwise row order per exercise.
    let setNumber = mapped.setNumber;
    if (setNumber === null || Number.isNaN(setNumber)) {
      const key = `${workoutId}|${lowerName}`;
      const next = (autoSetNumber.get(key) || 0) + 1;
      autoSetNumber.set(key, next);
      setNumber = next;
    }

    // completedAt is synthesised: the export gives a Date but no per-set time.
    // Anchor the workout at 09:00 local-as-UTC and space sets 3 minutes apart
    // in CSV row order, purely so sets have a plausible, strictly-increasing
    // timestamp for the rest-timer/history UI. This is a known scaffold
    // simplification (see README/PLAN notes), not a real captured time.
    const completedAt = new Date(
      new Date(`${mapped.date}T09:00:00.000Z`).getTime() + rowIndex * 3 * 60 * 1000
    ).toISOString();

    sets.push({
      id: setIdFor(mapped.date, mapped.workout, mapped.exercise, setNumber),
      workoutId,
      exerciseId,
      setNumber,
      weightKg: mapped.weightKg,
      reps: mapped.reps,
      rpe: mapped.rpe,
      isWarmup: mapped.isWarmup,
      completedAt,
      syncedAt: null,
    });
  });

  // ---- Assemble output, with explicit sorting so re-runs are byte-identical
  // regardless of Map/object insertion order. ----

  const exercises = [...customExercisesByName.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({
      id: e.id,
      name: e.name,
      muscleGroup: e.muscleGroup,
      equipment: e.equipment,
      isCustom: e.isCustom,
      createdAt: e.createdAt,
      syncedAt: e.syncedAt,
    }));

  const workouts = [...workoutsById.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((w) => {
      const notes = w.notesSet.size > 0 ? [...w.notesSet].sort().join(' | ') : null;
      return {
        id: w.id,
        date: w.date,
        startedAt: `${w.date}T09:00:00.000Z`,
        finishedAt: `${w.date}T10:00:00.000Z`,
        // Not inferable from this CSV shape; left null. A future mapRow could
        // set this if the export ever names a template explicitly.
        templateId: null,
        notes,
        syncedAt: null,
      };
    });

  const sortedSets = [...sets].sort((a, b) => {
    if (a.workoutId !== b.workoutId) return a.workoutId < b.workoutId ? -1 : 1;
    if (a.exerciseId !== b.exerciseId) return a.exerciseId < b.exerciseId ? -1 : 1;
    if (a.setNumber !== b.setNumber) return a.setNumber - b.setNumber;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const output = {
    exercises,
    workouts,
    sets: sortedSets.map((s) => ({
      id: s.id,
      workoutId: s.workoutId,
      exerciseId: s.exerciseId,
      setNumber: s.setNumber,
      weightKg: s.weightKg,
      reps: s.reps,
      rpe: s.rpe,
      isWarmup: s.isWarmup,
      completedAt: s.completedAt,
      syncedAt: s.syncedAt,
    })),
  };

  const outAbsPath = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
  fs.writeFileSync(outAbsPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `Imported ${rows.length} CSV rows -> ${output.workouts.length} workouts, ` +
      `${output.sets.length} sets, ${output.exercises.length} new custom exercise(s).\n` +
      `Wrote ${outAbsPath}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
