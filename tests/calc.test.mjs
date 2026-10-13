// Pure-Node unit tests for js/calc.js — zero dependencies, Node built-ins only.
// Run: `node tests/calc.test.mjs`  (exits non-zero on any failure).
//
// Builds a small in-memory fixture spanning multiple ISO weeks (incl. a
// year-boundary week), mixed warmup/working sets, an unfinished workout, and
// ties in PR weights, then asserts every exported function in calc.js.

import assert from 'node:assert/strict';
import {
  epley1RM,
  isoWeekOf,
  lastSessionFrom,
  recentWorkoutsFrom,
  prsFrom,
  topSetSeriesFrom,
  weeklyVolumeFrom,
  trainingFrequencyFrom,
} from '../js/calc.js';
import { formatDMY, formatHM } from '../js/util.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const exercises = [
  { id: 'ex-bench', name: 'Bench', muscleGroup: 'chest', equipment: 'barbell', isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null },
  { id: 'ex-squat', name: 'Squat', muscleGroup: 'legs', equipment: 'barbell', isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null },
  { id: 'ex-row', name: 'Row', muscleGroup: 'back', equipment: 'barbell', isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null },
  { id: 'ex-curl', name: 'Curl', muscleGroup: 'arms', equipment: 'dumbbell', isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null },
  { id: 'ex-ohp', name: 'Overhead Press', muscleGroup: 'shoulders', equipment: 'barbell', isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null },
  { id: 'ex-dead', name: 'Deadlift', muscleGroup: 'legs', equipment: 'barbell', isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null }, // never trained
];

const workouts = [
  { id: 'w1', date: '2025-12-29', startedAt: '2025-12-29T10:00:00Z', finishedAt: '2025-12-29T11:00:00Z', templateId: null, notes: null, syncedAt: null }, // 2026-W01 (year boundary)
  { id: 'w2', date: '2026-01-05', startedAt: '2026-01-05T10:00:00Z', finishedAt: '2026-01-05T11:00:00Z', templateId: null, notes: null, syncedAt: null }, // 2026-W02
  { id: 'w3', date: '2026-07-20', startedAt: '2026-07-20T10:00:00Z', finishedAt: '2026-07-20T11:00:00Z', templateId: null, notes: null, syncedAt: null }, // 2026-W30
  { id: 'w4', date: '2026-12-28', startedAt: '2026-12-28T10:00:00Z', finishedAt: '2026-12-28T11:00:00Z', templateId: null, notes: null, syncedAt: null }, // 2026-W53
  { id: 'w5', date: '2026-07-21', startedAt: '2026-07-21T10:00:00Z', finishedAt: null, templateId: null, notes: null, syncedAt: null }, // 2026-W30, UNFINISHED
];

