// ============================================================================
// screens/workout.js — the workout screen (#/workout active, #/workout/:id past).
// Meta card, one card per exercise entry with an inline-editable set grid,
// one-tap Add Set (with rest-timer auto-start for the active workout), and the
// per-set / per-exercise bottom sheets. Past workouts are fully editable too.
//
// Matches screenshots 1 & 5 (cards + meta), sheets in 3–4.
// User text only ever via textContent / h() — never innerHTML.
// ============================================================================

import {
  getWorkout, putWorkout, deleteWorkout,
  listSetsForWorkout, putSet, getSet, deleteSet,
  listExercises, listSetsForExercise,
} from '../db.js';
import { getPRs, getLastSession } from '../queries.js';
import * as timer from '../timer.js';
import { uid } from '../util.js';
import {
  h, Icon, go, setCurrent,
  currentWorkout, getEntries, saveEntries, displayName,
  formatWeight, formatDate, formatDateTime, mmss, formatElapsed,
  kgToDisplay, displayToKg, unitLabel, trimNum,
  WEIGHT_STEP, RPE_VALUES,
  openSheet, closeSheet, sheetHeader, sheetGroup, sheetRow,
  confirmSheet, textareaSheet, setScreenCleanup,
} from '../ui.js';

// The screen re-renders itself after every mutation; renderTarget remembers
// which workout (null = the active one) so re-renders resolve the same target.
let renderTarget = null;
let elapsedTimer = null; // the active-workout elapsed ticker (one at a time)
const reRender = () => renderWorkoutScreen(renderTarget);
function stopElapsed() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } }

// ---- small data helpers ----------------------------------------------------
async function mutateWorkout(id, changes) {
  const w = await getWorkout(id);
  if (w) return putWorkout({ ...w, ...changes });
}
async function mutateSet(id, changes) {
  const s = await getSet(id);
  if (s) return putSet({ ...s, ...changes });
}
/** Renumber a single exercise's sets in a workout to stay 1-based contiguous. */
async function renumberExercise(workoutId, exerciseId) {
  const sets = (await listSetsForWorkout(workoutId))
    .filter((s) => s.exerciseId === exerciseId)
    .sort((a, b) => a.setNumber - b.setNumber);
  let n = 1;
  for (const s of sets) { if (s.setNumber !== n) await putSet({ ...s, setNumber: n }); n++; }
}
function topWorkingSet(sets) {
  const working = (sets || []).filter((s) => s.isWarmup !== true && s.setType !== 'cardio');
  if (!working.length) return null;
  return working.reduce((best, s) =>
    (s.weightKg > best.weightKg || (s.weightKg === best.weightKg && s.reps > best.reps)) ? s : best);
}
function setSummaryLine(s) {
  if (s.setType === 'cardio') {
    const parts = [mmss(s.durationSeconds || 0)];
    if (s.distanceM) parts.push(`${trimNum(s.distanceM)} m`);
    if (s.kcal) parts.push(`${trimNum(s.kcal)} kcal`);
    return parts.join(' · ');
  }
  return `${formatWeight(s.weightKg)} × ${s.reps}`
    + (s.isWarmup ? ' (W)' : '')
    + (s.rpe != null ? ` · RPE ${s.rpe}` : '');
}

// ============================================================================
// Render
// ============================================================================
export async function renderWorkoutScreen(workoutId) {
  renderTarget = workoutId ?? null;
  stopElapsed(); // clear any prior ticker before this (re-)render installs one
  const isActive = workoutId == null;
  const screen = document.getElementById('s-workout');

  const workout = isActive ? await currentWorkout() : await getWorkout(workoutId);
  if (!workout) { go('#/log'); return; }

  const sets = await listSetsForWorkout(workout.id);
  const exList = await listExercises();
  const exMap = new Map(exList.map((e) => [e.id, e]));
  const setsByEx = new Map();
  for (const s of sets) {
    if (!setsByEx.has(s.exerciseId)) setsByEx.set(s.exerciseId, []);
    setsByEx.get(s.exerciseId).push(s);
  }
  for (const arr of setsByEx.values()) arr.sort((a, b) => a.setNumber - b.setNumber);

  const entries = getEntries(workout, sets);

  const children = [
    buildHeader(workout, isActive),
    buildMetaCard(workout),
  ];

  // Group consecutive entries that share a non-null supersetGroup.
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (e.supersetGroup != null) {
      const g = e.supersetGroup;
      const run = [];
      while (i < entries.length && entries[i].supersetGroup === g) { run.push({ entry: entries[i], index: i }); i++; }
      children.push(h('div', { class: 'superset' },
        h('div', { class: 'superset-label', text: 'Superset' }),
        ...run.map((r) => buildEntryCard(r.entry, r.index, workout, entries, setsByEx, exMap, isActive)),
      ));
    } else {
      children.push(buildEntryCard(e, i, workout, entries, setsByEx, exMap, isActive));
      i++;
    }
  }

  children.push(h('button', {
    class: 'add-exercise', 'data-action': 'add-exercise', type: 'button', onclick: () => go('#/pick'),
  }, Icon('plus'), h('span', { text: 'Add Exercise' })));

  screen.replaceChildren(h('div', { class: 'workout-scroll' }, ...children));
}

