// ============================================================================
// ui.js — entry module: hyperscript builder, formatting helpers, hash router,
// bottom-tab bar, bottom-sheet infrastructure, rest-timer wiring and the shared
// helpers every screen module imports. No screen markup lives here beyond the
// glue; the screens themselves are in js/screens/*.
//
// User-supplied text (notes, custom exercise names) is only ever written via
// textContent / the h() text prop — never innerHTML.
// ============================================================================

import {
  putWorkout, getWorkout, listWorkouts, putSet, getExercise,
} from './db.js';
import { seedIfEmpty } from './seed.js';
import * as timer from './timer.js';
import { uid, nowISO, todayISO } from './util.js';
import { EXERCISE_TYPE_GROUPS, blankSet } from './exercise-types.js';
import { playOnce, motionOK } from './motion.js';
import { closeOpenSwipe } from './swipe.js';
import { initHealth } from './health.js';

import { renderWorkoutScreen } from './screens/workout.js';
import { renderPick } from './screens/picker.js';
import { renderLogTab } from './screens/log.js';
import { renderCopyPicker, renderRoutineEditor } from './screens/routines.js';
import { renderStats } from './screens/stats.js';
import { renderSettings } from './screens/settings.js';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------
const LB_PER_KG = 2.20462;
export const WEIGHT_STEP = 2.5; // in DISPLAY units (kg or lb)
export const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

const state = { currentWorkoutId: null };
let currentRouteKey = null;
let screenCleanup = null; // per-screen teardown (e.g. the elapsed ticker)

const screens = {
  log: document.getElementById('s-log'),
  stats: document.getElementById('s-stats'),
  settings: document.getElementById('s-settings'),
  workout: document.getElementById('s-workout'),
  pick: document.getElementById('s-pick'),
  copy: document.getElementById('s-copy'),
  routine: document.getElementById('s-routine'),
};
const TABS = ['log', 'stats'];

// ----------------------------------------------------------------------------
// Tiny DOM builder (hyperscript). No innerHTML anywhere.
// ----------------------------------------------------------------------------
export function h(tag, props, ...children) {
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
      else if (k === 'onkeydown') e.addEventListener('keydown', v);
      else if (k === 'onpointerdown') e.addEventListener('pointerdown', v);
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
// Inline SVG icons. Each call returns a FRESH node (DOM nodes can't be reused).
// ----------------------------------------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function svg(children, { size = 24, viewBox = '0 0 24 24', fill = false } = {}) {
  const el = svgEl('svg', {
    viewBox, width: size, height: size, 'aria-hidden': 'true',
    fill: fill ? 'currentColor' : 'none',
  });
  if (!fill) {
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
  }
  for (const c of children.flat()) el.appendChild(c);
  return el;
}
const p = (d) => svgEl('path', { d });

