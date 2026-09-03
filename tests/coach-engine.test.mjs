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
  isDurationType,
  currentPlanWeek,
  projectPlanWeek,
  projectedSessions,
  recentPRs,
} from '../js/coach-engine.js';
import { MUSCLE_GROUPS } from '../js/db.js';

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
  assert.ok(JSON.stringify(d).length < 9000, `digest was ${JSON.stringify(d).length} bytes`);
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

// Per-kind digest byte budget (PLAN.md §"Phase C2" C2.2/C2.3 amendment 2):
// daily/session 4500, plan/chat 9000 — the plan/chat budget grew again to fit
// `historyByGroup` (every kind) and the full `library` (plan/chat).
const DIGEST_BUDGET = { daily: 4500, session: 4500, plan: 9000, chat: 9000 };

const bigSizes = {};
check('buildDigest: a 300-workout, 25-exercise, two-year history stays inside its per-kind budget', () => {
  assert.equal(bigWorkouts.length, 300);
  assert.equal(bigExercises.length, 25);
  for (const kind of ['daily', 'session', 'plan', 'chat']) {
    const d = buildDigest({
      dataset: bigDS,
      profile: balanceProfile,
      today: TODAY,
      health: HEALTH,
      workoutId: kind === 'session' ? bigWorkouts[bigWorkouts.length - 1].id : null,
      plan: bigPlan,
      kind,
      chat: kind === 'chat' ? { thread: 'home', recent: [{ role: 'user', text: 'How is my training going?' }], message: 'Can we add more leg volume?' } : null,
    });
    const size = JSON.stringify(d).length;
    bigSizes[kind] = size;
    assert.ok(size < DIGEST_BUDGET[kind], `${kind} digest was ${size} bytes`);
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

// ---------------------------------------------------------------------------
// 12. Coach v2 — isDurationType
// ---------------------------------------------------------------------------

check('isDurationType: cardio, time and weight_time are duration types; reps/weight_reps are not', () => {
  assert.equal(isDurationType('cardio'), true);
  assert.equal(isDurationType('time'), true);
  assert.equal(isDurationType('weight_time'), true);
  assert.equal(isDurationType('weight_reps'), false);
  assert.equal(isDurationType('reps'), false);
  assert.equal(isDurationType('bw_weight_reps'), false);
  assert.equal(isDurationType('strength'), false); // legacy value normalises to weight_reps
  assert.equal(isDurationType(null), false);
});

// ---------------------------------------------------------------------------
// 13. Coach v2 — currentPlanWeek / projectPlanWeek / projectedSessions
// ---------------------------------------------------------------------------

/** One session, one exercise, everything else a sensible v2 default — override just what a test needs. */
function planWithExercise(peOverrides = {}, planOverrides = {}) {
  return {
    id: 'p-proj',
    version: 1,
    createdAt: '2026-08-01T00:00:00Z',
    source: 'created',
    basedOnWorkoutId: null,
    planVersion: 2,
    lineageStart: '2026-08-01',
    baseWeek: 1,
    weeks: 8,
    overview: { points: [], muscleFocus: [], progression: [], deloadWeek: null },
    weekNotes: [],
    sessions: [
      {
        id: 'ps-1',
        order: 1,
        name: 'S',
        focus: null,
        brief: [],
        exercises: [
          {
            exerciseId: 'ex-1',
            targetSets: 3,
            targetRepsLow: 6,
            targetRepsHigh: 10,
            targetWeightKg: 60,
            targetDurationSec: null,
            targetRpe: 8,
            purpose: 'p',
            goal: 'g',
            note: null,
            progression: null,
            ...peOverrides,
          },
        ],
      },
    ],
    ...planOverrides,
  };
}

check('currentPlanWeek: day 0 is week 1, day 20 is week 3, clamps at plan.weeks', () => {
  assert.equal(currentPlanWeek({ lineageStart: TODAY, weeks: 8 }, TODAY), 1);
  assert.equal(currentPlanWeek({ lineageStart: addDays(TODAY, -20), weeks: 8 }, TODAY), 3);
  assert.equal(currentPlanWeek({ lineageStart: addDays(TODAY, -70), weeks: 8 }, TODAY), 8);
});

check('currentPlanWeek: missing lineageStart falls back to createdAt', () => {
  const p = { createdAt: `${addDays(TODAY, -20)}T00:00:00Z`, weeks: 8 };
  assert.equal(currentPlanWeek(p, TODAY), 3);
});

check('currentPlanWeek: a null plan or a plan with no weeks behaves as a single week', () => {
  assert.equal(currentPlanWeek(null, TODAY), 1);
  assert.equal(currentPlanWeek({ lineageStart: addDays(TODAY, -20) }, TODAY), 1);
});

check('projectPlanWeek: weight steps 2.5 kg/week from baseWeek (week 4 → 67.5)', () => {
  const plan = planWithExercise({ progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 } });
  const pe = projectPlanWeek(plan, 4).sessions[0].exercises[0];
  assert.equal(pe.targetWeightKg, 67.5); // 3 steps × 2.5
});

check('projectPlanWeek: everyWeeks throttles the cadence (everyWeeks 2, week 4 → 62.5)', () => {
  const plan = planWithExercise({ progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 2 } });
  const pe = projectPlanWeek(plan, 4).sessions[0].exercises[0];
  assert.equal(pe.targetWeightKg, 62.5); // steps = floor(3/2) = 1
});

check('projectPlanWeek: reps step up together and cap at 30', () => {
  const plan = planWithExercise({ progression: { weightStepKg: null, repStep: 1, durationStepSec: null, everyWeeks: 1 } });
  const pe = projectPlanWeek(plan, 3).sessions[0].exercises[0];
  assert.equal(pe.targetRepsLow, 8); // steps = 2
  assert.equal(pe.targetRepsHigh, 12);

  const nearCap = planWithExercise({
    targetRepsLow: 28,
    targetRepsHigh: 29,
    progression: { weightStepKg: null, repStep: 3, durationStepSec: null, everyWeeks: 1 },
  });
  const capped = projectPlanWeek(nearCap, 8).sessions[0].exercises[0]; // steps = 7 → +21 uncapped
  assert.equal(capped.targetRepsLow, 30);
  assert.equal(capped.targetRepsHigh, 30);
});

check('projectPlanWeek: duration steps forward', () => {
  const plan = planWithExercise({
    targetRepsLow: null,
    targetRepsHigh: null,
    targetWeightKg: null,
    targetDurationSec: 30,
    progression: { weightStepKg: null, repStep: null, durationStepSec: 10, everyWeeks: 1 },
  });
  const pe = projectPlanWeek(plan, 3).sessions[0].exercises[0];
  assert.equal(pe.targetDurationSec, 50); // 30 + 2 × 10
});

check('projectPlanWeek: a base of 0 or null is never stepped', () => {
  const zero = planWithExercise({ targetWeightKg: 0, progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 } });
  assert.equal(projectPlanWeek(zero, 5).sessions[0].exercises[0].targetWeightKg, 0);
  const nul = planWithExercise({ targetWeightKg: null, progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 } });
  assert.equal(projectPlanWeek(nul, 5).sessions[0].exercises[0].targetWeightKg, null);
});

