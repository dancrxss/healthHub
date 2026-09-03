// Pure-Node unit tests for js/coach-engine.js — zero dependencies, Node
// built-ins only. Run: `node tests/coach-engine.test.mjs` (exits non-zero on
// the first failure).
//
// Every fixture is built programmatically against a fixed TODAY so nothing
// here depends on the clock. The engine is pure, so a failure is always a
// logic change, never a flake.

import assert from 'node:assert/strict';
import {
  COACH_ENGINE_VERSION,
  SET_TARGETS,
  RAMP_FACTORS,
  START_FACTORS,
  FLAG_CODES,
  setTargetsFor,
  hardSetsByGroup,
  muscleBalance,
  trainingGap,
  sessionDiff,
  loadFlags,
  progressionFor,
  nextPlanSession,
  planRefSets,
  buildDigest,
} from '../js/coach-engine.js';

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

const TODAY = '2026-09-03';
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function dayNum(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}
function addDays(iso, n) {
  const d = new Date((dayNum(iso) + n) * DAY_MS);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function ex(id, name, muscleGroup, equipment = 'barbell', exerciseType = 'weight_reps', isCustom = false) {
  return { id, name, muscleGroup, equipment, isCustom, exerciseType, createdAt: '2024-01-01T00:00:00Z', syncedAt: null };
}
function wo(id, date, opts = {}) {
  return {
    id,
    date,
    startedAt: `${date}T${opts.hour || '10'}:00:00Z`,
    finishedAt: opts.finished === false ? null : `${date}T${opts.hour || '10'}:55:00Z`,
    templateId: null,
    notes: null,
    name: opts.name || null,
    entries: opts.entries || null,
    planId: opts.planId || null,
    planSessionId: opts.planSessionId || null,
    syncedAt: null,
  };
}
let setSeq = 0;
function st(workoutId, exerciseId, setNumber, weightKg, reps, opts = {}) {
  setSeq += 1;
  return {
    id: `s${String(setSeq).padStart(5, '0')}`,
    workoutId,
    exerciseId,
    setNumber,
    weightKg,
    reps,
    rpe: opts.rpe == null ? null : opts.rpe,
    isWarmup: opts.isWarmup === true,
    setType: opts.setType || 'strength',
    durationSeconds: null,
    distanceM: null,
    kcal: null,
    notes: null,
    completedAt: opts.completedAt || `${workoutId}-${setNumber}`,
    syncedAt: null,
  };
}
/** n straight sets of the same weight/reps. */
function straight(workoutId, exerciseId, n, weightKg, reps, opts = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(st(workoutId, exerciseId, i, weightKg, reps, opts));
  return out;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

check('constants: version, bands, ramp, start factors and flag codes are pinned', () => {
  assert.equal(COACH_ENGINE_VERSION, 'coach-engine-1');
  assert.deepEqual(SET_TARGETS.chest, { min: 10, max: 20, scored: true });
  assert.deepEqual(SET_TARGETS.legs, { min: 12, max: 22, scored: true });
  assert.equal(SET_TARGETS.rehab.scored, false);
  assert.equal(SET_TARGETS.accessory.scored, false);
  assert.equal(SET_TARGETS.cardio.min, null);
  assert.deepEqual(RAMP_FACTORS, [0.4, 0.5, 0.65, 0.8, 0.9, 1.0]);
  assert.deepEqual(START_FACTORS.map((b) => b.factor), [0.95, 0.85, 0.75, 0.65, 0.6]);
  assert.equal(FLAG_CODES.length, 11);
  assert.ok(FLAG_CODES.includes('group-volume-spike'));
  assert.ok(FLAG_CODES.includes('weight-drop'));
});

// ---------------------------------------------------------------------------
// 8. setTargetsFor — return ramp and low-frequency scaling
// ---------------------------------------------------------------------------

check('setTargetsFor: ramp week 1 gives chest 4–8', () => {
  const t = setTargetsFor({ goal: 'return-from-injury', daysPerWeek: 4 }, 1);
  assert.equal(t.chest.min, 4); // floor(10 × 0.4)
  assert.equal(t.chest.max, 8); // ceil(20 × 0.4)
});

check('setTargetsFor: ramp week 6 and beyond gives the full chest band 10–20', () => {
  const t6 = setTargetsFor({ goal: 'return-from-injury', daysPerWeek: 4 }, 6);
  assert.equal(t6.chest.min, 10);
  assert.equal(t6.chest.max, 20);
  const t9 = setTargetsFor({ goal: 'return-from-injury', daysPerWeek: 4 }, 9);
  assert.deepEqual(t9.chest, t6.chest); // index clamps at 5
});

check('setTargetsFor: ramp week 3 uses 0.65', () => {
  const t = setTargetsFor({ goal: 'return-from-injury', daysPerWeek: 4 }, 3);
  assert.equal(t.legs.min, Math.floor(12 * 0.65)); // 7
  assert.equal(t.legs.max, Math.ceil(22 * 0.65)); // 15
});

check('setTargetsFor: daysPerWeek 3 scales the max by 0.85 but not the min', () => {
  const t = setTargetsFor({ goal: 'general-fitness', daysPerWeek: 3 }, null);
  assert.equal(t.chest.min, 10);
  assert.equal(t.chest.max, 17); // ceil(20 × 0.85)
  const t4 = setTargetsFor({ goal: 'general-fitness', daysPerWeek: 4 }, null);
  assert.equal(t4.chest.max, 20);
});

check('setTargetsFor: no ramp unless the goal is return-from-injury', () => {
  const t = setTargetsFor({ goal: 'build-muscle', daysPerWeek: 5 }, 1);
  assert.equal(t.chest.min, 10);
  assert.equal(t.chest.max, 20);
});

check('setTargetsFor: null profile defaults to 3 days/week, no ramp; every group present', () => {
  const t = setTargetsFor(null, null);
  assert.equal(t.chest.max, 17);
  assert.equal(t.cardio.min, null);
  assert.equal(t.other.scored, false);
  assert.equal(Object.keys(t).length, 11);
});

// ---------------------------------------------------------------------------
// 1. Layoff fixture — 12-week block, then 31 days off
// ---------------------------------------------------------------------------

const LAYOFF_LAST = addDays(TODAY, -31); // 2026-08-03
const layoffExercises = [
  ex('ex-bench', 'Bench Press', 'chest', 'barbell'),
  ex('ex-squat', 'Squat', 'legs', 'barbell'),
];
const layoffWorkouts = [];
const layoffSets = [];
for (let i = 11; i >= 0; i--) {
  const date = addDays(LAYOFF_LAST, -i * 7);
  const id = `lw${11 - i}`;
  layoffWorkouts.push(wo(id, date));
  // Weights climb 80 → 97.5, so the highest-e1RM session is the last one.
  const weight = 80 + (11 - i) * 1.5909090909; // 80 … 97.5
  const w = Math.round(weight * 2) / 2;
  layoffSets.push(...straight(id, 'ex-bench', 3, 11 - i === 11 ? 97.5 : w, 5, { rpe: 8 }));
  layoffSets.push(...straight(id, 'ex-squat', 3, 100, 5, { rpe: 8 }));
}
const layoffDS = { workouts: layoffWorkouts, sets: layoffSets, exercises: layoffExercises };

check('trainingGap: 31 days off ⇒ weeksOff 4, long-layoff, detraining 0.04', () => {
  const g = trainingGap(layoffDS, TODAY);
  assert.equal(g.daysSinceLastSession, 31);
  assert.equal(g.weeksOff, 4);
  assert.equal(g.status, 'long-layoff');
  assert.equal(g.detrainingPct, 0.04);
  assert.equal(g.lastSessionDate, LAYOFF_LAST);
  assert.equal(g.weeksTrained, 0); // inside the gap: not back yet
});

check('trainingGap: status bands are 10 and 20 days', () => {
  const at = (days) => {
    const d = { workouts: [wo('g1', addDays(TODAY, -days))], sets: [], exercises: [] };
    return trainingGap(d, TODAY).status;
  };
  assert.equal(at(9), 'active');
  assert.equal(at(10), 'layoff');
  assert.equal(at(20), 'layoff');
  assert.equal(at(21), 'long-layoff');
});

check('trainingGap: no history at all is reported without inventing detraining', () => {
  const g = trainingGap({ workouts: [], sets: [], exercises: [] }, TODAY);
  assert.equal(g.lastSessionDate, null);
  assert.equal(g.daysSinceLastSession, null);
  assert.equal(g.weeksTrained, null);
  assert.equal(g.detrainingPct, 0);
});

check('trainingGap: an unfinished workout does not count as training', () => {
  const d = {
    workouts: [wo('f1', addDays(TODAY, -30)), wo('f2', addDays(TODAY, -1), { finished: false })],
    sets: [],
    exercises: [],
  };
  assert.equal(trainingGap(d, TODAY).lastSessionDate, addDays(TODAY, -30));
});

check('progressionFor: layoff restart is 0.85 × the pre-layoff working weight, rounded down to 2.5', () => {
  const p = progressionFor(layoffDS, 'ex-bench', { today: TODAY, profile: { goal: 'return-from-injury', daysPerWeek: 3 } });
  // best session was 3 × 5 @ 97.5 kg ⇒ median 97.5 × 0.85 = 82.875 ⇒ 82.5
  assert.equal(p.rule, 'layoff-restart');
  assert.equal(p.weightKg, 82.5);
  assert.equal(p.repsLow, 6);
  assert.equal(p.repsHigh, 10);
  assert.equal(p.sets, 2); // ramp weeks 1–2 drop to two working sets
});

check('progressionFor: the layoff restart never goes below the barbell floor', () => {
  const light = {
    workouts: [wo('lt1', addDays(TODAY, -40))],
    sets: straight('lt1', 'ex-bar', 3, 20, 5),
    exercises: [ex('ex-bar', 'Empty Bar Press', 'chest', 'barbell')],
  };
  const p = progressionFor(light, 'ex-bar', { today: TODAY, profile: null });
  assert.equal(p.rule, 'layoff-restart');
  assert.equal(p.weightKg, 20);
});

check('progressionFor: an unknown exercise id returns null', () => {
  assert.equal(progressionFor(layoffDS, 'nope', { today: TODAY }), null);
});

check('progressionFor: cardio and notes types are unscored', () => {
  const d = {
    workouts: [],
    sets: [],
    exercises: [ex('ex-run', 'Treadmill', 'cardio', 'other', 'cardio'), ex('ex-stretch', 'Stretching', 'other', 'other', 'notes')],
  };
  for (const id of ['ex-run', 'ex-stretch']) {
    assert.deepEqual(progressionFor(d, id, { today: TODAY }), {
      weightKg: null,
      repsLow: null,
      repsHigh: null,
      sets: 1,
      rule: 'unscored',
    });
  }
});

// ---------------------------------------------------------------------------
// 2 + 3. Balance fixture — chest spike, legs under, shoulders untrained
// ---------------------------------------------------------------------------

const balanceExercises = [
  ex('ex-bench', 'Bench Press', 'chest', 'barbell'),
  ex('ex-fly', 'Cable Fly', 'chest', 'cable'),
  ex('ex-squat', 'Squat', 'legs', 'barbell'),
  ex('ex-ohp', 'Overhead Press', 'shoulders', 'barbell'),
  ex('ex-run', 'Treadmill', 'cardio', 'other', 'cardio'),
];
const balanceWorkouts = [
  wo('bw3', '2026-08-12'), // ISO week starting 2026-08-10
  wo('bw2', '2026-08-19'), // week starting 2026-08-17
  wo('bw1', '2026-08-26'), // week starting 2026-08-24
  wo('bw0', '2026-09-01'), // week starting 2026-08-31 (current)
];
const balanceSets = [
  ...straight('bw3', 'ex-bench', 9, 80, 8, { rpe: 7 }),
  ...straight('bw2', 'ex-bench', 10, 80, 8, { rpe: 7 }),
  ...straight('bw1', 'ex-bench', 11, 80, 8, { rpe: 7 }),
  ...straight('bw0', 'ex-bench', 26, 80, 8, { rpe: 9 }),
  ...straight('bw0', 'ex-squat', 3, 100, 5, { rpe: 8 }),
];
const balanceDS = { workouts: balanceWorkouts, sets: balanceSets, exercises: balanceExercises };
const balanceProfile = {
  version: 1,
  updatedAt: '2026-09-01T00:00:00Z',
  injuryNotes: 'Left shoulder, cleared for pressing',
  goal: 'build-muscle',
  daysPerWeek: 4,
  sessionMinutes: 60,
  equipmentNotes: 'Commercial gym',
  returnDate: null,
  avoidExerciseIds: [],
};

check('hardSetsByGroup: zero-filled, oldest first, one entry per MUSCLE_GROUP', () => {
  const rows = hardSetsByGroup(balanceDS, 4, TODAY);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.perGroup.chest), [9, 10, 11, 26]);
  assert.deepEqual(rows.map((r) => r.perGroup.legs), [0, 0, 0, 3]);
  assert.deepEqual(rows.map((r) => r.perGroup.shoulders), [0, 0, 0, 0]);
  assert.equal(Object.keys(rows[0].perGroup).length, 11);
});

