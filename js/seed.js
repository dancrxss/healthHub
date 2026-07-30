// Seed exercise library + one hand-seeded template. Part of the pinned
// contract for shapes/ids; the data itself is filled in by an implementation
// agent.
//
// Rules:
// - ~55 strength exercises covering every strength MUSCLE_GROUPS value plus 6
//   cardio exercises (db.js).
// - Seed ids are STABLE SLUGS: `seed-<kebab-name>` (e.g.
//   'seed-barbell-bench-press') so templates and imports can reference them
//   deterministically across installs.
// - isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null.
//
// Schema v2 (22 July 2026, PLAN.md §"Phase 1.5"):
// - SEED_EXERCISES carry the v2 shape directly: `exerciseType` ('strength' |
//   'cardio') and `isUnilateral` (boolean). Fresh installs seed straight to v2.
// - muscleGroup uses the v2 categories: old 'core' → 'abs', old 'arms' →
//   'biceps' (curls) or 'triceps' (extensions/presses).
// - seedIfEmpty runs the v1 seed once (meta flag 'seeded-v1'), then applies the
//   v2 upgrade exactly once (meta flag 'seeded-v2'): idempotent, upsert-only,
//   never deletes, and never touches records with isCustom === true. The
//   upgrade repairs installs that were seeded with the old v1 shapes and adds
//   the cardio seeds.

import { getMeta, setMeta, putExercise, listExercises } from './db.js';

export const SEED_CREATED_AT = '2026-07-21T00:00:00.000Z';