check('projectPlanWeek: deload week cuts weight 10% (floored to 2.5) and one set; reps untouched; isDeload true', () => {
  const plan = planWithExercise(
    { progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 } },
    { overview: { points: [], muscleFocus: [], progression: [], deloadWeek: 4 } }
  );
  const proj = projectPlanWeek(plan, 4);
  const pe = proj.sessions[0].exercises[0];
  assert.equal(proj.isDeload, true);
  assert.equal(pe.targetWeightKg, 60); // 60+3×2.5=67.5 → ×0.9=60.75 → floor to 2.5 → 60.0
  assert.equal(pe.targetSets, 2); // 3 − 1
  assert.equal(pe.targetRepsLow, 6);
  assert.equal(pe.targetRepsHigh, 10);
});

check('projectPlanWeek: deload never drops sets below one', () => {
  const plan = planWithExercise(
    { targetSets: 1, progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 } },
    { overview: { points: [], muscleFocus: [], progression: [], deloadWeek: 4 } }
  );
  assert.equal(projectPlanWeek(plan, 4).sessions[0].exercises[0].targetSets, 1);
});

check('projectPlanWeek: a week before baseWeek reports the stored targets and isPast', () => {
  const plan = planWithExercise(
    { progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 } },
    { baseWeek: 4 }
  );
  const proj = projectPlanWeek(plan, 2);
  assert.equal(proj.isPast, true);
  assert.equal(proj.isDeload, false);
  assert.equal(proj.sessions[0].exercises[0].targetWeightKg, 60);
});