// ---- header ----------------------------------------------------------------
function buildHeader(workout, isActive) {
  const tick = h('button', {
    class: 'w-tick', 'data-action': 'finish', 'aria-label': isActive ? 'Finish workout' : 'Done', type: 'button',
    onclick: () => isActive ? finishFlow(workout) : go('#/log'),
  }, Icon('check'));

  const centre = h('div', { class: 'w-head-centre' }, h('div', { class: 'w-date', text: formatDate(workout.date) }));
  if (isActive) {
    const el = h('span', { class: 'w-elapsed' });
    const tickFn = () => { el.textContent = formatElapsed(Date.now() - new Date(workout.startedAt)); };
    tickFn();
    elapsedTimer = setInterval(tickFn, 1000);
    setScreenCleanup(stopElapsed); // route change tears the ticker down
    centre.append(el);
  }

  return h('header', { class: 'w-head' },
    tick,
    centre,
    h('div', { class: 'w-head-actions' },
      h('button', { class: 'round-btn', 'aria-label': 'Rest timer', type: 'button', onclick: () => timerSheet() }, Icon('alarm')),
      h('button', { class: 'round-btn', 'aria-label': 'Workout menu', type: 'button', onclick: () => workoutMenu(workout, isActive) }, Icon('dots')),
    ),
  );
}

function finishFlow(workout) {
  confirmSheet({
    title: 'Finish workout?',
    message: 'You can still edit it later from the Log.',
    confirmLabel: 'Finish',
    onConfirm: async () => {
      await mutateWorkout(workout.id, { finishedAt: new Date().toISOString() });
      setCurrent(null);
      go('#/log');
    },
  });
}

function workoutMenu(workout, isActive) {
  const rows = [];
  if (!isActive && !workout.finishedAt) {
    rows.push(sheetRow({
      label: 'Resume', icon: Icon('swap'),
      onClick: () => { closeSheet(); setCurrent(workout.id); go('#/workout'); },
    }));
  }
  rows.push(sheetRow({
    label: 'Delete Workout', icon: Icon('trash'), danger: true,
    onClick: () => {
      closeSheet();
      confirmSheet({
        title: 'Delete workout?', message: 'This removes the workout and all its sets.',
        confirmLabel: 'Delete', danger: true,
        onConfirm: () => confirmSheet({
          title: 'Delete permanently?', message: 'This cannot be undone.',
          confirmLabel: 'Delete', danger: true,
          onConfirm: async () => {
            await deleteWorkout(workout.id);
            setCurrent(null);
            go('#/log');
          },
        }),
      });
    },
  }));
  openSheet(h('div', {},
    sheetHeader(displayName(workout), { onClose: () => closeSheet() }),
    sheetGroup(...rows),
  ));
}

function timerSheet() {
  let secs = timer.getDefaultRestSeconds();
  const val = h('span', { class: 'timer-val', text: mmss(secs) });
  const apply = (d) => { secs = Math.max(5, secs + d); timer.setDefaultRestSeconds(secs); val.textContent = mmss(secs); };
  const running = timer.remaining() > 0;
  openSheet(h('div', {},
    sheetHeader('Rest timer', { onClose: () => closeSheet() }),
    h('div', { class: 'sheet-label', text: 'Default rest' }),
    h('div', { class: 'timer-stepper' },
      h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Less rest', onclick: () => apply(-15) }, Icon('minus')),
      val,
      h('button', { class: 'round-btn', type: 'button', 'aria-label': 'More rest', onclick: () => apply(15) }, Icon('plus')),
    ),
    running
      ? sheetGroup(sheetRow({ label: 'Cancel current rest', icon: Icon('close'), danger: true, onClick: () => { timer.cancel(); closeSheet(); } }))
      : null,
  ));
}

