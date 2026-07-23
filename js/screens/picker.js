// ============================================================================
// screens/picker.js — exercise picker (#/pick category list, #/pick/:group list).
// Regular mode: tapping a row appends the exercise as a workout entry and returns
// to #/workout. Superset mode: multi-select then confirm, appending the picks
// under a shared supersetGroup. Custom create + edit sheets included.
//
// Matches screenshots 6 (group list) & 7 (category list); edit sheet is
// screenshot 3. User text only ever via textContent / h().
// ============================================================================

import * as db from '../db.js';
import { uid, nowISO } from '../util.js';
import {
  h, Icon, go,
  currentWorkout, getEntries, saveEntries, createInitialSet,
  openSheet, closeSheet, sheetHeader, sheetGroup, sheetRow,
  confirmSheet, optionSheet, exerciseTypeSheet,
} from '../ui.js';
import { normalizeExerciseType, typeLabel } from '../exercise-types.js';

// Transient picker state. Persists across the two sub-screens except that query
// and superset selection reset when the category (route key) changes.
const ps = { query: '', mode: 'regular', selected: [], lastKey: null };
let currentGroup = null;
const reRenderPick = () => renderPick(currentGroup);

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ============================================================================
// Render
// ============================================================================
export async function renderPick(group) {
  currentGroup = group || null;
  const key = group || '__root__';
  if (ps.lastKey !== key) { ps.query = ''; ps.selected = []; ps.lastKey = key; }

  const workout = await currentWorkout();
  const browse = !workout; // reached #/pick with no active workout → library browse
  const all = await db.listExercises();
  const screen = document.getElementById('s-pick');

  const listWrap = h('div', { class: 'pick-list' });
  const fill = () => listWrap.replaceChildren(...listBody(all, browse));
  fill();

  const search = h('input', {
    class: 'pick-search', type: 'search', 'aria-label': 'Search',
    placeholder: currentGroup ? `Search ${titleCase(currentGroup)}` : 'Search Exercises',
  });
  search.value = ps.query;
  search.addEventListener('input', () => { ps.query = search.value; fill(); });

  screen.replaceChildren(
    pickHeader(browse),
    h('div', { class: 'pick-search-wrap' }, Icon('search'), search),
    listWrap,
    footer(browse),
  );
}

function pickHeader(browse) {
  if (currentGroup) {
    return h('header', { class: 'pick-head' },
      h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Back', onclick: () => go('#/pick') }, Icon('back')),
      h('div', { class: 'pick-title', text: titleCase(currentGroup) }),
      h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Create exercise', onclick: () => createCustomSheet() }, Icon('plus')),
    );
  }
  return h('header', { class: 'pick-head' },
    h('button', { class: 'pick-cancel', type: 'button', onclick: () => go(browse ? '#/log' : '#/workout') }, 'Cancel'),
    h('div', { class: 'pick-title', text: 'Select Exercise' }),
    h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Create exercise', onclick: () => createCustomSheet() }, Icon('plus')),
  );
}

function listBody(all, browse) {
  const q = ps.query.trim().toLowerCase();

  if (currentGroup) {
    let items = all.filter((e) => e.muscleGroup === currentGroup);
    if (q) items = items.filter((e) => e.name.toLowerCase().includes(q));
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items.length ? items.map((e) => exerciseRow(e, browse)) : [emptyRow('No exercises here yet.')];
  }

  if (q) {
    const items = all.filter((e) => e.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    return items.length ? items.map((e) => exerciseRow(e, browse)) : [emptyRow('No matches. Use + to create one.')];
  }

  // Category rows: MUSCLE_GROUPS (display order) that have at least one exercise.
  const present = new Set(all.map((e) => e.muscleGroup));
  const groups = db.MUSCLE_GROUPS.filter((g) => present.has(g));
  return groups.map((g) => h('button', { class: 'pick-cat', type: 'button', onclick: () => go('#/pick/' + g) },
    h('span', { text: titleCase(g) }),
    h('span', { class: 'pick-cat-chev' }, Icon('chevron')),
  ));
}

function exerciseRow(ex, browse) {
  const superset = ps.mode === 'superset' && !browse;
  const selected = ps.selected.includes(ex.id);

  const row = h('div', { class: 'pick-row' + (selected ? ' selected' : ''), 'data-exercise-id': ex.id, role: 'button', tabindex: '0' });
  const activate = () => {
    if (browse) { editExerciseSheet(ex); return; }
    if (superset) { toggleSelect(ex.id); return; }
    addRegular(ex.id);
  };
  row.addEventListener('click', activate);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });

  const info = h('button', {
    class: 'pick-row-info', type: 'button', 'aria-label': 'Edit exercise',
    onclick: (e) => { e.stopPropagation(); editExerciseSheet(ex); },
  }, Icon('info'));

  // Element.append() stringifies null — only pass real nodes.
  if (superset) row.append(h('span', { class: 'pick-check' + (selected ? ' on' : '') }, selected ? Icon('check') : null));
  row.append(h('span', { class: 'pick-row-name', text: ex.name }), info);
  return row;
}