const sets = [
  // w1
  { id: 'w1s1', workoutId: 'w1', exerciseId: 'ex-bench', setNumber: 1, weightKg: 40, reps: 10, rpe: null, isWarmup: true, completedAt: '2025-12-29T10:05:00Z', syncedAt: null },
  { id: 'w1s2', workoutId: 'w1', exerciseId: 'ex-bench', setNumber: 2, weightKg: 100, reps: 5, rpe: null, isWarmup: false, completedAt: '2025-12-29T10:10:00Z', syncedAt: null },
  { id: 'w1s3', workoutId: 'w1', exerciseId: 'ex-bench', setNumber: 3, weightKg: 100, reps: 3, rpe: null, isWarmup: false, completedAt: '2025-12-29T10:15:00Z', syncedAt: null },
  { id: 'w1s4', workoutId: 'w1', exerciseId: 'ex-squat', setNumber: 1, weightKg: 140, reps: 5, rpe: null, isWarmup: false, completedAt: '2025-12-29T10:30:00Z', syncedAt: null },
  { id: 'w1s5', workoutId: 'w1', exerciseId: 'ex-curl', setNumber: 1, weightKg: 10, reps: 15, rpe: null, isWarmup: true, completedAt: '2025-12-29T10:45:00Z', syncedAt: null }, // warmup-only exercise
  // w2
  { id: 'w2s1', workoutId: 'w2', exerciseId: 'ex-bench', setNumber: 1, weightKg: 100, reps: 5, rpe: null, isWarmup: false, completedAt: '2026-01-05T10:10:00Z', syncedAt: null }, // ties w1s2 weight+reps -> earlier date wins
  { id: 'w2s2', workoutId: 'w2', exerciseId: 'ex-bench', setNumber: 2, weightKg: 102.5, reps: 3, rpe: null, isWarmup: false, completedAt: '2026-01-05T10:15:00Z', syncedAt: null },
  { id: 'w2s3', workoutId: 'w2', exerciseId: 'ex-row', setNumber: 1, weightKg: 80, reps: 8, rpe: null, isWarmup: false, completedAt: '2026-01-05T10:30:00Z', syncedAt: null },
  // w3
  { id: 'w3s1', workoutId: 'w3', exerciseId: 'ex-bench', setNumber: 1, weightKg: 105, reps: 1, rpe: null, isWarmup: false, completedAt: '2026-07-20T10:10:00Z', syncedAt: null },
  { id: 'w3s2', workoutId: 'w3', exerciseId: 'ex-bench', setNumber: 2, weightKg: 50, reps: 5, rpe: null, isWarmup: true, completedAt: '2026-07-20T10:20:00Z', syncedAt: null },
  // w4
  { id: 'w4s1', workoutId: 'w4', exerciseId: 'ex-squat', setNumber: 1, weightKg: 150, reps: 5, rpe: null, isWarmup: false, completedAt: '2026-12-28T10:10:00Z', syncedAt: null },
  // w5 (unfinished)
  { id: 'w5s1', workoutId: 'w5', exerciseId: 'ex-bench', setNumber: 1, weightKg: 60, reps: 5, rpe: null, isWarmup: false, completedAt: '2026-07-21T10:10:00Z', syncedAt: null },
  { id: 'w5s2', workoutId: 'w5', exerciseId: 'ex-ohp', setNumber: 2, weightKg: 50, reps: 5, rpe: null, isWarmup: false, completedAt: '2026-07-21T10:20:00Z', syncedAt: null }, // ohp ONLY in unfinished
];

const dataset = { workouts, sets, exercises };

// ---------------------------------------------------------------------------
// epley1RM
// ---------------------------------------------------------------------------

check('epley1RM: exact whole result', () => {
  assert.equal(epley1RM(100, 30), 200); // 100 * (1 + 30/30)
});
check('epley1RM: single rep is bodyweight-ish', () => {
  assert.ok(Math.abs(epley1RM(100, 1) - 100 * (31 / 30)) < 1e-9);
});
check('epley1RM: fractional', () => {
  assert.ok(Math.abs(epley1RM(100, 5) - 116.66666666666667) < 1e-9);
});

// ---------------------------------------------------------------------------
// isoWeekOf
// ---------------------------------------------------------------------------

check('isoWeekOf: 2026-01-01 -> 2026-W01', () => {
  assert.equal(isoWeekOf('2026-01-01'), '2026-W01');
});
check('isoWeekOf: 2027-01-01 -> 2026-W53 (belongs to prior ISO year)', () => {
  assert.equal(isoWeekOf('2027-01-01'), '2026-W53');
});
check('isoWeekOf: year-boundary 2025-12-29 -> 2026-W01', () => {
  assert.equal(isoWeekOf('2025-12-29'), '2026-W01');
});
check('isoWeekOf: Monday 2026-07-20 -> 2026-W30', () => {
  assert.equal(isoWeekOf('2026-07-20'), '2026-W30');
});
check('isoWeekOf: preceding Sunday 2026-07-19 -> 2026-W29 (week boundary)', () => {
  assert.equal(isoWeekOf('2026-07-19'), '2026-W29');
});
check('isoWeekOf: accepts full ISO datetime', () => {
  assert.equal(isoWeekOf('2026-07-20T10:00:00Z'), '2026-W30');
});

// ---------------------------------------------------------------------------
// lastSessionFrom
// ---------------------------------------------------------------------------