// ---- meta card -------------------------------------------------------------
function buildMetaCard(workout) {
  const nameInput = h('input', { class: 'meta-name', type: 'text', placeholder: 'Name', 'aria-label': 'Workout name' });
  nameInput.value = workout.name || '';
  nameInput.addEventListener('blur', () => mutateWorkout(workout.id, { name: nameInput.value.trim() || null }));

  const bwInput = h('input', { class: 'meta-bw-input', type: 'number', inputmode: 'decimal', step: '0.1', 'aria-label': 'Bodyweight in kilograms', placeholder: '—' });
  bwInput.value = workout.bodyweightKg != null ? trimNum(workout.bodyweightKg) : '';
  bwInput.addEventListener('blur', () => {
    const v = parseFloat(bwInput.value);
    mutateWorkout(workout.id, { bodyweightKg: Number.isFinite(v) ? v : null });
  });

  return h('div', { class: 'wmeta' },
    h('div', { class: 'meta-name-row' }, nameInput),
    metaRow('Start Time', h('span', { class: 'meta-val', text: formatDateTime(workout.startedAt) })),
    metaRow('End Time', h('span', { class: 'meta-val', text: workout.finishedAt ? formatDateTime(workout.finishedAt) : '—' })),
    metaRow('Bodyweight (kg)', bwInput),
    h('button', {
      class: 'meta-row meta-notes', type: 'button',
      onclick: () => textareaSheet({
        title: 'Workout notes', value: workout.notes,
        onSave: async (v) => { await mutateWorkout(workout.id, { notes: v }); reRender(); },
      }),
    },
      h('span', { class: 'meta-label', text: workout.notes ? 'Notes' : '' }),
      h('span', { class: 'meta-val notes-val', text: workout.notes || 'Notes' }),
      h('span', { class: 'meta-chev' }, Icon('chevron')),
    ),
  );
}
function metaRow(label, valueEl) {
  return h('div', { class: 'meta-row' }, h('span', { class: 'meta-label', text: label }), valueEl);
}

// ---- exercise card ---------------------------------------------------------
function buildEntryCard(entry, index, workout, entries, setsByEx, exMap, isActive) {
  const exercise = exMap.get(entry.exerciseId);
  const name = exercise ? exercise.name : 'Unknown exercise';
  const exSets = setsByEx.get(entry.exerciseId) || [];
  const isCardio = exercise ? exercise.exerciseType === 'cardio' : false;

  const card = h('div', { class: 'ex-card', 'data-exercise-id': entry.exerciseId });

  card.append(h('div', { class: 'ex-card-head' },
    h('div', { class: 'ex-name', text: name }),
    h('button', {
      class: 'ex-menu', 'aria-label': 'Exercise menu', type: 'button',
      onclick: () => exerciseMenu(entry, index, workout, entries, exercise, isActive),
    }, Icon('dots')),
  ));
  if (entry.note) card.append(h('div', { class: 'ex-note', text: entry.note }));

  for (const s of exSets) card.append(buildSetRow(s, workout, exercise, isCardio, isActive));

  card.append(h('div', { class: 'ex-card-foot' },
    h('button', {
      class: 'add-set', 'data-exercise-id': entry.exerciseId, type: 'button',
      onclick: () => addSet(workout, exercise, entry.exerciseId, exSets, isCardio, isActive),
    }, Icon('plus'), h('span', { text: 'Add Set' })),
    h('div', { class: 'ex-icons' },
      h('button', { class: 'ex-icon', 'aria-label': 'History', type: 'button', onclick: () => historySheet(exercise, entry) }, Icon('history')),
      h('button', { class: 'ex-icon', 'aria-label': 'Personal records', type: 'button', onclick: () => prSheet(exercise) }, Icon('bars')),
      h('button', { class: 'ex-icon', 'aria-label': 'Personal records', type: 'button', onclick: () => prSheet(exercise) }, Icon('star')),
    ),
  ));

  return card;
}

