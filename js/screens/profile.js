// ============================================================================
// screens/profile.js — Profile tab (#/profile). Display-unit toggle, default
// rest timer, CSV import, sync status and an about card.
//
// The import flow lives here because the Profile tab owns it end to end: pick a
// file -> csv-import.js turns it into a plan (pure, no DOM/DB) -> a preview
// sheet -> db.bulkImport persists it. Nothing about the file is trusted, so
// every scrap of file-derived text goes through textContent / h() — never
// innerHTML.
// ============================================================================

import * as timer from '../timer.js';
import { getActiveAdapter } from '../sync.js';
import { bulkImport, listExercises, listWorkouts } from '../db.js';
import {
  h, Icon, getUnits, mmss, openSheet, closeSheet, sheetHeader, sheetGroup,
} from '../ui.js';

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const num = (n) => Number(n || 0).toLocaleString('en-GB');
/** "6 Mar 2022" — the import preview needs the year, so formatDate won't do. */
function importDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ============================================================================
// Render
// ============================================================================
export async function renderProfile() {
  const screen = document.getElementById('s-profile');
  const adapter = getActiveAdapter();
  const status = await adapter.status();

  screen.replaceChildren(h('div', { class: 'tab-screen' },
    h('h1', { class: 'tab-title', text: 'Profile' }),
    settingsCard(),
    dataCard(),
    syncCard(status),
    aboutCard(),
  ));
}

// ---- settings card ----------------------------------------------------
function settingsCard() {
  const units = getUnits();

  return h('div', { class: 'tab-card settings-card' },
    h('div', { class: 'settings-row' },
      h('span', { class: 'settings-label', text: 'Display units' }),
      h('div', { class: 'seg-toggle' },
        h('button', {
          class: 'seg-btn' + (units === 'kg' ? ' on' : ''), type: 'button',
          onclick: () => setUnits('kg'),
        }, 'kg'),
        h('button', {
          class: 'seg-btn' + (units === 'lb' ? ' on' : ''), type: 'button',
          onclick: () => setUnits('lb'),
        }, 'lb'),
      ),
    ),
    h('p', { class: 'settings-note muted', text: 'Weights are always stored in kg; this only changes how they show.' }),
    restRow(),
  );
}

function restRow() {
  const val = h('span', { class: 'timer-val small', text: mmss(timer.getDefaultRestSeconds()) });
  const adjust = (delta) => {
    const next = Math.max(5, timer.getDefaultRestSeconds() + delta);
    timer.setDefaultRestSeconds(next);
    val.textContent = mmss(next);
  };
  return h('div', { class: 'settings-row' },
    h('span', { class: 'settings-label', text: 'Default rest timer' }),
    h('div', { class: 'rest-stepper' },
      h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Decrease default rest', onclick: () => adjust(-5) }, Icon('minus')),
      val,
      h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Increase default rest', onclick: () => adjust(5) }, Icon('plus')),
    ),
  );
}

function setUnits(v) {
  localStorage.setItem('settings.units', v);
  renderProfile(); // re-render so the segmented control and any live weights reflect the change
}

// ---- data card (CSV import) ------------------------------------------------
function dataCard() {
  // A real <input type="file"> stays in the DOM: iOS only opens the picker for a
  // click that originates in a genuine user gesture, and forwarding the row's tap
  // synchronously is the one pattern it honours everywhere.
  const fileInput = h('input', {
    class: 'file-input-hidden', type: 'file', id: 'import-file',
    accept: '.csv,text/csv,text/plain',
    onchange: (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = ''; // so re-picking the same file fires change again
      if (file) startImport(file);
    },
  });

  return h('div', { class: 'tab-card data-card' },
    h('button', {
      class: 'settings-row settings-btn-row', type: 'button', 'data-action': 'import-csv',
      onclick: () => fileInput.click(),
    },
      h('span', { class: 'settings-label stacked' },
        h('span', { text: 'Import workout history' }),
        h('span', { class: 'settings-sub', text: 'CSV export from another app — RepCount, Strong, Hevy…' }),
      ),
      h('span', { class: 'settings-chev' }, Icon('chevron')),
    ),
    fileInput,
  );
}

