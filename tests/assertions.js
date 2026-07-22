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