// ---- set row + inline editing ----------------------------------------------
function buildSetRow(s, workout, exercise, isCardio, isActive) {
  const badge = h('span', { class: 'set-badge' + (s.isWarmup ? ' warm' : '') }, s.isWarmup ? 'W' : String(s.setNumber));
  const menuBtn = h('button', {
    class: 'set-menu', 'aria-label': 'Set options', type: 'button',
    onclick: () => setSheet(s, workout),
  }, Icon('dots'));

  let fields;
  if (isCardio) {
    fields = h('div', { class: 'set-fields cardio' },
      h('div', { class: 'set-line' },
        numField('Minutes', 'minutes', {
          value: Math.floor((s.durationSeconds || 0) / 60), step: 1, min: 0, integer: true,
          onCommit: async (v) => { await mutateSet(s.id, { durationSeconds: v * 60 + ((s.durationSeconds || 0) % 60) }); reRender(); },
        }),
        numField('Seconds', 'seconds', {
          value: (s.durationSeconds || 0) % 60, step: 5, min: 0, integer: true,
          onCommit: async (v) => { await mutateSet(s.id, { durationSeconds: Math.floor((s.durationSeconds || 0) / 60) * 60 + v }); reRender(); },
        }),
        noteField(s),
      ),
      h('div', { class: 'set-line' },
        numField('Distance', 'distance', {
          value: s.distanceM || 0, step: 100, min: 0, integer: true,
          onCommit: async (v) => { await mutateSet(s.id, { distanceM: v }); reRender(); },
        }),
        numField('Kcal', 'kcal', {
          value: s.kcal || 0, step: 5, min: 0, integer: true,
          onCommit: async (v) => { await mutateSet(s.id, { kcal: v }); reRender(); },
        }),
        h('span', { class: 'set-field spacer' }),
      ),
    );
  } else {
    fields = h('div', { class: 'set-fields' },
      numField(unitLabel(), 'weight', {
        value: kgToDisplay(s.weightKg), step: WEIGHT_STEP, min: 0, integer: false,
        onCommit: async (v) => { await mutateSet(s.id, { weightKg: displayToKg(v) }); reRender(); },
      }),
      numField('Reps', 'reps', {
        value: s.reps, step: 1, min: 0, integer: true,
        onCommit: async (v) => { await mutateSet(s.id, { reps: v }); reRender(); },
      }),
      noteField(s),
    );
  }

  return h('div', { class: 'set-row' + (s.isWarmup ? ' warm' : ''), 'data-set-id': s.id }, badge, fields, menuBtn);
}

function noteField(s) {
  return h('button', {
    class: 'set-field note-field', type: 'button',
    onclick: () => textareaSheet({
      title: 'Set note', value: s.notes,
      onSave: async (v) => { await mutateSet(s.id, { notes: v }); reRender(); },
    }),
  },
    h('span', { class: 'fl', text: 'Notes' }),
    h('span', { class: 'fv muted', text: s.notes || '' }),
  );
}

function numField(label, dataField, { value, step, min, integer, onCommit }) {
  const fv = h('span', { class: 'fv' }, trimNum(value));
  const btn = h('button', { class: 'set-field', 'data-field': dataField, type: 'button' },
    h('span', { class: 'fl', text: label }), fv);
  btn.addEventListener('click', () => {
    if (fv.querySelector('.feditor')) return;
    editNumber(fv, { value, step, min, integer, onCommit });
  });
  return btn;
}

