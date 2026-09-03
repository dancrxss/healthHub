#!/usr/bin/env node
// One-off diagnostic for the Coach's Claude API calls. Sends ONE real request
// (kind: chat by default) with a small synthetic digest and prints the outcome,
// including the API's own error message on a 400. Run from the repo root:
//
//   ANTHROPIC_API_KEY=sk-ant-... node local/coach-diag.mjs [chat|daily|plan]
//
// The key is read from the environment only — never pass it as an argument.
// Costs about a penny (chat/daily) or a few pence (plan).

import { buildDigest } from '../js/coach-engine.js';
import { callCoach, buildRequest } from '../js/coach-api.js';

const kind = process.argv[2] || 'chat';
const apiKey = process.env.ANTHROPIC_API_KEY || '';
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY in the environment first.'); process.exit(2); }

const today = new Date().toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const exercises = [
  { id: 'seed-barbell-bench-press', name: 'Barbell Bench Press', muscleGroup: 'chest', equipment: 'barbell', exerciseType: 'weight_reps', isCustom: false, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'seed-lat-pulldown', name: 'Lat Pulldown', muscleGroup: 'back', equipment: 'machine', exerciseType: 'weight_reps', isCustom: false, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'seed-goblet-squat', name: 'Goblet Squat', muscleGroup: 'legs', equipment: 'dumbbell', exerciseType: 'weight_reps', isCustom: false, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'seed-assault-bike', name: 'Assault Bike', muscleGroup: 'cardio', equipment: 'machine', exerciseType: 'cardio', isCustom: false, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'seed-plank', name: 'Plank', muscleGroup: 'abs', equipment: 'bodyweight', exerciseType: 'time', isCustom: false, createdAt: '2026-01-01T00:00:00.000Z' },
];
const workouts = []; const sets = [];
for (let i = 0; i < 6; i++) {
  const date = day(3 + i * 4);
  const w = { id: `w${i}`, date, startedAt: `${date}T18:00:00.000Z`, finishedAt: `${date}T19:00:00.000Z`, templateId: null, notes: null, entries: null };
  workouts.push(w);
  for (const [ex, kg] of [['seed-barbell-bench-press', 60 + i * 2.5], ['seed-lat-pulldown', 50]]) {
    for (let n = 1; n <= 3; n++) sets.push({ id: `${w.id}-${ex}-${n}`, workoutId: w.id, exerciseId: ex, setNumber: n, weightKg: kg, reps: 8, rpe: 7.5, isWarmup: false, completedAt: `${date}T18:${10 + n}:00.000Z` });
  }
}
const profile = { version: 2, updatedAt: new Date().toISOString(), injuryNotes: 'sciatica — easing back', goal: 'return-from-injury', daysPerWeek: 3, sessionMinutes: 60, equipmentNotes: null, returnDate: null, avoidExerciseIds: [], split: 'auto', groupPrefs: { legs: 'include' }, cardio: { include: true, minutesPerSession: 10, standaloneDay: false, exerciseIds: [] }, core: { include: true }, favouriteExerciseIds: [], notes: null };
const memory = [{ id: 'm-diag', text: 'Prefers morning sessions' }];
const chat = { thread: 'home', recent: [], message: 'Quick check — how am I doing this week?' };

const digest = buildDigest({ dataset: { workouts, sets, exercises }, profile, today, health: null, plan: null, kind, memory, chat });
const { body } = buildRequest({ kind, digest });
console.log(`kind=${kind} · digest ${JSON.stringify(digest).length} bytes · schema ${JSON.stringify(body.output_config.format.schema).length} bytes · max_tokens ${body.max_tokens}`);

try {
  const t0 = Date.now();
  const { narrative, usage, raw } = await callCoach({ kind, digest, apiKey });
  console.log(`OK in ${Math.round((Date.now() - t0) / 1000)}s · model ${raw.model} · stop ${raw.stopReason} · tokens in ${usage.inputTokens} out ${usage.outputTokens}`);
  console.log(JSON.stringify(narrative, null, 2).slice(0, 2500));
} catch (err) {
  console.log(`FAILED · code=${err.code} status=${err.status ?? '-'} retryable=${err.retryable}`);
  console.log('message:', err.message);
  console.log('detail :', typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail, null, 2));
  process.exit(1);
}