function emptyRow(text) {
  return h('p', { class: 'pick-empty muted', text });
}

// ---- footer: Regular/Superset toggle + superset confirm bar -----------------
function footer(browse) {
  if (browse) return null;
  const seg = h('div', { class: 'seg-toggle' }, segBtn('Regular', 'regular'), segBtn('Superset', 'superset'));
  const bar = (ps.mode === 'superset' && ps.selected.length)
    ? h('button', { class: 'superset-confirm', type: 'button', onclick: () => confirmSuperset() }, `Add Superset (${ps.selected.length})`)
    : null;
  return h('div', { class: 'pick-footer' }, bar, seg);
}
function segBtn(label, mode) {
  return h('button', {
    class: 'seg-btn' + (ps.mode === mode ? ' on' : ''), type: 'button',
    onclick: () => { ps.mode = mode; if (mode === 'regular') ps.selected = []; reRenderPick(); },
  }, label);
}

// ---- mutations -------------------------------------------------------------
function toggleSelect(id) {
  const i = ps.selected.indexOf(id);
  if (i >= 0) ps.selected.splice(i, 1); else ps.selected.push(id);
  reRenderPick();
}

async function addRegular(id) {
  const w = await currentWorkout();
  if (!w) return;
  const sets = await db.listSetsForWorkout(w.id);
  const entries = getEntries(w, sets).slice();
  entries.push({ exerciseId: id, supersetGroup: null, note: null });
  await saveEntries(w, entries);
  // Selecting an exercise means at least one set — auto-create a blank set 1
  // (unless this exercise already has sets in the workout, e.g. re-added).
  if (!sets.some((s) => s.exerciseId === id)) await createInitialSet(w.id, id);
  go('#/workout');
}

function nextGroup(entries) {
  let m = 0;
  for (const e of entries) if (typeof e.supersetGroup === 'number') m = Math.max(m, e.supersetGroup);
  return m + 1;
}
async function confirmSuperset() {
  const w = await currentWorkout();
  if (!w || !ps.selected.length) return;
  const sets = await db.listSetsForWorkout(w.id);
  const entries = getEntries(w, sets).slice();
  const g = nextGroup(entries);
  for (const id of ps.selected) entries.push({ exerciseId: id, supersetGroup: g, note: null });
  await saveEntries(w, entries);
  for (const id of ps.selected) {
    if (!sets.some((s) => s.exerciseId === id)) await createInitialSet(w.id, id);
  }
  ps.selected = [];
  go('#/workout');
}

// ---- edit exercise sheet (screenshot 3) ------------------------------------
function editRow(label, valueNode, onClick, danger) {
  return h('button', { class: 'sheet-row' + (danger ? ' danger' : ''), type: 'button', onclick: onClick },
    h('span', { class: 'sheet-row-label' }, h('span', { text: label })),
    valueNode || null,
    h('span', { class: 'sheet-row-chev' }, Icon('chevron')),
  );
}
/**
 * Edit-exercise sheet — shared: the picker's ⓘ buttons AND the workout screen's
 * per-exercise Settings row open this. onSaved re-renders the caller's screen.
 */