const ICONS = {
  check: () => svg([p('M20 6 9 17l-5-5')]),
  alarm: () => svg([svgEl('circle', { cx: 12, cy: 13, r: 7 }), p('M12 10v3l2 2'), p('M5 3 2 6'), p('M19 3l3 3')]),
  dots: () => svg([svgEl('circle', { cx: 5, cy: 12, r: 1.6 }), svgEl('circle', { cx: 12, cy: 12, r: 1.6 }), svgEl('circle', { cx: 19, cy: 12, r: 1.6 })], { fill: true }),
  plus: () => svg([p('M12 5v14M5 12h14')]),
  minus: () => svg([p('M5 12h14')]),
  back: () => svg([p('M15 18l-6-6 6-6')]),
  close: () => svg([p('M18 6 6 18M6 6l12 12')]),
  search: () => svg([svgEl('circle', { cx: 11, cy: 11, r: 7 }), p('M21 21l-4-4')]),
  chevron: () => svg([p('M9 6l6 6-6 6')]),
  down: () => svg([p('M6 9l6 6 6-6')]),
  up: () => svg([p('M6 15l6-6 6 6')]),
  history: () => svg([p('M3 12a9 9 0 1 0 3-6.7L3 8'), p('M3 3v5h5'), p('M12 8v4l3 2')]),
  bars: () => svg([p('M6 20V10M12 20V4M18 20v-7')]),
  star: () => svg([p('M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.2l5.9-.9z')]),
  move: () => svg([p('M4 8h16M4 16h16')]),
  trash: () => svg([p('M4 7h16'), p('M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2'), p('M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13')]),
  note: () => svg([p('M12 20h9'), p('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z')]),
  info: () => svg([svgEl('circle', { cx: 12, cy: 12, r: 9 }), p('M12 11v5'), p('M12 8h.01')]),
  lock: () => svg([svgEl('rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }), p('M8 11V8a4 4 0 0 1 8 0v3')]),
  swap: () => svg([p('M4 8h13l-3-3'), p('M20 16H7l3 3')]),
  gear: () => svg([
    svgEl('circle', { cx: 12, cy: 12, r: 3.2 }),
    p('M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.58 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.86a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.22.63.8 1.05 1.47 1.06H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.94z'),
  ]),
};

/** A fresh SVG icon node by name. Unknown names return an empty group. */
export function Icon(name) {
  return (ICONS[name] || (() => svg([])))();
}

/** The settings gear shown top-right of every tab header (replaced the
 * Profile tab). Each call returns a fresh button. */
export function gearButton() {
  return h('button', {
    class: 'round-btn tab-head-btn', type: 'button', 'aria-label': 'Settings',
    'data-action': 'open-settings', onclick: () => go('#/settings'),
  }, Icon('gear'));
}

// ----------------------------------------------------------------------------
// Formatting & units
// ----------------------------------------------------------------------------
export function getUnits() {
  return localStorage.getItem('settings.units') === 'lb' ? 'lb' : 'kg';
}
export function unitLabel() {
  return getUnits() === 'lb' ? 'Lb' : 'Kg';
}
export function trimNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
/** Storage kg -> display number (rounded to a sensible step in the display unit). */
export function kgToDisplay(kg) {
  if (kg == null || Number.isNaN(kg)) return 0;
  return getUnits() === 'lb' ? Math.round(kg * LB_PER_KG * 100) / 100 : Math.round(kg * 100) / 100;
}
/** Display-unit number -> stored kg (rounded to 2dp per the domain rule). */
export function displayToKg(v) {
  if (v == null || Number.isNaN(v)) return 0;
  return getUnits() === 'lb' ? Math.round((v / LB_PER_KG) * 100) / 100 : Math.round(v * 100) / 100;
}
/** Single source of truth for weight display WITH unit (used in history/PR lines). */
export function formatWeight(kg) {
  if (kg == null || Number.isNaN(kg)) return '—';
  return `${trimNum(kgToDisplay(kg))} ${getUnits()}`;
}
export function mmss(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
export function formatDate(iso) {
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
/** "Tue 21 Jul at 16:39" */
export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} at ${time}`;
}

/** Display name for a workout: its own name, else derived from start hour. */
export function displayName(w) {
  if (w && w.name) return w.name;
  const hr = new Date(w.startedAt).getHours();
  return hr < 12 ? 'Morning Workout' : hr < 17 ? 'Afternoon Workout' : 'Evening Workout';
}

// ----------------------------------------------------------------------------
// Workout entries (schema v2). entries is the ordered exercise list; for legacy
// workouts (entries null) we derive it from the sets' first completedAt.
// ----------------------------------------------------------------------------
export function getEntries(workout, sets) {
  if (Array.isArray(workout.entries)) return workout.entries;
  const firstAt = new Map();
  for (const s of sets) {
    const cur = firstAt.get(s.exerciseId);
    if (cur == null || s.completedAt < cur) firstAt.set(s.exerciseId, s.completedAt);
  }
  return [...firstAt.entries()]
    .sort((a, b) => (a[1] < b[1] ? -1 : 1))
    .map(([exerciseId]) => ({ exerciseId, supersetGroup: null, note: null }));
}
/** Persist a new entries array on the workout; returns the stored record. */
export async function saveEntries(workout, entries) {
  return putWorkout({ ...workout, entries });
}

// ----------------------------------------------------------------------------
// Navigation & current-workout resolution
// ----------------------------------------------------------------------------
export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

export function setCurrent(id) {
  state.currentWorkoutId = id;
  if (id) localStorage.setItem('currentWorkoutId', id);
  else localStorage.removeItem('currentWorkoutId');
}

/** The in-progress workout (finishedAt null), resolved robustly across reloads. */
export async function currentWorkout() {
  const id = state.currentWorkoutId || localStorage.getItem('currentWorkoutId');
  if (id) {
    const w = await getWorkout(id);
    if (w && !w.finishedAt) { state.currentWorkoutId = id; return w; }
  }
  const all = await listWorkouts('0000');
  const inProgress = all.find((w) => !w.finishedAt);
  if (inProgress) { setCurrent(inProgress.id); return inProgress; }
  setCurrent(null);
  return null;
}

/**
 * Auto-create the first (blank) set for a just-added workout entry — selecting
 * an exercise means you'll do at least one set. Values start at zero and render
 * as empty inputs with grey last-session placeholders. No rest timer here.
 */
export async function createInitialSet(workoutId, exerciseId, setNumber = 1) {
  const exercise = await getExercise(exerciseId);
  if (!exercise) return null;
  return putSet(blankSet(workoutId, exercise, setNumber));
}

/** Create a workout (optionally seeding entries from a template) and open it. */
export async function startWorkout(template = null) {
  const entries = template
    ? (template.entries || []).map((e) => ({ exerciseId: e.exerciseId, supersetGroup: null, note: null }))
    : [];
  const w = await putWorkout({
    id: uid(),
    date: todayISO(),
    startedAt: nowISO(),
    finishedAt: null,
    templateId: template ? template.id : null,
    name: null,
    bodyweightKg: null,
    notes: null,
    entries,
  });
  for (const e of entries) await createInitialSet(w.id, e.exerciseId);
  setCurrent(w.id);
  go('#/workout');
}

// ----------------------------------------------------------------------------
// Bottom-sheet infrastructure. Sheets stack: closeSheet() pops the topmost, so a
// menu can open a confirm/sub-sheet on top of itself. Tapping the backdrop or
// navigating closes them.
// ----------------------------------------------------------------------------
const sheetRoot = document.getElementById('sheet-root');

// Background scroll lock. Without it the page scrolls behind an open sheet,
// which reads as jank. position:fixed + a restored offset is the only thing
// iOS honours; a counter keeps stacked sheets from unlocking early.
let scrollLockY = 0;
function lockScroll() {
  if (document.body.classList.contains('scroll-locked')) return;
  scrollLockY = window.scrollY;
  document.body.style.top = `-${scrollLockY}px`;
  document.body.classList.add('scroll-locked');
}
function unlockScroll() {
  if (!document.body.classList.contains('scroll-locked')) return;
  document.body.classList.remove('scroll-locked');
  document.body.style.top = '';
  window.scrollTo(0, scrollLockY);
}

export function openSheet(content) {
  const inner = typeof content === 'function' ? content() : content;
  const sheet = h('div', { class: 'sheet' }, inner);
  sheet.addEventListener('click', (e) => e.stopPropagation());
  const backdrop = h('div', { class: 'sheet-backdrop' }, sheet);
  backdrop.addEventListener('click', () => closeSheet());
  sheetRoot.append(backdrop);
  if (!document.body.classList.contains('sheet-open')) lockScroll();
  document.body.classList.add('sheet-open');
  // Force a layout pass so the browser has painted the off-screen start state
  // before .open flips it — a single rAF is too early on iOS and the sheet
  // pops in instead of sliding.
  void sheet.offsetHeight;
  backdrop.classList.add('open');
  return backdrop;
}

export function closeSheet() {
  const all = sheetRoot.querySelectorAll('.sheet-backdrop');
  const top = all[all.length - 1];
  if (!top) return;
  top.classList.remove('open');
  const done = () => top.remove();
  top.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 260); // fallback if transitionend doesn't fire
  if (all.length <= 1) { document.body.classList.remove('sheet-open'); unlockScroll(); }
}

export function closeAllSheets() {
  sheetRoot.replaceChildren();
  document.body.classList.remove('sheet-open');
  unlockScroll();
}

// ---- reusable sheet building blocks (shared styling for every screen) ----
export function sheetHeader(title, { onSave, onClose } = {}) {
  return h('div', { class: 'sheet-head' },
    onClose ? h('button', { class: 'sheet-x', 'aria-label': 'Close', onclick: onClose }, Icon('close')) : h('span', {}),
    h('div', { class: 'sheet-title', text: title }),
    onSave
      ? h('button', { class: 'sheet-tick', 'data-action': 'save', 'aria-label': 'Save', onclick: onSave }, Icon('check'))
      : (onClose ? h('span', {}) : h('button', { class: 'sheet-x', 'aria-label': 'Close', onclick: () => closeSheet() }, Icon('close'))),
  );
}
export function sheetGroup(...rows) {
  return h('div', { class: 'sheet-group' }, ...rows.filter(Boolean));
}
export function sheetRow({ label, sub, value, icon, danger, locked, action, chevron, onClick }) {
  return h('button', {
    class: 'sheet-row' + (danger ? ' danger' : ''),
    'data-action': action, type: 'button', onclick: onClick,
  },
    icon ? h('span', { class: 'sheet-row-icon' }, icon) : null,
    h('span', { class: 'sheet-row-label' },
      h('span', { text: label }),
      sub ? h('span', { class: 'sheet-row-sub', text: sub }) : null,
    ),
    value != null ? h('span', { class: 'sheet-row-value', text: value }) : null,
    locked ? h('span', { class: 'sheet-row-lock' }, Icon('lock')) : null,
    chevron ? h('span', { class: 'sheet-row-chev' }, Icon('chevron')) : null,
  );
}

/** A confirm bottom sheet. Both buttons close the sheet first. */
export function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  openSheet(h('div', {},
    sheetHeader(title, { onClose: () => closeSheet() }),
    message ? h('p', { class: 'sheet-message', text: message }) : null,
    h('div', { class: 'sheet-actions' },
      h('button', {
        class: 'sheet-btn' + (danger ? ' danger' : ''), 'data-action': 'confirm', type: 'button',
        onclick: async () => { closeSheet(); await onConfirm(); },
      }, confirmLabel),
      h('button', { class: 'sheet-btn cancel', 'data-action': 'cancel', type: 'button', onclick: () => closeSheet() }, 'Cancel'),
    ),
  ));
}

/** A textarea sheet (notes). onSave(trimmedOrNull). */
export function textareaSheet({ title, value, placeholder = 'Notes', onSave }) {
  const ta = h('textarea', { class: 'sheet-textarea', placeholder, rows: '5' });
  ta.value = value || '';
  const save = async () => { closeSheet(); await onSave(ta.value.trim() || null); };
  openSheet(h('div', {},
    sheetHeader(title, { onSave: save }),
    h('div', { class: 'sheet-group' }, ta),
  ));
  requestAnimationFrame(() => ta.focus());
}

/** A single-choice option sub-sheet. options: [{value,label,sub}]. */
export function optionSheet({ title, options, current, onPick }) {
  openSheet(h('div', {},
    sheetHeader(title, { onClose: () => closeSheet() }),
    sheetGroup(...options.map((o) => sheetRow({
      label: o.label, sub: o.sub,
      value: current === o.value ? '✓' : null,
      onClick: () => { closeSheet(); onPick(o.value); },
    }))),
  ));
}

/**
 * The grouped exercise-type picker (matches the RepCount reference screens):
 * one section per EXERCISE_TYPE_GROUPS entry, options carry grey example
 * lines, the current type shows a teal tick, and group notes render beneath.
 */
export function exerciseTypeSheet({ current, onPick }) {
  const sections = [];
  for (const group of EXERCISE_TYPE_GROUPS) {
    sections.push(h('div', { class: 'sheet-label', text: group.label }));
    sections.push(sheetGroup(...group.types.map((t) => h('button', {
      class: 'sheet-row', type: 'button', 'data-type-id': t.id,
      onclick: () => { closeSheet(); onPick(t.id); },
    },
      h('span', { class: 'sheet-row-label' },
        h('span', { text: t.label }),
        h('span', { class: 'sheet-row-sub', text: `Examples: ${t.examples}` }),
      ),
      current === t.id ? h('span', { class: 'sheet-row-tick' }, Icon('check')) : null,
    ))));
    if (group.note) sections.push(h('p', { class: 'sheet-note muted', text: group.note }));
  }
  openSheet(h('div', {},
    sheetHeader('Exercise Type', { onClose: () => closeSheet() }),
    ...sections,
  ));
}

// ----------------------------------------------------------------------------
// Router
// ----------------------------------------------------------------------------
function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}
function setActiveTab(tab) {
  for (const btn of document.querySelectorAll('#tabbar button')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
}
/** Registered by a screen to tear down timers when the route changes. */
export function setScreenCleanup(fn) {
  screenCleanup = fn;
}

async function route() {
  if (screenCleanup) { try { screenCleanup(); } catch (e) { /* ignore */ } screenCleanup = null; }
  closeAllSheets();
  closeOpenSwipe(); // a revealed Delete must never survive a navigation

  const raw = (location.hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  const [a, b] = parts;
  const key = parts.join('/');
  const changed = key !== currentRouteKey;
  currentRouteKey = key;

  if (!a) { location.replace('#/log'); return; }
  if (a === 'profile') { location.replace('#/settings'); return; } // legacy route
  // The Routines tab became the Copy Routine picker + a routine editor reached
  // from a workout's menu (30 Jul 2026); keep the old route working.
  if (a === 'routines') { location.replace('#/copy/routines'); return; }

  const tab = TABS.includes(a) ? a : null;
  const fullscreenRoutes = ['workout', 'pick', 'settings', 'copy', 'routine'];
  document.body.classList.toggle('fullscreen', fullscreenRoutes.includes(a));
  setActiveTab(tab);

  try {
    if (tab) {
      showScreen(tab);
      if (tab === 'log') await renderLogTab();
      // Stats owns its sub-routes (#/stats/exercises, #/stats/exercise/:id,
      // #/stats/category/:g, #/stats/overall/:metric …) — tab bar stays up.
      else await renderStats(parts.slice(1));
    } else if (a === 'copy') {
      showScreen('copy');
      await renderCopyPicker(parts.slice(1));
    } else if (a === 'routine') {
      showScreen('routine');
      await renderRoutineEditor(parts.slice(1));
    } else if (a === 'settings') {
      showScreen('settings');
      await renderSettings();
    } else if (a === 'workout') {
      showScreen('workout');
      await renderWorkoutScreen(b || null);
    } else if (a === 'pick') {
      showScreen('pick');
      await renderPick(b || null);
    } else {
      location.replace('#/log');
      return;
    }
  } catch (err) {
    console.error('route error', err);
  }
  updateResumeBar(a); // fire-and-forget; hides itself when nothing is in progress
  if (changed) {
    window.scrollTo(0, 0);
    // A genuine route change drifts its screen into place. Deliberately NOT on
    // re-renders of the same screen: committing a set must never re-animate
    // the workout, and the screen is interactive throughout regardless.
    const shown = screens[tab || a];
    if (shown && shown.firstElementChild) playOnce(shown.firstElementChild, 'anim-float-in');
  }
}

// ----------------------------------------------------------------------------
// Rest timer bar (shell)
// ----------------------------------------------------------------------------
const restBar = document.getElementById('rest-bar');
const restBarTime = document.getElementById('rest-bar-time');

// ---- pill show/hide -------------------------------------------------------
// The pills pop in and drop out rather than blinking. `hidden` stays the
// source of truth (CSS and the test suite both read it): it is cleared before
// the entrance and set only once the exit has finished, so an animating pill
// is always genuinely visible. Pending exits are tracked per element so a
// re-show mid-exit cancels cleanly instead of hiding the pill a beat later.
const pillExits = new WeakMap();

function cancelPillExit(el) {
  const t = pillExits.get(el);
  if (t) { clearTimeout(t); pillExits.delete(el); }
  el.classList.remove('anim-pill-out');
}

function pillShow(el) {
  cancelPillExit(el);
  if (!el.hidden) return; // already up — don't re-play the entrance
  el.hidden = false;
  playOnce(el, 'anim-pill-in');
}

function pillHide(el) {
  cancelPillExit(el);
  if (el.hidden) return;
  if (!motionOK()) { el.hidden = true; return; }
  el.classList.remove('anim-pill-in');
  el.classList.add('anim-pill-out');
  const done = () => {
    el.removeEventListener('animationend', done);
    cancelPillExit(el);
    el.hidden = true;
  };
  el.addEventListener('animationend', done);
  // Fallback: an animation on a hidden tab may never fire animationend, and a
  // pill that never hides would sit over the tab bar forever.
  pillExits.set(el, setTimeout(done, 500));
}

function showRestBar(secs) {
  restBarTime.textContent = mmss(secs);
  pillShow(restBar);
  document.body.classList.add('timer-active');
}
function hideRestBar() {
  pillHide(restBar);
  document.body.classList.remove('timer-active');
}
restBar.addEventListener('click', () => { timer.cancel(); hideRestBar(); });

function onTimerTick(secs) { if (secs > 0) showRestBar(secs); else hideRestBar(); }
function onTimerDone() {
  // Rest is over: one swell to catch the eye, then leave.
  if (!restBar.hidden && motionOK()) {
    playOnce(restBar, 'anim-pill-done');
    setTimeout(() => hideRestBar(), 520);
    document.body.classList.remove('timer-active');
    return;
  }
  hideRestBar();
}

// ----------------------------------------------------------------------------
// Resume bar (shell): when a workout is in progress but minimised (any route
// except the workout screen itself / the picker), a pill above the tab bar
// shows "Resume Workout" + live elapsed time. Tap returns to the workout.
// ----------------------------------------------------------------------------
const resumeBar = document.getElementById('resume-bar');
const resumeBarTime = document.getElementById('resume-bar-time');
let resumeTimer = null;

resumeBar.addEventListener('click', () => go('#/workout'));

function hideResumeBar() {
  if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
  pillHide(resumeBar);
  document.body.classList.remove('resume-active');
}

let resumeBarSeq = 0;
async function updateResumeBar(routeHead) {
  const seq = ++resumeBarSeq;
  if (routeHead === 'workout' || routeHead === 'pick') { hideResumeBar(); return; }
  const w = await currentWorkout();
  if (seq !== resumeBarSeq) return; // a newer route already decided
  if (!w) { hideResumeBar(); return; }
  const tickFn = () => { resumeBarTime.textContent = formatElapsed(Date.now() - new Date(w.startedAt)); };
  tickFn();
  if (resumeTimer) clearInterval(resumeTimer);
  resumeTimer = setInterval(tickFn, 1000);
  pillShow(resumeBar);
  document.body.classList.add('resume-active');
}

// ----------------------------------------------------------------------------
// Startup
// ----------------------------------------------------------------------------
async function init() {
  // Inside the Capacitor shell the assets are bundled with the app, so the SW
  // adds nothing and its reload-on-update dance can fight the native lifecycle.
  const isNativeShell = !!window.Capacitor?.isNativePlatform?.();
  if ('serviceWorker' in navigator && !isNativeShell) {
    // Self-updating PWA: the SW is cache-first, so a launch always shows the
    // OLD version while the new one installs in the background. When the new
    // worker takes control (skipWaiting + clients.claim in sw.js), reload once
    // so the update lands on THIS launch instead of the next. The
    // hadController guard stops the very first install from reloading, and the
    // once-flag stops any loop. Data is safe — IndexedDB is not the SW cache.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* file:// etc. */ }
  }
  try { await seedIfEmpty(); } catch (e) { console.error('seed failed', e); }
  // Apple Health (native shell only — a guarded no-op in the PWA). Not awaited:
  // startup must never block on HealthKit.
  initHealth().catch((e) => console.error('health init failed', e));
  timer.bind({ tick: onTimerTick, done: onTimerDone });

  for (const btn of document.querySelectorAll('#tabbar button')) {
    btn.addEventListener('click', () => go('#/' + btn.dataset.tab));
  }
  window.addEventListener('hashchange', route);
  await route();
}

init();