check('projectPlanWeek: no progression on the exercise stays flat for every week 1..8', () => {
  const plan = planWithExercise({ progression: null });
  for (let w = 1; w <= 8; w++) {
    const pe = projectPlanWeek(plan, w).sessions[0].exercises[0];
    assert.equal(pe.targetWeightKg, 60);
    assert.equal(pe.targetRepsLow, 6);
    assert.equal(pe.targetRepsHigh, 10);
  }
});

check('projectPlanWeek: a v1 plan (no baseWeek/overview/progression at all) is flat too', () => {
  // reuses the v1 `plan` fixture from the Plans section above
  const week1 = projectPlanWeek(plan, 1).sessions[0].exercises[0];
  const week6 = projectPlanWeek(plan, 6).sessions[0].exercises[0];
  assert.deepEqual(week1, week6);
  assert.equal(week1.targetWeightKg, 72.5);
});

check('projectPlanWeek: keeps id/order/name/focus/brief and every other exercise field untouched', () => {
  const prog = { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 };
  const planFixture = planWithExercise({ progression: prog });
  const proj = projectPlanWeek(planFixture, 2);
  const s = proj.sessions[0];
  assert.equal(s.id, 'ps-1');
  assert.equal(s.order, 1);
  assert.equal(s.name, 'S');
  assert.equal(s.focus, null);
  assert.deepEqual(s.brief, []);
  const pe = s.exercises[0];
  assert.equal(pe.exerciseId, 'ex-1');
  assert.equal(pe.targetRpe, 8);
  assert.equal(pe.purpose, 'p');
  assert.equal(pe.goal, 'g');
  assert.equal(pe.note, null);
  assert.deepEqual(pe.progression, prog);
});

check('projectPlanWeek: never mutates the input plan', () => {
  const planFixture = planWithExercise({ progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 } });
  const before = JSON.stringify(planFixture);
  projectPlanWeek(planFixture, 5);
  assert.equal(JSON.stringify(planFixture), before);
});

check('projectedSessions: picks the current week', () => {
  const planFixture = planWithExercise(
    { progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 } },
    { lineageStart: addDays(TODAY, -14) } // → week 3
  );
  assert.equal(currentPlanWeek(planFixture, TODAY), 3);
  const sessions = projectedSessions(planFixture, TODAY);
  assert.equal(sessions[0].exercises[0].targetWeightKg, 65); // 60 + 2 × 2.5
});

check('projectedSessions: a null plan is an empty array', () => {
  assert.deepEqual(projectedSessions(null, TODAY), []);
});

// ---------------------------------------------------------------------------
// 14. Coach v2 — planRefSets: duration branch and targetSets: 0
// ---------------------------------------------------------------------------

check('planRefSets: a duration exercise autofills time only, weight/reps stay 0', () => {
  const pe = { targetSets: 2, targetRepsLow: null, targetRepsHigh: null, targetWeightKg: null, targetDurationSec: 45 };
  const refs = planRefSets(pe);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], { weightKg: 0, reps: 0, durationSeconds: 45, distanceM: null, kcal: null });
  assert.deepEqual(refs[0], refs[1]);
});

check('planRefSets: targetSets 0 still shows one ghost set (never an empty array for a real exercise)', () => {
  const pe = { targetSets: 0, targetRepsHigh: 10, targetWeightKg: 50 };
  const refs = planRefSets(pe);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].weightKg, 50);
  assert.equal(refs[0].reps, 10);
});

// ---------------------------------------------------------------------------
// 15. Coach v2 — recentPRs
// ---------------------------------------------------------------------------

check('recentPRs: a PR 3 days ago is found, one 20 days ago is not', () => {
  const ds = {
    workouts: [wo('prA', addDays(TODAY, -20)), wo('prB', addDays(TODAY, -3))],
    sets: [...straight('prA', 'ex-bench', 3, 100, 5, { rpe: 8 }), ...straight('prB', 'ex-squat', 3, 120, 5, { rpe: 8 })],
    exercises: [ex('ex-bench', 'Bench Press', 'chest', 'barbell'), ex('ex-squat', 'Squat', 'legs', 'barbell')],
  };
  const prs = recentPRs(ds, { today: TODAY, days: 7 });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].exerciseId, 'ex-squat');
  assert.equal(prs[0].name, 'Squat');
  assert.equal(prs[0].kind, 'e1rm');
  assert.equal(prs[0].date, addDays(TODAY, -3));
  assert.equal(prs[0].value, Math.round(120 * (1 + 5 / 30) * 10) / 10);
});

