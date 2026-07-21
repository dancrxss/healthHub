// ============================================================================
// ui.js — screens, rendering, event wiring, hash router.
// The only UI file. Talks to db.js / queries.js / timer.js / seed.js / sync.js
// through their exported APIs. No data logic lives here beyond glue + display.
// User-supplied text (notes, custom exercise names) is only ever written via
// textContent / createElement — never innerHTML.
// ============================================================================

import {
  putWorkout, getWorkout, listWorkouts, deleteWorkout,
  putSet, getSet, listSetsForWorkout, deleteSet,
  putExercise, getExercise, listExercises,
  getTemplate, listTemplates,
  MUSCLE_GROUPS, EQUIPMENT,
} from './db.js';
import { getRecentWorkouts, getLastSession } from './queries.js';
import { seedIfEmpty } from './seed.js';
import { getActiveAdapter } from './sync.js';
import * as timer from './timer.js';
import { uid, nowISO, todayISO } from './util.js';

// ----------------------------------------------------------------------------
// Constants & module state
// ----------------------------------------------------------------------------
const LB_PER_KG = 2.20462;
const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
const WEIGHT_STEP = 2.5;
const REP_STEP = 1;

const state = { currentWorkoutId: null };
let currentRouteKey = null;
let activeInterval = null;
// Transient logging-screen state; null means "rebuild pre-fill from data".
let logState = null;
let pickQuery = '';

const screens = {
  home: document.getElementById('s-home'),
  workout: document.getElementById('s-workout'),
  log: document.getElementById('s-log'),
  pick: document.getElementById('s-pick'),
  history: document.getElementById('s-history'),
  detail: document.getElementById('s-detail'),
  settings: document.getElementById('s-settings'),
};