check('muscleBalance: chest 26 against 9/10/11 is over, trending up', () => {
  const b = muscleBalance(balanceDS, { weeks: 4, today: TODAY, profile: balanceProfile });
  const chest = b.find((x) => x.group === 'chest');
  assert.equal(chest.sets, 26);
  assert.equal(chest.min, 10);
  assert.equal(chest.max, 20);
  assert.equal(chest.status, 'over');
  assert.equal(chest.trend, 'up');
  assert.equal(chest.trendPct, 1.6); // 26 / 10 − 1
  assert.deepEqual(chest.weekly, [9, 10, 11, 26]);
});

check('muscleBalance: legs 3 sets is under; shoulders 0 is untrained', () => {
  const b = muscleBalance(balanceDS, { weeks: 4, today: TODAY, profile: balanceProfile });
  const legs = b.find((x) => x.group === 'legs');
  assert.equal(legs.sets, 3);
  assert.equal(legs.status, 'under'); // 3 < 0.75 × 12
  const shoulders = b.find((x) => x.group === 'shoulders');
  assert.equal(shoulders.sets, 0);
  assert.equal(shoulders.status, 'untrained');
});

check('muscleBalance: groups with no band report status unscored and are ordered canonically', () => {
  const b = muscleBalance(balanceDS, { weeks: 4, today: TODAY, profile: balanceProfile });
  const cardio = b.find((x) => x.group === 'cardio');
  assert.equal(cardio.status, 'unscored');
  assert.equal(cardio.min, null);
  assert.deepEqual(b.slice(0, 4).map((x) => x.group), ['chest', 'back', 'legs', 'shoulders']);
});