check('recentPRs: sorted by date desc, then name', () => {
  const ds = {
    workouts: [wo('a', addDays(TODAY, -1)), wo('b', addDays(TODAY, -2))],
    sets: [...straight('a', 'ex-bench', 3, 100, 5, { rpe: 8 }), ...straight('b', 'ex-squat', 3, 100, 5, { rpe: 8 })],
    exercises: [ex('ex-bench', 'Bench Press', 'chest', 'barbell'), ex('ex-squat', 'Squat', 'legs', 'barbell')],
  };
  const prs = recentPRs(ds, { today: TODAY, days: 7 });
  assert.deepEqual(prs.map((p) => p.exerciseId), ['ex-bench', 'ex-squat']); // -1 day sorts before -2 day
});

check('recentPRs: only rep-type exercises are scored; the default window is 7 days', () => {
  const ds = {
    workouts: [wo('c', addDays(TODAY, -1))],
    sets: [st('c', 'ex-run', 1, 0, 0, { setType: 'cardio' })],
    exercises: [ex('ex-run', 'Treadmill', 'cardio', 'other', 'cardio')],
  };
  assert.deepEqual(recentPRs(ds, { today: TODAY }), []);
});

// ---------------------------------------------------------------------------
// 16. Coach v2 — buildDigest: profile v2, group top-up, duration types, chat, memory
// ---------------------------------------------------------------------------

const v2EmptyProfile = { ...emptyProfile, version: 2, groupPrefs: {}, cardio: { include: false, minutesPerSession: 10 }, core: { include: false }, favouriteExerciseIds: [], notes: null };

// Eight distinct TRAINED exercises today, none of them 'legs' — enough that the
// old PLAN_MIN_EXERCISES top-up (rep-type, group-blind) never fires, so any legs
// entries below can only come from the NEW group top-up.
const groupDS = {
  workouts: [wo('gd1', TODAY)],
  sets: [
    ...straight('gd1', 'ex-01', 3, 60, 8, { rpe: 7 }), // chest
    ...straight('gd1', 'ex-02', 3, 50, 8, { rpe: 7 }), // chest
    ...straight('gd1', 'ex-04', 3, 60, 8, { rpe: 7 }), // back
    ...straight('gd1', 'ex-11', 3, 40, 8, { rpe: 7 }), // shoulders
    ...straight('gd1', 'ex-14', 3, 20, 8, { rpe: 7 }), // biceps
    ...straight('gd1', 'ex-18', 3, 20, 8, { rpe: 7 }), // triceps
    ...straight('gd1', 'ex-22', 3, 20, 8, { rpe: 7 }), // abs
    ...straight('gd1', 'ex-25', 3, 20, 8, { rpe: 7 }), // accessory
  ],
  exercises: library,
};

check('buildDigest plan: groupPrefs emphasise tops up an untrained group (≤ 4 entries)', () => {
  const profile = { ...v2EmptyProfile, groupPrefs: { legs: 'emphasise' } };
  const d = buildDigest({ dataset: groupDS, profile, today: TODAY, kind: 'plan' });
  const legs = d.exercises.filter((e) => e.group === 'legs');
  assert.ok(legs.length > 0 && legs.length <= 4, `expected 1-4 legs entries, got ${legs.length}`);
  assert.ok(legs.every((e) => e.proposal.rule === 'first-time'));
});

check('buildDigest plan: groupPrefs avoid removes a trained group entirely', () => {
  const profile = { ...v2EmptyProfile, groupPrefs: { chest: 'avoid' } };
  const d = buildDigest({ dataset: groupDS, profile, today: TODAY, kind: 'plan' });
  assert.equal(d.exercises.find((e) => e.group === 'chest'), undefined);
});

