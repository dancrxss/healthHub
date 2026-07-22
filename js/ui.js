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
  putWorkout, getWorkout, listWorkouts,
} from './db.js';
import { seedIfEmpty } from './seed.js';
import * as timer from './timer.js';
import { uid, nowISO, todayISO } from './util.js';

import { renderWorkoutScreen } from './screens/workout.js';
import { renderPick } from './screens/picker.js';
import { renderLogTab } from './screens/log.js';
import { renderRoutines } from './screens/routines.js';
import { renderStats } from './screens/stats.js';
import { renderProfile } from './screens/profile.js';

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
  routines: document.getElementById('s-routines'),
  stats: document.getElementById('s-stats'),
  profile: document.getElementById('s-profile'),
  workout: document.getElementById('s-workout'),
  pick: document.getElementById('s-pick'),
};
const TABS = ['log', 'routines', 'stats', 'profile'];

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
  history: () => svg([p('M3 12a9 9 0 1 0 3-6.7L3 8'), p('M3 3v5h5'), p('M12 8v4l3 2')]),
  bars: () => svg([p('M6 20V10M12 20V4M18 20v-7')]),
  star: () => svg([p('M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.2l5.9-.9z')]),
  move: () => svg([p('M4 8h16M4 16h16')]),
  trash: () => svg([p('M4 7h16'), p('M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2'), p('M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13')]),
  note: () => svg([p('M12 20h9'), p('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z')]),
  info: () => svg([svgEl('circle', { cx: 12, cy: 12, r: 9 }), p('M12 11v5'), p('M12 8h.01')]),
  lock: () => svg([svgEl('rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }), p('M8 11V8a4 4 0 0 1 8 0v3')]),
  swap: () => svg([p('M4 8h13l-3-3'), p('M20 16H7l3 3')]),
};

/** A fresh SVG icon node by name. Unknown names return an empty group. */
export function Icon(name) {
  return (ICONS[name] || (() => svg([])))();
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
  setCurrent(w.id);
  go('#/workout');
}

// ----------------------------------------------------------------------------
// Bottom-sheet infrastructure. Sheets stack: closeSheet() pops the topmost, so a
// menu can open a confirm/sub-sheet on top of itself. Tapping the backdrop or
// navigating closes them.
// ----------------------------------------------------------------------------
const sheetRoot = document.getElementById('sheet-root');

export function openSheet(content) {
  const inner = typeof content === 'function' ? content() : content;
  const sheet = h('div', { class: 'sheet' }, inner);
  sheet.addEventListener('click', (e) => e.stopPropagation());
  const backdrop = h('div', { class: 'sheet-backdrop' }, sheet);
  backdrop.addEventListener('click', () => closeSheet());
  sheetRoot.append(backdrop);
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => backdrop.classList.add('open'));
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
  if (all.length <= 1) document.body.classList.remove('sheet-open');
}

export function closeAllSheets() {
  sheetRoot.replaceChildren();
  document.body.classList.remove('sheet-open');
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

  const raw = (location.hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  const [a, b] = parts;
  const key = parts.join('/');
  const changed = key !== currentRouteKey;
  currentRouteKey = key;

  if (!a) { location.replace('#/log'); return; }

  const tab = TABS.includes(a) ? a : null;
  document.body.classList.toggle('fullscreen', a === 'workout' || a === 'pick');
  setActiveTab(tab);

  try {
    if (tab) {
      showScreen(tab);
      if (tab === 'log') await renderLogTab();
      else if (tab === 'routines') await renderRoutines();
      else if (tab === 'stats') await renderStats();
      else await renderProfile();
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
  if (changed) window.scrollTo(0, 0);
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

function onTimerTick(secs) { if (secs > 0) showRestBar(secs); else hideRestBar(); }
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

  for (const btn of document.querySelectorAll('#tabbar button')) {
    btn.addEventListener('click', () => go('#/' + btn.dataset.tab));
  }
  window.addEventListener('hashchange', route);
  await route();
}

init();