check('lastSessionFrom: most recent FINISHED workout, skips newer unfinished', () => {
  const res = lastSessionFrom(dataset, 'ex-bench');
  assert.ok(res);
  // w5 (2026-07-21) is unfinished and newer; must be skipped in favour of w3.
  assert.equal(res.workout.id, 'w3');
  assert.deepEqual(res.sets.map((s) => s.id), ['w3s1', 'w3s2']); // ordered by setNumber, warmups included
});
check('lastSessionFrom: picks newest across finished workouts', () => {
  const res = lastSessionFrom(dataset, 'ex-squat');
  assert.equal(res.workout.id, 'w4');
  assert.deepEqual(res.sets.map((s) => s.id), ['w4s1']);
});
check('lastSessionFrom: null when exercise never trained', () => {
  assert.equal(lastSessionFrom(dataset, 'ex-dead'), null);
});
check('lastSessionFrom: null when exercise only in an unfinished workout', () => {
  assert.equal(lastSessionFrom(dataset, 'ex-ohp'), null);
});

// ---------------------------------------------------------------------------
// recentWorkoutsFrom
// ---------------------------------------------------------------------------

check('recentWorkoutsFrom: inclusive since, newest first', () => {
  const res = recentWorkoutsFrom(dataset, '2026-07-20');
  // date >= 2026-07-20 -> w3 (07-20, inclusive), w5 (07-21), w4 (12-28); newest first
  assert.deepEqual(res.map((r) => r.workout.id), ['w4', 'w5', 'w3']);
});
check('recentWorkoutsFrom: sets ordered by exerciseId then setNumber', () => {
  const res = recentWorkoutsFrom(dataset, '2026-07-20');
  const w5 = res.find((r) => r.workout.id === 'w5');
  // ex-bench (w5s1) before ex-ohp (w5s2)
  assert.deepEqual(w5.sets.map((s) => s.id), ['w5s1', 'w5s2']);
  const w3 = res.find((r) => r.workout.id === 'w3');
  assert.deepEqual(w3.sets.map((s) => s.id), ['w3s1', 'w3s2']);
});
check('recentWorkoutsFrom: since before all returns everything', () => {
  const res = recentWorkoutsFrom(dataset, '0000');
  assert.equal(res.length, 5);
  assert.equal(res[0].workout.id, 'w4'); // newest overall
});

// ---------------------------------------------------------------------------
// prsFrom
// ---------------------------------------------------------------------------

check('prsFrom: byReps buckets, ties resolve to earliest date', () => {
  const res = prsFrom(dataset, 'ex-bench');
  assert.deepEqual(res.byReps, [
    { reps: 1, weightKg: 105, date: '2026-07-20', setId: 'w3s1' },
    { reps: 3, weightKg: 102.5, date: '2026-01-05', setId: 'w2s2' },
    // 100x5 in both w1 (2025-12-29) and w2 (2026-01-05) -> earliest date w1s2
    { reps: 5, weightKg: 100, date: '2025-12-29', setId: 'w1s2' },
  ]);
});
check('prsFrom: bestE1RM correct with tie -> earliest date', () => {
  const res = prsFrom(dataset, 'ex-bench');
  assert.equal(res.bestE1RM.weightKg, 100);
  assert.equal(res.bestE1RM.reps, 5);
  assert.equal(res.bestE1RM.date, '2025-12-29');
  assert.equal(res.bestE1RM.setId, 'w1s2');
  assert.ok(Math.abs(res.bestE1RM.value - epley1RM(100, 5)) < 1e-9);
});
check('prsFrom: warmups excluded — curl has only warmups -> empty/null', () => {
  const res = prsFrom(dataset, 'ex-curl');
  assert.deepEqual(res.byReps, []);
  assert.equal(res.bestE1RM, null);
});
check('prsFrom: unused exercise -> empty/null', () => {
  const res = prsFrom(dataset, 'ex-dead');
  assert.deepEqual(res.byReps, []);
  assert.equal(res.bestE1RM, null);
});
check('prsFrom: reps-0 sets (blank / time- or distance-only) never make a PR', () => {
  // A heavy weighted carry logged as weight+distance stores reps 0 — without
  // the reps >= 1 guard it would fake an Epley "1RM" of its carry weight.
  const ds = {
    workouts: [{ id: 'wz', date: '2026-07-22', startedAt: '2026-07-22T10:00:00Z', finishedAt: '2026-07-22T11:00:00Z', templateId: null, notes: null, syncedAt: null }],
    exercises: [{ id: 'ex-carry', name: 'Carry', muscleGroup: 'other', equipment: 'other', isCustom: false, createdAt: '2026-07-21T00:00:00Z', syncedAt: null }],
    sets: [
      { id: 'wzs1', workoutId: 'wz', exerciseId: 'ex-carry', setNumber: 1, weightKg: 80, reps: 0, rpe: null, isWarmup: false, completedAt: '2026-07-22T10:10:00Z', syncedAt: null, distanceM: 40 },
      { id: 'wzs2', workoutId: 'wz', exerciseId: 'ex-carry', setNumber: 2, weightKg: 20, reps: 5, rpe: null, isWarmup: false, completedAt: '2026-07-22T10:20:00Z', syncedAt: null },
    ],
  };
  const res = prsFrom(ds, 'ex-carry');
  assert.deepEqual(res.byReps, [{ reps: 5, weightKg: 20, date: '2026-07-22', setId: 'wzs2' }]);
  assert.equal(res.bestE1RM.setId, 'wzs2'); // the 80 kg reps-0 carry is ignored
});