function editNumber(fv, { value, step, min = 0, integer = false, onCommit }) {
  const input = h('input', { class: 'fedit', type: 'text', inputmode: integer ? 'numeric' : 'decimal' });
  input.value = trimNum(value);
  const round = (v) => (integer ? Math.round(v) : Math.round(v * 100) / 100);
  const clamp = (v) => (min != null && v < min ? min : v);
  const adjust = (delta) => {
    let v = parseFloat(input.value); if (!Number.isFinite(v)) v = 0;
    v = clamp(round(v + delta));
    input.value = trimNum(v);
    input.focus();
  };
  const dec = h('button', { class: 'fstep', type: 'button', 'aria-label': 'decrease', onpointerdown: (e) => { e.preventDefault(); adjust(-step); } }, Icon('minus'));
  const inc = h('button', { class: 'fstep', type: 'button', 'aria-label': 'increase', onpointerdown: (e) => { e.preventDefault(); adjust(step); } }, Icon('plus'));
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    let v = parseFloat(input.value); if (!Number.isFinite(v)) v = 0;
    onCommit(clamp(round(v)));
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  fv.replaceChildren(h('span', { class: 'feditor' }, dec, input, inc));
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

// ---- add set ---------------------------------------------------------------
async function addSet(workout, exercise, exerciseId, exSets, isCardio, isActive) {
  const prev = exSets[exSets.length - 1];
  const base = { id: uid(),
    workoutId: workout.id, exerciseId, setNumber: exSets.length + 1,
    rpe: null, isWarmup: false, notes: null, completedAt: new Date().toISOString() };

  if (isCardio) {
    Object.assign(base, {
      setType: 'cardio', weightKg: 0, reps: 0,
      durationSeconds: prev ? (prev.durationSeconds || 0) : 0,
      distanceM: prev ? (prev.distanceM || 0) : 0,
      kcal: prev ? (prev.kcal || 0) : 0,
    });
  } else {
    let weightKg = 20; let reps = 8;
    if (prev) { weightKg = prev.weightKg; reps = prev.reps; }
    else if (exercise) {
      const last = await getLastSession(exercise.id);
      const top = last ? topWorkingSet(last.sets) : null;
      if (top) { weightKg = top.weightKg; reps = top.reps; }
    }
    Object.assign(base, { setType: 'strength', weightKg, reps, durationSeconds: null, distanceM: null, kcal: null });
  }

  await putSet(base);
  if (isActive) timer.start(); // auto rest timer for the active workout only
  reRender();
}

// ---- per-set sheet ---------------------------------------------------------
function setSheet(set, workout) {
  const warmRow = sheetRow({
    label: 'Warm-up', value: set.isWarmup ? 'Yes' : 'No',
    onClick: async () => { closeSheet(); await mutateSet(set.id, { isWarmup: !set.isWarmup }); reRender(); },
  });

  let curRpe = set.rpe ?? null;
  const chipWrap = h('div', { class: 'rpe-chips' });
  const chips = RPE_VALUES.map((v) => h('button', {
    class: 'rpe-chip', type: 'button', 'aria-pressed': curRpe === v ? 'true' : 'false',
    onclick: async () => { curRpe = curRpe === v ? null : v; await mutateSet(set.id, { rpe: curRpe }); repaint(); reRender(); },
  }, String(v)));
  const clearChip = h('button', {
    class: 'rpe-chip clear', type: 'button',
    onclick: async () => { curRpe = null; await mutateSet(set.id, { rpe: null }); repaint(); reRender(); },
  }, 'Clear');
  const repaint = () => chips.forEach((c, i) => c.setAttribute('aria-pressed', curRpe === RPE_VALUES[i] ? 'true' : 'false'));
  chipWrap.append(...chips, clearChip);

  const noteRow = sheetRow({
    label: 'Note', icon: Icon('note'),
    onClick: () => textareaSheet({
      title: 'Set note', value: set.notes,
      onSave: async (v) => { await mutateSet(set.id, { notes: v }); reRender(); },
    }),
  });

  const delRow = sheetRow({
    label: 'Delete Set', icon: Icon('trash'), danger: true,
    onClick: () => {
      closeSheet();
      confirmSheet({
        title: 'Delete set?', confirmLabel: 'Delete', danger: true,
        onConfirm: async () => { await deleteSet(set.id); await renumberExercise(workout.id, set.exerciseId); reRender(); },
      });
    },
  });

  openSheet(h('div', {},
    sheetHeader(`Set ${set.setNumber}`, { onClose: () => closeSheet() }),
    sheetGroup(warmRow),
    h('div', { class: 'sheet-label', text: 'RPE' }),
    chipWrap,
    sheetGroup(noteRow),
    sheetGroup(delRow),
  ));
}

// ---- per-exercise sheet ----------------------------------------------------
function exerciseMenu(entry, index, workout, entries, exercise, isActive) {
  const move = async (dir) => {
    const j = index + dir;
    if (j < 0 || j >= entries.length) { closeSheet(); return; }
    const next = entries.slice();
    [next[index], next[j]] = [next[j], next[index]];
    closeSheet();
    await saveEntries(workout, next);
    reRender();
  };

  const rows = [
    sheetRow({ label: 'Move Up', icon: Icon('move'), onClick: () => move(-1) }),
    sheetRow({ label: 'Move Down', icon: Icon('move'), onClick: () => move(1) }),
    sheetRow({
      label: 'Delete', icon: Icon('trash'), danger: true,
      onClick: () => {
        closeSheet();
        confirmSheet({
          title: 'Delete exercise?', message: 'Removes it and its sets from this workout.',
          confirmLabel: 'Delete', danger: true,
          onConfirm: async () => {
            const next = entries.filter((_, k) => k !== index);
            await saveEntries(workout, next);
            const sets = (await listSetsForWorkout(workout.id)).filter((s) => s.exerciseId === entry.exerciseId);
            for (const s of sets) await deleteSet(s.id);
            reRender();
          },
        });
      },
    }),
  ];

  const addNote = sheetRow({
    label: 'Add Note', icon: Icon('note'),
    onClick: () => textareaSheet({
      title: 'Exercise note', value: entry.note,
      onSave: async (v) => {
        const next = entries.slice();
        next[index] = { ...entry, note: v };
        await saveEntries(workout, next);
        reRender();
      },
    }),
  });

  const info = [
    sheetRow({ label: 'History', icon: Icon('history'), onClick: () => { closeSheet(); historySheet(exercise, entry); } }),
    sheetRow({ label: 'Personal Records', icon: Icon('bars'), onClick: () => { closeSheet(); prSheet(exercise); } }),
  ];

  openSheet(h('div', {},
    sheetHeader(exercise ? exercise.name : 'Exercise', { onClose: () => closeSheet() }),
    sheetGroup(...rows),
    sheetGroup(addNote),
    sheetGroup(...info),
  ));
}

// ---- history & PR sheets ---------------------------------------------------
async function historySheet(exercise, entry) {
  const title = exercise ? exercise.name : 'History';
  if (!exercise) { openSheet(h('div', {}, sheetHeader('History', { onClose: () => closeSheet() }), emptyNote('No history yet.'))); return; }

  const sets = await listSetsForExercise(exercise.id);
  const byW = new Map();
  for (const s of sets) { if (!byW.has(s.workoutId)) byW.set(s.workoutId, []); byW.get(s.workoutId).push(s); }
  const workouts = (await Promise.all([...byW.keys()].map((id) => getWorkout(id))))
    .filter((w) => w && w.finishedAt)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.startedAt < b.startedAt ? 1 : -1)))
    .slice(0, 3);

  const body = [sheetHeader(title, { onClose: () => closeSheet() })];
  if (!workouts.length) body.push(emptyNote('No previous sessions yet.'));
  for (const w of workouts) {
    const wSets = byW.get(w.id).slice().sort((a, b) => a.setNumber - b.setNumber);
    body.push(h('div', { class: 'sheet-history' },
      h('div', { class: 'sheet-history-date', text: formatDate(w.date) }),
      ...wSets.map((s) => h('div', { class: 'sheet-history-set' },
        h('span', { class: 'shs-badge', text: s.isWarmup ? 'W' : String(s.setNumber) }),
        h('span', { text: setSummaryLine(s) }),
      )),
    ));
  }
  openSheet(h('div', {}, ...body));
}