// ---- import flow -----------------------------------------------------------
/** Read the picked file, build a plan, and show the preview (or the failure). */
async function startImport(file) {
  try {
    const text = await file.text();
    // Lazily loaded: the parser is only ever needed once, on this one tap.
    const { buildImportPlan } = await import('../csv-import.js');
    const [exercises, workouts] = await Promise.all([listExercises(), listWorkouts('0000')]);
    const plan = buildImportPlan(text, exercises, workouts);
    if (!plan || !plan.ok) {
      importErrorSheet((plan && plan.error) || 'That file could not be read.', plan ? plan.warnings : null);
      return;
    }
    importPreviewSheet(plan);
  } catch (err) {
    importErrorSheet((err && err.message) || String(err));
  }
}

function importErrorSheet(message, notes) {
  const extra = (notes || []).slice(0, 3);
  openSheet(h('div', { 'data-action': 'import-error' },
    sheetHeader('Import failed', { onClose: () => closeSheet() }),
    h('p', { class: 'sheet-message', text: String(message) }),
    extra.length ? h('p', { class: 'sheet-message muted', text: extra.join(' · ') }) : null,
    h('div', { class: 'sheet-actions' },
      h('button', {
        class: 'sheet-btn', type: 'button', 'data-action': 'import-error-close',
        onclick: () => closeSheet(),
      }, 'Close'),
    ),
  ));
}

/** A read-only label/value line, styled like a sheet row but not tappable. */
function statRow(label, value) {
  return h('div', { class: 'sheet-row readonly' },
    h('span', { class: 'sheet-row-label' }, h('span', { text: label })),
    h('span', { class: 'sheet-row-value', text: value }),
  );
}

function importPreviewSheet(plan) {
  const { stats } = plan;
  const colliding = plan.collidingWorkoutIds || [];
  const opts = { skipCollisions: colliding.length > 0 };

  const skipVal = h('span', { class: 'sheet-row-value', text: opts.skipCollisions ? 'Yes' : 'No' });
  const skipRow = colliding.length
    ? h('button', {
      class: 'sheet-row', type: 'button', 'data-action': 'import-skip-collisions',
      onclick: () => {
        opts.skipCollisions = !opts.skipCollisions;
        skipVal.textContent = opts.skipCollisions ? 'Yes' : 'No';
      },
    },
      h('span', { class: 'sheet-row-label' },
        h('span', { text: 'Skip already-logged days' }),
        h('span', {
          class: 'sheet-row-sub',
          text: `${num(colliding.length)} workout${colliding.length === 1 ? '' : 's'} fall on days you've already logged — likely duplicates`,
        }),
      ),
      skipVal,
    )
    : null;

  const warnings = (plan.warnings || []).slice(0, 3);
  const moreWarnings = (plan.warnings || []).length - warnings.length;

  const root = h('div', { 'data-action': 'import-preview' },
    sheetHeader('Import CSV', { onClose: () => closeSheet() }),
    sheetGroup(
      statRow('Workouts', num(stats.workouts)),
      statRow('Sets', num(stats.sets)),
      statRow('New exercises', num(stats.newExercises)),
      statRow('Date range', stats.firstDate ? `${importDate(stats.firstDate)} – ${importDate(stats.lastDate)}` : '—'),
      stats.skippedRows > 0 ? statRow('Skipped rows', num(stats.skippedRows)) : null,
    ),
    skipRow ? sheetGroup(skipRow) : null,
    warnings.length
      ? h('p', {
        class: 'sheet-note muted',
        text: warnings.join(' · ') + (moreWarnings > 0 ? ` …and ${num(moreWarnings)} more` : ''),
      })
      : null,
    h('div', { class: 'sheet-actions' },
      h('button', {
        class: 'sheet-btn', type: 'button', 'data-action': 'import-confirm',
        onclick: () => runImport(plan, opts, root),
      }, 'Import'),
      h('button', {
        class: 'sheet-btn cancel', type: 'button', 'data-action': 'import-cancel',
        onclick: () => closeSheet(),
      }, 'Cancel'),
    ),
  );
  openSheet(root);
}