check('loadFlags: the chest spike is a group-volume-spike at warn', () => {
  const flags = loadFlags(balanceDS, { today: TODAY, profile: balanceProfile });
  const spike = flags.find((f) => f.code === 'group-volume-spike');
  assert.ok(spike, 'expected a group-volume-spike');
  assert.equal(spike.severity, 'warn'); // 26 / 10 = 2.6 > 1.5
  assert.equal(spike.detail.group, 'chest');
  assert.equal(spike.detail.ratio, 2.6);
  assert.equal(spike.detail.sets, 26);
  assert.equal(spike.detail.priorMean, 10);
});

check('loadFlags: the same week is a total volume-spike, and warn sorts before watch/info', () => {
  const flags = loadFlags(balanceDS, { today: TODAY, profile: balanceProfile });
  const codes = flags.map((f) => f.code);
  assert.ok(codes.includes('volume-spike'));
  const sev = flags.map((f) => f.severity);
  const rank = { warn: 0, watch: 1, info: 2 };
  for (let i = 1; i < sev.length; i++) assert.ok(rank[sev[i - 1]] <= rank[sev[i]], 'flags are severity-sorted');
});

check('loadFlags: rehab and accessory volume is never flagged', () => {
  const rehabDS = {
    workouts: balanceWorkouts,
    sets: [
      ...straight('bw3', 'ex-band', 9, 5, 15),
      ...straight('bw2', 'ex-band', 10, 5, 15),
      ...straight('bw1', 'ex-band', 11, 5, 15),
      ...straight('bw0', 'ex-band', 30, 5, 15),
    ],
    exercises: [ex('ex-band', 'Band Pull Apart', 'rehab', 'other')],
  };
  const flags = loadFlags(rehabDS, { today: TODAY, profile: balanceProfile });
  assert.equal(flags.filter((f) => f.code === 'group-volume-spike').length, 0);
});

check('loadFlags: return-ramp is always present while not active', () => {
  const flags = loadFlags(layoffDS, { today: TODAY, profile: { goal: 'return-from-injury', daysPerWeek: 3 } });
  const ramp = flags.find((f) => f.code === 'return-ramp');
  assert.ok(ramp);
  assert.equal(ramp.severity, 'info');
  assert.equal(ramp.detail.status, 'long-layoff');
  assert.equal(ramp.detail.weeksOff, 4);
  assert.equal(ramp.detail.rampFactor, 0.4);
});

check('loadFlags: no-rest-day fires after four consecutive training days', () => {
  const days = [4, 3, 2, 1].map((d) => addDays(TODAY, -d));
  const ds = { workouts: days.map((d, i) => wo(`r${i}`, d)), sets: [], exercises: [] };
  const flag = loadFlags(ds, { today: TODAY }).find((f) => f.code === 'no-rest-day');
  assert.ok(flag);
  assert.equal(flag.detail.days, 4);
  assert.equal(flag.severity, 'watch');
  const three = { workouts: days.slice(1).map((d, i) => wo(`r${i}`, d)), sets: [], exercises: [] };
  assert.equal(loadFlags(three, { today: TODAY }).find((f) => f.code === 'no-rest-day'), undefined);
});

// ---------------------------------------------------------------------------
// 4. sessionDiff
// ---------------------------------------------------------------------------

