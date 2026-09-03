// ============================================================================
// screens/settings.js — the Settings screen (#/settings), opened from the gear
// button on every tab header (it replaced the Profile tab, 29 Jul 2026).
// Display-unit toggle, default rest timer, CSV import, sync status, about.
//
// The import flow lives here because Settings owns it end to end: pick a
// file -> csv-import.js turns it into a plan (pure, no DOM/DB) -> a preview
// sheet -> db.bulkImport persists it. Nothing about the file is trusted, so
// every scrap of file-derived text goes through textContent / h() — never
// innerHTML.
// ============================================================================

import * as timer from '../timer.js';
import { getActiveAdapter } from '../sync.js';
import { getSetting, setSetting } from '../settings.js';
import {
  bulkImport, listExercises, listWorkouts, getMeta, setMeta,
} from '../db.js';
import {
  h, Icon, go, getUnits, mmss, openSheet, closeSheet, sheetHeader, sheetGroup,
  confirmSheet, setScreenCleanup, refreshCoachTab,
} from '../ui.js';
import {
  healthAvailable, getHealthState, connectHealth, disconnectHealth, syncNow, onHealthUpdate,
} from '../health.js';
import {
  hasApiKey, apiKeyMasked, setApiKey, checkApiKey, getShareRecovery, setShareRecovery,
  getCoachState, clearCoachData, initCoach,
} from '../coach.js';
import { userMessageFor } from '../coach-api.js';

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
/** Coarse relative time for the Apple Health status line: "just now", "5 min
 * ago", "3 hr ago", "2d ago", falling back to a plain date past a week. */
function relTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return importDate(iso);
}

// ============================================================================
// Render
// ============================================================================
export async function renderSettings() {
  const screen = document.getElementById('s-settings');
  const adapter = getActiveAdapter();
  const status = await adapter.status();

  // Re-renders happen a lot on this screen (unit toggle, import flow) without a
  // route change in between, so the subscription is torn down and re-armed
  // here rather than relying solely on the route-change cleanup below.
  stopHealthSubscription();

  const healthOn = healthAvailable();
  const health = healthOn ? await getHealthState() : null;
  const healthWriteOn = health && health.connected
    ? (await getMeta('healthWriteWorkouts')) !== false
    : true;

  const coachKeyPresent = hasApiKey();
  const coachState = coachKeyPresent ? await getCoachState() : null;
  const coachShareOn = health && health.connected ? await getShareRecovery() : false;

  screen.replaceChildren(
    h('header', { class: 'pick-head' },
      h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Back', onclick: () => history.length > 1 ? history.back() : go('#/log') }, Icon('back')),
      h('div', { class: 'pick-title', text: 'Settings' }),
      h('span', { class: 'round-btn-ghost' }),
    ),
    h('div', { class: 'tab-screen settings-screen' },
      settingsCard(),
      workoutLogCard(),
      chartsCard(),
      dataCard(),
      syncCard(status),
      health ? healthCard(health, healthWriteOn) : null,
      coachCard(healthOn, health, coachKeyPresent, coachState, coachShareOn),
      aboutCard(),
    ),
  );

  if (health && health.connected) {
    unsubHealth = onHealthUpdate(() => {
      refreshHealthStatus().catch((err) => console.error('settings: health status refresh failed', err));
    });
    setScreenCleanup(() => stopHealthSubscription());
  }
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
  renderSettings(); // re-render so the segmented control and any live weights reflect the change
}

// ---- toggle rows -------------------------------------------------------
/**
 * One label + iOS-style switch, optionally followed by a muted explanation.
 * The switch is the single source of truth for its own state: tapping it
 * writes through setSetting and repaints only itself — no re-render, so a
 * flurry of taps can never fight a rebuild. Initial state comes from
 * getSetting, so it survives every render.
 *
 * @param {string} label
 * @param {string} name  a SETTING_DEFS key; also the `data-setting` hook
 * @param {string} [note]
 * @returns {Node[]} row (+ note), spread into a card by h()'s flattening
 */