// ----------------------------------------------------------------------------
// Tiny DOM builder (hyperscript). No innerHTML anywhere.
// ----------------------------------------------------------------------------
function h(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'onclick') e.addEventListener('click', v);
      else if (k === 'oninput') e.addEventListener('input', v);
      else if (k === 'onchange') e.addEventListener('change', v);
      else if (k === 'onblur') e.addEventListener('blur', v);
      else if (k === 'onsubmit') e.addEventListener('submit', v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

// ----------------------------------------------------------------------------
// Formatting helpers
// ----------------------------------------------------------------------------
function getUnits() {
  return localStorage.getItem('settings.units') === 'lb' ? 'lb' : 'kg';
}

function trimNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** Single source of truth for weight display. Storage stays kg; lb is display. */
function formatWeight(kg) {
  if (kg == null || Number.isNaN(kg)) return '—';
  if (getUnits() === 'lb') {
    const lb = Math.round(kg * LB_PER_KG * 2) / 2;
    return `${trimNum(lb)} lb`;
  }
  return `${trimNum(kg)} kg`;
}

function mmss(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

function formatDate(iso) {
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function workoutDuration(w) {
  if (!w.finishedAt) return null;
  const mins = Math.round((new Date(w.finishedAt) - new Date(w.startedAt)) / 60000);
  return `${mins} min`;
}

/** Distinct exercise ids in first-logged order (earliest completedAt first). */
function exercisesInOrder(sets) {
  const firstAt = new Map();
  for (const s of sets) {
    const cur = firstAt.get(s.exerciseId);
    if (cur == null || s.completedAt < cur) firstAt.set(s.exerciseId, s.completedAt);
  }
  return [...firstAt.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map((e) => e[0]);
}

function workingCount(sets) {
  return sets.filter((s) => s.isWarmup !== true).length;
}
function totalVolume(sets) {
  return sets.filter((s) => s.isWarmup !== true).reduce((a, s) => a + s.weightKg * s.reps, 0);
}

async function exerciseMap() {
  const list = await listExercises();
  return new Map(list.map((e) => [e.id, e]));
}

// ----------------------------------------------------------------------------
// Navigation & current-workout resolution
// ----------------------------------------------------------------------------
function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function setCurrent(id) {
  state.currentWorkoutId = id;
  if (id) localStorage.setItem('currentWorkoutId', id);
  else localStorage.removeItem('currentWorkoutId');
}

/** The in-progress workout (finishedAt null), resolved robustly across reloads. */
async function currentWorkout() {
  const id = state.currentWorkoutId || localStorage.getItem('currentWorkoutId');
  if (id) {
    const w = await getWorkout(id);
    if (w && !w.finishedAt) {
      state.currentWorkoutId = id;
      return w;
    }
  }
  const all = await listWorkouts('0000');
  const inProgress = all.find((w) => !w.finishedAt);
  if (inProgress) {
    setCurrent(inProgress.id);
    return inProgress;
  }
  setCurrent(null);
  return null;
}

async function startWorkout(templateId = null) {
  const w = await putWorkout({
    id: uid(),
    date: todayISO(),
    startedAt: nowISO(),
    finishedAt: null,
    templateId,
    notes: null,
  });
  setCurrent(w.id);
  go('#/workout');
}

// ----------------------------------------------------------------------------
// Router
// ----------------------------------------------------------------------------
function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  window.scrollTo(0, 0);
}

async function route() {
  if (activeInterval) { clearInterval(activeInterval); activeInterval = null; }
  const raw = (location.hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  const key = parts.join('/');
  if (key !== currentRouteKey) {
    logState = null;
    pickQuery = '';
    currentRouteKey = key;
  }
  const [a, b] = parts;
  try {
    if (!a) return await renderHome();
    if (a === 'workout' && !b) return await renderWorkout();
    if (a === 'workout' && b) return await renderDetail(b);
    if (a === 'log' && b) return await renderLog(b);
    if (a === 'pick') return await renderPick();
    if (a === 'history') return await renderHistory();
    if (a === 'settings') return await renderSettings();
    return await renderHome();
  } catch (err) {
    console.error('route error', err);
  }
}

// ----------------------------------------------------------------------------
// Header helper
// ----------------------------------------------------------------------------
function header(title, backHash, action) {
  return h('header', { class: 'app-header' },
    backHash ? h('a', { class: 'back', href: '#' + backHash }, '‹ Back') : null,
    h('h1', { class: 'app-title', text: title }),
    action || null,
  );
}

// ----------------------------------------------------------------------------
// Home (#/)
// ----------------------------------------------------------------------------
async function renderHome() {
  showScreen('home');
  const inProgress = (await listWorkouts('0000')).find((w) => !w.finishedAt);
  const templates = await listTemplates();
  const recent = (await getRecentWorkouts('0000')).slice(0, 5);

  const children = [
    header('Gym Tracker', null, h('a', { class: 'header-action', href: '#/settings' }, 'Settings')),
  ];

  if (inProgress) {
    setCurrent(inProgress.id);
    children.push(
      h('button', {
        class: 'btn btn-primary', onclick: () => go('#/workout'),
      }, 'Resume workout'),
      h('p', { class: 'muted', text: `In progress since ${formatDate(inProgress.startedAt)}` }),
    );
  } else {
    children.push(
      h('button', { class: 'btn btn-primary', onclick: () => startWorkout() }, 'Start workout'),
    );
    if (templates.length) {
      children.push(h('div', { class: 'section-label', text: 'Start from template' }));
      for (const t of templates) {
        children.push(h('button', {
          class: 'btn', onclick: () => startWorkout(t.id),
        }, t.name));
      }
    }
  }

  children.push(h('div', { class: 'section-label', text: 'Recent workouts' }));
  if (!recent.length) {
    children.push(h('p', { class: 'empty', text: 'No workouts yet. Start one above.' }));
  } else {
    for (const { workout, sets } of recent) {
      const exCount = new Set(sets.map((s) => s.exerciseId)).size;
      children.push(h('a', { class: 'card', href: `#/workout/${workout.id}` },
        h('div', { class: 'card-title', text: formatDate(workout.date) }),
        h('div', { class: 'card-sub', text:
          `${exCount} exercise${exCount === 1 ? '' : 's'} · ${workingCount(sets)} working set${workingCount(sets) === 1 ? '' : 's'}` +
          (workout.finishedAt ? '' : ' · in progress') }),
      ));
    }
  }

  screens.home.replaceChildren(...children);
}

// ----------------------------------------------------------------------------
// Workout in progress (#/workout)
// ----------------------------------------------------------------------------
async function renderWorkout() {
  showScreen('workout');
  const workout = await currentWorkout();
  if (!workout) { go('#/'); return; }

  const sets = await listSetsForWorkout(workout.id);
  const exMap = await exerciseMap();
  const orderedIds = exercisesInOrder(sets);

  const elapsedEl = h('span', { class: 'elapsed' });
  const tick = () => { elapsedEl.textContent = formatElapsed(Date.now() - new Date(workout.startedAt)); };
  tick();
  activeInterval = setInterval(tick, 1000);

  const children = [
    header('Workout', '/', elapsedEl),
  ];

  if (!orderedIds.length && !workout.templateId) {
    children.push(h('p', { class: 'empty', text: 'No exercises yet. Add one to get going.' }));
  }

  // Logged exercises, first-logged order.
  for (const exId of orderedIds) {
    const exSets = sets.filter((s) => s.exerciseId === exId);
    const ex = exMap.get(exId);
    children.push(h('button', { class: 'ex-row', onclick: () => go(`#/log/${exId}`) },
      h('div', {},
        h('div', { class: 'ex-name', text: ex ? ex.name : 'Unknown exercise' }),
        h('div', { class: 'ex-meta', text: `${exSets.length} × done` }),
      ),
      h('span', { class: 'chev', text: '›' }),
    ));
  }

  // Planned (template) entries not yet logged.
  if (workout.templateId) {
    const tpl = await getTemplate(workout.templateId);
    if (tpl) {
      const logged = new Set(orderedIds);
      const planned = tpl.entries.filter((en) => !logged.has(en.exerciseId));
      if (planned.length) {
        children.push(h('div', { class: 'section-label', text: `Planned · ${tpl.name}` }));
        for (const en of planned) {
          const ex = exMap.get(en.exerciseId);
          children.push(h('button', { class: 'ex-row planned', onclick: () => go(`#/log/${en.exerciseId}`) },
            h('div', {},
              h('div', { class: 'ex-name', text: ex ? ex.name : 'Unknown exercise' }),
              h('div', { class: 'ex-meta', text: `Target: ${en.targetSets} × ${en.targetRepsLow}-${en.targetRepsHigh}` }),
            ),
            h('span', { class: 'chev', text: '›' }),
          ));
        }
      }
    }
  }

  children.push(
    h('div', { class: 'section-label', text: ' ' }),
    h('button', { class: 'btn', onclick: () => go('#/pick') }, '+ Add exercise'),
    h('button', { class: 'btn btn-danger', onclick: () => finishWorkout(workout) }, 'Finish workout'),
  );

  screens.workout.replaceChildren(...children);
}

async function finishWorkout(workout) {
  if (!confirm('Finish this workout?')) return;
  await putWorkout({ ...workout, finishedAt: nowISO() });
  setCurrent(null);
  go('#/');
}

// ----------------------------------------------------------------------------
// Exercise logging (#/log/:exerciseId) — the make-or-break screen
// ----------------------------------------------------------------------------
function topWorkingSet(sets) {
  const working = sets.filter((s) => s.isWarmup !== true);
  if (!working.length) return null;
  return working.reduce((best, s) =>
    s.weightKg > best.weightKg || (s.weightKg === best.weightKg && s.reps > best.reps) ? s : best);
}

function buildPrefill(todaySets, last) {
  let weight = 20;
  let reps = 8;
  if (todaySets.length) {
    // Pre-fill from the LAST logged set today.
    const lastToday = todaySets.slice().sort((a, b) => (a.completedAt < b.completedAt ? -1 : 1)).pop();
    weight = lastToday.weightKg;
    reps = lastToday.reps;
  } else if (last) {
    // Else from last session's TOP working set (heaviest).
    const top = topWorkingSet(last.sets);
    if (top) { weight = top.weightKg; reps = top.reps; }
  }
  return { weight, reps, isWarmup: false, rpe: null, rpeOpen: false, editingSetId: null };
}

async function renderLog(exerciseId) {
  showScreen('log');
  const workout = await currentWorkout();
  if (!workout) { go('#/'); return; }

  const exercise = await getExercise(exerciseId);
  const last = await getLastSession(exerciseId);
  const allSets = await listSetsForWorkout(workout.id);
  const todaySets = allSets.filter((s) => s.exerciseId === exerciseId)
    .sort((a, b) => a.setNumber - b.setNumber);

  if (!logState) logState = buildPrefill(todaySets, last);
  const editing = logState.editingSetId != null;

  // --- Last session panel ---
  const lastPanel = h('div', { class: 'panel' });
  lastPanel.append(h('div', { class: 'section-label', text: 'Last session' }));
  if (last) {
    lastPanel.append(h('div', { class: 'muted', text: formatDate(last.workout.date) }));
    for (const s of last.sets) {
      lastPanel.append(h('div', { class: 'set-line' },
        `${formatWeight(s.weightKg)} × ${s.reps}`,
        s.isWarmup ? h('span', { class: 'w', text: 'warmup' }) : null,
        s.rpe != null ? h('span', { class: 'rpe', text: `RPE ${s.rpe}` }) : null,
      ));
    }
  } else {
    lastPanel.append(h('div', { class: 'muted', text: 'First time — no history' }));
  }

  // --- Today's sets (editable) ---
  const todayWrap = h('div', {});
  if (todaySets.length) {
    todayWrap.append(h('div', { class: 'section-label', text: "Today's sets" }));
    for (const s of todaySets) {
      todayWrap.append(h('div', { class: 'set-item' + (logState.editingSetId === s.id ? ' editing' : '') },
        h('span', { class: 'idx', text: s.setNumber }),
        h('button', { class: 'vals', style: 'text-align:left;background:none;border:none;', onclick: () => editSet(s) },
          `${formatWeight(s.weightKg)} × ${s.reps}`,
          s.isWarmup ? h('span', { class: 'w', text: ' W' }) : null,
          s.rpe != null ? h('span', { class: 'rpe', text: ` RPE ${s.rpe}` }) : null,
        ),
        h('button', { class: 'del', 'aria-label': 'Delete set', onclick: () => removeSet(s) }, '🗑'),
      ));
    }
  }

  // --- Input card ---
  const lbHint = getUnits() === 'lb'
    ? h('span', { class: 'hint' })
    : null;
  const weightInput = h('input', {
    type: 'number', inputmode: 'decimal', step: String(WEIGHT_STEP),
    class: 'stepper-input', 'aria-label': 'Weight (kg)', value: trimNum(logState.weight),
  });
  const updateLbHint = () => { if (lbHint) lbHint.textContent = formatWeight(logState.weight); };
  const weightStepper = buildStepper(weightInput, WEIGHT_STEP, 0, (v) => { logState.weight = v; updateLbHint(); });
  updateLbHint();

  const repsInput = h('input', {
    type: 'number', inputmode: 'numeric', step: String(REP_STEP),
    class: 'stepper-input', 'aria-label': 'Reps', value: String(logState.reps),
  });
  const repsStepper = buildStepper(repsInput, REP_STEP, 0, (v) => { logState.reps = v; });

  const warmupBtn = h('button', {
    class: 'toggle', 'aria-pressed': logState.isWarmup ? 'true' : 'false',
    onclick: () => { logState.isWarmup = !logState.isWarmup; renderLog(exerciseId); },
  }, 'Warm-up');

  const rpeBtn = h('button', {
    class: 'toggle', 'aria-pressed': logState.rpeOpen ? 'true' : 'false',
    onclick: () => { logState.rpeOpen = !logState.rpeOpen; renderLog(exerciseId); },
  }, logState.rpe != null ? `RPE ${logState.rpe}` : 'RPE');

  const inputCard = h('div', { class: 'input-card' },
    h('div', { class: 'stepper-group' },
      h('div', { class: 'stepper-label' }, h('span', { text: 'Weight (kg)' }), lbHint),
      weightStepper,
    ),
    h('div', { class: 'stepper-group' },
      h('div', { class: 'stepper-label' }, h('span', { text: 'Reps' })),
      repsStepper,
    ),
    h('div', { class: 'control-row' }, warmupBtn, rpeBtn),
    logState.rpeOpen ? buildRpePanel(exerciseId) : null,
  );

  // --- Confirm bar (fixed) ---
  const confirmBtn = h('button', {
    class: 'confirm-btn' + (editing ? ' confirm-edit' : ''),
    onclick: () => confirmSet(exerciseId, workout),
  }, editing ? 'Update set' : 'Confirm');
  const confirmInner = h('div', { class: 'inner' }, confirmBtn,
    editing ? h('button', { class: 'cancel-edit', onclick: () => { logState = null; renderLog(exerciseId); } }, 'Cancel edit') : null,
  );
  const confirmBar = h('div', { class: 'confirm-bar' }, confirmInner);

  screens.log.replaceChildren(
    header(exercise ? exercise.name : 'Exercise', '/workout'),
    lastPanel,
    todayWrap,
    inputCard,
    confirmBar,
  );
}

function buildStepper(input, step, min, onChange) {
  const round = (v) => Math.round(v * 100) / 100;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) onChange(v);
  });
  const dec = h('button', { class: 'step-btn', type: 'button', 'aria-label': 'decrease' }, '−');
  const inc = h('button', { class: 'step-btn', type: 'button', 'aria-label': 'increase' }, '+');
  dec.addEventListener('click', () => {
    let v = round((parseFloat(input.value) || 0) - step);
    if (min != null && v < min) v = min;
    input.value = trimNum(v);
    onChange(v);
  });
  inc.addEventListener('click', () => {
    const v = round((parseFloat(input.value) || 0) + step);
    input.value = trimNum(v);
    onChange(v);
  });
  return h('div', { class: 'stepper' }, dec, input, inc);
}

function buildRpePanel(exerciseId) {
  const panel = h('div', { class: 'rpe-panel' });
  for (const val of RPE_VALUES) {
    panel.append(h('button', {
      class: 'rpe-chip', 'aria-pressed': logState.rpe === val ? 'true' : 'false',
      onclick: () => { logState.rpe = logState.rpe === val ? null : val; renderLog(exerciseId); },
    }, String(val)));
  }
  panel.append(h('button', {
    class: 'rpe-chip', onclick: () => { logState.rpe = null; renderLog(exerciseId); },
  }, 'Clear'));
  return panel;
}

function editSet(set) {
  logState = {
    weight: set.weightKg,
    reps: set.reps,
    isWarmup: set.isWarmup === true,
    rpe: set.rpe ?? null,
    rpeOpen: set.rpe != null,
    editingSetId: set.id,
  };
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  renderLog(set.exerciseId);
}

async function removeSet(set) {
  if (!confirm('Delete this set?')) return;
  if (logState && logState.editingSetId === set.id) logState = null;
  await deleteSet(set.id);
  renderLog(set.exerciseId);
}

async function confirmSet(exerciseId, workout) {
  const weightKg = Number.isFinite(logState.weight) ? Math.max(0, logState.weight) : 0;
  const reps = Number.isFinite(logState.reps) ? Math.max(0, Math.round(logState.reps)) : 0;
  const rpe = logState.rpe;
  const isWarmup = logState.isWarmup === true;

  if (logState.editingSetId) {
    const existing = await getSet(logState.editingSetId);
    if (existing) {
      await putSet({ ...existing, weightKg, reps, rpe, isWarmup });
    }
    logState = null;
    renderLog(exerciseId);
    return;
  }

  // New set: setNumber = count of this exercise's sets in this workout + 1.
  const existing = (await listSetsForWorkout(workout.id)).filter((s) => s.exerciseId === exerciseId);
  await putSet({
    id: uid(),
    workoutId: workout.id,
    exerciseId,
    setNumber: existing.length + 1,
    weightKg,
    reps,
    rpe,
    isWarmup,
    completedAt: nowISO(),
  });
  timer.start(); // auto-start rest timer on set completion
  logState = null; // reset (warm-up off, rpe cleared); prefill now from just-logged set
  renderLog(exerciseId);
}

// ----------------------------------------------------------------------------
// Exercise picker (#/pick)
// ----------------------------------------------------------------------------
async function renderPick() {
  showScreen('pick');
  const workout = await currentWorkout();
  if (!workout) { go('#/'); return; }
  const exercises = await listExercises();

  const searchInput = h('input', {
    class: 'search', type: 'search', placeholder: 'Search exercises…',
    'aria-label': 'Search exercises', value: pickQuery,
  });
  const resultsEl = h('div', {});
  searchInput.addEventListener('input', () => {
    pickQuery = searchInput.value;
    renderPickResults(resultsEl, exercises, pickQuery);
  });
  renderPickResults(resultsEl, exercises, pickQuery);

  screens.pick.replaceChildren(
    header('Add exercise', '/workout'),
    searchInput,
    resultsEl,
    buildCustomForm(),
  );
}

function renderPickResults(container, exercises, query) {
  const q = query.trim().toLowerCase();
  const matches = q ? exercises.filter((e) => e.name.toLowerCase().includes(q)) : exercises;
  const nodes = [];
  for (const group of MUSCLE_GROUPS) {
    const inGroup = matches.filter((e) => e.muscleGroup === group);
    if (!inGroup.length) continue;
    nodes.push(h('div', { class: 'group-label', text: group }));
    for (const ex of inGroup) {
      nodes.push(h('button', { class: 'pick-item', onclick: () => go(`#/log/${ex.id}`) },
        h('span', { class: 'ex-name', text: ex.name }),
        h('span', { class: 'pick-eq', text: ex.equipment }),
      ));
    }
  }
  if (!nodes.length) nodes.push(h('p', { class: 'empty', text: 'No matches. Create a custom exercise below.' }));
  container.replaceChildren(...nodes);
}

function buildCustomForm() {
  const nameInput = h('input', { type: 'text', placeholder: 'e.g. Landmine Press', 'aria-label': 'Exercise name' });
  const groupSelect = h('select', { 'aria-label': 'Muscle group' },
    ...MUSCLE_GROUPS.map((g) => h('option', { value: g }, g)));
  const equipSelect = h('select', { 'aria-label': 'Equipment' },
    ...EQUIPMENT.map((eq) => h('option', { value: eq }, eq)));

  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const ex = await putExercise({
      id: uid(),
      name,
      muscleGroup: groupSelect.value,
      equipment: equipSelect.value,
      isCustom: true,
      createdAt: nowISO(),
    });
    go(`#/log/${ex.id}`);
  };

  return h('details', { class: 'custom' },
    h('summary', {}, '+ Create custom exercise'),
    h('div', { class: 'field' }, h('label', { text: 'Name' }), nameInput),
    h('div', { class: 'field' }, h('label', { text: 'Muscle group' }), groupSelect),
    h('div', { class: 'field' }, h('label', { text: 'Equipment' }), equipSelect),
    h('button', { class: 'btn btn-lg', style: 'margin-top:14px', onclick: submit }, 'Create & log'),
  );
}