// ---------------------------------------------------------------------------
// weeklyVolumeFrom
// ---------------------------------------------------------------------------

check('weeklyVolumeFrom: zero-filled weeks, oldest first, warmups excluded', () => {
  // today 2026-01-12 is Monday of 2026-W03; 3-week window -> W01, W02, W03.
  const res = weeklyVolumeFrom(dataset, 3, '2026-01-12');
  assert.deepEqual(res, [
    { isoWeek: '2026-W01', perMuscleGroup: { arms: 0, back: 0, chest: 800, legs: 700, shoulders: 0 } },
    { isoWeek: '2026-W02', perMuscleGroup: { arms: 0, back: 640, chest: 807.5, legs: 0, shoulders: 0 } },
    { isoWeek: '2026-W03', perMuscleGroup: { arms: 0, back: 0, chest: 0, legs: 0, shoulders: 0 } },
  ]);
});

// ---------------------------------------------------------------------------
// trainingFrequencyFrom
// ---------------------------------------------------------------------------

check('trainingFrequencyFrom: distinct workouts, warmups count for frequency', () => {
  const res = trainingFrequencyFrom(dataset, 3, '2026-01-12');
  assert.deepEqual(res, [
    // W01: w1 (chest+legs working, arms via curl WARMUP still counts)
    { isoWeek: '2026-W01', sessionsTotal: 1, perMuscleGroup: { arms: 1, back: 0, chest: 1, legs: 1, shoulders: 0 } },
    // W02: w2 (chest + back)
    { isoWeek: '2026-W02', sessionsTotal: 1, perMuscleGroup: { arms: 0, back: 1, chest: 1, legs: 0, shoulders: 0 } },
    // W03: empty
    { isoWeek: '2026-W03', sessionsTotal: 0, perMuscleGroup: { arms: 0, back: 0, chest: 0, legs: 0, shoulders: 0 } },
  ]);
});

// ---------------------------------------------------------------------------
// Cardio sets (schema v2) — excluded from PRs/volume, included in frequency and
// session listings. Uses a SEPARATE dataset so the assertions above (which
// deep-equal perMuscleGroup maps built from the exercise library) stay green.
// ---------------------------------------------------------------------------

const cardioExercises = [
  { id: 'ex-bench', name: 'Bench', muscleGroup: 'chest', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null },
  { id: 'ex-run', name: 'Treadmill Run', muscleGroup: 'cardio', equipment: 'other', exerciseType: 'cardio', isUnilateral: false, isCustom: false, createdAt: '2025-01-01T00:00:00Z', syncedAt: null },
];
const cardioWorkouts = [
  { id: 'cw1', date: '2026-07-20', startedAt: '2026-07-20T10:00:00Z', finishedAt: '2026-07-20T11:00:00Z', templateId: null, notes: null, name: null, bodyweightKg: 80, entries: null, syncedAt: null }, // 2026-W30
];
const cardioSets = [
  // Strength working set — the only thing that should score for PR/volume.
  { id: 'cs1', workoutId: 'cw1', exerciseId: 'ex-bench', setNumber: 1, weightKg: 100, reps: 5, rpe: null, isWarmup: false, setType: 'strength', completedAt: '2026-07-20T10:10:00Z', syncedAt: null },
  // Cardio set — weightKg/reps zeroed per the v2 contract; must NOT create a PR
  // or add volume, but still counts for frequency and appears in listings.
  { id: 'cs2', workoutId: 'cw1', exerciseId: 'ex-run', setNumber: 1, weightKg: 0, reps: 0, rpe: null, isWarmup: false, setType: 'cardio', durationSeconds: 1200, distanceM: 5000, kcal: 300, completedAt: '2026-07-20T10:40:00Z', syncedAt: null },
];
const cardioDS = { workouts: cardioWorkouts, sets: cardioSets, exercises: cardioExercises };