const diffExercises = [
  ex('ex-bench', 'Bench Press', 'chest', 'barbell'),
  ex('ex-row', 'Barbell Row', 'back', 'barbell'),
  ex('ex-curl', 'Dumbbell Curl', 'biceps', 'dumbbell'),
  ex('ex-run', 'Treadmill', 'cardio', 'other', 'cardio'),
];
const diffWorkouts = [wo('dA', '2026-08-27'), wo('dB', '2026-09-01', { name: 'Upper A' })];
const diffSets = [
  // Previous session
  ...straight('dA', 'ex-bench', 3, 100, 5, { rpe: 8 }),
  ...straight('dA', 'ex-row', 3, 60, 10, { rpe: 8 }),
  // This session: bench up, row down, curl new
  st('dB', 'ex-bench', 1, 40, 10, { isWarmup: true, completedAt: '2026-09-01T10:00:00Z' }),
  st('dB', 'ex-bench', 2, 105, 5, { rpe: 8, completedAt: '2026-09-01T10:05:00Z' }),
  st('dB', 'ex-bench', 3, 105, 5, { rpe: 8, completedAt: '2026-09-01T10:10:00Z' }),
  st('dB', 'ex-bench', 4, 105, 5, { rpe: 9, completedAt: '2026-09-01T10:15:00Z' }),
  st('dB', 'ex-row', 1, 60, 8, { rpe: 9, completedAt: '2026-09-01T10:20:00Z' }),
  st('dB', 'ex-row', 2, 60, 8, { rpe: 9, completedAt: '2026-09-01T10:25:00Z' }),
  st('dB', 'ex-row', 3, 60, 8, { rpe: 9, completedAt: '2026-09-01T10:30:00Z' }),
  st('dB', 'ex-curl', 1, 20, 10, { rpe: 8, completedAt: '2026-09-01T10:35:00Z' }),
  st('dB', 'ex-curl', 2, 20, 10, { rpe: 8, completedAt: '2026-09-01T10:40:00Z' }),
  st('dB', 'ex-curl', 3, 20, 10, { rpe: 8, completedAt: '2026-09-01T10:45:00Z' }),
  st('dB', 'ex-run', 1, 0, 0, { setType: 'cardio', completedAt: '2026-09-01T10:50:00Z' }),
];
const diffDS = { workouts: diffWorkouts, sets: diffSets, exercises: diffExercises };

check('sessionDiff: unknown workout id returns null', () => {
  assert.equal(sessionDiff(diffDS, 'nope'), null);
});

check('sessionDiff: warmup and cardio sets are excluded from every count', () => {
  const d = sessionDiff(diffDS, 'dB');
  assert.equal(d.hardSets, 9); // 3 bench + 3 row + 3 curl — not the warmup, not the cardio set
  assert.equal(d.volumeKg, 3 * 105 * 5 + 3 * 60 * 8 + 3 * 20 * 10); // 1575 + 1440 + 600
  assert.deepEqual(d.exercises.map((e) => e.id), ['ex-bench', 'ex-row', 'ex-curl']); // no ex-run
  const bench = d.exercises.find((e) => e.id === 'ex-bench');
  assert.equal(bench.sets.length, 3); // the warmup is not in the set list
  assert.equal(bench.volumeKg, 1575);
  assert.equal(bench.topSet.w, 105);
});

check('sessionDiff: header fields', () => {
  const d = sessionDiff(diffDS, 'dB');
  assert.equal(d.workoutId, 'dB');
  assert.equal(d.date, '2026-09-01');
  assert.equal(d.name, 'Upper A');
  assert.equal(d.durationMin, 55);
  assert.equal(d.avgRpe, Math.round(((8 + 8 + 9 + 9 + 9 + 9 + 8 + 8 + 8) / 9) * 100) / 100);
});

check('sessionDiff: improved, regressed and new exercises get the right verdicts', () => {
  const d = sessionDiff(diffDS, 'dB');
  const bench = d.exercises.find((e) => e.id === 'ex-bench');
  const row = d.exercises.find((e) => e.id === 'ex-row');
  const curl = d.exercises.find((e) => e.id === 'ex-curl');

  assert.equal(bench.verdict, 'better');
  assert.ok(bench.volumeKg > bench.volumePrevKg);
  assert.ok(bench.e1rm > bench.e1rmPrev);
  assert.equal(bench.repsAtSameWeight, null); // 105 vs 100 — different top weights
  assert.equal(bench.group, 'chest');

  assert.equal(row.verdict, 'worse');
  assert.ok(row.volumeKg < row.volumePrevKg);
  assert.ok(row.e1rm < row.e1rmPrev);
  assert.deepEqual(row.repsAtSameWeight, { reps: 8, prevReps: 10 }); // both top out at 60 kg
  assert.deepEqual(row.prevTop, { w: 60, r: 10, rpe: 8 });
  assert.equal(row.avgRpe, 9);
  assert.equal(row.prevAvgRpe, 8);

  assert.equal(curl.verdict, 'new');
  assert.equal(curl.volumePrevKg, null);
  assert.equal(curl.e1rmPrev, null);
  assert.equal(curl.prevTop, null);
});

check('sessionDiff: "same" when nothing moved, and a later workout is not used as "previous"', () => {
  const ds = {
    workouts: [wo('sA', '2026-08-25'), wo('sB', '2026-09-01'), wo('sC', '2026-09-02')],
    sets: [
      ...straight('sA', 'ex-bench', 3, 100, 5),
      ...straight('sB', 'ex-bench', 3, 100, 5),
      ...straight('sC', 'ex-bench', 3, 130, 5), // in the future relative to sB
    ],
    exercises: diffExercises,
  };
  const d = sessionDiff(ds, 'sB');
  assert.equal(d.exercises[0].verdict, 'same');
  assert.equal(d.exercises[0].e1rmPrev, d.exercises[0].e1rm);
});

check('sessionDiff: the set list is capped at six working sets', () => {
  const ds = {
    workouts: [wo('cap1', '2026-09-01')],
    sets: straight('cap1', 'ex-bench', 9, 60, 5),
    exercises: diffExercises,
  };
  const d = sessionDiff(ds, 'cap1');
  assert.equal(d.hardSets, 9);
  assert.equal(d.exercises[0].sets.length, 6);
});