// ----------------------------------------------------------------------------
// History (#/history)
// ----------------------------------------------------------------------------
async function renderHistory() {
  showScreen('history');
  const recent = await getRecentWorkouts('0000');
  const children = [header('History', '/')];
  if (!recent.length) {
    children.push(h('p', { class: 'empty', text: 'No workouts recorded yet.' }));
  } else {
    for (const { workout, sets } of recent) {
      const exCount = new Set(sets.map((s) => s.exerciseId)).size;
      const dur = workoutDuration(workout);
      children.push(h('a', { class: 'card', href: `#/workout/${workout.id}` },
        h('div', { class: 'row-between' },
          h('div', { class: 'card-title', text: formatDate(workout.date) }),
          h('div', { class: 'muted', text: dur || (workout.finishedAt ? '' : 'in progress') }),
        ),
        h('div', { class: 'card-sub', text:
          `${exCount} exercise${exCount === 1 ? '' : 's'} · ${workingCount(sets)} working sets · ${formatWeight(totalVolume(sets))} volume` }),
      ));
    }
  }
  screens.history.replaceChildren(...children);
}

// ----------------------------------------------------------------------------
// Workout detail / edit (#/workout/:id)
// ----------------------------------------------------------------------------
async function renderDetail(id) {
  showScreen('detail');
  const workout = await getWorkout(id);
  if (!workout) { go('#/history'); return; }
  const sets = await listSetsForWorkout(id);
  const exMap = await exerciseMap();
  const orderedIds = exercisesInOrder(sets);

  const children = [
    header(formatDate(workout.date), '/history',
      !workout.finishedAt
        ? h('button', { class: 'header-action', onclick: () => { setCurrent(workout.id); go('#/workout'); } }, 'Resume')
        : null),
  ];

  const dur = workoutDuration(workout);
  children.push(h('p', { class: 'muted', text:
    `${new Set(sets.map((s) => s.exerciseId)).size} exercises · ${workingCount(sets)} working sets · ${formatWeight(totalVolume(sets))} volume` +
    (dur ? ` · ${dur}` : ' · in progress') }));

  if (!orderedIds.length) {
    children.push(h('p', { class: 'empty', text: 'No sets logged in this workout.' }));
  }

  for (const exId of orderedIds) {
    const exSets = sets.filter((s) => s.exerciseId === exId).sort((a, b) => a.setNumber - b.setNumber);
    const ex = exMap.get(exId);
    const group = h('div', { class: 'ex-group' }, h('h3', { text: ex ? ex.name : 'Unknown exercise' }));
    for (const s of exSets) group.append(buildDetailSetRow(s, id));
    children.push(group);
  }

  // Notes
  const notes = h('textarea', { class: 'notes', placeholder: 'Notes…', 'aria-label': 'Workout notes' });
  notes.value = workout.notes || '';
  notes.addEventListener('blur', async () => {
    await putWorkout({ ...workout, notes: notes.value.trim() || null });
  });
  children.push(h('div', { class: 'section-label', text: 'Notes' }), notes);

  children.push(h('button', {
    class: 'btn btn-danger', style: 'margin-top:20px',
    onclick: () => deleteWholeWorkout(workout),
  }, 'Delete workout'));

  screens.detail.replaceChildren(...children);
}

