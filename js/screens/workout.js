// ============================================================================
// screens/workout.js — the workout screen (#/workout active, #/workout/:id past).
// Meta card, one card per exercise entry with a set grid of ALWAYS-PRESENT
// inputs (RepCount-style: type straight in, last-session values shown as grey
// placeholders), one-tap Add Set (duplicates the previous set, auto rest timer
// on the active workout), and the per-set / per-exercise bottom sheets.
//
// Smoothness rules: numeric commits and Add Set touch the DOM surgically —
// no full-screen re-render, no focus/scroll loss. Structural changes (delete,
// reorder, warmup toggle) still re-render the screen.
// User text only ever via textContent / h() — never innerHTML.
// ============================================================================

import {
  getWorkout, putWorkout, deleteWorkout,
  listSetsForWorkout, putSet, getSet, deleteSet,
  listExercises, listSetsForExercise,
} from '../db.js';
import { getPRs, getLastSession } from '../queries.js';
import * as timer from '../timer.js';
import { nowISO } from '../util.js';
import {
  h, Icon, go, setCurrent,
  currentWorkout, getEntries, saveEntries, displayName,
  formatWeight, formatDate, formatDateTime, mmss, formatElapsed,
  kgToDisplay, displayToKg, unitLabel, trimNum,
  RPE_VALUES,
  openSheet, closeSheet, sheetHeader, sheetGroup, sheetRow,
  confirmSheet, textareaSheet, setScreenCleanup,
} from '../ui.js';
import { normalizeExerciseType, blankSet } from '../exercise-types.js';
import { getSetting } from '../settings.js';
import { enhanceInput } from '../inputs.js';
import { editExerciseSheet } from './picker.js';

// The screen re-renders itself after every structural mutation; renderTarget
// remembers which workout (null = the active one) so re-renders resolve the
// same target.
let renderTarget = null;
let elapsedTimer = null; // the active-workout elapsed ticker (one at a time)
const reRender = () => renderWorkoutScreen(renderTarget);
function stopElapsed() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } }

// ---- keep screen on (Screen Wake Lock API) ---------------------------------
// Held only while the ACTIVE workout screen is on show and the setting is on.
// The lock is dropped by the browser whenever the tab is hidden, so we re-ask
// on visibilitychange. Every path is feature-detected and swallows rejections:
// no support (Safari < 16.4, Firefox), a denied request or a lock released
// under us must never surface as an error on the logging screen.
let wakeLock = null;
let wakeHandler = null; // the visibilitychange listener, when installed

async function requestWakeLock() {
  if (wakeLock || !wakeHandler) return; // already held, or the screen has gone
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!wakeHandler) { lock.release().catch(() => { /* left mid-await */ }); return; }
    wakeLock = lock;
    lock.addEventListener?.('release', () => { if (wakeLock === lock) wakeLock = null; });
  } catch { /* denied, or not permitted in this state — carry on without it */ }
}

function startWakeLock() {
  if (wakeHandler) return; // already running for this screen
  if (!getSetting('keepScreenOn')) return;
  if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
  wakeHandler = () => { if (document.visibilityState === 'visible') requestWakeLock(); };
  document.addEventListener('visibilitychange', wakeHandler);
  requestWakeLock();
}

function stopWakeLock() {
  if (wakeHandler) { document.removeEventListener('visibilitychange', wakeHandler); wakeHandler = null; }
  const lock = wakeLock;
  wakeLock = null;
  if (lock) { try { lock.release().catch(() => { /* already gone */ }); } catch { /* noop */ } }
}

