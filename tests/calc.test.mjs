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
  weeklyVolumeFrom,
  trainingFrequencyFrom,
} from '../js/calc.js';

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

console.log(`\nAll ${passed} assertions passed.`);
process.exit(0);
