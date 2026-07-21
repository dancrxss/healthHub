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
  // TODO: implement (~50 exercises)
];

/** One hand-seeded template, e.g. "Push Day A", referencing seed-* ids. */
export const SEED_TEMPLATE = null; // TODO: implement (TemplateRecord)

/** Idempotent: seeds exercises + template once, guarded by a meta flag. */
export async function seedIfEmpty() {
  if (await getMeta('seeded-v1')) return false;
  for (const ex of SEED_EXERCISES) await putExercise(ex);
  if (SEED_TEMPLATE) await putTemplate(SEED_TEMPLATE);
  await setMeta('seeded-v1', true);
  return true;
}
