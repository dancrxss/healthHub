// ============================================================================
// screens/routines.js — routines after the Routines tab was removed
// (30 July 2026). Two fullscreen screens, both in the exercise-picker visual
// language, plus the skeleton-copying logic they share.
//
//   #/copy                  categories: Routines · Previous Sessions
//   #/copy/routines         saved routines (user-created only — nothing seeded)
//   #/copy/sessions         finished workouts, newest first
//   #/routine/new           blank editor
//   #/routine/from/:id      editor prefilled from a workout's skeleton
//   #/routine/:id           edit an existing routine
//
// "Skeleton" means exercises + how many sets, never the loads: copying last
// Monday's session should set up the work, not pre-fill what you lifted. The
// copied sets are blank, so each one shows its own last-session placeholder.
//
// User text only ever via textContent / h() — never innerHTML.
// ============================================================================

import {
  listTemplates, getTemplate, putTemplate, deleteTemplate,
  listExercises, listWorkouts, listSetsForWorkout, getWorkout, putSet,
} from '../db.js';
import { uid } from '../util.js';
import {
  h, Icon, go,
  currentWorkout, getEntries, saveEntries, displayName, formatDate,
  openSheet, closeSheet, sheetHeader, sheetGroup, sheetRow, confirmSheet,
} from '../ui.js';
import { enhanceInput } from '../inputs.js';
import { blankSet } from '../exercise-types.js';
import { swipeRow } from '../swipe.js';
import { stagger } from '../motion.js';

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ============================================================================
// Skeletons
// ============================================================================

/**
 * The skeleton of a template: what to do, and how many sets of it.
 * @returns {Array<{exerciseId: string, sets: number}>}
 */
export function skeletonFromTemplate(template) {
  return (template.entries || []).map((e) => ({
    exerciseId: e.exerciseId,
    sets: Math.max(1, Number(e.targetSets) || 1),
  }));
}

/**
 * The skeleton of a past workout: its exercises in order, each with the number
 * of sets that were actually logged.
 * @returns {Promise<Array<{exerciseId: string, sets: number}>>}
 */
export async function skeletonFromWorkout(workoutId) {
  const workout = await getWorkout(workoutId);
  if (!workout) return [];
  const sets = await listSetsForWorkout(workout.id);
  const counts = new Map();
  for (const s of sets) counts.set(s.exerciseId, (counts.get(s.exerciseId) || 0) + 1);
  return getEntries(workout, sets)
    .map((e) => ({ exerciseId: e.exerciseId, sets: counts.get(e.exerciseId) || 1 }))
    .filter((e) => e.sets > 0);
}

/**
 * Append a skeleton to the in-progress workout: one entry per exercise, each
 * with that many blank sets.
 *
 * Exercises already in the workout are skipped rather than duplicated or
 * topped up — copying a routine on top of work you have already started
 * should never quietly change what is in front of you.
 *
 * @returns {Promise<number>} how many exercises were actually added
 */
export async function applySkeleton(workout, skeleton) {
  const existingSets = await listSetsForWorkout(workout.id);
  const entries = getEntries(workout, existingSets).slice();
  const present = new Set(entries.map((e) => e.exerciseId));
  const exMap = new Map((await listExercises()).map((e) => [e.id, e]));

  let added = 0;
  for (const item of skeleton) {
    const exercise = exMap.get(item.exerciseId);
    if (!exercise || present.has(item.exerciseId)) continue;
    entries.push({ exerciseId: item.exerciseId, supersetGroup: null, note: null });
    present.add(item.exerciseId);
    for (let n = 1; n <= item.sets; n += 1) {
      await putSet(blankSet(workout.id, exercise, n));
    }
    added += 1;
  }
  if (added) await saveEntries(workout, entries);
  return added;
}