check('buildDigest plan: cardio.include adds cardio proposals sized from minutesPerSession; absent when off', () => {
  const cardioLib = [...library, ex('ex-run', 'Treadmill Run', 'cardio', 'other', 'cardio')];
  const ds = { workouts: groupDS.workouts, sets: groupDS.sets, exercises: cardioLib };
  const on = { ...v2EmptyProfile, cardio: { include: true, minutesPerSession: 15, standaloneDay: false, exerciseIds: [] } };
  const dOn = buildDigest({ dataset: ds, profile: on, today: TODAY, kind: 'plan' });
  const cardioEntries = dOn.exercises.filter((e) => e.group === 'cardio');
  assert.ok(cardioEntries.length > 0);
  assert.ok(cardioEntries.every((e) => e.proposal.durationSec === 15 * 60 && e.proposal.rule === 'duration' && e.proposal.sets === 1));

  const off = { ...v2EmptyProfile, cardio: { include: false, minutesPerSession: 15 } };
  const dOff = buildDigest({ dataset: ds, profile: off, today: TODAY, kind: 'plan' });
  assert.equal(dOff.exercises.find((e) => e.group === 'cardio'), undefined);
});

check('buildDigest plan: core.include adds abs entries including a duration-type plank', () => {
  const abLib = [...library, ex('ex-plank', 'Front Plank', 'abs', 'other', 'time')];
  const ds = { workouts: groupDS.workouts, sets: groupDS.sets, exercises: abLib };
  const profile = { ...v2EmptyProfile, core: { include: true } };
  const d = buildDigest({ dataset: ds, profile, today: TODAY, kind: 'plan' });
  const plank = d.exercises.find((e) => e.id === 'ex-plank');
  assert.ok(plank, 'expected the plank to appear via the core top-up');
  assert.equal(plank.type, 'time');
  assert.equal(plank.proposal.rule, 'duration');
  assert.equal(plank.proposal.sets, 3);
});

check('buildDigest plan: favouriteExerciseIds are always present', () => {
  const profile = { ...v2EmptyProfile, favouriteExerciseIds: ['ex-09'] }; // Leg Curl — untrained, no groupPref
  const d = buildDigest({ dataset: groupDS, profile, today: TODAY, kind: 'plan' });
  assert.ok(d.exercises.some((e) => e.id === 'ex-09'));
});

check("buildDigest: daily kind never lists duration-type exercises, even when trained", () => {
  const durDS = {
    workouts: [wo('du1', TODAY)],
    sets: [{ ...st('du1', 'ex-run', 1, 0, 0, { setType: 'cardio' }), durationSeconds: 600 }],
    exercises: [ex('ex-run', 'Treadmill', 'cardio', 'other', 'cardio')],
  };
  const d = buildDigest({ dataset: durDS, profile: null, today: TODAY, kind: 'daily' });
  assert.deepEqual(d.exercises, []);
});

check('buildDigest plan: a 30-exercise library with a full v2 profile stays under its 9 kB budget', () => {
  const cardioLib = [...library, ex('ex-run', 'Treadmill Run', 'cardio', 'other', 'cardio')];
  const profile = {
    ...v2EmptyProfile,
    split: 'ppl',
    groupPrefs: { legs: 'emphasise', shoulders: 'include' },
    cardio: { include: true, minutesPerSession: 20, standaloneDay: true, exerciseIds: [] },
    core: { include: true },
    favouriteExerciseIds: ['ex-01', 'ex-14'],
    notes: 'Prefers machines over free weights where possible.',
  };
  const d = buildDigest({ dataset: { workouts: [], sets: [], exercises: cardioLib }, profile, today: TODAY, kind: 'plan' });
  assert.ok(d.exercises.length <= 30);
  const size = JSON.stringify(d).length;
  assert.ok(size < 9000, `plan digest was ${size} bytes`);
});

check('buildDigest: memory is always present ([] when none) on every kind', () => {
  const daily = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, kind: 'daily' });
  const session = buildDigest({ dataset: diffDS, profile: balanceProfile, today: TODAY, workoutId: 'dB', kind: 'session' });
  const planKind = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, kind: 'plan' });
  assert.deepEqual(daily.memory, []);
  assert.deepEqual(session.memory, []);
  assert.deepEqual(planKind.memory, []);
});

check('buildDigest: a supplied memory list is carried through as {id, text}', () => {
  const mem = [{ id: 'm-1', text: 'Left shoulder — avoid overhead pressing past 80 kg.' }];
  const d = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, kind: 'daily', memory: mem });
  assert.deepEqual(d.memory, mem);
});

