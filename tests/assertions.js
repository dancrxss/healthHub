// Browser end-to-end suite: runs against REAL IndexedDB in a throwaway database.
// Loaded by tests/test.html. Seeds records through the db.js repository
// functions, exercises every repository function (incl. deleteWorkout cascade),
// then runs the same logical assertions through the queries.js wrappers.
//
// Renders one PASS/FAIL line per assertion plus a final summary. Any failure
// makes the summary contain the string "FAIL".

import {
  DB_NAME,
  _setDbNameForTests,
  openDb,
  putExercise,
  getExercise,
  listExercises,
  putWorkout,
  getWorkout,
  listWorkouts,
  deleteWorkout,
  putSet,
  getSet,
  listSetsForWorkout,
  listSetsForExercise,
  deleteSet,
  putTemplate,
  getTemplate,
  listTemplates,
  getMeta,
  setMeta,
} from '../js/db.js';
import {
  getLastSession,
  getRecentWorkouts,
  getPRs,
  getWeeklyVolume,
  getTrainingFrequency,
} from '../js/queries.js';
import { isoWeekOf, epley1RM } from '../js/calc.js';
import { seedIfEmpty, SEED_EXERCISES } from '../js/seed.js';
import { parseCSV, sniffDelimiter, detectColumns, buildImportPlan } from '../js/csv-import.js';

const TEST_DB = 'healthhub-test';
const SEED_DB = 'healthhub-seed-test';
const UPGRADE_DB = 'healthhub-upgrade-test';

let root;
let summaryEl;
let pass = 0;
let fail = 0;