function toggleRow(label, name, note) {
  const on = getSetting(name);
  const btn = h('button', {
    class: 'toggle' + (on ? ' on' : ''),
    type: 'button', role: 'switch',
    'aria-checked': on ? 'true' : 'false',
    'aria-label': label,
    'data-setting': name,
  });
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    setSetting(name, next);
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    btn.classList.toggle('on', next);
  });

  const row = h('div', { class: 'settings-row' },
    h('span', { class: 'settings-label', text: label }),
    btn,
  );
  return note ? [row, h('p', { class: 'settings-note muted', text: note })] : [row];
}

function sectionLabel(text) {
  return h('div', { class: 'settings-section', text });
}

// ---- workout log card --------------------------------------------------
function workoutLogCard() {
  return h('div', { class: 'settings-group' },
    sectionLabel('Workout Log'),
    h('div', { class: 'tab-card settings-card settings-toggle-card' },
      toggleRow('Autofill weight', 'autofillWeight',
        'When you enter reps, the weight fills in from last session if you left it empty.'),
      toggleRow('Auto-start rest timer', 'autoStartTimer',
        'Starts the rest countdown each time you add a set.'),
      toggleRow('Timer sound', 'timerSound',
        'Beep when the rest timer finishes.'),
      toggleRow('Keep screen on during workout', 'keepScreenOn',
        'Stops the screen locking while a workout is open. Uses more battery.'),
    ),
  );
}

// ---- charts card -------------------------------------------------------
function chartsCard() {
  return h('div', { class: 'settings-group' },
    sectionLabel('Charts'),
    h('div', { class: 'tab-card settings-card settings-toggle-card' },
      toggleRow('Show trend line', 'chartTrendLine'),
      toggleRow('Include warm-up sets', 'chartIncludeWarmup',
        'Charts only — PRs and records always exclude warm-ups.'),
      toggleRow('Count single arm/leg twice', 'countUnilateralTwice',
        'Doubles volume and reps from unilateral exercises in statistics.'),
    ),
  );
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
    sheetHeader('Import complete', { onClose: () => { closeSheet(); renderSettings(); } }),
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
        onclick: () => { closeSheet(); renderSettings(); },
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

// ---- Apple Health card --------------------------------------------------
// Rendered only when healthAvailable() — absent entirely in the PWA, so the
// GitHub Pages build looks byte-for-byte unchanged. The Swift plugin behind
// health.js never reports WHY data is missing (HealthKit read denials are
// invisible by design), so the app never claims the user blocked anything —
// see the copy in emptyHealthNote below.
let unsubHealth = null;
function stopHealthSubscription() {
  if (unsubHealth) { unsubHealth(); unsubHealth = null; }
}

/** Update just the status line in place — no re-render, no lost scroll. */
async function refreshHealthStatus() {
  const el = document.querySelector('#s-settings .health-status');
  if (!el) return; // screen moved on, or disconnected since the event fired
  const state = await getHealthState();
  el.textContent = `Connected · last updated ${state.lastSyncAt ? relTime(state.lastSyncAt) : '—'}`;
}

function healthCard(state, writeOn) {
  return h('div', { class: 'settings-group' },
    sectionLabel('Apple Health'),
    state.connected ? connectedHealthCard(state, writeOn) : disconnectedHealthCard(),
  );
}

function disconnectedHealthCard() {
  return h('div', { class: 'tab-card health-card' },
    h('p', {
      class: 'settings-note muted',
      text: 'Read your workouts, heart rate, body weight and sleep from Apple Health. Your health data never leaves your device.',
    }),
    h('button', {
      class: 'sheet-btn', type: 'button', 'data-action': 'health-connect',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await connectHealth(); } finally { renderSettings(); }
      },
    }, 'Connect Apple Health'),
  );
}

