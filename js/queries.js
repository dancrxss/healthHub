// The FROZEN derived-query contract for the future MCP server
// (gym-tracker-spec.md §"Derived query layer"). Names and signatures must not
// change without flagging it to Dan first. These are thin async wrappers:
// load records via db.js, delegate all logic to the pure functions in calc.js.

import { todayISO } from './util.js';
import {
  listWorkouts,
  listSetsForWorkout,
  listSetsForExercise,
  listExercises,
  getWorkout,
} from './db.js';
import {
  lastSessionFrom,
  recentWorkoutsFrom,
  prsFrom,
  weeklyVolumeFrom,
  trainingFrequencyFrom,
} from './calc.js';

/** Load every set across all workouts (single-user scale). */
async function loadAllSets(workouts) {
  const out = [];
  for (const w of workouts) {
    const sets = await listSetsForWorkout(w.id);
    for (const s of sets) out.push(s);
  }
  return out;
}

/**
 * Most recent finished workout containing the exercise, with its sets —
 * shown inline while logging ("what to beat").
 * @param {string} exerciseId
 * @returns {Promise<{workout: WorkoutRecord, sets: SetRecord[]}|null>}
 */
export async function getLastSession(exerciseId) {
  const workouts = await listWorkouts('0000');
  const sets = await listSetsForExercise(exerciseId);
  return lastSessionFrom({ workouts, sets, exercises: [] }, exerciseId);
}

/**
 * Workouts + their sets since a date, newest first.
 * @param {string} sinceDate ISO date, inclusive
 * @returns {Promise<Array<{workout: WorkoutRecord, sets: SetRecord[]}>>}
 */
export async function getRecentWorkouts(sinceDate) {
  const workouts = await listWorkouts(sinceDate);
  const sets = await loadAllSets(workouts);
  return recentWorkoutsFrom({ workouts, sets, exercises: [] }, sinceDate);
}

/**
 * Best weight at each rep count 1–10 plus best estimated 1RM (Epley),
 * warmups excluded. Shape per calc.js prsFrom.
 * @param {string} exerciseId
 */
export async function getPRs(exerciseId) {
  const sets = await listSetsForExercise(exerciseId);
  const workoutIds = [...new Set(sets.map((s) => s.workoutId))];
  const workouts = (await Promise.all(workoutIds.map((id) => getWorkout(id)))).filter(Boolean);
  return prsFrom({ workouts, sets, exercises: [] }, exerciseId);
}

/**
 * Σ(weight × reps) per muscle group per ISO week, warmups excluded.
 * @param {number} weeks trailing window including the current week
 */
export async function getWeeklyVolume(weeks) {
  const today = todayISO();
  const workouts = await listWorkouts('0000');
  const sets = await loadAllSets(workouts);
  const exercises = await listExercises();
  return weeklyVolumeFrom({ workouts, sets, exercises }, weeks, today);
}

/**
 * Sessions per week, per muscle group.
 * @param {number} weeks trailing window including the current week
 */
export async function getTrainingFrequency(weeks) {
  const today = todayISO();
  const workouts = await listWorkouts('0000');
  const sets = await loadAllSets(workouts);
  const exercises = await listExercises();
  return trainingFrequencyFrom({ workouts, sets, exercises }, weeks, today);
}