function line(ok, name, detail) {
  const el = document.createElement('div');
  el.className = ok ? 'ok' : 'bad';
  el.textContent = `${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`;
  root.appendChild(el);
}

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    line(true, name);
  } else {
    fail += 1;
    line(false, name, detail || 'assertion false');
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}, got ${a}`);
}

function approx(name, actual, expected, tol = 1e-6) {
  ok(name, Math.abs(actual - expected) < tol, `expected ~${expected}, got ${actual}`);
}

/** Format a Date as local ISO date (YYYY-MM-DD) — matches util.todayISO(). */
function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

function deleteDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // no other connections expected
  });
}

export async function runTests(rootEl, summaryElement) {
  root = rootEl;
  summaryEl = summaryElement;

  try {
    // ---- throwaway DB ----
    _setDbNameForTests(TEST_DB);
    await deleteDb(TEST_DB);
    const db = await openDb();
    ok('openDb: object stores created', ['exercises', 'workouts', 'sets', 'templates', 'meta'].every((s) => db.objectStoreNames.contains(s)));
    ok('openDb: workouts by-date index exists', db.transaction('workouts').objectStore('workouts').indexNames.contains('by-date'));
    ok('openDb: sets by-workout & by-exercise indexes exist', (() => {
      const idx = db.transaction('sets').objectStore('sets').indexNames;
      return idx.contains('by-workout') && idx.contains('by-exercise');
    })());
    ok('_setDbNameForTests did not touch production DB name constant', DB_NAME === 'healthhub');

    const today = isoDate(new Date());
    const lastWeek = daysAgo(7);

    // ---- Exercises ----
    const bench = await putExercise({ id: 'ex-bench', name: 'Bench Press', muscleGroup: 'chest', equipment: 'barbell', isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: 'STALE' });
    ok('putExercise: returns stored record', bench.id === 'ex-bench');
    ok('putExercise: resets syncedAt to null', bench.syncedAt === null);
    await putExercise({ id: 'ex-squat', name: 'Back Squat', muscleGroup: 'legs', equipment: 'barbell', isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null });
    await putExercise({ id: 'ex-curl', name: 'Arm Curl', muscleGroup: 'arms', equipment: 'dumbbell', isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null });

    const gotBench = await getExercise('ex-bench');
    ok('getExercise: round-trips', gotBench && gotBench.name === 'Bench Press');
    ok('getExercise: missing id -> undefined', (await getExercise('nope')) === undefined);
    const listed = await listExercises();
    eq('listExercises: sorted by name', listed.map((e) => e.name), ['Arm Curl', 'Back Squat', 'Bench Press']);

    // ---- Workouts + sets (today, finished) ----
    await putWorkout({ id: 'wt', date: today, startedAt: `${today}T10:00:00Z`, finishedAt: `${today}T11:00:00Z`, templateId: null, notes: null, syncedAt: null });
    const wtSet = await putSet({ id: 'wt-b1', workoutId: 'wt', exerciseId: 'ex-bench', setNumber: 2, weightKg: 100, reps: 5, rpe: null, isWarmup: false, completedAt: `${today}T10:10:00Z`, syncedAt: 'STALE' });
    ok('putSet: resets syncedAt to null', wtSet.syncedAt === null);
    await putSet({ id: 'wt-b0', workoutId: 'wt', exerciseId: 'ex-bench', setNumber: 1, weightKg: 40, reps: 10, rpe: null, isWarmup: true, completedAt: `${today}T10:05:00Z`, syncedAt: null });
    await putSet({ id: 'wt-s1', workoutId: 'wt', exerciseId: 'ex-squat', setNumber: 1, weightKg: 140, reps: 5, rpe: null, isWarmup: false, completedAt: `${today}T10:30:00Z`, syncedAt: null });
    await putSet({ id: 'wt-c1', workoutId: 'wt', exerciseId: 'ex-curl', setNumber: 1, weightKg: 10, reps: 15, rpe: null, isWarmup: true, completedAt: `${today}T10:45:00Z`, syncedAt: null });

    // ---- Workout last week (finished) ----
    await putWorkout({ id: 'wl', date: lastWeek, startedAt: `${lastWeek}T10:00:00Z`, finishedAt: `${lastWeek}T11:00:00Z`, templateId: null, notes: null, syncedAt: null });
    await putSet({ id: 'wl-b1', workoutId: 'wl', exerciseId: 'ex-bench', setNumber: 1, weightKg: 95, reps: 5, rpe: null, isWarmup: false, completedAt: `${lastWeek}T10:10:00Z`, syncedAt: null });

    const gotWt = await getWorkout('wt');
    ok('getWorkout: round-trips', gotWt && gotWt.date === today);

    const wkList = await listWorkouts('0000');
    eq('listWorkouts: newest first', wkList.map((w) => w.id), ['wt', 'wl']);
    const wkSince = await listWorkouts(today);
    ok('listWorkouts: since filter inclusive of today only', wkSince.length === 1 && wkSince[0].id === 'wt');

    const wtSets = await listSetsForWorkout('wt');
    eq('listSetsForWorkout: ordered by exerciseId then setNumber', wtSets.map((s) => s.id), ['wt-b0', 'wt-b1', 'wt-c1', 'wt-s1']);
    const benchSets = await listSetsForExercise('ex-bench');
    eq('listSetsForExercise: all across workouts', benchSets.map((s) => s.id).sort(), ['wl-b1', 'wt-b0', 'wt-b1']);

    // ---- deleteSet ----
    await putSet({ id: 'tmp-del', workoutId: 'wt', exerciseId: 'ex-curl', setNumber: 2, weightKg: 12, reps: 12, rpe: null, isWarmup: false, completedAt: `${today}T10:50:00Z`, syncedAt: null });
    ok('deleteSet: set exists before delete', (await getSet('tmp-del')) !== undefined);
    await deleteSet('tmp-del');
    ok('deleteSet: set gone after delete', (await getSet('tmp-del')) === undefined);

    // ---- deleteWorkout cascade ----
    await putWorkout({ id: 'wx', date: '2020-01-01', startedAt: '2020-01-01T10:00:00Z', finishedAt: '2020-01-01T11:00:00Z', templateId: null, notes: null, syncedAt: null });
    await putSet({ id: 'wx-1', workoutId: 'wx', exerciseId: 'ex-bench', setNumber: 1, weightKg: 60, reps: 5, rpe: null, isWarmup: false, completedAt: '2020-01-01T10:10:00Z', syncedAt: null });
    await putSet({ id: 'wx-2', workoutId: 'wx', exerciseId: 'ex-bench', setNumber: 2, weightKg: 60, reps: 5, rpe: null, isWarmup: false, completedAt: '2020-01-01T10:15:00Z', syncedAt: null });
    ok('deleteWorkout: sets exist before delete', (await listSetsForWorkout('wx')).length === 2);
    await deleteWorkout('wx');
    ok('deleteWorkout: workout removed', (await getWorkout('wx')) === undefined);
    ok('deleteWorkout: cascaded sets removed (by-workout)', (await listSetsForWorkout('wx')).length === 0);
    ok('deleteWorkout: cascaded sets removed (getSet)', (await getSet('wx-1')) === undefined && (await getSet('wx-2')) === undefined);

    // ---- Templates ----
    await putTemplate({ id: 'tpl-1', name: 'Push Day A', entries: [{ exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 5, targetRepsHigh: 8 }], syncedAt: 'STALE' });
    const tpl = await getTemplate('tpl-1');
    ok('putTemplate/getTemplate: round-trips, syncedAt reset', tpl && tpl.name === 'Push Day A' && tpl.syncedAt === null);
    ok('listTemplates: returns template', (await listTemplates()).some((t) => t.id === 'tpl-1'));

    // ---- Meta ----
    ok('getMeta: missing -> undefined', (await getMeta('seeded')) === undefined);
    await setMeta('seeded', true);
    ok('setMeta/getMeta: stores value', (await getMeta('seeded')) === true);
    await setMeta('restDefault', 90);
    ok('setMeta/getMeta: numeric value', (await getMeta('restDefault')) === 90);

    // ---- Query wrappers ----
    const last = await getLastSession('ex-bench');
    ok('getLastSession: most recent finished workout w/ bench', last && last.workout.id === 'wt');
    eq('getLastSession: bench sets ordered by setNumber (warmups incl.)', last.sets.map((s) => s.id), ['wt-b0', 'wt-b1']);
    ok('getLastSession: null when absent', (await getLastSession('ex-nope')) === null);

    const recent = await getRecentWorkouts('0000');
    eq('getRecentWorkouts: newest first', recent.map((r) => r.workout.id), ['wt', 'wl']);
    const wtEntry = recent.find((r) => r.workout.id === 'wt');
    eq('getRecentWorkouts: sets ordered exerciseId then setNumber', wtEntry.sets.map((s) => s.id), ['wt-b0', 'wt-b1', 'wt-c1', 'wt-s1']);

    const prs = await getPRs('ex-bench');
    const r5 = prs.byReps.find((r) => r.reps === 5);
    ok('getPRs: best weight at 5 reps is 100 (warmup 40x10 excluded)', r5 && r5.weightKg === 100 && r5.setId === 'wt-b1');
    ok('getPRs: no warmup weights appear', !prs.byReps.some((r) => r.weightKg === 40));
    approx('getPRs: bestE1RM = Epley(100,5)', prs.bestE1RM.value, epley1RM(100, 5));
    ok('getPRs: bestE1RM references working set', prs.bestE1RM.setId === 'wt-b1');
    const prCurl = await getPRs('ex-curl');
    ok('getPRs: curl only-warmups -> empty/null', prCurl.byReps.length === 0 && prCurl.bestE1RM === null);

    const vol = await getWeeklyVolume(2);
    ok('getWeeklyVolume: returns `weeks` buckets', vol.length === 2);
    ok('getWeeklyVolume: oldest first, current week last', vol[1].isoWeek === isoWeekOf(today));
    ok('getWeeklyVolume: current-week chest = 100x5 = 500 (warmup excluded)', vol[1].perMuscleGroup.chest === 500);
    ok('getWeeklyVolume: current-week legs = 140x5 = 700', vol[1].perMuscleGroup.legs === 700);
    ok('getWeeklyVolume: current-week arms = 0 (curl warmup excluded)', vol[1].perMuscleGroup.arms === 0);

    const freq = await getTrainingFrequency(2);
    ok('getTrainingFrequency: returns `weeks` buckets', freq.length === 2);
    ok('getTrainingFrequency: current week last', freq[1].isoWeek === isoWeekOf(today));
    ok('getTrainingFrequency: current-week sessionsTotal = 1', freq[1].sessionsTotal === 1);
    ok('getTrainingFrequency: arms counts (curl warmup still counts for frequency)', freq[1].perMuscleGroup.arms === 1);
    ok('getTrainingFrequency: chest + legs each 1', freq[1].perMuscleGroup.chest === 1 && freq[1].perMuscleGroup.legs === 1);

    // ---- Schema v2: workout entries[] + cardio set roundtrip ----
    await putWorkout({
      id: 'wv2', date: today, startedAt: `${today}T12:00:00Z`, finishedAt: null,
      templateId: null, notes: null,
      name: 'Morning Workout', bodyweightKg: 82.5,
      entries: [
        { exerciseId: 'ex-bench', supersetGroup: 1, note: null },
        { exerciseId: 'ex-squat', supersetGroup: 1, note: 'paired' },
        { exerciseId: 'ex-run', supersetGroup: null, note: null },
      ],
      syncedAt: null,
    });
    const gotV2 = await getWorkout('wv2');
    eq('workout v2: entries[] round-trips', gotV2.entries.map((e) => e.exerciseId), ['ex-bench', 'ex-squat', 'ex-run']);
    ok('workout v2: name + bodyweightKg round-trip', gotV2.name === 'Morning Workout' && gotV2.bodyweightKg === 82.5);
    ok('workout v2: supersetGroup + note preserved', gotV2.entries[0].supersetGroup === 1 && gotV2.entries[1].note === 'paired' && gotV2.entries[2].supersetGroup === null);

    const cardioSet = await putSet({
      id: 'wv2-cardio', workoutId: 'wv2', exerciseId: 'ex-run', setNumber: 1,
      weightKg: 0, reps: 0, rpe: null, isWarmup: false,
      setType: 'cardio', notes: 'steady', durationSeconds: 600, distanceM: 2000, kcal: 150,
      completedAt: `${today}T12:20:00Z`, syncedAt: 'STALE',
    });
    ok('cardio set: syncedAt reset to null', cardioSet.syncedAt === null);
    const gotCardio = await getSet('wv2-cardio');
    ok('cardio set: setType stored', gotCardio.setType === 'cardio');
    ok('cardio set: cardio fields round-trip', gotCardio.durationSeconds === 600 && gotCardio.distanceM === 2000 && gotCardio.kcal === 150);
    ok('cardio set: notes round-trip', gotCardio.notes === 'steady');
    ok('cardio set: weight/reps zeroed', gotCardio.weightKg === 0 && gotCardio.reps === 0);

    // ---- cleanup ----
    await deleteDb(TEST_DB);

    // ---- Seed v2: fresh install seeds straight to v2 ----
    _setDbNameForTests(SEED_DB);
    await deleteDb(SEED_DB);
    await openDb();
    const seededFresh = await seedIfEmpty();
    ok('seedIfEmpty: performs work on first run', seededFresh === true);
    ok('seedIfEmpty: seeded-v1 flag set', (await getMeta('seeded-v1')) === true);
    ok('seedIfEmpty: seeded-v2 flag set', (await getMeta('seeded-v2')) === true);

    const seededEx = await listExercises();
    eq('seed: exercise count matches SEED_EXERCISES', seededEx.length, SEED_EXERCISES.length);
    const cardioEx = seededEx.filter((e) => e.exerciseType === 'cardio');
    eq('seed: 6 cardio exercises present', cardioEx.length, 6);
    ok('seed: cardio have muscleGroup cardio + equipment other', cardioEx.every((e) => e.muscleGroup === 'cardio' && e.equipment === 'other'));
    ok('seed: assault bike stable id + name', seededEx.some((e) => e.id === 'seed-assault-bike' && e.name === 'Assault Bike'));
    ok('seed: core remapped to abs (plank)', (await getExercise('seed-plank')).muscleGroup === 'abs');
    ok('seed: arms curl remapped to biceps (barbell-curl)', (await getExercise('seed-barbell-curl')).muscleGroup === 'biceps');
    ok('seed: arms extension remapped to triceps (triceps-pushdown)', (await getExercise('seed-triceps-pushdown')).muscleGroup === 'triceps');
    ok('seed: unilateral flag set where true (dumbbell-row)', (await getExercise('seed-dumbbell-row')).isUnilateral === true);
    ok('seed: unilateral defaults false (barbell-bench-press)', (await getExercise('seed-barbell-bench-press')).isUnilateral === false);
    ok('seed: exerciseType strength on lifts (barbell-bench-press)', (await getExercise('seed-barbell-bench-press')).exerciseType === 'strength');

    const seededAgain = await seedIfEmpty();
    ok('seedIfEmpty: idempotent — no work on second run', seededAgain === false);
    eq('seed: count unchanged after second call', (await listExercises()).length, SEED_EXERCISES.length);
    await deleteDb(SEED_DB);

    // ---- Seed v2 upgrade: existing v1 install is repaired in place ----
    _setDbNameForTests(UPGRADE_DB);
    await deleteDb(UPGRADE_DB);
    await openDb();
    // Simulate a v1 install: old-shape seed records + seeded-v1 flag, no v2 flag.
    await putExercise({ id: 'seed-plank', name: 'Plank', muscleGroup: 'core', equipment: 'bodyweight', isCustom: false, createdAt: '2026-07-21T00:00:00.000Z', syncedAt: null });
    await putExercise({ id: 'seed-barbell-curl', name: 'Barbell Curl', muscleGroup: 'arms', equipment: 'barbell', isCustom: false, createdAt: '2026-07-21T00:00:00.000Z', syncedAt: null });
    await putExercise({ id: 'my-custom', name: 'My Special Lift', muscleGroup: 'arms', equipment: 'other', isCustom: true, createdAt: '2026-07-21T00:00:00.000Z', syncedAt: null });
    await setMeta('seeded-v1', true);
    const upgraded = await seedIfEmpty();
    ok('upgrade: seedIfEmpty performs the v2 upgrade', upgraded === true);
    ok('upgrade: seeded-v2 flag set', (await getMeta('seeded-v2')) === true);
    ok('upgrade: legacy core -> abs remapped', (await getExercise('seed-plank')).muscleGroup === 'abs');
    ok('upgrade: legacy arms -> biceps remapped', (await getExercise('seed-barbell-curl')).muscleGroup === 'biceps');
    ok('upgrade: cardio seeds added', (await getExercise('seed-assault-bike')) !== undefined);
    const custom = await getExercise('my-custom');
    ok('upgrade: custom (isCustom) record untouched', custom.muscleGroup === 'arms' && custom.isCustom === true);
    await deleteDb(UPGRADE_DB);

    // ---- csv-import ----
    // Pure functions — no IndexedDB involved. Fixtures are inline CSV strings
    // shaped like the RepCount reference export (sample/export_29 Jul 2026.csv).

    // parseCSV: RFC 4180 edge cases
    eq('parseCSV: quoted field with an embedded comma', parseCSV('a,"b,c",d'), [['a', 'b,c', 'd']]);
    eq('parseCSV: doubled quotes escape a quote', parseCSV('a,"say ""hi""",c'), [['a', 'say "hi"', 'c']]);
    eq('parseCSV: newline inside quotes stays in the field', parseCSV('a,"one\ntwo",c\nd,e,f'), [['a', 'one\ntwo', 'c'], ['d', 'e', 'f']]);
    eq('parseCSV: CRLF line endings', parseCSV('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
    eq('parseCSV: last row without a trailing newline', parseCSV('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
    eq('parseCSV: wholly-empty rows dropped', parseCSV('a,b\n,\n\nc,d\n'), [['a', 'b'], ['c', 'd']]);
    eq('parseCSV: empty text -> no rows', parseCSV(''), []);

    // sniffDelimiter
    eq('sniffDelimiter: comma header', sniffDelimiter('Workout Start,Exercise,Weight'), ',');
    eq('sniffDelimiter: semicolon header', sniffDelimiter('Workout Start;Exercise;Weight'), ';');
    eq('sniffDelimiter: tab header', sniffDelimiter('Workout Start\tExercise\tWeight'), '\t');
    eq('sniffDelimiter: delimiters inside quotes are not counted', sniffDelimiter('"a;b;c",d'), ',');
    eq('sniffDelimiter: no delimiter at all -> comma', sniffDelimiter('Exercise'), ',');
    eq('parseCSV: semicolon file sniffed automatically', parseCSV('a;b\n1;2'), [['a', 'b'], ['1', '2']]);

    // detectColumns
    const REF_HEADER = ['Workout Start', 'Workout End', 'Exercise', 'Weight', 'Reps', 'Notes', 'Kcal', 'Distance', 'Duration', 'Category', 'Name', 'Bodyweight'];
    const refCols = detectColumns(REF_HEADER);
    eq('detectColumns: reference header maps all 12 columns', Object.keys(refCols.map).length, 12);
    eq('detectColumns: reference header field positions', [refCols.map.start, refCols.map.end, refCols.map.exercise, refCols.map.weight, refCols.map.reps, refCols.map.notes, refCols.map.kcal, refCols.map.distance, refCols.map.duration, refCols.map.category, refCols.map.name, refCols.map.bodyweight], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    eq('detectColumns: reference header has nothing unrecognised', refCols.unrecognised, []);
    eq('detectColumns: reference header is kg', refCols.weightUnit, 'kg');
    const lbCols = detectColumns(['Date', 'Exercise Name', 'Weight (lbs)', 'Reps', 'Set Order']);
    eq('detectColumns: lb header detected as lb', lbCols.weightUnit, 'lb');
    eq('detectColumns: Strong-style headers still map', [lbCols.map.start, lbCols.map.exercise, lbCols.map.weight, lbCols.map.reps, lbCols.map.setNumber], [0, 1, 2, 3, 4]);
    const alienCols = detectColumns(['Alpha', 'Beta', 'Gamma']);
    eq('detectColumns: alien header maps nothing', Object.keys(alienCols.map).length, 0);
    eq('detectColumns: alien headers are listed as unrecognised', alienCols.unrecognised, ['Alpha', 'Beta', 'Gamma']);

    // buildImportPlan: hand-written fixture
    const IMPORT_CSV = [
      'Workout Start,Workout End,Exercise,Weight,Reps,Notes,Kcal,Distance,Duration,Category,Name,Bodyweight',
      '2026-05-01 18:00,2026-05-01 19:00,"Face pulls ",25,12,"Elbows high, chin down",,,,Back,"Pull day",91',
      '2026-05-01 18:00,2026-05-01 19:00,"Face pulls ",30,10,"",,,,Back,"Pull day",91',
      '2026-05-01 18:00,2026-05-01 19:00,"Assisted Dips",-14,8,"",,,,Triceps,"Pull day",91',
      '2026-05-01 18:00,2026-05-01 19:00,"Assisted Dips",-14,6,"",,,,Triceps,"Pull day",91',
      '2026-05-01 18:00,2026-05-01 19:00,"Rowing Machine",,,"",120,2000,538,Cardio,"Pull day",91',
      '2026-05-03 09:30,2026-05-03 10:15,"Dead Hang",,,"",,,45,Accessory,"",',
      '2026-05-03 09:30,2026-05-03 10:15,"Dead Hang",,,"",,,40,Accessory,"",',
      '2026-05-03 09:30,2026-05-03 10:15,"Lying leg curl","42,5",10,"",,,,Legs,"",',
      '2026-05-03 09:30,2026-05-03 10:15,"",,,"",,,,,"",',
      '"not a date",,"Ghost Lift",50,5,"",,,,Chest,"",',
    ].join('\n');
    const LIBRARY = [{ id: 'seed-face-pull', name: 'Face Pulls', muscleGroup: 'back', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: '2026-01-01T00:00:00.000Z', syncedAt: null }];
    const plan = buildImportPlan(IMPORT_CSV, LIBRARY, []);

    ok('buildImportPlan: fixture imports cleanly', plan.ok === true && plan.error === null, plan.error || '');
    eq('buildImportPlan: stats counts', [plan.stats.rows, plan.stats.skippedRows, plan.stats.workouts, plan.stats.sets, plan.stats.newExercises, plan.stats.matchedExercises], [10, 2, 2, 8, 4, 1]);
    eq('buildImportPlan: first/last dates', [plan.stats.firstDate, plan.stats.lastDate], ['2026-05-01', '2026-05-03']);
    ok('buildImportPlan: skipped rows are warned about', plan.warnings.some((w) => w.includes('Skipped 2')), JSON.stringify(plan.warnings));

    // Exercise resolution
    ok('import exercises: existing name matched trim/case-insensitively', !plan.exercises.some((e) => e.name.trim().toLowerCase() === 'face pulls'));
    eq('import exercises: new custom exercises, in first-appearance order', plan.exercises.map((e) => e.id), ['import-assisted-dips', 'import-rowing-machine', 'import-dead-hang', 'import-lying-leg-curl']);
    const dipsEx = plan.exercises.find((e) => e.id === 'import-assisted-dips');
    ok('import exercises: negative weight infers bw_assisted_reps', dipsEx.exerciseType === 'bw_assisted_reps');
    ok('import exercises: muscleGroup from the category column', dipsEx.muscleGroup === 'triceps');
    ok('import exercises: custom + equipment other + createdAt at midnight', dipsEx.isCustom === true && dipsEx.equipment === 'other' && dipsEx.createdAt === '2026-05-01T00:00:00');
    const rowEx = plan.exercises.find((e) => e.id === 'import-rowing-machine');
    ok('import exercises: Cardio category infers cardio type', rowEx.exerciseType === 'cardio' && rowEx.muscleGroup === 'cardio');
    ok('import exercises: duration-only infers time', plan.exercises.find((e) => e.id === 'import-dead-hang').exerciseType === 'time');
    ok('import exercises: weight+reps infers weight_reps', plan.exercises.find((e) => e.id === 'import-lying-leg-curl').exerciseType === 'weight_reps');

    // Workouts
    eq('import workouts: deterministic ids from start + name', plan.workouts.map((w) => w.id), ['import-w-20260501-1800-pull-day', 'import-w-20260503-0930']);
    const wA = plan.workouts[0];
    const wB = plan.workouts[1];
    ok('import workouts: naked local ISO timestamps (no Z)', wA.startedAt === '2026-05-01T18:00:00' && wA.finishedAt === '2026-05-01T19:00:00');
    ok('import workouts: date, name and bodyweightKg picked up', wA.date === '2026-05-01' && wA.name === 'Pull day' && wA.bodyweightKg === 91);
    ok('import workouts: workout notes stay null (row notes belong to sets)', wA.notes === null && wB.notes === null);
    ok('import workouts: absent name/bodyweight are null', wB.name === null && wB.bodyweightKg === null);
    eq('import workouts: entries[] in first-appearance order', wA.entries.map((e) => e.exerciseId), ['seed-face-pull', 'import-assisted-dips', 'import-rowing-machine']);
    ok('import workouts: entries carry null supersetGroup/note', wA.entries.every((e) => e.supersetGroup === null && e.note === null));

    // Sets
    const setsA = plan.sets.filter((s) => s.workoutId === wA.id);
    eq('import sets: ids from workout key + exercise + set number', setsA.map((s) => s.id), [
      'import-s-20260501-1800-pull-day-face-pulls-1',
      'import-s-20260501-1800-pull-day-face-pulls-2',
      'import-s-20260501-1800-pull-day-assisted-dips-1',
      'import-s-20260501-1800-pull-day-assisted-dips-2',
      'import-s-20260501-1800-pull-day-rowing-machine-1',
    ]);
    eq('import sets: per-exercise setNumber counters restart at 1', setsA.map((s) => s.setNumber), [1, 2, 1, 2, 1]);
    ok('import sets: negative weight stored as absolute kg', setsA[2].weightKg === 14 && setsA[2].reps === 8);
    ok('import sets: row notes land on the set', setsA[0].notes === 'Elbows high, chin down' && setsA[1].notes === null);
    ok('import sets: strength sets are setType strength, not warmups', setsA.slice(0, 4).every((s) => s.setType === 'strength' && s.isWarmup === false));
    const cardioSetImported = setsA[4];
    ok('import sets: cardio set zeroes weight/reps', cardioSetImported.setType === 'cardio' && cardioSetImported.weightKg === 0 && cardioSetImported.reps === 0);
    ok('import sets: cardio fields carried through', cardioSetImported.durationSeconds === 538 && cardioSetImported.distanceM === 2000 && cardioSetImported.kcal === 120);
    ok('import sets: completedAt is naked ISO (no Z)', setsA.every((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s.completedAt)));
    ok('import sets: completedAt strictly increasing inside the workout window', setsA.every((s, i) => s.completedAt > wA.startedAt && s.completedAt < wA.finishedAt && (i === 0 || s.completedAt > setsA[i - 1].completedAt)), setsA.map((s) => s.completedAt).join(' '));
    const curlSet = plan.sets.find((s) => s.exerciseId === 'import-lying-leg-curl');
    ok('import sets: decimal comma weight parsed as 42.5', curlSet.weightKg === 42.5);
    const hangSet = plan.sets.find((s) => s.exerciseId === 'import-dead-hang');
    ok('import sets: duration-only set keeps seconds, zero weight/reps', hangSet.durationSeconds === 45 && hangSet.weightKg === 0 && hangSet.reps === 0);
    ok('import sets: every set belongs to a planned workout', plan.sets.every((s) => plan.workouts.some((w) => w.id === s.workoutId)));
    ok('import sets: syncedAt null on every record', plan.sets.every((s) => s.syncedAt === null) && plan.workouts.every((w) => w.syncedAt === null) && plan.exercises.every((e) => e.syncedAt === null));

    // Determinism / idempotency
    const planAgain = buildImportPlan(IMPORT_CSV, LIBRARY, []);
    eq('buildImportPlan: re-running yields identical exercise ids', planAgain.exercises.map((e) => e.id), plan.exercises.map((e) => e.id));
    eq('buildImportPlan: re-running yields identical workout ids', planAgain.workouts.map((w) => w.id), plan.workouts.map((w) => w.id));
    ok('buildImportPlan: re-running is byte-identical', JSON.stringify(planAgain) === JSON.stringify(plan));

    // Duplicate-day detection
    const planColl = buildImportPlan(IMPORT_CSV, LIBRARY, [
      { id: 'real-workout', date: '2026-05-01' },
      { id: 'import-w-20260503-0930', date: '2026-05-03' },
    ]);
    eq('buildImportPlan: real workout on the same day collides', planColl.collidingWorkoutIds, ['import-w-20260501-1800-pull-day']);

    // lb + km headers convert to kg / metres
    const planLb = buildImportPlan([
      'Date,Exercise Name,Weight (lbs),Reps,Distance (km)',
      '2026-06-01 07:00,Bench Press,100,5,',
      '2026-06-01 07:00,Treadmill,,,5',
    ].join('\n'), [], []);
    ok('buildImportPlan: lb weights convert to kg', planLb.ok === true && planLb.sets[0].weightKg === 45.36, JSON.stringify(planLb.sets[0] || planLb.error));
    ok('buildImportPlan: km distances convert to metres', planLb.sets[1].distanceM === 5000);
    ok('buildImportPlan: no end column -> finishedAt = start + 60 min', planLb.workouts[0].finishedAt === '2026-06-01T08:00:00');

    // Error path
    const planBad = buildImportPlan('Alpha,Beta,Gamma\n1,2,3', [], []);
    ok('buildImportPlan: alien CSV is rejected', planBad.ok === false && planBad.workouts.length === 0 && planBad.sets.length === 0);
    ok('buildImportPlan: error names the missing fields', typeof planBad.error === 'string' && planBad.error.includes('exercise name') && planBad.error.includes('Alpha'), planBad.error || '(no error)');
    ok('buildImportPlan: empty file is rejected', buildImportPlan('', [], []).ok === false);
    const planNoRows = buildImportPlan('Workout Start,Exercise,Weight,Reps', [], []);
    ok('buildImportPlan: header-only file is ok with zero counts', planNoRows.ok === true && planNoRows.stats.rows === 0 && planNoRows.stats.workouts === 0 && planNoRows.stats.sets === 0);
  } catch (err) {
    fail += 1;
    line(false, 'suite threw', err && err.message ? err.message : String(err));
    if (err && err.stack) console.error(err.stack);
  }

  const summary = fail === 0
    ? `SUMMARY: ${pass} passed, 0 failed — ALL GREEN`
    : `SUMMARY: ${pass} passed, ${fail} FAIL`;
  summaryEl.textContent = summary;
  summaryEl.className = fail === 0 ? 'ok summary' : 'bad summary';
  return { pass, fail };
}