// ---------------------------------------------------------------------------
// 5. Double progression
// ---------------------------------------------------------------------------

const progProfile = { goal: 'get-stronger', daysPerWeek: 4, avoidExerciseIds: [] };
const benchOnly = [ex('ex-bench', 'Bench Press', 'chest', 'barbell')];

function progDS(sessions) {
  // sessions: [{date, weight, reps, rpe}] oldest first
  const workouts = sessions.map((s, i) => wo(`pw${i}`, s.date));
  const sets = sessions.flatMap((s, i) => straight(`pw${i}`, 'ex-bench', 3, s.weight, s.reps, { rpe: s.rpe }));
  return { workouts, sets, exercises: benchOnly };
}

check('progressionFor: top of range at RPE 8 adds one step and resets the reps target', () => {
  const ds = progDS([{ date: '2026-09-01', weight: 70, reps: 10, rpe: 8 }]);
  const p = progressionFor(ds, 'ex-bench', { today: TODAY, profile: progProfile });
  assert.equal(p.rule, 'double-progression-up');
  assert.equal(p.weightKg, 72.5); // 70 × 1.025 = 71.75 ⇒ 72.5
  assert.equal(p.repsLow, 6);
  assert.equal(p.repsHigh, 10);
  assert.equal(p.sets, 3);
});

check('progressionFor: mid-range holds the weight and asks for one more rep', () => {
  const ds = progDS([{ date: '2026-09-01', weight: 70, reps: 8, rpe: 8 }]);
  const p = progressionFor(ds, 'ex-bench', { today: TODAY, profile: progProfile });
  assert.equal(p.rule, 'double-progression-reps');
  assert.equal(p.weightKg, 70);
  assert.equal(p.repsLow, 9);
  assert.equal(p.repsHigh, 10);
});

check('progressionFor: RPE 9.5 holds even at the top of the range', () => {
  const top = progressionFor(progDS([{ date: '2026-09-01', weight: 70, reps: 10, rpe: 9.5 }]), 'ex-bench', {
    today: TODAY,
    profile: progProfile,
  });
  assert.equal(top.rule, 'double-progression-hold');
  assert.equal(top.weightKg, 70);
  const mid = progressionFor(progDS([{ date: '2026-09-01', weight: 70, reps: 8, rpe: 9.5 }]), 'ex-bench', {
    today: TODAY,
    profile: progProfile,
  });
  assert.equal(mid.rule, 'double-progression-hold');
  assert.equal(mid.repsLow, 6);
});

check('progressionFor: one session short of the range holds, three in a row deload 10%', () => {
  const once = progDS([
    { date: '2026-08-24', weight: 70, reps: 8, rpe: 8 },
    { date: '2026-09-01', weight: 70, reps: 5, rpe: 9 },
  ]);
  assert.equal(progressionFor(once, 'ex-bench', { today: TODAY, profile: progProfile }).rule, 'double-progression-hold');

  const thrice = progDS([
    { date: '2026-08-24', weight: 70, reps: 5, rpe: 9 },
    { date: '2026-08-28', weight: 70, reps: 5, rpe: 9 },
    { date: '2026-09-01', weight: 70, reps: 5, rpe: 9 },
  ]);
  const p = progressionFor(thrice, 'ex-bench', { today: TODAY, profile: progProfile });
  assert.equal(p.rule, 'deload');
  assert.equal(p.weightKg, 62.5); // 70 × 0.9 = 63 ⇒ rounded down to 62.5
});

check('progressionFor: dumbbells step by 2 kg, cables by 2.5', () => {
  const dbDS = {
    workouts: [wo('dw1', '2026-09-01')],
    sets: straight('dw1', 'ex-db', 3, 20, 12, { rpe: 7 }),
    exercises: [ex('ex-db', 'Dumbbell Press', 'chest', 'dumbbell')],
  };
  const p = progressionFor(dbDS, 'ex-db', { today: TODAY, profile: progProfile });
  assert.equal(p.repsLow, 8); // dumbbell work uses the 8–12 lane
  assert.equal(p.repsHigh, 12);
  assert.equal(p.rule, 'double-progression-up');
  assert.equal(p.weightKg, 22); // 20 × 1.025 = 20.5 ⇒ nearest 2 kg step is 20, so it is forced one full step up
});

check('progressionFor: bodyweight work stays at 0 kg and progresses on reps', () => {
  const bwDS = {
    workouts: [wo('bwo1', '2026-09-01')],
    sets: straight('bwo1', 'ex-pu', 3, 0, 12, { rpe: 7 }),
    exercises: [ex('ex-pu', 'Push Up', 'chest', 'bodyweight', 'reps')],
  };
  const p = progressionFor(bwDS, 'ex-pu', { today: TODAY, profile: progProfile });
  assert.equal(p.weightKg, 0);
  assert.equal(p.rule, 'double-progression-reps');
  assert.equal(p.repsLow, 13);
  assert.ok(p.repsHigh >= 15);
});

check('progressionFor: never-trained exercise is first-time at the equipment floor', () => {
  const ds = { workouts: [], sets: [], exercises: benchOnly };
  const p = progressionFor(ds, 'ex-bench', { today: TODAY, profile: progProfile });
  assert.equal(p.rule, 'first-time');
  assert.equal(p.weightKg, 20);
});

check('progressionFor: warmup sets never set the working weight', () => {
  const ds = {
    workouts: [wo('hw1', '2026-09-01')],
    sets: [
      st('hw1', 'ex-bench', 1, 200, 10, { isWarmup: true }), // absurd warmup, must be ignored
      ...straight('hw1', 'ex-bench', 3, 70, 10, { rpe: 8 }).map((s, i) => ({ ...s, setNumber: i + 2 })),
    ],
    exercises: benchOnly,
  };
  const p = progressionFor(ds, 'ex-bench', { today: TODAY, profile: progProfile });
  assert.equal(p.weightKg, 72.5);
});