check('prsFrom: cardio sets excluded — cardio exercise yields no PR', () => {
  const res = prsFrom(cardioDS, 'ex-run');
  // Without the exclusion, epley(0,0)=0 would seed a bogus bestE1RM of {value:0}.
  assert.deepEqual(res.byReps, []);
  assert.equal(res.bestE1RM, null);
});
check('prsFrom: strength set in same workout still scores normally', () => {
  const res = prsFrom(cardioDS, 'ex-bench');
  assert.deepEqual(res.byReps, [{ reps: 5, weightKg: 100, date: '2026-07-20', setId: 'cs1' }]);
  assert.ok(Math.abs(res.bestE1RM.value - epley1RM(100, 5)) < 1e-9);
});
check('weeklyVolumeFrom: cardio set contributes zero volume', () => {
  const res = weeklyVolumeFrom(cardioDS, 1, '2026-07-20');
  assert.deepEqual(res, [
    { isoWeek: '2026-W30', perMuscleGroup: { cardio: 0, chest: 500 } },
  ]);
});
check('trainingFrequencyFrom: cardio set still counts towards frequency', () => {
  const res = trainingFrequencyFrom(cardioDS, 1, '2026-07-20');
  assert.deepEqual(res, [
    { isoWeek: '2026-W30', sessionsTotal: 1, perMuscleGroup: { cardio: 1, chest: 1 } },
  ]);
});
check('lastSessionFrom: cardio exercise session is returned with its cardio set', () => {
  const res = lastSessionFrom(cardioDS, 'ex-run');
  assert.ok(res);
  assert.equal(res.workout.id, 'cw1');
  assert.deepEqual(res.sets.map((s) => s.id), ['cs2']);
});
check('recentWorkoutsFrom: cardio set appears in the session listing', () => {
  const res = recentWorkoutsFrom(cardioDS, '0000');
  assert.equal(res.length, 1);
  assert.deepEqual(res[0].sets.map((s) => s.id), ['cs1', 'cs2']); // ordered by exerciseId
});

// ---------------------------------------------------------------------------
// prsFrom — real records (13 Oct 2026). The bug this guards: the old PR table
// was "heaviest at exactly N reps", so one 8 kg x 3 grinder read as "the
// record" while the genuine best set (14 kg x 12) was not shown at all.
// ---------------------------------------------------------------------------

const curlDS = (() => {
  const ex = [{ id: 'ex-sdc', name: 'Seated Dumbbell Curl', muscleGroup: 'biceps', equipment: 'dumbbell', exerciseType: 'weight_reps' }];
  const w = (id, date, finished = true) => ({ id, date, startedAt: `${date}T17:00:00`, finishedAt: finished ? `${date}T18:00:00` : null });
  const ws = [w('c1', '2024-11-18'), w('c2', '2026-04-14'), w('c3', '2026-04-23'), w('c4', '2026-05-13'), w('c5', '2026-07-28'), w('c6', '2026-08-01', false)];
  const st = (id, workoutId, setNumber, weightKg, reps, extra = {}) => ({ id, workoutId, exerciseId: 'ex-sdc', setNumber, weightKg, reps, isWarmup: false, ...extra });
  const ss = [
    st('c1a', 'c1', 1, 8, 8), st('c1b', 'c1', 2, 8, 3),                       // the 3-rep grinder
    st('c2a', 'c2', 1, 12, 12), st('c2b', 'c2', 2, 12, 8),
    st('c3w', 'c3', 1, 6, 15, { isWarmup: true }),                            // warm-up first: NOT the top set
    st('c3a', 'c3', 2, 14, 12), st('c3b', 'c3', 3, 14, 9), st('c3c', 'c3', 4, 14, 6),
    st('c4z', 'c4', 1, 0, 0),                                                 // untouched blank row: skipped
    st('c4a', 'c4', 2, 14, 7), st('c4b', 'c4', 3, 14, 5),
    st('c5a', 'c5', 1, 10, 8), st('c5b', 'c5', 2, 10, 6),
    st('c6a', 'c6', 1, 20, 20),                                               // unfinished workout
  ];
  return { workouts: ws, sets: ss, exercises: ex };
})();