/** Route-change teardown for the active workout screen. */
function teardownWorkoutScreen() { stopElapsed(); stopWakeLock(); }

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
function setSummaryLine(s) {
  if (s.setType === 'cardio' || (s.durationSeconds != null && !s.reps)) {
    const parts = [mmss(s.durationSeconds || 0)];
    if (s.distanceM) parts.push(`${trimNum(s.distanceM)} m`);
    if (s.kcal) parts.push(`${trimNum(s.kcal)} kcal`);
    if (s.weightKg) parts.unshift(formatWeight(s.weightKg));
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
  // Structural re-renders of the SAME active workout keep the existing lock —
  // dropping and re-taking it would let the screen dim for a frame. Leaving the
  // screen goes through setScreenCleanup instead, which does release it.
  if (!isActive) stopWakeLock();

  const workout = isActive ? await currentWorkout() : await getWorkout(workoutId);
  if (!workout) { go('#/log'); return; }

  if (isActive) startWakeLock(); // no-op unless supported, enabled, and not already held

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

  // Last-session reference sets per exercise — the grey placeholders.
  const lastByEx = new Map();
  await Promise.all([...new Set(entries.map((e) => e.exerciseId))].map(async (id) => {
    const last = await getLastSession(id);
    lastByEx.set(id, last && last.workout.id !== workout.id ? last.sets : null);
  }));

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
        ...run.map((r) => buildEntryCard(r.entry, r.index, workout, entries, setsByEx, exMap, lastByEx, isActive)),
      ));
    } else {
      children.push(buildEntryCard(e, i, workout, entries, setsByEx, exMap, lastByEx, isActive));
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
  const centre = h('div', { class: 'w-head-centre' }, h('div', { class: 'w-date', text: formatDate(workout.date) }));
  const actions = h('div', { class: 'w-head-actions' },
    isActive ? h('button', { class: 'round-btn', 'aria-label': 'Rest timer', type: 'button', onclick: () => timerSheet() }, Icon('alarm')) : null,
    h('button', { class: 'round-btn', 'aria-label': 'Workout menu', type: 'button', onclick: () => workoutMenu(workout, isActive) }, Icon('dots')),
  );

  if (isActive) {
    const el = h('span', { class: 'w-elapsed' });
    const tickFn = () => { el.textContent = formatElapsed(Date.now() - new Date(workout.startedAt)); };
    tickFn();
    elapsedTimer = setInterval(tickFn, 1000);
    setScreenCleanup(teardownWorkoutScreen); // route change stops the ticker and drops the wake lock
    centre.append(el);

    return h('header', { class: 'w-head' },
      h('button', {
        class: 'round-btn', 'data-action': 'minimise', 'aria-label': 'Minimise workout', type: 'button',
        onclick: () => go('#/log'), // workout keeps running; the resume bar takes over
      }, Icon('down')),
      h('button', {
        class: 'w-finish', 'data-action': 'finish', type: 'button',
        onclick: () => finishFlow(workout),
      }, 'Finish'),
      centre,
      actions,
    );
  }

  return h('header', { class: 'w-head' },
    h('button', {
      class: 'round-btn', 'data-action': 'finish', 'aria-label': 'Back to log', type: 'button',
      onclick: () => go('#/log'),
    }, Icon('back')),
    centre,
    actions,
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
  const nameInput = h('input', { class: 'meta-name', type: 'text', placeholder: 'Name', 'aria-label': 'Workout name', autocomplete: 'off' });
  nameInput.value = workout.name || '';
  enhanceInput(nameInput);
  nameInput.addEventListener('blur', () => mutateWorkout(workout.id, { name: nameInput.value.trim() || null }));

  const bwInput = h('input', { class: 'meta-bw-input', type: 'text', inputmode: 'decimal', enterkeyhint: 'done', 'aria-label': 'Bodyweight in kilograms', placeholder: '—' });
  bwInput.value = workout.bodyweightKg != null ? trimNum(workout.bodyweightKg) : '';
  enhanceInput(bwInput, { replaceOnType: true });
  bwInput.addEventListener('blur', () => {
    const v = parseFloat(bwInput.value.replace(',', '.'));
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
function buildEntryCard(entry, index, workout, entries, setsByEx, exMap, lastByEx, isActive) {
  const exercise = exMap.get(entry.exerciseId);
  const name = exercise ? exercise.name : 'Unknown exercise';
  const exSets = setsByEx.get(entry.exerciseId) || [];
  const refSets = lastByEx.get(entry.exerciseId) || null;

  const card = h('div', { class: 'ex-card', 'data-exercise-id': entry.exerciseId });

  card.append(h('div', { class: 'ex-card-head' },
    h('div', { class: 'ex-name', text: name }),
    h('button', {
      class: 'ex-menu', 'aria-label': 'Exercise menu', type: 'button',
      onclick: () => exerciseMenu(entry, index, workout, entries, exercise, isActive),
    }, Icon('dots')),
  ));
  if (entry.note) card.append(h('div', { class: 'ex-note', text: entry.note }));

  for (const s of exSets) card.append(buildSetRow(s, workout, exercise, refSets, isActive));

  const addBtn = h('button', {
    class: 'add-set', 'data-exercise-id': entry.exerciseId, type: 'button',
  }, Icon('plus'), h('span', { text: 'Add Set' }));
  addBtn.addEventListener('click', async () => {
    if (addBtn.disabled) return; // no duplicate sets from a double-tap
    addBtn.disabled = true;
    try { await addSet(workout, exercise, entry.exerciseId, exSets, refSets, isActive, card); }
    finally { addBtn.disabled = false; }
  });

  card.append(h('div', { class: 'ex-card-foot' },
    addBtn,
    h('div', { class: 'ex-icons' },
      h('button', { class: 'ex-icon', 'aria-label': 'History', type: 'button', onclick: () => historySheet(exercise, entry) }, Icon('history')),
      h('button', { class: 'ex-icon', 'aria-label': 'Personal records', type: 'button', onclick: () => prSheet(exercise) }, Icon('bars')),
      h('button', { class: 'ex-icon', 'aria-label': 'Personal records', type: 'button', onclick: () => prSheet(exercise) }, Icon('star')),
    ),
  ));

  return card;
}

// ---- set grid: always-present inputs ----------------------------------------
// Per-type field layout. Each inner array is one .set-line; 'notes' is the
// notes button, 'spacer' pads the second line so columns align.
const LAYOUTS = {
  weight_reps: [['weight', 'reps', 'notes']],
  bw_weight_reps: [['weight', 'reps', 'notes']],
  bw_assisted_reps: [['weight', 'reps', 'notes']],
  reps: [['reps', 'notes']],
  time: [['minutes', 'seconds', 'notes']],
  weight_time: [['weight', 'minutes', 'seconds', 'notes']],
  weight_distance: [['weight', 'distance', 'notes']],
  weight_distance_time: [['weight', 'distance', 'notes'], ['minutes', 'seconds', 'spacer']],
  cardio: [['minutes', 'seconds', 'notes'], ['distance', 'kcal', 'spacer']],
  notes: [['notes']],
};

/**
 * Field definitions bound to a live set record `s`. `text` renders the stored
 * value ('' when untouched/zero, so the grey placeholder shows through);
 * `commit(n)` returns the SetRecord changes for a typed number; `ref` renders
 * the placeholder from the matching last-session set.
 */
function cellDef(field, s, exercise) {
  const assisted = exercise && normalizeExerciseType(exercise.exerciseType) === 'bw_assisted_reps';
  switch (field) {
    case 'weight': return {
      label: assisted ? `- ${unitLabel()}` : unitLabel(), decimal: true,
      text: () => (s.weightKg > 0 ? trimNum(kgToDisplay(s.weightKg)) : ''),
      commit: (n) => ({ weightKg: displayToKg(Math.max(0, n)) }),
      ref: (r) => trimNum(kgToDisplay((r && r.weightKg) || 0)),
    };
    case 'reps': return {
      label: 'Reps', decimal: false,
      text: () => (s.reps > 0 ? String(s.reps) : ''),
      commit: (n) => ({ reps: Math.max(0, Math.round(n)) }),
      ref: (r) => String((r && r.reps) || 0),
    };
    case 'minutes': return {
      label: 'Min', decimal: false,
      text: () => { const m = Math.floor((s.durationSeconds || 0) / 60); return m > 0 ? String(m) : ''; },
      commit: (n) => ({ durationSeconds: Math.max(0, Math.round(n)) * 60 + ((s.durationSeconds || 0) % 60) }),
      ref: (r) => String(Math.floor(((r && r.durationSeconds) || 0) / 60)),
    };
    case 'seconds': return {
      label: 'Sec', decimal: false,
      text: () => { const v = (s.durationSeconds || 0) % 60; return v > 0 ? String(v) : ''; },
      commit: (n) => ({ durationSeconds: Math.floor((s.durationSeconds || 0) / 60) * 60 + Math.min(59, Math.max(0, Math.round(n))) }),
      ref: (r) => String(((r && r.durationSeconds) || 0) % 60),
    };
    case 'distance': return {
      label: 'Metres', decimal: false,
      text: () => (s.distanceM > 0 ? trimNum(s.distanceM) : ''),
      commit: (n) => ({ distanceM: Math.max(0, Math.round(n)) }),
      ref: (r) => trimNum((r && r.distanceM) || 0),
    };
    case 'kcal': return {
      label: 'Kcal', decimal: false,
      text: () => (s.kcal > 0 ? trimNum(s.kcal) : ''),
      commit: (n) => ({ kcal: Math.max(0, Math.round(n)) }),
      ref: (r) => trimNum((r && r.kcal) || 0),
    };
    default: return null;
  }
}

/**
 * Autofill weight: entering reps on a set that still has no weight pulls the
 * weight straight from the matching last-session set — the grey placeholder
 * you were looking at becomes real. It is deliberately timid; it bails on any
 * hint that the user has an opinion about the weight.
 *
 * Mutates `changes` in place so the caller persists reps and weight in a
 * SINGLE mutateSet, and writes the sibling input directly so only that row's
 * DOM moves (no re-render, no lost keyboard).
 *
 * @param {HTMLInputElement} repsInput the reps field that just committed
 * @param {object} s      the live set record (already carrying `changes`)
 * @param {object|null} refSet  last session's matching set
 * @param {object|null} exercise
 * @param {object} changes the commit payload, extended here
 */
function autofillWeight(repsInput, s, refSet, exercise, changes) {
  if (!getSetting('autofillWeight')) return;
  if (!(changes.reps > 0)) return;            // blanked to 0, or nonsense typed
  if (s.weightKg > 0) return;                 // already has a weight — never overwrite
  if (!refSet || !(refSet.weightKg > 0)) return; // nothing to copy from
  // Only for layouts that actually show a weight (skips reps/time/cardio/notes).
  const type = normalizeExerciseType(exercise ? exercise.exerciseType : null);
  const layout = LAYOUTS[type] || LAYOUTS.weight_reps;
  if (!layout.some((line) => line.includes('weight'))) return;
  const row = repsInput.closest('.set-row');
  const weightInput = row && row.querySelector('input[data-field="weight"]');
  if (!weightInput || weightInput.value !== '') return; // the user typed one — leave it

  changes.weightKg = refSet.weightKg;
  s.weightKg = refSet.weightKg;
  weightInput.value = trimNum(kgToDisplay(refSet.weightKg));
}

function setInputCell(field, s, refSet, exercise) {
  const def = cellDef(field, s, exercise);
  const input = h('input', {
    class: 'set-input', 'data-field': field,
    type: 'text', inputmode: def.decimal ? 'decimal' : 'numeric',
    enterkeyhint: 'done', autocomplete: 'off',
    placeholder: def.ref(refSet), 'aria-label': def.label,
  });
  input.value = def.text();

  // Numeric mode: caret to the end, first keystroke replaces (see inputs.js).
  enhanceInput(input, { replaceOnType: true });

  let atFocus = input.value;
  input.addEventListener('focus', () => { atFocus = input.value; });
  input.addEventListener('blur', () => {
    if (input.value === atFocus) return; // untouched — no write, no churn
    const raw = input.value.trim().replace(',', '.');
    const n = raw === '' ? 0 : parseFloat(raw);
    const changes = def.commit(Number.isFinite(n) ? n : 0);
    Object.assign(s, changes); // keep the in-memory record current for Add Set duplication
    input.value = def.text(); // canonical display (blanks a zero back to placeholder)
    // May add weightKg to `changes` (and paint the sibling input) before we write.
    if (field === 'reps') autofillWeight(input, s, refSet, exercise, changes);
    mutateSet(s.id, changes); // persist quietly — no re-render, keyboard stays put
  });

  return h('label', { class: 'set-field' }, h('span', { class: 'fl', text: def.label }), input);
}

function buildSetRow(s, workout, exercise, refSets, isActive) {
  const type = normalizeExerciseType(exercise ? exercise.exerciseType : null);
  const layout = LAYOUTS[type] || LAYOUTS.weight_reps;
  // Placeholder source: same set number last session, else its final set.
  const ref = refSets && refSets.length ? (refSets[s.setNumber - 1] || refSets[refSets.length - 1]) : null;

  const badge = h('span', { class: 'set-badge' + (s.isWarmup ? ' warm' : '') }, s.isWarmup ? 'W' : String(s.setNumber));
  const menuBtn = h('button', {
    class: 'set-menu', 'aria-label': 'Set options', type: 'button',
    onclick: () => setSheet(s, workout),
  }, Icon('dots'));

  const lines = layout.map((cells) => h('div', { class: 'set-line' }, ...cells.map((c) => {
    if (c === 'notes') return noteField(s);
    if (c === 'spacer') return h('span', { class: 'set-field spacer' });
    return setInputCell(c, s, ref, exercise);
  })));

  return h('div', { class: 'set-row' + (s.isWarmup ? ' warm' : ''), 'data-set-id': s.id },
    badge, h('div', { class: 'set-fields' + (lines.length > 1 ? ' multi' : '') }, ...lines), menuBtn);
}

// Notes is a direct inline input like Kg/Reps — no sheet. Free text, commits
// on blur; text mode, so tapping mid-word keeps the caret where you tapped.
function noteField(s) {
  const input = h('input', {
    class: 'set-input note-input', 'data-field': 'notes',
    type: 'text', enterkeyhint: 'done', autocomplete: 'off',
    'aria-label': 'Set notes',
  });
  input.value = s.notes || '';
  enhanceInput(input);

  let atFocus = input.value;
  input.addEventListener('focus', () => { atFocus = input.value; });
  input.addEventListener('blur', () => {
    if (input.value === atFocus) return;
    const v = input.value.trim() || null;
    s.notes = v;
    input.value = v || '';
    mutateSet(s.id, { notes: v }); // persist quietly — no re-render
  });

  return h('label', { class: 'set-field note-field' },
    h('span', { class: 'fl', text: 'Notes' }), input);
}

// ---- add set ---------------------------------------------------------------
// One tap duplicates the previous set (values already committed by its inputs);
// the new row is inserted in place — no full re-render, no scroll jump.
async function addSet(workout, exercise, exerciseId, exSets, refSets, isActive, card) {
  const prev = exSets[exSets.length - 1];
  const base = blankSet(workout.id, exercise || { id: exerciseId, exerciseType: null }, exSets.length + 1);
  base.completedAt = nowISO();
  if (prev) {
    base.weightKg = prev.weightKg;
    base.reps = prev.reps;
    base.durationSeconds = prev.durationSeconds;
    base.distanceM = prev.distanceM;
    base.kcal = prev.kcal;
  }
  await putSet(base);
  exSets.push(base);
  const row = buildSetRow(base, workout, exercise, refSets, isActive);
  card.querySelector('.ex-card-foot').before(row);
  // Auto rest timer: active workout only, and only when the setting is on.
  if (isActive && getSetting('autoStartTimer')) timer.start();
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
    onclick: async () => { curRpe = curRpe === v ? null : v; set.rpe = curRpe; await mutateSet(set.id, { rpe: curRpe }); repaint(); },
  }, String(v)));
  const clearChip = h('button', {
    class: 'rpe-chip clear', type: 'button',
    onclick: async () => { curRpe = null; set.rpe = null; await mutateSet(set.id, { rpe: null }); repaint(); },
  }, 'Clear');
  const repaint = () => chips.forEach((c, i) => c.setAttribute('aria-pressed', curRpe === RPE_VALUES[i] ? 'true' : 'false'));
  chipWrap.append(...chips, clearChip);

  const noteRow = sheetRow({
    label: 'Note', icon: Icon('note'),
    onClick: () => textareaSheet({
      title: 'Set note', value: set.notes,
      onSave: async (v) => { await mutateSet(set.id, { notes: v }); set.notes = v; reRender(); },
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
    sheetRow({ label: 'Move Up', icon: Icon('up'), onClick: () => move(-1) }),
    sheetRow({ label: 'Move Down', icon: Icon('down'), onClick: () => move(1) }),
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

  // Settings opens the SAME edit sheet as the exercise library (name, category,
  // type, equipment-agnostic flags); a type change re-renders the set grid.
  const settings = exercise ? sheetRow({
    label: 'Settings', icon: Icon('info'), action: 'exercise-settings',
    onClick: () => { closeSheet(); editExerciseSheet(exercise, () => reRender()); },
  }) : null;

  const info = [
    sheetRow({ label: 'History', icon: Icon('history'), onClick: () => { closeSheet(); historySheet(exercise, entry); } }),
    sheetRow({ label: 'Personal Records', icon: Icon('bars'), onClick: () => { closeSheet(); prSheet(exercise); } }),
  ];

  openSheet(h('div', {},
    sheetHeader(exercise ? exercise.name : 'Exercise', { onClose: () => closeSheet() }),
    sheetGroup(...rows),
    sheetGroup(addNote),
    settings ? sheetGroup(settings) : null,
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