// ---------------------------------------------------------------------------
// 9. Plans
// ---------------------------------------------------------------------------

const plan = {
  id: 'plan-1',
  version: 2,
  createdAt: '2026-09-01T00:00:00Z',
  source: 'created',
  basedOnWorkoutId: null,
  rationale: 'Return block',
  weeks: 6,
  sessions: [
    {
      id: 'ps-1',
      order: 1,
      name: 'Push',
      focus: 'chest',
      exercises: [
        { exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 10, targetWeightKg: 72.5, targetRpe: 8, note: 'slow eccentric' },
      ],
    },
    {
      id: 'ps-2',
      order: 2,
      name: 'Pull',
      focus: 'back',
      exercises: [
        { exerciseId: 'ex-row', targetSets: 4, targetRepsLow: 8, targetRepsHigh: 12, targetWeightKg: null, targetRpe: null, note: null },
      ],
    },
    {
      id: 'ps-3',
      order: 3,
      name: 'Legs',
      focus: 'legs',
      exercises: [
        { exerciseId: 'ex-squat', targetSets: 3, targetRepsLow: 5, targetRepsHigh: 8, targetWeightKg: 90, targetRpe: 8, note: null },
      ],
    },
  ],
};

check('nextPlanSession: walks on from the last tagged session', () => {
  const recents = [
    { workout: wo('pa', '2026-09-01', { planSessionId: 'ps-1' }), sets: [] },
    { workout: wo('pb', '2026-08-30', { planSessionId: 'ps-3' }), sets: [] },
  ];
  assert.equal(nextPlanSession(plan, recents).id, 'ps-2');
});

check('nextPlanSession: wraps round the end of the plan', () => {
  const recents = [{ workout: wo('pa', '2026-09-01', { planSessionId: 'ps-3' }), sets: [] }];
  assert.equal(nextPlanSession(plan, recents).id, 'ps-1');
});

check('nextPlanSession: accepts plain workout records too', () => {
  assert.equal(nextPlanSession(plan, [wo('pa', '2026-09-01', { planSessionId: 'ps-2' })]).id, 'ps-3');
});

check('nextPlanSession: unfinished, untagged and unknown ids fall through to the first session', () => {
  assert.equal(nextPlanSession(plan, []).id, 'ps-1');
  assert.equal(nextPlanSession(plan, [wo('pa', '2026-09-01', { planSessionId: 'ps-2', finished: false })]).id, 'ps-1');
  assert.equal(nextPlanSession(plan, [wo('pa', '2026-09-01', { planSessionId: 'ps-9' })]).id, 'ps-1');
  assert.equal(nextPlanSession(plan, [wo('pa', '2026-09-01')]).id, 'ps-1');
});

check('nextPlanSession: ordering comes from `order`, not array position', () => {
  const shuffled = { ...plan, sessions: [plan.sessions[2], plan.sessions[0], plan.sessions[1]] };
  assert.equal(nextPlanSession(shuffled, []).id, 'ps-1');
  assert.equal(nextPlanSession(shuffled, [wo('pa', '2026-09-01', { planSessionId: 'ps-1' })]).id, 'ps-2');
});

check('nextPlanSession: a plan with no sessions returns null', () => {
  assert.equal(nextPlanSession({ sessions: [] }, []), null);
  assert.equal(nextPlanSession(null, []), null);
});

check('planRefSets: one ghost set per target set, at the top of the rep range', () => {
  const refs = planRefSets(plan.sessions[0].exercises[0]);
  assert.equal(refs.length, 3);
  assert.deepEqual(refs[0], { weightKg: 72.5, reps: 10, durationSeconds: null, distanceM: null, kcal: null });
  assert.deepEqual(refs[0], refs[2]);
});

check('planRefSets: a null target weight becomes 0; no exercise gives an empty list', () => {
  const refs = planRefSets(plan.sessions[1].exercises[0]);
  assert.equal(refs.length, 4);
  assert.equal(refs[0].weightKg, 0);
  assert.equal(refs[0].reps, 12);
  assert.deepEqual(planRefSets(null), []);
});

// ---------------------------------------------------------------------------
// 6. Digest — determinism and recovery consent
// ---------------------------------------------------------------------------

const HEALTH = {
  sleepH: 7.4,
  hrvMs: 58,
  hrvBaselineMs: 62,
  restingHr: 51,
  restingHrBaseline: 50,
  weightKg: 82.3,
  weightTrend30dPct: -0.4,
};

check('buildDigest: two identical calls are deep-equal (and stringify identically)', () => {
  const a = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, health: HEALTH, kind: 'daily' });
  const b = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, health: HEALTH, kind: 'daily' });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

check('buildDigest: no recovery key at all when health is null', () => {
  const d = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, health: null, kind: 'daily' });
  assert.equal('recovery' in d, false);
  assert.equal(JSON.stringify(d).includes('recovery'), false);
});

check('buildDigest: recovery carries exactly the seven consented fields', () => {
  const d = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, health: HEALTH, kind: 'daily' });
  assert.deepEqual(Object.keys(d.recovery).sort(), [
    'hrvBaselineMs',
    'hrvMs',
    'restingHr',
    'restingHrBaseline',
    'sleepH',
    'weightKg',
    'weightTrend30dPct',
  ]);
  assert.equal(d.recovery.sleepH, 7.4);
});

check('buildDigest: core shape, week totals and balance projection', () => {
  const d = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, kind: 'daily' });
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.kind, 'daily');
  assert.equal(d.today, TODAY);
  assert.equal(d.profile.goal, 'build-muscle');
  assert.equal(d.profile.daysPerWeek, 4);
  assert.equal(d.week.sessions, 1);
  assert.equal(d.week.hardSets, 29);
  assert.ok(d.balance.every((b) => b.min !== null && 'g' in b));
  assert.equal(d.balance.find((b) => b.g === 'chest').status, 'over');
  assert.equal(d.balance.find((b) => b.g === 'cardio'), undefined); // unscored groups are omitted
  assert.equal(d.plan, null);
  assert.equal('session' in d, false);
});

