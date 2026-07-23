// ============================================================================
// exercise-types.js — the full RepCount-style exercise-type taxonomy (schema
// v3, ADDITIVE). ExerciseRecord.exerciseType widens from 'strength'|'cardio'
// to the ids below; legacy values normalise on read ('strength' ⇒
// 'weight_reps'; 'cardio' is unchanged). SetRecord.setType stays
// 'strength'|'cardio' — storage and the calc layer are untouched.
//
// Each type maps to the set-grid fields it logs. Field -> SetRecord column:
//   weight -> weightKg   reps -> reps   time -> durationSeconds
//   distance -> distanceM   kcal -> kcal
// ============================================================================

import { uid, nowISO } from './util.js';

/** Grouped taxonomy for the type-picker sheet (labels + grey example lines). */
export const EXERCISE_TYPE_GROUPS = [
  {
    label: 'Weight Training',
    types: [
      { id: 'weight_reps', label: 'Weight, Reps', examples: 'Bench Press, Dumbbell Row, Cable Crossovers' },
      { id: 'weight_time', label: 'Weight, Time', examples: 'Weighted Static Holds' },
      { id: 'weight_distance', label: 'Weight, Distance', examples: "Farmer's Walk, Sled Push, Suitcase Carry" },
      { id: 'weight_distance_time', label: 'Weight, Distance, Time', examples: "Farmer's Walk for time, Weighted Carry" },
    ],
  },
  {
    label: 'Bodyweight Strength Training',
    types: [
      { id: 'bw_weight_reps', label: 'Weight, Reps', examples: 'Dips, Pull Up, Chin Up' },
      { id: 'bw_assisted_reps', label: 'Assisted bodyweight, Reps', examples: 'Assisted Dips, Assisted Chin Up' },
      { id: 'reps', label: 'Reps', examples: 'Push Ups, Bodyweight Squat' },
      { id: 'time', label: 'Time', examples: 'Front Plank, Wall Sits' },
    ],
    note: 'For exercises where you sometimes add additional weight, like Dips or Pull Up, it is recommended to use the Weight, Reps option and enter 0 in the weight field when you track unweighted reps.',
  },
  {
    label: 'Cardio',
    types: [
      { id: 'cardio', label: 'Time, Distance, Kcal', examples: 'Running, Stationary Bike' },
    ],
  },
  {
    label: 'Other',
    types: [
      { id: 'notes', label: 'Notes', examples: 'Stretching' },
    ],
  },
];

const TYPE_INDEX = new Map(
  EXERCISE_TYPE_GROUPS.flatMap((g) => g.types.map((t) => [t.id, { ...t, group: g.label }]))
);

/** Set-grid fields per type (order = display order). */
const TYPE_FIELDS = {
  weight_reps: ['weight', 'reps'],
  weight_time: ['weight', 'time'],
  weight_distance: ['weight', 'distance'],
  weight_distance_time: ['weight', 'distance', 'time'],
  bw_weight_reps: ['weight', 'reps'],
  bw_assisted_reps: ['weight', 'reps'],
  reps: ['reps'],
  time: ['time'],
  cardio: ['time', 'distance', 'kcal'],
  notes: [],
};

/** Legacy 'strength' (and absent) ⇒ 'weight_reps'; unknown ids fall back too. */
export function normalizeExerciseType(t) {
  if (!t || t === 'strength') return 'weight_reps';
  return TYPE_INDEX.has(t) ? t : 'weight_reps';
}

/** Short display label, e.g. "Weight, Reps". */
export function typeLabel(t) {
  const info = TYPE_INDEX.get(normalizeExerciseType(t));
  return info ? info.label : 'Weight, Reps';
}

/** The fields the set grid shows for an exercise type. */
export function fieldsForType(t) {
  return TYPE_FIELDS[normalizeExerciseType(t)] || TYPE_FIELDS.weight_reps;
}

/** SetRecord.setType stays binary — only true cardio is 'cardio'. */
export function setTypeFor(t) {
  return normalizeExerciseType(t) === 'cardio' ? 'cardio' : 'strength';
}

/**
 * A fresh untouched SetRecord for an exercise (all numeric fields 0/null); the
 * UI renders zeros as empty inputs with grey last-session placeholders.
 * Used to auto-create set 1 when an exercise is added to a workout.
 */
export function blankSet(workoutId, exercise, setNumber) {
  const type = normalizeExerciseType(exercise ? exercise.exerciseType : null);
  const fields = fieldsForType(type);
  return {
    id: uid(),
    workoutId,
    exerciseId: exercise.id,
    setNumber,
    setType: setTypeFor(type),
    weightKg: 0,
    reps: 0,
    durationSeconds: fields.includes('time') ? 0 : null,
    distanceM: fields.includes('distance') ? 0 : null,
    kcal: fields.includes('kcal') ? 0 : null,
    rpe: null,
    isWarmup: false,
    notes: null,
    completedAt: nowISO(),
  };
}