async function prSheet(exercise) {
  if (!exercise) { openSheet(h('div', {}, sheetHeader('Personal Records', { onClose: () => closeSheet() }), emptyNote('No records yet.'))); return; }
  const { byReps, bestE1RM } = await getPRs(exercise.id);
  const body = [sheetHeader(exercise.name, { onClose: () => closeSheet() })];

  if (!bestE1RM) {
    body.push(emptyNote('No records yet.'));
  } else {
    body.push(h('div', { class: 'pr-best' },
      h('div', { class: 'pr-best-label', text: 'Best estimated 1RM' }),
      h('div', { class: 'pr-best-val', text: formatWeight(bestE1RM.value) }),
      h('div', { class: 'pr-best-sub', text: `${formatWeight(bestE1RM.weightKg)} × ${bestE1RM.reps} · ${formatDate(bestE1RM.date)}` }),
    ));
    body.push(h('div', { class: 'pr-table' },
      h('div', { class: 'pr-row pr-head' }, h('span', { text: 'Reps' }), h('span', { text: 'Best' }), h('span', { text: 'Date' })),
      ...byReps.map((r) => h('div', { class: 'pr-row' },
        h('span', { text: String(r.reps) }),
        h('span', { text: formatWeight(r.weightKg) }),
        h('span', { text: formatDate(r.date) }),
      )),
    ));
  }
  openSheet(h('div', {}, ...body));
}

function emptyNote(text) {
  return h('p', { class: 'sheet-message muted', text });
}
