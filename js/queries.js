// The FROZEN derived-query contract for the future MCP server
// (gym-tracker-spec.md §"Derived query layer"). Names and signatures must not
// change without flagging it to Dan first. These are thin async wrappers:
// load records via db.js, delegate all logic to the pure functions in calc.js.

import { todayISO } from './util.js';

/**
 * Most recent finished workout containing the exercise, with its sets —
 * shown inline while logging ("what to beat").
 * @param {string} exerciseId
 * @returns {Promise<{workout: WorkoutRecord, sets: SetRecord[]}|null>}
 */
export async function getLastSession(exerciseId) { throw new Error('TODO: implement'); }

/**
 * Workouts + their sets since a date, newest first.
 * @param {string} sinceDate ISO date, inclusive
 * @returns {Promise<Array<{workout: WorkoutRecord, sets: SetRecord[]}>>}
 */
export async function getRecentWorkouts(sinceDate) { throw new Error('TODO: implement'); }

/**
 * Best weight at each rep count 1–10 plus best estimated 1RM (Epley),
 * warmups excluded. Shape per calc.js prsFrom.
 * @param {string} exerciseId
 */
export async function getPRs(exerciseId) { throw new Error('TODO: implement'); }

/**
 * Σ(weight × reps) per muscle group per ISO week, warmups excluded.
 * @param {number} weeks trailing window including the current week
 */
export async function getWeeklyVolume(weeks) { throw new Error('TODO: implement'); }

/**
 * Sessions per week, per muscle group.
 * @param {number} weeks trailing window including the current week
 */
export async function getTrainingFrequency(weeks) { throw new Error('TODO: implement'); }