check('buildDigest: avoided exercises are kept out of the list', () => {
  const d = buildDigest({
    dataset: balanceDS,
    profile: { ...balanceProfile, avoidExerciseIds: ['ex-bench'] },
    today: TODAY,
    kind: 'daily',
  });
  assert.equal(d.exercises.find((e) => e.id === 'ex-bench'), undefined);
  assert.deepEqual(d.profile.avoid, ['ex-bench']);
});

check('buildDigest: kind session carries the diff, kinds daily/session carry the plan', () => {
  const d = buildDigest({ dataset: diffDS, profile: balanceProfile, today: TODAY, workoutId: 'dB', plan, kind: 'session' });
  assert.equal(d.session.workoutId, 'dB');
  assert.equal(d.session.hardSets, 9);
  assert.equal(d.session.exercises.length, 3);
  assert.ok(d.session.exercises.every((e) => e.sets.length <= 6));
  assert.equal(d.plan.version, 2);
  assert.equal(JSON.stringify(d.plan).includes('note'), false); // notes are stripped
  assert.equal(JSON.stringify(d.plan).includes('slow eccentric'), false);
});

check('buildDigest: kind plan never echoes a plan back', () => {
  const d = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, plan, kind: 'plan' });
  assert.equal(d.plan, null);
});

// ---------------------------------------------------------------------------
// 9 (cont). Exercise window anchored at the last session, not today
// ---------------------------------------------------------------------------

check('buildDigest: a 31-day layoff still lists exercises (window anchored at the last session)', () => {
  const d = buildDigest({
    dataset: layoffDS,
    profile: { goal: 'return-from-injury', daysPerWeek: 3, avoidExerciseIds: [] },
    today: TODAY,
    kind: 'daily',
  });
  assert.ok(d.exercises.length > 0, 'the exercise list must not be empty after a layoff');
  assert.deepEqual(d.exercises.map((e) => e.id).sort(), ['ex-bench', 'ex-squat']);
  const bench = d.exercises.find((e) => e.id === 'ex-bench');
  assert.equal(bench.lastDate, LAYOFF_LAST);
  assert.equal(bench.weeksSince, 4);
  assert.equal(bench.proposal.rule, 'layoff-restart');
  assert.equal(bench.bestE1rm, Math.round(97.5 * (1 + 5 / 30) * 10) / 10);
  assert.ok(bench.e1rmPrev != null && bench.e1rmPrev < bench.e1rm);
});

// ---------------------------------------------------------------------------
// 10. Health flags at their thresholds
// ---------------------------------------------------------------------------

function healthCodes(health) {
  return loadFlags(balanceDS, { today: TODAY, health, profile: balanceProfile }).map((f) => f.code);
}

check('loadFlags: low-hrv fires below 0.8 × baseline, not at it', () => {
  assert.ok(healthCodes({ ...HEALTH, hrvMs: 39.9, hrvBaselineMs: 50 }).includes('low-hrv'));
  assert.ok(!healthCodes({ ...HEALTH, hrvMs: 40, hrvBaselineMs: 50 }).includes('low-hrv'));
});

check('loadFlags: elevated-rhr fires at baseline + 5, not below', () => {
  assert.ok(healthCodes({ ...HEALTH, restingHr: 55, restingHrBaseline: 50 }).includes('elevated-rhr'));
  assert.ok(!healthCodes({ ...HEALTH, restingHr: 54.9, restingHrBaseline: 50 }).includes('elevated-rhr'));
});

check('loadFlags: short-sleep fires below six hours, not at six', () => {
  assert.ok(healthCodes({ ...HEALTH, sleepH: 5.9 }).includes('short-sleep'));
  assert.ok(!healthCodes({ ...HEALTH, sleepH: 6 }).includes('short-sleep'));
});

check('loadFlags: weight-drop fires below −2% over 30 days, not at −2%', () => {
  assert.ok(healthCodes({ ...HEALTH, weightTrend30dPct: -2.1 }).includes('weight-drop'));
  assert.ok(!healthCodes({ ...HEALTH, weightTrend30dPct: -2 }).includes('weight-drop'));
});

check('loadFlags: no health flags without health, or with the fields missing', () => {
  const none = loadFlags(balanceDS, { today: TODAY, health: null, profile: balanceProfile }).map((f) => f.code);
  const health = ['low-hrv', 'elevated-rhr', 'short-sleep', 'weight-drop'];
  assert.ok(health.every((c) => !none.includes(c)));
  const blanks = healthCodes({
    sleepH: null,
    hrvMs: null,
    hrvBaselineMs: null,
    restingHr: null,
    restingHrBaseline: null,
    weightKg: null,
    weightTrend30dPct: null,
  });
  assert.ok(health.every((c) => !blanks.includes(c)));
});

// ---------------------------------------------------------------------------
// 11. Empty history — plan digests are topped up from the library
// ---------------------------------------------------------------------------

const LIB_NAMES = [
  ['Bench Press', 'chest', 'barbell'], ['Incline Press', 'chest', 'dumbbell'], ['Cable Fly', 'chest', 'cable'],
  ['Barbell Row', 'back', 'barbell'], ['Lat Pulldown', 'back', 'cable'], ['Seated Row', 'back', 'machine'],
  ['Back Squat', 'legs', 'barbell'], ['Leg Press', 'legs', 'machine'], ['Leg Curl', 'legs', 'machine'],
  ['Calf Raise', 'legs', 'machine'], ['Overhead Press', 'shoulders', 'barbell'], ['Lateral Raise', 'shoulders', 'dumbbell'],
  ['Rear Fly', 'shoulders', 'cable'], ['Barbell Curl', 'biceps', 'barbell'], ['Hammer Curl', 'biceps', 'dumbbell'],
  ['Preacher Curl', 'biceps', 'machine'], ['Cable Curl', 'biceps', 'cable'], ['Skullcrusher', 'triceps', 'barbell'],
  ['Rope Pushdown', 'triceps', 'cable'], ['Dip', 'triceps', 'bodyweight'], ['Overhead Ext', 'triceps', 'dumbbell'],
  ['Cable Crunch', 'abs', 'cable'], ['Hanging Raise', 'abs', 'bodyweight'], ['Plank Pull', 'abs', 'other'],
  ['Face Pull', 'accessory', 'cable'], ['Shrug', 'accessory', 'dumbbell'], ['Band Pull', 'rehab', 'other'],
  ['Cuff Raise', 'rehab', 'other'], ['Wrist Curl', 'accessory', 'dumbbell'], ['Farmer Hold', 'accessory', 'dumbbell'],
];
const library = LIB_NAMES.map(([name, group, equip], i) =>
  ex(`ex-${String(i + 1).padStart(2, '0')}`, name, group, equip, equip === 'bodyweight' ? 'reps' : 'weight_reps')
);
const emptyDS = { workouts: [], sets: [], exercises: library };
const emptyProfile = {
  version: 1,
  updatedAt: '2026-09-01T00:00:00Z',
  injuryNotes: null,
  goal: 'return-from-injury',
  daysPerWeek: 3,
  sessionMinutes: 45,
  equipmentNotes: null,
  returnDate: null,
  avoidExerciseIds: [],
};