// ============================================================================
// #/copy — pick a routine or a previous session to copy
// ============================================================================
export async function renderCopyPicker(parts) {
  const screen = document.getElementById('s-copy');
  const group = parts[0] || null;

  const workout = await currentWorkout();
  if (!workout) { go('#/log'); return; } // nothing to copy INTO

  if (group === 'routines') { await renderRoutineList(screen, workout); return; }
  if (group === 'sessions') { await renderSessionList(screen, workout); return; }

  const [templates, sessions] = await Promise.all([listTemplates(), listWorkouts('0000')]);
  const finished = sessions.filter((w) => w.finishedAt && w.id !== workout.id);

  screen.replaceChildren(
    copyHeader('Copy Routine', '#/workout'),
    h('div', { class: 'pick-list' },
      catRow('Routines', `${templates.length} saved`, () => go('#/copy/routines')),
      catRow('Previous Sessions', `${finished.length} logged`, () => go('#/copy/sessions')),
    ),
  );
}

function copyHeader(title, backHash) {
  return h('header', { class: 'pick-head' },
    h('button', {
      class: 'round-btn', type: 'button', 'aria-label': 'Back',
      'data-action': 'copy-back', onclick: () => go(backHash),
    }, Icon('back')),
    h('div', { class: 'pick-title', text: title }),
    h('span', { class: 'round-btn-ghost' }),
  );
}

function catRow(label, sub, onClick) {
  return h('button', {
    class: 'pick-cat', type: 'button', 'data-copy-cat': label.toLowerCase().split(' ')[0],
    onclick: onClick,
  },
    h('span', { class: 'pick-cat-main' },
      h('span', { text: label }),
      h('span', { class: 'pick-cat-sub', text: sub }),
    ),
    h('span', { class: 'pick-cat-chev' }, Icon('chevron')),
  );
}

// ---- routines list ---------------------------------------------------------
async function renderRoutineList(screen, workout) {
  const [templates, exercises] = await Promise.all([listTemplates(), listExercises()]);
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const list = h('div', { class: 'pick-list' });

  if (!templates.length) {
    list.append(h('p', {
      class: 'pick-empty muted',
      text: 'No routines yet. Finish a session, then use its ⋯ menu → Save as routine.',
    }));
  } else {
    for (const t of templates) {
      const names = (t.entries || [])
        .map((e) => (exMap.get(e.exerciseId) || {}).name)
        .filter(Boolean);
      const row = h('div', { class: 'pick-row copy-row', 'data-template-id': t.id, role: 'button', tabindex: '0' },
        h('span', { class: 'pick-row-main' },
          h('span', { class: 'pick-row-name', text: t.name }),
          h('span', { class: 'pick-row-sub', text: summarise(names, t.entries.length) }),
        ),
        h('span', { class: 'pick-row-chev' }, Icon('chevron')),
      );
      const use = () => copyInto(workout, skeletonFromTemplate(t), t.name);
      row.addEventListener('click', use);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); use(); } });
      list.append(swipeRow(row, {
        onDelete: () => confirmSheet({
          title: 'Delete routine?',
          message: `This removes "${t.name}". Workouts already logged from it are unaffected.`,
          confirmLabel: 'Delete', danger: true,
          onConfirm: async () => { await deleteTemplate(t.id); go('#/copy/routines'); },
        }),
      }));
    }
  }

  screen.replaceChildren(copyHeader('Routines', '#/copy'), list);
  stagger(list.children, 'anim-card-settle');
}

// ---- previous sessions list -------------------------------------------------
async function renderSessionList(screen, workout) {
  const [all, exercises] = await Promise.all([listWorkouts('0000'), listExercises()]);
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const finished = all.filter((w) => w.finishedAt && w.id !== workout.id).slice(0, 60);
  const list = h('div', { class: 'pick-list' });

  if (!finished.length) {
    list.append(h('p', { class: 'pick-empty muted', text: 'No finished sessions yet.' }));
  } else {
    for (const w of finished) {
      const sets = await listSetsForWorkout(w.id);
      const entries = getEntries(w, sets);
      const names = entries.map((e) => (exMap.get(e.exerciseId) || {}).name).filter(Boolean);
      const row = h('div', { class: 'pick-row copy-row', 'data-workout-id': w.id, role: 'button', tabindex: '0' },
        h('span', { class: 'pick-row-main' },
          h('span', { class: 'pick-row-name', text: `${displayName(w)} · ${formatDate(w.date)}` }),
          h('span', { class: 'pick-row-sub', text: summarise(names, entries.length) }),
        ),
        h('span', { class: 'pick-row-chev' }, Icon('chevron')),
      );
      const use = async () => copyInto(workout, await skeletonFromWorkout(w.id), displayName(w));
      row.addEventListener('click', use);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); use(); } });
      list.append(row);
    }
  }

  screen.replaceChildren(copyHeader('Previous Sessions', '#/copy'), list);
  stagger(list.children, 'anim-card-settle');
}