function connectedHealthCard(state, writeOn) {
  const statusLine = h('p', {
    class: 'health-status',
    text: `Connected · last updated ${state.lastSyncAt ? relTime(state.lastSyncAt) : '—'}`,
  });

  const syncLabel = h('span', { class: 'settings-label', text: 'Sync now' });
  const syncBtn = h('button', {
    class: 'settings-row settings-btn-row', type: 'button', 'data-action': 'health-sync',
  },
    syncLabel,
    h('span', { class: 'settings-chev' }, Icon('chevron')),
  );
  syncBtn.addEventListener('click', async () => {
    if (syncBtn.disabled) return;
    syncBtn.disabled = true;
    syncLabel.textContent = 'Syncing…';
    try { await syncNow(); } finally {
      syncLabel.textContent = 'Sync now';
      syncBtn.disabled = false;
      refreshHealthStatus();
    }
  });

  return h('div', { class: 'tab-card settings-card settings-toggle-card health-card' },
    statusLine,
    syncBtn,
    healthWriteToggleRow(writeOn),
    h('button', {
      class: 'settings-row settings-btn-row', type: 'button', 'data-action': 'health-disconnect',
      onclick: () => disconnectSheet(),
    },
      h('span', { class: 'settings-label danger', text: 'Disconnect…' }),
      h('span', { class: 'settings-chev' }, Icon('chevron')),
    ),
  );
}

/** Mirrors toggleRow()'s pattern but is backed by IndexedDB meta (async), not
 * localStorage — it repaints only itself, no re-render. */
function healthWriteToggleRow(on) {
  const btn = h('button', {
    class: 'toggle' + (on ? ' on' : ''),
    type: 'button', role: 'switch',
    'aria-checked': on ? 'true' : 'false',
    'aria-label': 'Save workouts to Apple Health',
    'data-setting': 'healthWriteWorkouts',
  });
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    setMeta('healthWriteWorkouts', next);
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    btn.classList.toggle('on', next);
  });
  return h('div', { class: 'settings-row' },
    h('span', { class: 'settings-label', text: 'Save workouts to Apple Health' }),
    btn,
  );
}

/** Matches the app's destructive-confirm look (sheet-actions + danger pills)
 * used by delete-workout, but offers two distinct destructive choices instead
 * of one confirm/cancel pair. */
function disconnectSheet() {
  openSheet(h('div', {},
    sheetHeader('Disconnect Apple Health', { onClose: () => closeSheet() }),
    h('p', {
      class: 'sheet-message muted',
      text: 'You can reconnect at any time. Removing imported data deletes the Apple Health samples stored on this device.',
    }),
    h('div', { class: 'sheet-actions' },
      h('button', {
        class: 'sheet-btn danger', type: 'button', 'data-action': 'health-disconnect-only',
        onclick: async () => { closeSheet(); await disconnectHealth({ purge: false }); renderSettings(); },
      }, 'Disconnect'),
      h('button', {
        class: 'sheet-btn danger', type: 'button', 'data-action': 'health-disconnect-purge',
        onclick: async () => { closeSheet(); await disconnectHealth({ purge: true }); renderSettings(); },
      }, 'Disconnect and remove imported data'),
      h('button', { class: 'sheet-btn cancel', type: 'button', 'data-action': 'cancel', onclick: () => closeSheet() }, 'Cancel'),
    ),
  ));
}

// ---- Coach card (Phase C) ------------------------------------------------
// An AI coach powered by the user's own Anthropic API key. Absent a key the
// app makes zero network calls; every field here lives in settings.js only —
// the heavy lifting (queueing, idempotency, digest building) is coach.js's
// job. Mirrors the Apple Health card's shape: intro note, then rows, all
// inside one settings-toggle-card.
function coachCard(healthOn, health, hasKey, coachState, shareOn) {
  return h('div', { class: 'settings-group' },
    sectionLabel('Coach'),
    h('div', { class: 'tab-card settings-card settings-toggle-card' },
      h('p', {
        class: 'settings-note muted',
        text: 'An AI coach that summarises your training, reviews each session and keeps a plan up to date. Needs your own Anthropic API key — usage costs a few pence per session and is billed to your key.',
      }),
      ...coachApiKeySection(hasKey),
      coachModelRow(),
      ...coachRecoveryRows(healthOn, health, shareOn),
      hasKey ? coachBuilderRow() : null,
      hasKey && coachState && coachState.usageTotals ? coachUsageRow(coachState.usageTotals) : null,
      coachClearRow(),
    ),
  );
}

