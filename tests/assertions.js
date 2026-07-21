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

const TEST_DB = 'healthhub-test';

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

    // ---- cleanup ----
    await deleteDb(TEST_DB);
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