check('buildDigest: an empty history plan digest is topped up to 20 first-time exercises', () => {
  const d = buildDigest({ dataset: emptyDS, profile: emptyProfile, today: TODAY, kind: 'plan' });
  assert.equal(d.exercises.length, 20);
  assert.ok(d.exercises.every((e) => e.proposal.rule === 'first-time'));
  assert.ok(d.exercises.every((e) => typeof e.id === 'string' && typeof e.name === 'string'));
  // sorted by muscle group (canonical order) then name
  assert.equal(d.exercises[0].group, 'chest');
  assert.ok(JSON.stringify(d).length < 4000, `digest was ${JSON.stringify(d).length} bytes`);
});

check('buildDigest: an empty history daily digest lists nothing (no top-up outside plan kind)', () => {
  const d = buildDigest({ dataset: emptyDS, profile: emptyProfile, today: TODAY, kind: 'daily' });
  assert.deepEqual(d.exercises, []);
});

check('buildDigest: the top-up respects avoidExerciseIds and skips non-rep types', () => {
  const withCardio = { workouts: [], sets: [], exercises: [...library, ex('ex-run', 'Treadmill', 'cardio', 'other', 'cardio')] };
  const d = buildDigest({
    dataset: withCardio,
    profile: { ...emptyProfile, avoidExerciseIds: ['ex-01'] },
    today: TODAY,
    kind: 'plan',
  });
  assert.equal(d.exercises.find((e) => e.id === 'ex-01'), undefined);
  assert.equal(d.exercises.find((e) => e.id === 'ex-run'), undefined);
});

// ---------------------------------------------------------------------------
// 7. Size bound on a realistic two-year history
// ---------------------------------------------------------------------------

const bigExercises = LIB_NAMES.slice(0, 25).map(([name, group, equip], i) =>
  ex(`bx-${String(i + 1).padStart(2, '0')}`, name, group, equip, equip === 'bodyweight' ? 'reps' : 'weight_reps')
);
const bigWorkouts = [];
const bigSets = [];
const BIG_START = addDays(TODAY, -720);
for (let i = 0; i < 300; i++) {
  const date = addDays(BIG_START, Math.floor(i * 2.4));
  const id = `bw-${String(i).padStart(3, '0')}`;
  bigWorkouts.push(wo(id, date, { name: `Session ${i}` }));
  for (let k = 0; k < 4; k++) {
    const exercise = bigExercises[(i * 4 + k) % 25];
    const base = 40 + ((i * 4 + k) % 25) * 2.5 + Math.floor(i / 20) * 2.5;
    bigSets.push(st(id, exercise.id, 1, base * 0.5, 10, { isWarmup: true }));
    bigSets.push(...straight(id, exercise.id, 3, base, 8 + (i % 3), { rpe: 7 + (i % 3) * 0.5 }).map((s, j) => ({ ...s, setNumber: j + 2 })));
  }
}
const bigDS = { workouts: bigWorkouts, sets: bigSets, exercises: bigExercises };
const bigPlan = {
  ...plan,
  sessions: plan.sessions.map((s) => ({
    ...s,
    exercises: bigExercises.slice(0, 5).map((e, i) => ({
      exerciseId: e.id,
      targetSets: 3,
      targetRepsLow: 6,
      targetRepsHigh: 10,
      targetWeightKg: 60 + i * 2.5,
      targetRpe: 8,
      note: 'a note that should never reach the model because it is stripped',
    })),
  })),
};

const bigSizes = {};
check('buildDigest: a 300-workout, 25-exercise, two-year history stays under 4 kB for every kind', () => {
  assert.equal(bigWorkouts.length, 300);
  assert.equal(bigExercises.length, 25);
  for (const kind of ['daily', 'session', 'plan']) {
    const d = buildDigest({
      dataset: bigDS,
      profile: balanceProfile,
      today: TODAY,
      health: HEALTH,
      workoutId: kind === 'session' ? bigWorkouts[bigWorkouts.length - 1].id : null,
      plan: bigPlan,
      kind,
    });
    const size = JSON.stringify(d).length;
    bigSizes[kind] = size;
    assert.ok(size < 4000, `${kind} digest was ${size} bytes`);
    assert.ok(d.exercises.length >= 4, `${kind} digest kept too few exercises`);
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d, 'digest must be JSON round-trippable');
  }
});

check('buildDigest: the big fixture is deterministic across kinds', () => {
  for (const kind of ['daily', 'session', 'plan']) {
    const args = {
      dataset: bigDS,
      profile: balanceProfile,
      today: TODAY,
      health: HEALTH,
      workoutId: kind === 'session' ? bigWorkouts[bigWorkouts.length - 1].id : null,
      plan: bigPlan,
      kind,
    };
    assert.equal(JSON.stringify(buildDigest(args)), JSON.stringify(buildDigest(args)));
  }
});

console.log(`digest sizes (300-workout fixture): ${JSON.stringify(bigSizes)}`);
console.log(`\nAll ${passed} assertions passed.`);
process.exit(0);
