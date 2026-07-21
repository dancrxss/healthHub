// Seed exercise library + one hand-seeded template. Part of the pinned
// contract for shapes/ids; the data itself is filled in by an implementation
// agent.
//
// Rules:
// - ~50 exercises covering every MUSCLE_GROUPS and EQUIPMENT value (db.js).
// - Seed ids are STABLE SLUGS: `seed-<kebab-name>` (e.g.
//   'seed-barbell-bench-press') so templates and imports can reference them
//   deterministically across installs.
// - isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null.

import { getMeta, setMeta, putExercise, putTemplate } from './db.js';

export const SEED_CREATED_AT = '2026-07-21T00:00:00.000Z';

/** @type {ExerciseRecord[]} ~50 entries. */
export const SEED_EXERCISES = [
  // ---- Chest ----
  { id: 'seed-barbell-bench-press', name: 'Barbell Bench Press', muscleGroup: 'chest', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-incline-barbell-bench-press', name: 'Incline Barbell Bench Press', muscleGroup: 'chest', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-bench-press', name: 'Dumbbell Bench Press', muscleGroup: 'chest', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-incline-dumbbell-press', name: 'Incline Dumbbell Press', muscleGroup: 'chest', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-fly', name: 'Dumbbell Fly', muscleGroup: 'chest', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-fly', name: 'Cable Fly', muscleGroup: 'chest', equipment: 'cable', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-chest-press-machine', name: 'Chest Press Machine', muscleGroup: 'chest', equipment: 'machine', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-push-up', name: 'Push Up', muscleGroup: 'chest', equipment: 'bodyweight', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dip', name: 'Dip', muscleGroup: 'chest', equipment: 'bodyweight', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Back ----
  { id: 'seed-barbell-deadlift', name: 'Barbell Deadlift', muscleGroup: 'back', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-barbell-row', name: 'Barbell Row', muscleGroup: 'back', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-pendlay-row', name: 'Pendlay Row', muscleGroup: 'back', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-row', name: 'Dumbbell Row', muscleGroup: 'back', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-lat-pulldown', name: 'Lat Pulldown', muscleGroup: 'back', equipment: 'cable', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-seated-cable-row', name: 'Seated Cable Row', muscleGroup: 'back', equipment: 'cable', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-t-bar-row', name: 'T-Bar Row', muscleGroup: 'back', equipment: 'machine', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-pull-up', name: 'Pull Up', muscleGroup: 'back', equipment: 'bodyweight', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-chin-up', name: 'Chin Up', muscleGroup: 'back', equipment: 'bodyweight', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Legs ----
  { id: 'seed-barbell-back-squat', name: 'Barbell Back Squat', muscleGroup: 'legs', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-barbell-front-squat', name: 'Barbell Front Squat', muscleGroup: 'legs', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-romanian-deadlift', name: 'Romanian Deadlift', muscleGroup: 'legs', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-hip-thrust', name: 'Hip Thrust', muscleGroup: 'legs', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-leg-press', name: 'Leg Press', muscleGroup: 'legs', equipment: 'machine', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-leg-extension', name: 'Leg Extension', muscleGroup: 'legs', equipment: 'machine', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-leg-curl', name: 'Leg Curl', muscleGroup: 'legs', equipment: 'machine', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-standing-calf-raise-machine', name: 'Standing Calf Raise Machine', muscleGroup: 'legs', equipment: 'machine', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-walking-lunge', name: 'Walking Lunge', muscleGroup: 'legs', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-bulgarian-split-squat', name: 'Bulgarian Split Squat', muscleGroup: 'legs', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-goblet-squat', name: 'Goblet Squat', muscleGroup: 'legs', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-pull-through', name: 'Cable Pull Through', muscleGroup: 'legs', equipment: 'cable', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-bodyweight-squat', name: 'Bodyweight Squat', muscleGroup: 'legs', equipment: 'bodyweight', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Shoulders ----
  { id: 'seed-overhead-press', name: 'Overhead Press', muscleGroup: 'shoulders', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-shoulder-press', name: 'Dumbbell Shoulder Press', muscleGroup: 'shoulders', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-lateral-raise', name: 'Lateral Raise', muscleGroup: 'shoulders', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-front-raise', name: 'Front Raise', muscleGroup: 'shoulders', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-shoulder-press-machine', name: 'Shoulder Press Machine', muscleGroup: 'shoulders', equipment: 'machine', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-face-pull', name: 'Face Pull', muscleGroup: 'shoulders', equipment: 'cable', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-rear-delt-fly', name: 'Cable Rear Delt Fly', muscleGroup: 'shoulders', equipment: 'cable', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-pike-push-up', name: 'Pike Push Up', muscleGroup: 'shoulders', equipment: 'bodyweight', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Arms ----
  { id: 'seed-close-grip-bench-press', name: 'Close-Grip Bench Press', muscleGroup: 'arms', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-barbell-curl', name: 'Barbell Curl', muscleGroup: 'arms', equipment: 'barbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-curl', name: 'Dumbbell Curl', muscleGroup: 'arms', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-hammer-curl', name: 'Hammer Curl', muscleGroup: 'arms', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-overhead-triceps-extension', name: 'Overhead Triceps Extension', muscleGroup: 'arms', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-curl', name: 'Cable Curl', muscleGroup: 'arms', equipment: 'cable', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-triceps-pushdown', name: 'Triceps Pushdown', muscleGroup: 'arms', equipment: 'cable', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-preacher-curl-machine', name: 'Preacher Curl Machine', muscleGroup: 'arms', equipment: 'machine', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-bench-dip', name: 'Bench Dip', muscleGroup: 'arms', equipment: 'bodyweight', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Core ----
  { id: 'seed-plank', name: 'Plank', muscleGroup: 'core', equipment: 'bodyweight', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-hanging-leg-raise', name: 'Hanging Leg Raise', muscleGroup: 'core', equipment: 'bodyweight', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-crunch', name: 'Cable Crunch', muscleGroup: 'core', equipment: 'cable', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-russian-twist', name: 'Russian Twist', muscleGroup: 'core', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-ab-wheel-rollout', name: 'Ab Wheel Rollout', muscleGroup: 'core', equipment: 'other', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Other ----
  { id: 'seed-farmers-carry', name: "Farmer's Carry", muscleGroup: 'other', equipment: 'dumbbell', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-sled-push', name: 'Sled Push', muscleGroup: 'other', equipment: 'other', isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
];

/** One hand-seeded template, e.g. "Push Day A", referencing seed-* ids. */
export const SEED_TEMPLATE = {
  id: 'seed-template-push-day-a',
  name: 'Push Day A',
  entries: [
    { exerciseId: 'seed-barbell-bench-press', targetSets: 4, targetRepsLow: 5, targetRepsHigh: 8 },
    { exerciseId: 'seed-overhead-press', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 10 },
    { exerciseId: 'seed-incline-dumbbell-press', targetSets: 3, targetRepsLow: 8, targetRepsHigh: 12 },
    { exerciseId: 'seed-lateral-raise', targetSets: 3, targetRepsLow: 12, targetRepsHigh: 15 },
    { exerciseId: 'seed-triceps-pushdown', targetSets: 3, targetRepsLow: 10, targetRepsHigh: 15 },
  ],
  syncedAt: null,
};

/** Idempotent: seeds exercises + template once, guarded by a meta flag. */
export async function seedIfEmpty() {
  if (await getMeta('seeded-v1')) return false;
  for (const ex of SEED_EXERCISES) await putExercise(ex);
  if (SEED_TEMPLATE) await putTemplate(SEED_TEMPLATE);
  await setMeta('seeded-v1', true);
  return true;
}