/**
 * Persist the plan, swapping the open sheet through progress -> result. The
 * sheet element is reused rather than stacked, so a mid-import backdrop tap can
 * never strand a sheet: the write finishes quietly and there is nothing to pop.
 */
async function runImport(plan, opts, root) {
  const skip = new Set(opts.skipCollisions ? plan.collidingWorkoutIds || [] : []);
  const workouts = (plan.workouts || []).filter((w) => !skip.has(w.id));
  const sets = (plan.sets || []).filter((s) => !skip.has(s.workoutId));
  const exercises = plan.exercises || [];

  const progressLine = h('p', { class: 'sheet-message', text: 'Importing…' });
  root.setAttribute('data-action', 'import-progress');
  root.replaceChildren(
    sheetHeader('Importing', {}),
    progressLine,
    h('p', { class: 'sheet-note muted', text: 'Keep this screen open until it finishes.' }),
  );

  try {
    await bulkImport({ exercises, workouts, sets }, (done, total) => {
      progressLine.textContent = `Importing… ${num(done)} / ${num(total)}`;
    });
  } catch (err) {
    root.setAttribute('data-action', 'import-error');
    root.replaceChildren(
      sheetHeader('Import failed', { onClose: () => closeSheet() }),
      h('p', { class: 'sheet-message', text: (err && err.message) || String(err) }),
      h('div', { class: 'sheet-actions' },
        h('button', {
          class: 'sheet-btn', type: 'button', 'data-action': 'import-error-close',
          onclick: () => closeSheet(),
        }, 'Close'),
      ),
    );
    return;
  }

  root.setAttribute('data-action', 'import-done');
  root.replaceChildren(
    sheetHeader('Import complete', { onClose: () => { closeSheet(); renderProfile(); } }),
    h('p', {
      class: 'sheet-message',
      text: `Imported ${num(workouts.length)} workout${workouts.length === 1 ? '' : 's'}, ${num(sets.length)} set${sets.length === 1 ? '' : 's'}, ${num(exercises.length)} new exercise${exercises.length === 1 ? '' : 's'}.`,
    }),
    skip.size
      ? h('p', {
        class: 'sheet-message muted',
        text: `Skipped ${num(skip.size)} workout${skip.size === 1 ? '' : 's'} on already-logged days.`,
      })
      : null,
    h('p', { class: 'sheet-note muted', text: 'Importing the same file again is safe — records update in place.' }),
    h('div', { class: 'sheet-actions' },
      h('button', {
        class: 'sheet-btn', type: 'button', 'data-action': 'import-done-close',
        onclick: () => { closeSheet(); renderProfile(); },
      }, 'Close'),
    ),
  );
}

// ---- sync card -------------------------------------------------------------
function syncCard(status) {
  const modeLabel = status.mode === 'local' ? 'Local only' : titleCase(status.mode);
  const note = status.mode === 'local'
    ? 'Local only — Azure sync arrives in Phase 2.'
    : (status.lastError || (status.configured ? 'Connected.' : 'Not configured.'));

  return h('div', { class: 'tab-card sync-card' },
    h('div', { class: 'settings-row' },
      h('span', { class: 'settings-label', text: 'Sync' }),
      h('span', { class: 'settings-value', text: modeLabel }),
    ),
    h('div', { class: 'settings-row' },
      h('span', { class: 'settings-label', text: 'Status' }),
      h('span', { class: 'settings-value', text: status.configured ? 'Configured' : 'Not configured' }),
    ),
    h('p', { class: 'settings-note muted', text: note }),
  );
}

// ---- about card --------------------------------------------------------
function aboutCard() {
  return h('div', { class: 'tab-card about-card' },
    h('div', { class: 'about-name', text: 'Gym Tracker' }),
    h('p', { class: 'about-line muted', text: 'Built for Dan — data lives on this device.' }),
  );
}