check('prsFrom: heaviest is the heaviest weight with the MOST reps done at it', () => {
  const res = prsFrom({ ...curlDS, sets: curlDS.sets.filter((s) => s.workoutId !== 'c6') }, 'ex-sdc');
  assert.deepEqual(res.heaviest, { weightKg: 14, reps: 12, date: '2026-04-23', setId: 'c3a' });
});

check('prsFrom: bestSet is the highest weight x reps, mostReps the most reps (heavier wins a tie)', () => {
  const res = prsFrom({ ...curlDS, sets: curlDS.sets.filter((s) => s.workoutId !== 'c6') }, 'ex-sdc');
  assert.deepEqual(res.bestSet, { loadKg: 168, weightKg: 14, reps: 12, date: '2026-04-23', setId: 'c3a' });
  assert.deepEqual(res.mostReps, { reps: 12, weightKg: 14, date: '2026-04-23', setId: 'c3a' }); // 12 kg x 12 ties on reps, loses on weight
});

check('prsFrom: byWeight lists the most reps at each weight, heaviest first — real sets only', () => {
  const res = prsFrom({ ...curlDS, sets: curlDS.sets.filter((s) => s.workoutId !== 'c6') }, 'ex-sdc');
  assert.deepEqual(res.byWeight.map((r) => [r.weightKg, r.reps, r.date]), [
    [14, 12, '2026-04-23'], [12, 12, '2026-04-14'], [10, 8, '2026-07-28'], [8, 8, '2024-11-18'],
  ]);
  assert.ok(!res.byWeight.some((r) => r.weightKg === 6), 'warm-up weight must not appear');
  assert.ok(!res.byWeight.some((r) => r.weightKg === 8 && r.reps === 3), 'the 3-rep grinder is not the 8 kg record');
});

check('prsFrom: byReps / bestE1RM keep their original contract alongside the new fields', () => {
  const res = prsFrom(dataset, 'ex-bench');
  assert.deepEqual(res.byReps.map((r) => r.reps), [1, 3, 5]);
  assert.equal(res.heaviest.weightKg, 105);
  assert.equal(res.heaviest.reps, 1);
  assert.equal(res.mostReps.reps, 5);
});

check('prsFrom: no working sets -> every record null/empty', () => {
  const res = prsFrom(dataset, 'ex-curl');
  assert.equal(res.heaviest, null);
  assert.equal(res.bestSet, null);
  assert.equal(res.mostReps, null);
  assert.deepEqual(res.byWeight, []);
  assert.equal(res.longest, null);
  assert.equal(res.furthest, null);
  assert.equal(res.mostKcal, null);
});

check('prsFrom: time / distance / kcal records for non-rep exercises', () => {
  const ds = {
    workouts: [
      { id: 'k1', date: '2026-06-01', startedAt: '2026-06-01T07:00:00', finishedAt: '2026-06-01T08:00:00' },
      { id: 'k2', date: '2026-06-08', startedAt: '2026-06-08T07:00:00', finishedAt: '2026-06-08T08:00:00' },
    ],
    sets: [
      { id: 'k1a', workoutId: 'k1', exerciseId: 'ex-run', setNumber: 1, setType: 'cardio', weightKg: 0, reps: 0, durationSeconds: 1500, distanceM: 5000, kcal: 400, isWarmup: false },
      { id: 'k2a', workoutId: 'k2', exerciseId: 'ex-run', setNumber: 1, setType: 'cardio', weightKg: 0, reps: 0, durationSeconds: 1800, distanceM: 4800, kcal: 380, isWarmup: false },
    ],
    exercises: [],
  };
  const res = prsFrom(ds, 'ex-run');
  assert.equal(res.heaviest, null); // cardio never produces a lifting record
  assert.deepEqual([res.longest.durationSeconds, res.longest.date], [1800, '2026-06-08']);
  assert.deepEqual([res.furthest.distanceM, res.furthest.date], [5000, '2026-06-01']);
  assert.deepEqual([res.mostKcal.kcal, res.mostKcal.date], [400, '2026-06-01']);
});

