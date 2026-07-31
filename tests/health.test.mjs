// Pure-Node unit tests for the testable half of js/health.js — zero
// dependencies, Node built-ins only. Run: `node tests/health.test.mjs`
// (exits non-zero on any failure).
//
// Only the pure functions are covered here: they take plain arrays and an
// injectable `now`, so the suite runs with no IndexedDB and no Capacitor. The
// plugin plumbing (listeners, meta flags, store writes) is exercised on-device.

import assert from 'node:assert/strict';
import {
  isValidSample,
  validateSamples,
  sleepNightFrom,
  weightTrendFrom,
  activeEnergyTodayFrom,
  cardioKcalFrom,
  healthAvailable,
} from '../js/health.js';

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

// A fixed "now" so every window assertion is deterministic.
const NOW = Date.parse('2026-07-31T09:00:00Z');
const HOUR = 3600000;
const DAY = 86400000;
const ago = (ms) => new Date(NOW - ms).toISOString();

// ---------------------------------------------------------------------------
// Availability (must be false in Node — no window, no Capacitor)
// ---------------------------------------------------------------------------

check('healthAvailable: false outside the native shell', () => {
  assert.equal(healthAvailable(), false);
});

// ---------------------------------------------------------------------------
// Sample validation
// ---------------------------------------------------------------------------

const goodSample = {
  id: 'hk-1',
  type: 'bodyMass',
  startedAt: '2026-07-30T07:00:00Z',
  endedAt: '2026-07-30T07:00:00Z',
  value: 82.4,
  unit: 'kg',
  meta: null,
};

check('isValidSample: accepts a well-formed sample', () => {
  assert.equal(isValidSample(goodSample), true);
});
check('isValidSample: rejects missing/blank id', () => {
  assert.equal(isValidSample({ ...goodSample, id: undefined }), false);
  assert.equal(isValidSample({ ...goodSample, id: '' }), false);
  assert.equal(isValidSample({ ...goodSample, id: 12 }), false);
});
check('isValidSample: rejects an unknown type', () => {
  // Guards the §10 permitted read set: a type we never agreed to store is dropped.
  assert.equal(isValidSample({ ...goodSample, type: 'bloodGlucose' }), false);
  assert.equal(isValidSample({ ...goodSample, type: undefined }), false);
});
check('isValidSample: rejects missing or unparseable startedAt', () => {
  assert.equal(isValidSample({ ...goodSample, startedAt: undefined }), false);
  assert.equal(isValidSample({ ...goodSample, startedAt: 'not a date' }), false);
});
check('isValidSample: rejects non-objects', () => {
  assert.equal(isValidSample(null), false);
  assert.equal(isValidSample('hk-1'), false);
});

check('validateSamples: drops the malformed ones and counts them', () => {
  const { valid, dropped } = validateSamples([
    goodSample,
    { ...goodSample, id: 'hk-2', type: 'nonsense' },
    null,
    { ...goodSample, id: '', },
    { ...goodSample, id: 'hk-3', startedAt: 'yesterday' },
    { ...goodSample, id: 'hk-4', type: 'hrv', value: 44 },
  ]);
  assert.deepEqual(valid.map((s) => s.id), ['hk-1', 'hk-4']);
  assert.equal(dropped, 4);
});
check('validateSamples: defaults a missing endedAt to startedAt', () => {
  const { valid } = validateSamples([{ ...goodSample, endedAt: undefined }]);
  assert.equal(valid[0].endedAt, goodSample.startedAt);
});
check('validateSamples: keeps everything else verbatim (idempotent upsert)', () => {
  const { valid } = validateSamples([goodSample]);
  assert.deepEqual(valid[0], goodSample);
});
check('validateSamples: empty / non-array input', () => {
  assert.deepEqual(validateSamples([]), { valid: [], dropped: 0 });
  assert.deepEqual(validateSamples(undefined), { valid: [], dropped: 0 });
});