check('buildDigest: kind chat carries recent turns (capped at 6) and a truncated message', () => {
  const recent = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'coach' : 'user', text: `turn ${i}` }));
  const d = buildDigest({
    dataset: balanceDS,
    profile: balanceProfile,
    today: TODAY,
    kind: 'chat',
    chat: { thread: 'home', recent, message: 'x'.repeat(2000) },
  });
  assert.equal(d.chat.thread, 'home');
  assert.equal(d.chat.recent.length, 6);
  assert.deepEqual(d.chat.recent.map((r) => r.text), recent.slice(-6).map((r) => r.text));
  assert.equal(d.chat.message.length, 1200);
});

check('buildDigest: chat is absent on every kind but chat', () => {
  const d = buildDigest({ dataset: balanceDS, profile: balanceProfile, today: TODAY, kind: 'daily' });
  assert.equal('chat' in d, false);
});

check('buildDigest: the shrink loop trims chat.recent then memory under real size pressure', () => {
  // 20 memory items at their storage-side cap (160 chars), turns and a
  // message at their own caps — deliberately oversized relative to what a
  // 9-kB budget can hold once the 300-workout dataset, `historyByGroup`,
  // `library` and a big plan are also in play.
  const bigMemory = Array.from({ length: 20 }, (_, i) => ({ id: `m-${i}`, text: 'x'.repeat(160) }));
  const recent = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'coach' : 'user', text: 'x'.repeat(400) }));
  const d = buildDigest({
    dataset: bigDS,
    profile: balanceProfile,
    today: TODAY,
    health: HEALTH,
    plan: bigPlan,
    kind: 'chat',
    memory: bigMemory,
    chat: { thread: 'plan', recent, message: 'x'.repeat(2000) },
  });
  const size = JSON.stringify(d).length;
  assert.ok(size < 9000, `chat digest was ${size} bytes`);
  assert.ok(d.memory.length <= 10 || d.chat.recent.length <= 3, 'expected the shrink loop to have trimmed memory or chat.recent');
});

// ---------------------------------------------------------------------------
// 17. Coach v2/C2.3 amendment 2 — historyByGroup, library, chat window, shrink levers
// ---------------------------------------------------------------------------

check('buildDigest: historyByGroup covers a group trained six months ago, on every kind', () => {
  const legsDate = addDays(TODAY, -183);
  const ds = {
    workouts: [wo('hg1', legsDate)],
    sets: [...straight('hg1', 'ex-07', 3, 100, 6, { rpe: 8 })], // Back Squat, legs
    exercises: library,
  };
  for (const kind of ['daily', 'session', 'plan', 'chat']) {
    const d = buildDigest({ dataset: ds, profile: emptyProfile, today: TODAY, kind, workoutId: kind === 'session' ? 'hg1' : null });
    assert.ok(d.historyByGroup.legs, `${kind} digest missing historyByGroup.legs`);
    assert.equal(d.historyByGroup.legs.sessions, 1);
    assert.equal(d.historyByGroup.legs.last, legsDate);
    assert.deepEqual(d.historyByGroup.legs.top, ['ex-07']);
    // A group with no history at all is simply absent.
    assert.equal('chest' in d.historyByGroup, false);
  }
});

check('buildDigest: historyByGroup.top ranks by session count then recency then id, capped at 3', () => {
  const d1 = addDays(TODAY, -30);
  const d2 = addDays(TODAY, -20);
  const d3 = addDays(TODAY, -10);
  const ds = {
    workouts: [wo('hg2a', d1), wo('hg2b', d2), wo('hg2c', d3)],
    sets: [
      ...straight('hg2a', 'ex-01', 3, 60, 8, { rpe: 7 }), // Bench Press — 3 sessions
      ...straight('hg2b', 'ex-01', 3, 60, 8, { rpe: 7 }),
      ...straight('hg2c', 'ex-01', 3, 60, 8, { rpe: 7 }),
      ...straight('hg2a', 'ex-02', 3, 20, 10, { rpe: 7 }), // Incline Press — 1 session
      ...straight('hg2b', 'ex-03', 3, 15, 12, { rpe: 7 }), // Cable Fly — 1 session
    ],
    exercises: library,
  };
  const d = buildDigest({ dataset: ds, profile: emptyProfile, today: TODAY, kind: 'daily' });
  assert.equal(d.historyByGroup.chest.sessions, 3);
  assert.equal(d.historyByGroup.chest.last, d3);
  assert.deepEqual(d.historyByGroup.chest.top, ['ex-01', 'ex-03', 'ex-02'], 'ex-01 by count, then ex-03/ex-02 by recency');
});