/** @type {ExerciseRecord[]} ~55 strength + 6 cardio entries (v2 shapes). */
export const SEED_EXERCISES = [
  // ---- Chest ----
  { id: 'seed-barbell-bench-press', name: 'Barbell Bench Press', muscleGroup: 'chest', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-incline-barbell-bench-press', name: 'Incline Barbell Bench Press', muscleGroup: 'chest', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-bench-press', name: 'Dumbbell Bench Press', muscleGroup: 'chest', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-incline-dumbbell-press', name: 'Incline Dumbbell Press', muscleGroup: 'chest', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-fly', name: 'Dumbbell Fly', muscleGroup: 'chest', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-fly', name: 'Cable Fly', muscleGroup: 'chest', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-chest-press-machine', name: 'Chest Press Machine', muscleGroup: 'chest', equipment: 'machine', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-push-up', name: 'Push Up', muscleGroup: 'chest', equipment: 'bodyweight', exerciseType: 'reps', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dip', name: 'Dip', muscleGroup: 'chest', equipment: 'bodyweight', exerciseType: 'bw_weight_reps', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Back ----
  { id: 'seed-barbell-deadlift', name: 'Barbell Deadlift', muscleGroup: 'back', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-barbell-row', name: 'Barbell Row', muscleGroup: 'back', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-pendlay-row', name: 'Pendlay Row', muscleGroup: 'back', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-row', name: 'Dumbbell Row', muscleGroup: 'back', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: true, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-lat-pulldown', name: 'Lat Pulldown', muscleGroup: 'back', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-seated-cable-row', name: 'Seated Cable Row', muscleGroup: 'back', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-t-bar-row', name: 'T-Bar Row', muscleGroup: 'back', equipment: 'machine', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-pull-up', name: 'Pull Up', muscleGroup: 'back', equipment: 'bodyweight', exerciseType: 'bw_weight_reps', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-chin-up', name: 'Chin Up', muscleGroup: 'back', equipment: 'bodyweight', exerciseType: 'bw_weight_reps', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Legs ----
  { id: 'seed-barbell-back-squat', name: 'Barbell Back Squat', muscleGroup: 'legs', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-barbell-front-squat', name: 'Barbell Front Squat', muscleGroup: 'legs', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-romanian-deadlift', name: 'Romanian Deadlift', muscleGroup: 'legs', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-hip-thrust', name: 'Hip Thrust', muscleGroup: 'legs', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-leg-press', name: 'Leg Press', muscleGroup: 'legs', equipment: 'machine', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-leg-extension', name: 'Leg Extension', muscleGroup: 'legs', equipment: 'machine', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-leg-curl', name: 'Leg Curl', muscleGroup: 'legs', equipment: 'machine', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-standing-calf-raise-machine', name: 'Standing Calf Raise Machine', muscleGroup: 'legs', equipment: 'machine', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-walking-lunge', name: 'Walking Lunge', muscleGroup: 'legs', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: true, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-bulgarian-split-squat', name: 'Bulgarian Split Squat', muscleGroup: 'legs', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: true, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-goblet-squat', name: 'Goblet Squat', muscleGroup: 'legs', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-pull-through', name: 'Cable Pull Through', muscleGroup: 'legs', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-bodyweight-squat', name: 'Bodyweight Squat', muscleGroup: 'legs', equipment: 'bodyweight', exerciseType: 'reps', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Shoulders ----
  { id: 'seed-overhead-press', name: 'Overhead Press', muscleGroup: 'shoulders', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-shoulder-press', name: 'Dumbbell Shoulder Press', muscleGroup: 'shoulders', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-lateral-raise', name: 'Lateral Raise', muscleGroup: 'shoulders', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-front-raise', name: 'Front Raise', muscleGroup: 'shoulders', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-shoulder-press-machine', name: 'Shoulder Press Machine', muscleGroup: 'shoulders', equipment: 'machine', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-face-pull', name: 'Face Pull', muscleGroup: 'shoulders', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-rear-delt-fly', name: 'Cable Rear Delt Fly', muscleGroup: 'shoulders', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-pike-push-up', name: 'Pike Push Up', muscleGroup: 'shoulders', equipment: 'bodyweight', exerciseType: 'reps', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Biceps (was 'arms') ----
  { id: 'seed-barbell-curl', name: 'Barbell Curl', muscleGroup: 'biceps', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-dumbbell-curl', name: 'Dumbbell Curl', muscleGroup: 'biceps', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-hammer-curl', name: 'Hammer Curl', muscleGroup: 'biceps', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-curl', name: 'Cable Curl', muscleGroup: 'biceps', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-preacher-curl-machine', name: 'Preacher Curl Machine', muscleGroup: 'biceps', equipment: 'machine', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Triceps (was 'arms') ----
  { id: 'seed-close-grip-bench-press', name: 'Close-Grip Bench Press', muscleGroup: 'triceps', equipment: 'barbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-overhead-triceps-extension', name: 'Overhead Triceps Extension', muscleGroup: 'triceps', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-triceps-pushdown', name: 'Triceps Pushdown', muscleGroup: 'triceps', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-bench-dip', name: 'Bench Dip', muscleGroup: 'triceps', equipment: 'bodyweight', exerciseType: 'reps', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Abs (was 'core') ----
  { id: 'seed-plank', name: 'Plank', muscleGroup: 'abs', equipment: 'bodyweight', exerciseType: 'time', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-hanging-leg-raise', name: 'Hanging Leg Raise', muscleGroup: 'abs', equipment: 'bodyweight', exerciseType: 'reps', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-cable-crunch', name: 'Cable Crunch', muscleGroup: 'abs', equipment: 'cable', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-russian-twist', name: 'Russian Twist', muscleGroup: 'abs', equipment: 'dumbbell', exerciseType: 'strength', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-ab-wheel-rollout', name: 'Ab Wheel Rollout', muscleGroup: 'abs', equipment: 'other', exerciseType: 'reps', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Other ----
  { id: 'seed-farmers-carry', name: "Farmer's Carry", muscleGroup: 'other', equipment: 'dumbbell', exerciseType: 'weight_distance', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-sled-push', name: 'Sled Push', muscleGroup: 'other', equipment: 'other', exerciseType: 'weight_distance', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },

  // ---- Cardio (v2) ----
  { id: 'seed-assault-bike', name: 'Assault Bike', muscleGroup: 'cardio', equipment: 'other', exerciseType: 'cardio', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-rowing-machine', name: 'Rowing Machine', muscleGroup: 'cardio', equipment: 'other', exerciseType: 'cardio', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-treadmill-run', name: 'Treadmill Run', muscleGroup: 'cardio', equipment: 'other', exerciseType: 'cardio', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-incline-walk', name: 'Incline Walk', muscleGroup: 'cardio', equipment: 'other', exerciseType: 'cardio', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-stationary-bike', name: 'Stationary Bike', muscleGroup: 'cardio', equipment: 'other', exerciseType: 'cardio', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
  { id: 'seed-stair-climber', name: 'Stair Climber', muscleGroup: 'cardio', equipment: 'other', exerciseType: 'cardio', isUnilateral: false, isCustom: false, createdAt: SEED_CREATED_AT, syncedAt: null },
];

/**
 * A reference routine shape. NO LONGER SEEDED (30 Jul 2026) — routines are
 * user-created via "Save as routine" on a workout. Kept exported because the
 * browser test suite uses it as a known-good TemplateRecord fixture.
 */
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

/**
 * v2 upgrade: bring seed exercises up to the v2 shape (muscleGroup remap,
 * exerciseType, isUnilateral) and add the cardio seeds. Upsert-only, never
 * deletes; user records (isCustom === true) are never touched. Idempotent —
 * re-running just re-writes the same v2 shapes. Safe on installs that already
 * hold the old v1 shapes as well as on fresh v2 installs.
 */
async function applyV2Upgrade() {
  const existing = await listExercises();
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const ex of SEED_EXERCISES) {
    const cur = byId.get(ex.id);
    if (cur && cur.isCustom === true) continue; // never touch user-owned records
    await putExercise(ex);
  }
}

/**
 * v3 upgrade (23 July 2026): the exercise-type taxonomy widened (see
 * js/exercise-types.js) and SEED_EXERCISES now carry proper types for
 * bodyweight / time / carry movements. Existing installs hold 'strength' for
 * those ids; retype ONLY records still on the legacy value ('strength' or
 * absent) so any type the user has since chosen is preserved. Upsert-only,
 * never deletes, never touches isCustom records.
 */
async function applyV3Upgrade() {
  const existing = await listExercises();
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const seedEx of SEED_EXERCISES) {
    if (seedEx.exerciseType === 'strength' || seedEx.exerciseType === 'cardio') continue;
    const cur = byId.get(seedEx.id);
    if (!cur || cur.isCustom === true) continue;
    if (cur.exerciseType && cur.exerciseType !== 'strength') continue; // user already retyped
    await putExercise({ ...cur, exerciseType: seedEx.exerciseType });
  }
}

/**
 * Idempotent: seeds exercises + template once (v1), then applies the v2 and v3
 * upgrades exactly once each. Returns true if any work was performed.
 */
export async function seedIfEmpty() {
  let didWork = false;

  const firstRun = !(await getMeta('seeded-v1'));
  if (firstRun) {
    for (const ex of SEED_EXERCISES) await putExercise(ex);
    // NOT seeded any more (30 Jul 2026): routines are Dan's to create — the
    // Copy Routine picker should start empty rather than pre-stocked. Existing
    // installs keep the template they were given; deleting it would be a
    // destructive migration for no gain (CLAUDE.md §2.1).
    await setMeta('seeded-v1', true);
    didWork = true;
  }

  // v2 upgrade — applied exactly once. On a fresh run SEED_EXERCISES are already
  // in v2 shapes, so we only need to repair existing v1 installs; either way the
  // flag is set so it never runs twice.
  if (!(await getMeta('seeded-v2'))) {
    if (!firstRun) await applyV2Upgrade();
    await setMeta('seeded-v2', true);
    didWork = true;
  }

  // v3 upgrade — same pattern: fresh installs already seed v3 types.
  if (!(await getMeta('seeded-v3'))) {
    if (!firstRun) await applyV3Upgrade();
    await setMeta('seeded-v3', true);
    didWork = true;
  }

  return didWork;
}