// ---------------------------------------------------------------------------
// Sleep aggregation
// ---------------------------------------------------------------------------

const sleepSample = (id, stage, seconds, endMsAgo) => ({
  id,
  type: 'sleepAnalysis',
  startedAt: new Date(NOW - endMsAgo - seconds * 1000).toISOString(),
  endedAt: ago(endMsAgo),
  value: seconds,
  unit: 's',
  meta: { stage },
});

check('sleepNightFrom: sums core+deep+rem, excludes inBed, reports awake', () => {
  const res = sleepNightFrom([
    sleepSample('s1', 'asleepCore', 3600, 9 * HOUR),
    sleepSample('s2', 'asleepDeep', 1800, 8 * HOUR),
    sleepSample('s3', 'asleepREM', 900, 7 * HOUR),
    sleepSample('s4', 'awake', 300, 6 * HOUR),
    // inBed spans the whole night and would double-count everything above.
    sleepSample('s5', 'inBed', 28800, 6 * HOUR),
  ], NOW);
  assert.deepEqual(res, {
    totalAsleepSeconds: 3600 + 1800 + 900,
    deepSeconds: 1800,
    remSeconds: 900,
    coreSeconds: 3600,
    awakeSeconds: 300,
    endedAt: ago(6 * HOUR),
  });
});
check('sleepNightFrom: endedAt is the latest segment end in the window', () => {
  const res = sleepNightFrom([
    sleepSample('s1', 'asleepCore', 3600, 2 * HOUR),
    sleepSample('s2', 'asleepDeep', 1800, 10 * HOUR),
  ], NOW);
  assert.equal(res.endedAt, ago(2 * HOUR));
});
check('sleepNightFrom: ignores segments that ended more than 24h ago', () => {
  const res = sleepNightFrom([
    sleepSample('old', 'asleepCore', 20000, 30 * HOUR), // the night before last
    sleepSample('new', 'asleepCore', 3600, 8 * HOUR),
  ], NOW);
  assert.equal(res.totalAsleepSeconds, 3600);
});
check('sleepNightFrom: null when nothing is in the window', () => {
  assert.equal(sleepNightFrom([], NOW), null);
  assert.equal(sleepNightFrom(undefined, NOW), null);
  assert.equal(sleepNightFrom([sleepSample('old', 'asleepREM', 3600, 3 * DAY)], NOW), null);
});
check('sleepNightFrom: inBed-only night reports no data rather than 0h asleep', () => {
  // Older watchless nights only produce inBed; "0h asleep" would be a lie.
  assert.equal(sleepNightFrom([sleepSample('s1', 'inBed', 28800, 6 * HOUR)], NOW), null);
});
check('sleepNightFrom: ignores other sample types and bad values', () => {
  const res = sleepNightFrom([
    sleepSample('s1', 'asleepCore', 3600, 8 * HOUR),
    { ...sleepSample('s2', 'asleepDeep', 1800, 7 * HOUR), value: null },
    { ...sleepSample('s3', 'asleepREM', 900, 7 * HOUR), type: 'heartRate' },
  ], NOW);
  assert.equal(res.totalAsleepSeconds, 3600);
  assert.equal(res.deepSeconds, 0);
  assert.equal(res.remSeconds, 0);
});

// ---------------------------------------------------------------------------
// Weight trend
// ---------------------------------------------------------------------------

const massSample = (id, kg, msAgo) => ({
  id,
  type: 'bodyMass',
  startedAt: ago(msAgo),
  endedAt: ago(msAgo),
  value: kg,
  unit: 'kg',
  meta: null,
});