function buildDetailSetRow(set, workoutId) {
  const wInput = h('input', { type: 'number', inputmode: 'decimal', step: String(WEIGHT_STEP), 'aria-label': 'Weight kg' });
  wInput.value = trimNum(set.weightKg);
  const rInput = h('input', { type: 'number', inputmode: 'numeric', step: '1', 'aria-label': 'Reps' });
  rInput.value = String(set.reps);
  const warm = h('input', { type: 'checkbox', 'aria-label': 'Warm-up' });
  warm.checked = set.isWarmup === true;

  const save = async () => {
    const weightKg = Math.max(0, parseFloat(wInput.value) || 0);
    const reps = Math.max(0, Math.round(parseFloat(rInput.value) || 0));
    await putSet({ ...set, weightKg, reps, isWarmup: warm.checked });
    renderDetail(workoutId);
  };
  const del = async () => {
    if (!confirm('Delete this set?')) return;
    await deleteSet(set.id);
    renderDetail(workoutId);
  };

  return h('div', { class: 'detail-edit' },
    h('span', { class: 'idx muted', text: `#${set.setNumber}` }),
    wInput, h('span', { class: 'muted', text: '×' }), rInput,
    h('label', { class: 'warm' }, warm, 'warm-up'),
    set.rpe != null ? h('span', { class: 'rpe', text: `RPE ${set.rpe}` }) : null,
    h('button', { class: 'btn-sm btn', onclick: save }, 'Save'),
    h('button', { class: 'btn-sm btn btn-danger', onclick: del }, 'Delete'),
  );
}