// ---------------------------------------------------------------------------
// topSetSeriesFrom — one point per finished session, from the first working set
// ---------------------------------------------------------------------------

check('topSetSeriesFrom: one point per FINISHED session, oldest first', () => {
  const res = topSetSeriesFrom(curlDS, 'ex-sdc');
  assert.deepEqual(res.map((p) => p.workoutId), ['c1', 'c2', 'c3', 'c4', 'c5']); // c6 unfinished
  assert.ok(res.every((p, i) => i === 0 || p.t > res[i - 1].t));
});

check('topSetSeriesFrom: the top set is the first WORKING set — warm-ups and blank rows skipped', () => {
  const res = topSetSeriesFrom(curlDS, 'ex-sdc');
  const byW = Object.fromEntries(res.map((p) => [p.workoutId, p]));
  assert.equal(byW.c1.setId, 'c1a');   // 8 kg x 8, not the later 8 kg x 3
  assert.equal(byW.c3.setId, 'c3a');   // warm-up was set 1
  assert.equal(byW.c4.setId, 'c4a');   // blank row was set 1
});

check('topSetSeriesFrom: weight is the logged weight, load is weight x reps of that one set', () => {
  const res = topSetSeriesFrom(curlDS, 'ex-sdc');
  assert.deepEqual(res.map((p) => [p.weightKg, p.reps, p.loadKg]), [
    [8, 8, 64], [12, 12, 144], [14, 12, 168], [14, 7, 98], [10, 8, 80],
  ]);
  assert.ok(Math.abs(res[2].e1rm - 14 * (1 + 12 / 30)) < 1e-9);
  assert.equal(res[0].durationSeconds, null);
});

check('topSetSeriesFrom: cardio and timed sets carry time / distance / kcal, no load', () => {
  const ds = {
    workouts: [{ id: 'k1', date: '2026-06-01', startedAt: '2026-06-01T07:00:00', finishedAt: '2026-06-01T08:00:00' }],
    sets: [
      { id: 'k1a', workoutId: 'k1', exerciseId: 'ex-run', setNumber: 1, setType: 'cardio', weightKg: 0, reps: 0, durationSeconds: 1500, distanceM: 5000, kcal: 400, isWarmup: false },
      { id: 'k1b', workoutId: 'k1', exerciseId: 'ex-run', setNumber: 2, setType: 'cardio', weightKg: 0, reps: 0, durationSeconds: 600, distanceM: 2000, kcal: 150, isWarmup: false },
    ],
    exercises: [],
  };
  const res = topSetSeriesFrom(ds, 'ex-run');
  assert.equal(res.length, 1);
  assert.deepEqual([res[0].durationSeconds, res[0].distanceM, res[0].kcal, res[0].loadKg, res[0].e1rm], [1500, 5000, 400, null, null]);
});

check('topSetSeriesFrom: unknown exercise -> []', () => {
  assert.deepEqual(topSetSeriesFrom(curlDS, 'nope'), []);
});

// ---------------------------------------------------------------------------
// util date display — DD/MM/YYYY everywhere
// ---------------------------------------------------------------------------

check('formatDMY: ISO date -> DD/MM/YYYY with no day slip', () => {
  assert.equal(formatDMY('2026-04-23'), '23/04/2026');
  assert.equal(formatDMY('2026-01-05'), '05/01/2026');
  assert.equal(formatDMY('2025-12-31'), '31/12/2025');
});

check('formatDMY: datetime, epoch ms and Date all work; junk -> empty', () => {
  assert.equal(formatDMY('2026-07-28T17:10:00'), '28/07/2026');
  assert.equal(formatDMY(new Date(2026, 9, 13)), '13/10/2026');
  assert.equal(formatDMY(new Date(2026, 9, 13).getTime()), '13/10/2026');
  assert.equal(formatDMY(''), '');
  assert.equal(formatDMY(null), '');
  assert.equal(formatDMY('not a date'), '');
});

check('formatHM: 24-hour local time', () => {
  assert.equal(formatHM('2026-07-28T07:05:00'), '07:05');
  assert.equal(formatHM('2026-07-28T17:10:00'), '17:10');
  assert.equal(formatHM(null), '');
});

console.log(`\nAll ${passed} assertions passed.`);
process.exit(0);
