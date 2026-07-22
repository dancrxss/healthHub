// ============================================================================
// screens/routines.js — Routines tab (#/routines). One card per template with
// its entry summary; tap opens a detail sheet (Start Routine / Edit / Delete).
// The "+" and Edit actions open the same create/edit sheet builder.
//
// User text only ever via textContent / h() — never innerHTML.
// ============================================================================

import {
  listTemplates, putTemplate, deleteTemplate, listExercises,
} from '../db.js';
import { uid } from '../util.js';
import {
  h, Icon, startWorkout,
  openSheet, closeSheet, sheetHeader, sheetGroup, sheetRow, confirmSheet,
} from '../ui.js';

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ============================================================================
// Render
// ============================================================================
export async function renderRoutines() {
  const screen = document.getElementById('s-routines');
  const [templates, exercises] = await Promise.all([listTemplates(), listExercises()]);
  const exMap = new Map(exercises.map((e) => [e.id, e]));

  const children = [
    h('div', { class: 'tab-head' },
      h('h1', { class: 'tab-title', text: 'Routines' }),
      h('button', {
        class: 'round-btn tab-head-btn', type: 'button', 'aria-label': 'Create routine',
        onclick: () => openTemplateEditor(null),
      }, Icon('plus')),
    ),
  ];

  if (!templates.length) {
    children.push(h('p', { class: 'log-empty muted', text: 'No routines yet. Tap + to build one.' }));
  } else {
    children.push(...templates.map((t) => templateCard(t, exMap)));
  }

  screen.replaceChildren(h('div', { class: 'tab-screen' }, ...children));
}
function reRenderRoutines() { renderRoutines(); }

// ---- template card -----------------------------------------------------
function templateCard(template, exMap) {
  const lines = template.entries.map((e) => {
    const exercise = exMap.get(e.exerciseId);
    const name = exercise ? exercise.name : 'Unknown exercise';
    return `${e.targetSets} × ${e.targetRepsLow}-${e.targetRepsHigh} ${name}`;
  });
  return h('button', {
    class: 'tab-card routine-card', 'data-template-id': template.id, type: 'button',
    onclick: () => openTemplateDetail(template, exMap),
  },
    h('span', { class: 'routine-card-name', text: template.name }),
    ...lines.map((line) => h('span', { class: 'routine-card-line', text: line })),
  );
}

// ---- detail sheet --------------------------------------------------------
function openTemplateDetail(template, exMap) {
  const rows = template.entries.map((e) => {
    const exercise = exMap.get(e.exerciseId);
    const name = exercise ? exercise.name : 'Unknown exercise';
    return sheetRow({ label: name, sub: `${e.targetSets} sets · ${e.targetRepsLow}-${e.targetRepsHigh} reps` });
  });

  openSheet(h('div', {},
    sheetHeader(template.name, { onClose: () => closeSheet() }),
    rows.length ? sheetGroup(...rows) : h('p', { class: 'sheet-message muted', text: 'No exercises in this routine yet.' }),
    sheetGroup(sheetRow({
      label: 'Start Routine', icon: Icon('check'), action: 'start-routine',
      onClick: () => { closeSheet(); startWorkout(template); },
    })),
    sheetGroup(sheetRow({
      label: 'Edit', icon: Icon('note'),
      onClick: () => { closeSheet(); openTemplateEditor(template); },
    })),
    sheetGroup(sheetRow({
      label: 'Delete', icon: Icon('trash'), danger: true,
      onClick: () => {
        closeSheet();
        confirmSheet({
          title: 'Delete routine?',
          message: `This removes "${template.name}". Workouts already logged from it are unaffected.`,
          confirmLabel: 'Delete', danger: true,
          onConfirm: async () => { await deleteTemplate(template.id); reRenderRoutines(); },
        });
      },
    })),
  ));
}

// ---- create / edit sheet ---------------------------------------------------
async function openTemplateEditor(existing) {
  const allExercises = await listExercises();
  const exMap = new Map(allExercises.map((e) => [e.id, e]));
  const work = existing
    ? { id: existing.id, name: existing.name, entries: existing.entries.map((e) => ({ ...e })) }
    : { id: null, name: '', entries: [] };

  const nameInput = h('input', { class: 'sheet-input', type: 'text', placeholder: 'Routine name', 'aria-label': 'Routine name' });
  nameInput.value = work.name;
  nameInput.addEventListener('input', () => { work.name = nameInput.value; errorMsg.hidden = true; });

  const errorMsg = h('p', { class: 'sheet-message danger', text: 'Give the routine a name and at least one exercise.' });
  errorMsg.hidden = true;

  const entriesWrap = h('div', {});
  const fillEntries = () => {
    entriesWrap.replaceChildren(
      work.entries.length
        ? h('div', { class: 'sheet-group tpl-entries' }, ...work.entries.map((e, i) => entryRow(e, i)))
        : h('p', { class: 'sheet-message muted', text: 'No exercises yet. Tap Add exercise below.' }),
    );
  };

  function entryRow(entry, index) {
    const exercise = exMap.get(entry.exerciseId);
    const name = exercise ? exercise.name : 'Unknown exercise';
    return h('div', { class: 'tpl-entry-row' },
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
  }

  fillEntries();

  const addBtn = h('button', {
    class: 'add-exercise', type: 'button',
    onclick: () => openExercisePicker(allExercises, (id) => {
      work.entries.push({ exerciseId: id, targetSets: 3, targetRepsLow: 8, targetRepsHigh: 12 });
      fillEntries();
    }),
  }, Icon('plus'), h('span', { text: 'Add exercise' }));

  const save = async () => {
    const name = work.name.trim();
    if (!name || work.entries.length === 0) { errorMsg.hidden = false; return; }
    closeSheet();
    await putTemplate({ id: work.id || uid(), name, entries: work.entries, syncedAt: null });
    reRenderRoutines();
  };

  openSheet(h('div', {},
    sheetHeader(existing ? 'Edit Routine' : 'New Routine', { onSave: save, onClose: () => closeSheet() }),
    errorMsg,
    h('div', { class: 'sheet-group' }, h('div', { class: 'sheet-input-row' }, nameInput)),
    entriesWrap,
    addBtn,
  ));
  requestAnimationFrame(() => { if (!existing) nameInput.focus(); });
}

function tplField(label, value, onCommit) {
  const input = h('input', { class: 'tpl-num-input', type: 'number', inputmode: 'numeric', min: '1', 'aria-label': label });
  input.value = String(value);
  const commit = () => {
    let v = parseInt(input.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    input.value = String(v);
    onCommit(v);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
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
        ? items.map((e) => sheetRow({ label: e.name, sub: titleCase(e.muscleGroup), onClick: () => { closeSheet(); onPick(e.id); } }))
        : [h('p', { class: 'sheet-message muted', text: 'No matches.' })]
    ));
  };
  fill();

  const search = h('input', { class: 'sheet-input', type: 'search', placeholder: 'Search exercises', 'aria-label': 'Search exercises' });
  search.addEventListener('input', () => { query = search.value; fill(); });

  openSheet(h('div', {},
    sheetHeader('Add exercise', { onClose: () => closeSheet() }),
    h('div', { class: 'sheet-group' }, h('div', { class: 'sheet-input-row' }, search)),
    listWrap,
  ));
  requestAnimationFrame(() => search.focus());
}