/** The API key row(s). Self-managing (no re-render) except after a successful
 * save, which does re-render so the masked view + profile/usage rows appear. */
function coachApiKeySection(hasKey) {
  const wrap = h('div', { class: 'coach-key-wrap' });
  wrap.append(...(hasKey ? coachMaskedKeyView(wrap) : coachKeyInputView(wrap)));
  return [
    wrap,
    h('p', {
      class: 'settings-note muted',
      text: "Stored only on this device. If you clear website data you'll need to enter it again.",
    }),
  ];
}

function coachMaskedKeyView(wrap) {
  const statusNote = h('p', { class: 'settings-note muted', hidden: true });

  const testBtn = h('button', {
    class: 'settings-btn-row coach-key-btn', type: 'button', 'data-action': 'coach-test-key',
  }, 'Test key');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    statusNote.hidden = false;
    statusNote.classList.remove('danger');
    statusNote.textContent = '';
    try {
      await checkApiKey();
      statusNote.textContent = 'Key is working.';
    } catch (err) {
      statusNote.classList.add('danger');
      statusNote.textContent = userMessageFor(err);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test key';
    }
  });

  const replaceBtn = h('button', {
    class: 'settings-btn-row coach-key-btn', type: 'button', 'data-action': 'coach-key-replace',
    onclick: () => wrap.replaceChildren(...coachKeyInputView(wrap)),
  }, 'Replace key…');

  return [
    h('div', { class: 'settings-row' },
      h('span', { class: 'settings-label', text: 'API key' }),
      h('span', { class: 'settings-value', text: apiKeyMasked() }),
    ),
    h('div', { class: 'coach-key-actions' }, testBtn, replaceBtn),
    statusNote,
  ];
}

function coachKeyInputView(wrap) {
  const keyInput = h('input', {
    class: 'sheet-input coach-key-input', type: 'password', inputmode: 'text',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'sk-ant-…', 'data-action': 'coach-key-input', 'aria-label': 'Anthropic API key',
  });
  const eyeBtn = h('button', {
    class: 'coach-key-eye', type: 'button', 'data-action': 'coach-key-show',
    'aria-pressed': 'false', 'aria-label': 'Show API key',
  }, 'Show');
  eyeBtn.addEventListener('click', () => {
    const showing = keyInput.type === 'text';
    keyInput.type = showing ? 'password' : 'text';
    eyeBtn.setAttribute('aria-pressed', showing ? 'false' : 'true');
    eyeBtn.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
    eyeBtn.textContent = showing ? 'Show' : 'Hide';
  });

  const statusNote = h('p', { class: 'settings-note muted', hidden: true });
  const saveBtn = h('button', {
    class: 'sheet-btn coach-key-save', type: 'button', 'data-action': 'coach-key-save',
  }, 'Save');
  saveBtn.addEventListener('click', async () => {
    const value = keyInput.value.trim();
    if (!value) return;
    saveBtn.disabled = true;
    setApiKey(value);
    try {
      await checkApiKey(value);
      statusNote.hidden = false;
      statusNote.classList.remove('danger');
      statusNote.textContent = 'Key saved and working.';
      refreshCoachTab();
      initCoach();
      renderSettings();
      return; // renderSettings rebuilds the whole screen
    } catch (err) {
      statusNote.hidden = false;
      statusNote.classList.add('danger');
      statusNote.textContent = userMessageFor(err);
      refreshCoachTab();
    }
    saveBtn.disabled = false;
  });

  return [
    h('div', { class: 'coach-key-row' }, keyInput, eyeBtn, saveBtn),
    statusNote,
  ];
}

function coachModelRow() {
  return h('div', { class: 'settings-row' },
    h('span', { class: 'settings-label', text: 'Model' }),
    h('span', { class: 'settings-value', text: 'Claude Sonnet 5' }),
  );
}