async function deleteWholeWorkout(workout) {
  if (!confirm('Delete this whole workout and all its sets?')) return;
  if (!confirm('This cannot be undone. Delete permanently?')) return;
  await deleteWorkout(workout.id);
  if (state.currentWorkoutId === workout.id) setCurrent(null);
  go('#/history');
}

// ----------------------------------------------------------------------------
// Settings (#/settings)
// ----------------------------------------------------------------------------
async function renderSettings() {
  showScreen('settings');
  const status = await getActiveAdapter().status();

  const restInput = h('input', {
    class: 'num-input', type: 'number', inputmode: 'numeric', min: '5', step: '5',
    'aria-label': 'Default rest seconds', value: String(timer.getDefaultRestSeconds()),
  });
  restInput.addEventListener('change', () => {
    const v = parseInt(restInput.value, 10);
    if (Number.isFinite(v) && v > 0) timer.setDefaultRestSeconds(v);
  });

  const units = getUnits();
  const kgBtn = h('button', { 'aria-pressed': units === 'kg' ? 'true' : 'false' }, 'kg');
  const lbBtn = h('button', { 'aria-pressed': units === 'lb' ? 'true' : 'false' }, 'lb');
  kgBtn.addEventListener('click', () => { localStorage.setItem('settings.units', 'kg'); renderSettings(); });
  lbBtn.addEventListener('click', () => { localStorage.setItem('settings.units', 'lb'); renderSettings(); });

  screens.settings.replaceChildren(
    header('Settings', '/'),
    h('div', { class: 'setting' },
      h('label', { text: 'Default rest timer (seconds)' }),
      restInput,
    ),
    h('div', { class: 'setting' },
      h('label', { text: 'Display units' }),
      h('div', { class: 'seg' }, kgBtn, lbBtn),
      h('p', { class: 'muted', style: 'margin:8px 0 0', text: 'Weights are always stored in kg; this only changes how they show.' }),
    ),
    h('div', { class: 'setting' },
      h('label', { text: 'Sync' }),
      h('p', { class: 'muted', style: 'margin:0', text:
        `Mode: ${status.mode} · ${status.configured ? 'configured' : 'not configured'}` +
        (status.lastError ? ` · ${status.lastError}` : '') }),
    ),
  );
}

// ----------------------------------------------------------------------------
// Rest timer bar (shell)
// ----------------------------------------------------------------------------
const restBar = document.getElementById('rest-bar');
const restBarTime = document.getElementById('rest-bar-time');

function showRestBar(secs) {
  restBarTime.textContent = mmss(secs);
  restBar.hidden = false;
  document.body.classList.add('timer-active');
}
function hideRestBar() {
  restBar.hidden = true;
  document.body.classList.remove('timer-active');
}
restBar.addEventListener('click', () => { timer.cancel(); hideRestBar(); });

function onTimerTick(secs) {
  if (secs > 0) showRestBar(secs);
  else hideRestBar();
}
function onTimerDone() { hideRestBar(); }

// ----------------------------------------------------------------------------
// Startup
// ----------------------------------------------------------------------------
async function init() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* file:// etc. */ }
  }
  try { await seedIfEmpty(); } catch (e) { console.error('seed failed', e); }
  timer.bind({ tick: onTimerTick, done: onTimerDone });
  window.addEventListener('hashchange', route);
  await route();
}

init();