check('buildDigest: library is present only on plan/chat, grouped by muscle group, sorted, with the type suffix only when non-default', () => {
  const withExtras = [
    ...library,
    ex('ex-run', 'Treadmill Run', 'cardio', 'other', 'cardio'),
    ex('ex-plank', 'Front Plank', 'abs', 'other', 'time'),
    ex('ex-notes', 'Stretching', 'other', 'other', 'notes'),
  ];
  const ds = { workouts: [], sets: [], exercises: withExtras };
  const daily = buildDigest({ dataset: ds, profile: emptyProfile, today: TODAY, kind: 'daily' });
  const session = buildDigest({ dataset: { ...ds, workouts: [wo('lb1', TODAY)] }, profile: emptyProfile, today: TODAY, workoutId: 'lb1', kind: 'session' });
  assert.equal('library' in daily, false);
  assert.equal('library' in session, false);

  const plan = buildDigest({ dataset: ds, profile: emptyProfile, today: TODAY, kind: 'plan' });
  const chat = buildDigest({ dataset: ds, profile: emptyProfile, today: TODAY, kind: 'chat' });
  for (const d of [plan, chat]) {
    assert.ok(Array.isArray(d.library.chest), 'expected a chest group');
    assert.ok(d.library.chest.includes('ex-01|Bench Press'), 'default weight_reps carries no |type suffix');
    assert.ok(d.library.cardio.includes('ex-run|Treadmill Run|cardio'));
    assert.ok(d.library.abs.includes('ex-plank|Front Plank|time'));
    const flat = JSON.stringify(d.library);
    assert.equal(flat.includes('ex-notes'), false, 'notes-type exercises are excluded from the library');
    // grouped in MUSCLE_GROUPS order
    assert.deepEqual(Object.keys(d.library), MUSCLE_GROUPS.filter((g) => g in d.library));
    // sorted by name within a group
    const chestNames = d.library.chest.map((s) => s.split('|')[1]);
    assert.deepEqual(chestNames, chestNames.slice().sort());
  }
});

check("buildDigest: kind chat ranks over 52 weeks — an exercise last trained 20 weeks ago appears in chat but not daily", () => {
  const oldDate = addDays(TODAY, -140); // 20 weeks
  const ds = {
    workouts: [wo('cw1', TODAY), wo('cw2', oldDate)],
    sets: [
      ...straight('cw1', 'ex-01', 3, 60, 8, { rpe: 7 }), // Bench Press, trained today
      ...straight('cw2', 'ex-07', 3, 100, 6, { rpe: 8 }), // Back Squat, trained 20 weeks ago
    ],
    exercises: library,
  };
  const daily = buildDigest({ dataset: ds, profile: emptyProfile, today: TODAY, kind: 'daily' });
  const chat = buildDigest({ dataset: ds, profile: emptyProfile, today: TODAY, kind: 'chat' });
  assert.equal(daily.exercises.some((e) => e.id === 'ex-07'), false, 'outside the 8-week daily window');
  assert.ok(chat.exercises.some((e) => e.id === 'ex-07'), 'inside the 52-week chat window');
});

check('buildDigest: plan and chat digests stay under 9 kB with a 61-exercise library and a 300-workout history; daily/session stay under 4.5 kB', () => {
  const extraExercises = Array.from({ length: 36 }, (_, i) =>
    ex(`bx-extra-${String(i + 1).padStart(2, '0')}`, `Extra Exercise ${i + 1}`, MUSCLE_GROUPS[i % MUSCLE_GROUPS.length], 'other', 'weight_reps')
  );
  const wideExercises = [...bigExercises, ...extraExercises];
  assert.equal(wideExercises.length, 61);
  const ds = { workouts: bigWorkouts, sets: bigSets, exercises: wideExercises };
  const sizes = {};
  for (const kind of ['daily', 'session', 'plan', 'chat']) {
    const d = buildDigest({
      dataset: ds,
      profile: balanceProfile,
      today: TODAY,
      health: HEALTH,
      workoutId: kind === 'session' ? bigWorkouts[bigWorkouts.length - 1].id : null,
      plan: bigPlan,
      kind,
      chat: kind === 'chat' ? { thread: 'home', recent: [], message: 'What should I train today?' } : null,
    });
    sizes[kind] = JSON.stringify(d).length;
  }
  assert.ok(sizes.daily < 4500, `daily digest was ${sizes.daily} bytes`);
  assert.ok(sizes.session < 4500, `session digest was ${sizes.session} bytes`);
  assert.ok(sizes.plan < 9000, `plan digest was ${sizes.plan} bytes`);
  assert.ok(sizes.chat < 9000, `chat digest was ${sizes.chat} bytes`);
  console.log(`61-exercise/300-workout digest sizes: ${JSON.stringify(sizes)}`);
});