/** Gated on Apple Health, not on having a key — see PLAN.md §"Phase C" C1. */
function coachRecoveryRows(healthOn, health, shareOn) {
  if (!healthOn) return []; // PWA — no Apple Health at all, render nothing
  if (!(health && health.connected)) {
    return [h('p', {
      class: 'settings-note muted',
      text: 'Connect Apple Health to let the coach use your recovery data (optional).',
    })];
  }
  return [
    coachShareRecoveryToggleRow(shareOn),
    h('p', {
      class: 'settings-note muted',
      text: "Sends last night's sleep, HRV, resting heart rate and body-weight trend to Anthropic along with your gym data when the coach runs. Off by default. Your gym data is always sent when the coach runs.",
    }),
  ];
}

/** Mirrors healthWriteToggleRow's pattern: async meta-backed, repaints only
 * itself. Default OFF per CLAUDE.md §10 (consent must not default on). */
function coachShareRecoveryToggleRow(on) {
  const btn = h('button', {
    class: 'toggle' + (on ? ' on' : ''),
    type: 'button', role: 'switch',
    'aria-checked': on ? 'true' : 'false',
    'aria-label': 'Share recovery data with coach',
    'data-setting': 'coach.shareRecovery',
  });
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    setShareRecovery(next);
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    btn.classList.toggle('on', next);
  });
  return h('div', { class: 'settings-row' },
    h('span', { class: 'settings-label', text: 'Share recovery data with coach' }),
    btn,
  );
}

/** Plan configuration lives in the Coach tab (Phase C2) — this is just the door. */
function coachBuilderRow() {
  return h('button', {
    class: 'settings-row settings-btn-row', type: 'button', 'data-action': 'coach-open-builder',
    onclick: () => go('#/coach/builder'),
  },
    h('span', { class: 'settings-label', text: 'Open plan builder' }),
    h('span', { class: 'settings-chev' }, Icon('chevron')),
  );
}

function coachUsageRow(usageTotals) {
  if (!usageTotals || !usageTotals.calls) return null;
  const cost = (Math.round((usageTotals.estimatedCostUsd || 0) * 100) / 100).toFixed(2);
  return h('div', { class: 'settings-row' },
    h('span', { class: 'settings-label', text: 'Usage' }),
    h('span', {
      class: 'settings-value',
      text: `${num(usageTotals.calls)} call${usageTotals.calls === 1 ? '' : 's'} · about $${cost}`,
    }),
  );
}

function coachClearRow() {
  return h('button', {
    class: 'settings-row settings-btn-row', type: 'button', 'data-action': 'coach-clear',
    onclick: () => coachClearSheet(),
  },
    h('span', { class: 'settings-label danger', text: 'Clear coach data…' }),
    h('span', { class: 'settings-chev' }, Icon('chevron')),
  );
}

/** Two distinct destructive choices, matching disconnectSheet's shape. */
function coachClearSheet() {
  openSheet(h('div', {},
    sheetHeader('Clear coach data', { onClose: () => closeSheet() }),
    h('p', {
      class: 'sheet-message muted',
      text: 'Your workouts are never touched. Clearing the key hides the Coach tab.',
    }),
    h('div', { class: 'sheet-actions' },
      h('button', {
        class: 'sheet-btn danger', type: 'button', 'data-action': 'coach-clear-data',
        onclick: async () => { closeSheet(); await clearCoachData({ keepKey: true }); renderSettings(); },
      }, 'Clear plans and summaries'),
      h('button', {
        class: 'sheet-btn danger', type: 'button', 'data-action': 'coach-clear-all',
        onclick: async () => {
          closeSheet();
          await clearCoachData({ keepKey: false });
          refreshCoachTab();
          renderSettings();
        },
      }, 'Clear everything including the API key'),
      h('button', { class: 'sheet-btn cancel', type: 'button', 'data-action': 'cancel', onclick: () => closeSheet() }, 'Cancel'),
    ),
  ));
}

// ---- about card --------------------------------------------------------
function aboutCard() {
  return h('div', { class: 'tab-card about-card' },
    h('div', { class: 'about-name', text: 'Gym Tracker' }),
    h('p', { class: 'about-line muted', text: 'Built for Dan — data lives on this device.' }),
  );
}