export async function editExerciseSheet(ex, onSaved = reRenderPick) {
  const work = {
    name: ex.name, muscleGroup: ex.muscleGroup,
    exerciseType: normalizeExerciseType(ex.exerciseType), isUnilateral: ex.isUnilateral === true,
  };
  const usedCount = (await db.listSetsForExercise(ex.id)).length;
  const canDelete = ex.isCustom === true && usedCount === 0 && typeof db.deleteExercise === 'function';

  const nameInput = h('input', { class: 'sheet-input', type: 'text', 'aria-label': 'Exercise name', placeholder: 'Name' });
  nameInput.value = work.name;
  nameInput.addEventListener('input', () => { work.name = nameInput.value; });

  const catVal = h('span', { class: 'sheet-row-value', text: titleCase(work.muscleGroup) });
  const catRow = editRow('Category', catVal, () => optionSheet({
    title: 'Category', options: db.MUSCLE_GROUPS.map((g) => ({ value: g, label: titleCase(g) })),
    current: work.muscleGroup, onPick: (v) => { work.muscleGroup = v; catVal.textContent = titleCase(v); },
  }));

  const typeVal = h('span', { class: 'sheet-row-value', text: typeLabel(work.exerciseType) });
  const typeRow = editRow('Exercise Type', typeVal, () => exerciseTypeSheet({
    current: work.exerciseType,
    onPick: (v) => { work.exerciseType = v; typeVal.textContent = typeLabel(v); },
  }));

  const uniVal = h('span', { class: 'sheet-row-value', text: work.isUnilateral ? 'Yes' : 'Default(No)' });
  const uniRow = editRow('Single Leg / Single Arm', uniVal, () => {
    work.isUnilateral = !work.isUnilateral;
    uniVal.textContent = work.isUnilateral ? 'Yes' : 'Default(No)';
  });

  const save = async () => {
    closeSheet();
    await db.putExercise({ ...ex, name: work.name.trim() || ex.name, muscleGroup: work.muscleGroup, exerciseType: work.exerciseType, isUnilateral: work.isUnilateral });
    onSaved();
  };

  const groups = [
    sheetGroup(h('div', { class: 'sheet-input-row' }, nameInput), catRow),
    sheetGroup(typeRow),
    sheetGroup(uniRow),
  ];
  if (canDelete) {
    groups.push(sheetGroup(sheetRow({
      label: 'Delete', icon: Icon('trash'), danger: true,
      onClick: () => {
        closeSheet();
        confirmSheet({
          title: 'Delete exercise?', message: 'Only unused custom exercises can be deleted.',
          confirmLabel: 'Delete', danger: true,
          onConfirm: async () => { await db.deleteExercise(ex.id); onSaved(); },
        });
      },
    })));
  }

  openSheet(h('div', {}, sheetHeader('Edit Exercise', { onSave: save, onClose: () => closeSheet() }), ...groups));
}

// ---- create custom exercise sheet ------------------------------------------
async function createCustomSheet() {
  const work = { name: '', muscleGroup: currentGroup || 'other', exerciseType: 'weight_reps', isUnilateral: false, equipment: 'other' };

  const nameInput = h('input', { class: 'sheet-input', type: 'text', 'aria-label': 'Exercise name', placeholder: 'Name' });
  nameInput.addEventListener('input', () => { work.name = nameInput.value; });

  const catVal = h('span', { class: 'sheet-row-value', text: titleCase(work.muscleGroup) });
  const catRow = editRow('Category', catVal, () => optionSheet({
    title: 'Category', options: db.MUSCLE_GROUPS.map((g) => ({ value: g, label: titleCase(g) })),
    current: work.muscleGroup, onPick: (v) => { work.muscleGroup = v; catVal.textContent = titleCase(v); },
  }));

  const typeVal = h('span', { class: 'sheet-row-value', text: typeLabel(work.exerciseType) });
  const typeRow = editRow('Exercise Type', typeVal, () => exerciseTypeSheet({
    current: work.exerciseType,
    onPick: (v) => { work.exerciseType = v; typeVal.textContent = typeLabel(v); },
  }));

  const equipVal = h('span', { class: 'sheet-row-value', text: titleCase(work.equipment) });
  const equipRow = editRow('Equipment', equipVal, () => optionSheet({
    title: 'Equipment', options: db.EQUIPMENT.map((eq) => ({ value: eq, label: titleCase(eq) })),
    current: work.equipment, onPick: (v) => { work.equipment = v; equipVal.textContent = titleCase(v); },
  }));

  const uniVal = h('span', { class: 'sheet-row-value', text: work.isUnilateral ? 'Yes' : 'Default(No)' });
  const uniRow = editRow('Single Leg / Single Arm', uniVal, () => {
    work.isUnilateral = !work.isUnilateral;
    uniVal.textContent = work.isUnilateral ? 'Yes' : 'Default(No)';
  });

  const save = async () => {
    const name = work.name.trim();
    if (!name) { nameInput.focus(); return; }
    const ex = await db.putExercise({
      id: uid(), name, muscleGroup: work.muscleGroup, equipment: work.equipment,
      exerciseType: work.exerciseType, isUnilateral: work.isUnilateral, isCustom: true, createdAt: nowISO(),
    });
    closeSheet();
    const w = await currentWorkout();
    if (w) await addRegular(ex.id);
    else reRenderPick();
  };

  openSheet(h('div', {},
    sheetHeader('New Exercise', { onSave: save, onClose: () => closeSheet() }),
    sheetGroup(h('div', { class: 'sheet-input-row' }, nameInput), catRow),
    sheetGroup(typeRow),
    sheetGroup(equipRow),
    sheetGroup(uniRow),
  ));
  requestAnimationFrame(() => nameInput.focus());
}