/** "Bench Press, Lat Pulldown +3 more" */
function summarise(names, total) {
  if (!names.length) return 'Empty';
  const shown = names.slice(0, 2).join(', ');
  const rest = total - Math.min(2, names.length);
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

async function copyInto(workout, skeleton, label) {
  const added = await applySkeleton(workout, skeleton);
  if (!added) {
    openSheet(h('div', {},
      sheetHeader('Nothing to add', { onClose: () => closeSheet() }),
      h('p', { class: 'sheet-message muted', text: `Every exercise in "${label}" is already in this workout.` }),
    ));
    return;
  }
  go('#/workout');
}

// ============================================================================
// #/routine — create or edit a routine (a full screen, not a sheet: it is a
// build-it task, and a sheet over a sheet is where the old editor got fiddly)
// ============================================================================
export async function renderRoutineEditor(parts) {
  const screen = document.getElementById('s-routine');
  const mode = parts[0] || 'new';

  const allExercises = await listExercises();
  const exMap = new Map(allExercises.map((e) => [e.id, e]));

  let work = { id: null, name: '', entries: [] };
  let backHash = '#/copy/routines';

  if (mode === 'from') {
    // Prefilled from a workout: the "Save as routine" path. The skeleton is
    // already correct; all that is missing is a name.
    const workoutId = parts[1];
    const source = await getWorkout(workoutId);
    const skeleton = await skeletonFromWorkout(workoutId);
    work = {
      id: null,
      name: '',
      entries: skeleton.map((s) => ({
        exerciseId: s.exerciseId, targetSets: s.sets, targetRepsLow: 8, targetRepsHigh: 12,
      })),
    };
    backHash = source && !source.finishedAt ? '#/workout' : `#/workout/${workoutId}`;
  } else if (mode !== 'new') {
    const existing = await getTemplate(mode);
    if (!existing) { go('#/copy/routines'); return; }
    work = { id: existing.id, name: existing.name, entries: existing.entries.map((e) => ({ ...e })) };
  }

  const nameInput = h('input', {
    class: 'sheet-input routine-name-input', type: 'text', autocomplete: 'off',
    placeholder: 'Routine name', 'aria-label': 'Routine name',
  });
  nameInput.value = work.name;
  enhanceInput(nameInput);
  nameInput.addEventListener('input', () => { work.name = nameInput.value; error.hidden = true; });

  const error = h('p', { class: 'sheet-message danger', text: 'Give the routine a name and at least one exercise.' });
  error.hidden = true;

  const entriesWrap = h('div', { class: 'routine-entries' });
  const fillEntries = () => {
    if (!work.entries.length) {
      entriesWrap.replaceChildren(h('p', { class: 'sheet-message muted', text: 'No exercises yet. Tap Add exercise below.' }));
      return;
    }
    entriesWrap.replaceChildren(h('div', { class: 'sheet-group tpl-entries' },
      ...work.entries.map((entry, index) => {
        const name = (exMap.get(entry.exerciseId) || {}).name || 'Unknown exercise';
        const row = h('div', { class: 'tpl-entry-row' },
          h('div', { class: 'tpl-entry-main' },
            h('span', { class: 'tpl-entry-name', text: name }),
            h('div', { class: 'tpl-entry-fields' },
              tplField('Sets', entry.targetSets, (v) => { entry.targetSets = v; }),
              tplField('Low', entry.targetRepsLow, (v) => { entry.targetRepsLow = v; }),
              tplField('High', entry.targetRepsHigh, (v) => { entry.targetRepsHigh = v; }),
            ),
          ),
          h('button', {
            class: 'tpl-entry-remove', type: 'button', 'aria-label': `Remove ${name}`,
            onclick: () => { work.entries.splice(index, 1); fillEntries(); },
          }, Icon('close')),
        );
        return row;
      }),
    ));
  };
  fillEntries();

  const save = async () => {
    const name = work.name.trim();
    if (!name || !work.entries.length) { error.hidden = false; nameInput.focus(); return; }
    await putTemplate({ id: work.id || uid(), name, entries: work.entries, syncedAt: null });
    go(backHash);
  };

  screen.replaceChildren(
    h('header', { class: 'pick-head' },
      h('button', {
        class: 'round-btn', type: 'button', 'aria-label': 'Back',
        'data-action': 'routine-back', onclick: () => go(backHash),
      }, Icon('back')),
      h('div', { class: 'pick-title', text: work.id ? 'Edit Routine' : 'New Routine' }),
      h('button', {
        class: 'sheet-tick', type: 'button', 'aria-label': 'Save routine',
        'data-action': 'routine-save', onclick: save,
      }, Icon('check')),
    ),
    h('div', { class: 'tab-screen routine-screen' },
      error,
      h('div', { class: 'sheet-group' }, h('div', { class: 'sheet-input-row' }, nameInput)),
      entriesWrap,
      h('button', {
        class: 'add-exercise', type: 'button', 'data-action': 'routine-add-exercise',
        onclick: () => openExercisePicker(allExercises, (id) => {
          work.entries.push({ exerciseId: id, targetSets: 3, targetRepsLow: 8, targetRepsHigh: 12 });
          fillEntries();
        }),
      }, Icon('plus'), h('span', { text: 'Add exercise' })),
    ),
  );

  // Prefilled from a workout: the skeleton is done, so put the caret where the
  // only remaining decision is.
  if (mode === 'from' || mode === 'new') requestAnimationFrame(() => nameInput.focus());
}

function tplField(label, value, onCommit) {
  // type=text + inputmode=numeric (not type=number) so the caret helpers in
  // inputs.js can drive it — setSelectionRange throws on number inputs.
  const input = h('input', {
    class: 'tpl-num-input', type: 'text', inputmode: 'numeric',
    enterkeyhint: 'done', autocomplete: 'off', 'aria-label': label,
  });
  input.value = String(value);
  enhanceInput(input, { replaceOnType: true });
  input.addEventListener('blur', () => {
    let v = parseInt(input.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    input.value = String(v);
    onCommit(v);
  });
  return h('label', { class: 'tpl-field' }, h('span', { class: 'tpl-field-label', text: label }), input);
}

// ---- add-exercise sub-sheet -------------------------------------------------
function openExercisePicker(allExercises, onPick) {
  let query = '';
  const listWrap = h('div', { class: 'sheet-group' });
  const fill = () => {
    const q = query.trim().toLowerCase();
    const items = (q ? allExercises.filter((e) => e.name.toLowerCase().includes(q)) : allExercises)
      .slice().sort((a, b) => a.name.localeCompare(b.name));
    listWrap.replaceChildren(...(
      items.length
        ? items.map((e) => sheetRow({
          label: e.name, sub: titleCase(e.muscleGroup),
          onClick: () => { closeSheet(); onPick(e.id); },
        }))
        : [h('p', { class: 'sheet-message muted', text: 'No matches.' })]
    ));
  };
  fill();

  const search = h('input', {
    class: 'sheet-input', type: 'search',
    placeholder: 'Search exercises', 'aria-label': 'Search exercises',
  });
  search.addEventListener('input', () => { query = search.value; fill(); });

  openSheet(h('div', {},
    sheetHeader('Add exercise', { onClose: () => closeSheet() }),
    h('div', { class: 'sheet-group' }, h('div', { class: 'sheet-input-row' }, search)),
    listWrap,
  ));
  requestAnimationFrame(() => search.focus());
}