check('weightTrendFrom: trend is oldest→newest, latest is the newest reading', () => {
  // Deliberately supplied newest-first, as listHealthSamples returns them.
  const res = weightTrendFrom([
    massSample('m1', 81.0, 1 * DAY),
    massSample('m2', 82.0, 10 * DAY),
    massSample('m3', 83.0, 20 * DAY),
  ], NOW);
  assert.deepEqual(res.trend.map((p) => p.kg), [83.0, 82.0, 81.0]);
  assert.deepEqual(res.trend.map((p) => p.at), [ago(20 * DAY), ago(10 * DAY), ago(1 * DAY)]);
  assert.equal(res.latestKg, 81.0);
  assert.equal(res.at, ago(1 * DAY));
});
check('weightTrendFrom: trend is the last 30 days only', () => {
  const res = weightTrendFrom([
    massSample('m-old', 90.0, 200 * DAY),
    massSample('m-new', 82.0, 5 * DAY),
  ], NOW);
  assert.deepEqual(res.trend.map((p) => p.kg), [82.0]);
});
check('weightTrendFrom: a stale-only history still reports latestKg', () => {
  const res = weightTrendFrom([massSample('m-old', 90.0, 200 * DAY)], NOW);
  assert.equal(res.latestKg, 90.0);
  assert.deepEqual(res.trend, []);
});
check('weightTrendFrom: null when there is nothing usable', () => {
  assert.equal(weightTrendFrom([], NOW), null);
  assert.equal(weightTrendFrom(undefined, NOW), null);
  assert.equal(weightTrendFrom([{ ...massSample('m1', 82, DAY), value: null }], NOW), null);
});

// ---------------------------------------------------------------------------
// Active energy
// ---------------------------------------------------------------------------

check('activeEnergyTodayFrom: matches the deterministic daily-total id', () => {
  const samples = [
    { id: 'activeEnergy-2026-07-31', type: 'activeEnergy', startedAt: '2026-07-31T00:00:00Z', endedAt: '2026-07-31T09:00:00Z', value: 512, unit: 'kcal', meta: null },
    { id: 'activeEnergy-2026-07-30', type: 'activeEnergy', startedAt: '2026-07-30T00:00:00Z', endedAt: '2026-07-30T23:59:59Z', value: 780, unit: 'kcal', meta: null },
  ];
  assert.deepEqual(activeEnergyTodayFrom(samples, '2026-07-31'), { kcal: 512 });
});
check('activeEnergyTodayFrom: null when today has no sample', () => {
  const samples = [
    { id: 'activeEnergy-2026-07-29', type: 'activeEnergy', startedAt: '2026-07-29T00:00:00Z', endedAt: '2026-07-29T23:59:59Z', value: 780, unit: 'kcal', meta: null },
  ];
  assert.equal(activeEnergyTodayFrom(samples, '2026-07-31'), null);
  assert.equal(activeEnergyTodayFrom([], '2026-07-31'), null);
});

// ---------------------------------------------------------------------------
// Cardio kcal for the HKWorkout write
// ---------------------------------------------------------------------------

const strengthSet = (id, kcal) => ({ id, setType: 'strength', weightKg: 100, reps: 5, kcal: kcal ?? null });
const cardioSet = (id, kcal) => ({ id, setType: 'cardio', weightKg: 0, reps: 0, kcal });

check('cardioKcalFrom: sums cardio sets only', () => {
  assert.equal(cardioKcalFrom([cardioSet('c1', 300), cardioSet('c2', 120), strengthSet('s1', 999)]), 420);
});
check('cardioKcalFrom: null for a pure strength session', () => {
  // A 0 kcal HKWorkout is worse than no energy figure at all.
  assert.equal(cardioKcalFrom([strengthSet('s1'), strengthSet('s2')]), null);
});
check('cardioKcalFrom: null when cardio sets carry no kcal', () => {
  assert.equal(cardioKcalFrom([cardioSet('c1', null), cardioSet('c2', 0)]), null);
});
check('cardioKcalFrom: ignores rubbish values, empty / non-array input', () => {
  assert.equal(cardioKcalFrom([cardioSet('c1', 'lots'), cardioSet('c2', 200)]), 200);
  assert.equal(cardioKcalFrom([]), null);
  assert.equal(cardioKcalFrom(undefined), null);
});

console.log(`\nAll ${passed} assertions passed.`);
process.exit(0);