check('buildDigest: forced size pressure drops historyByGroup.top before it touches library', () => {
  // A big, deliberately padded memory list is enough pressure on its own once
  // the 300-workout fixture and a big plan are also in play — the same
  // pressure source the chat shrink-loop test above uses.
  const bigMemory = Array.from({ length: 20 }, (_, i) => ({ id: `m-${i}`, text: 'x'.repeat(160) }));
  const profile = { ...balanceProfile, groupPrefs: {} }; // no group is "of interest" — every library group is droppable
  const d = buildDigest({
    dataset: bigDS,
    profile,
    today: TODAY,
    health: HEALTH,
    plan: bigPlan,
    kind: 'plan',
    memory: bigMemory,
  });
  const size = JSON.stringify(d).length;
  assert.ok(size < 9000, `plan digest was ${size} bytes`);
  const anyTopDropped = Object.values(d.historyByGroup).some((h) => !('top' in h));
  const anyLibraryGroupDropped = Object.keys(d.library).length < new Set(library.map((e) => e.muscleGroup)).size;
  assert.ok(anyTopDropped || anyLibraryGroupDropped, 'expected some shrink lever beyond exercises/memory to have fired');
  // 'plan' never loses its library entirely, even under this much pressure.
  assert.ok(Object.keys(d.library).length >= 1, 'a plan digest must keep at least one library group');
});

check("buildDigest: the plan echo on daily/session/chat is the CURRENT WEEK's projection, not the stored plan", () => {
  const planFixture = planWithExercise(
    { exerciseId: 'ex-bench', targetWeightKg: 60, progression: { weightStepKg: 2.5, repStep: null, durationStepSec: null, everyWeeks: 1 } },
    { lineageStart: addDays(TODAY, -14), baseWeek: 1, weeks: 8 } // → week 3
  );
  const d = buildDigest({ dataset: diffDS, profile: balanceProfile, today: TODAY, workoutId: 'dB', plan: planFixture, kind: 'session' });
  assert.equal(d.plan.currentWeek, 3);
  assert.equal(d.plan.baseWeek, 1);
  assert.equal(d.plan.weeks, 8);
  const pe = d.plan.sessions[0].exercises.find((e) => e.exerciseId === 'ex-bench');
  assert.ok(pe, 'expected the plan echo to carry the projected exercise');
  assert.equal(pe.targetWeightKg, 65); // 60 + 2 × 2.5
  assert.equal(JSON.stringify(d.plan).includes('purpose'), false); // purpose/goal/note/progression/brief are dropped
});

check('buildDigest: profile v2 fields — split omitted when auto, groupPrefs/cardio/core omitted when off, favourites resolved', () => {
  const auto = buildDigest({ dataset: groupDS, profile: v2EmptyProfile, today: TODAY, kind: 'plan' });
  assert.equal('split' in auto.profile, false);
  assert.equal('groupPrefs' in auto.profile, false);
  assert.equal('cardio' in auto.profile, false);
  assert.equal('core' in auto.profile, false);
  assert.deepEqual(auto.profile.favourites, []);

  const rich = buildDigest({
    dataset: groupDS,
    profile: { ...v2EmptyProfile, split: 'ppl', groupPrefs: { legs: 'emphasise', chest: 'auto' }, favouriteExerciseIds: ['ex-01'] },
    today: TODAY,
    kind: 'plan',
  });
  assert.equal(rich.profile.split, 'ppl');
  assert.deepEqual(rich.profile.groupPrefs, { legs: 'emphasise' }); // 'auto' entries filtered out
  assert.deepEqual(rich.profile.favourites, [{ id: 'ex-01', name: 'Bench Press' }]);
});

console.log(`digest sizes (300-workout fixture): ${JSON.stringify(bigSizes)}`);
console.log(`\nAll ${passed} assertions passed.`);
process.exit(0);
