// ============================================================================
// screens/coach.js — the Coach tab (#/coach) and every screen under it.
//
// Routes (the router hands us the hash path after 'coach'; the tab bar stays):
//   #/coach                       the summary screen (status, next session,
//                                 today, balance, last session, recovery)
//   #/coach/balance               muscle balance in full, all groups
//   #/coach/session/:workoutId    per-exercise session diff + the coach's read
//   #/coach/plan                  the whole plan, week by week
//   #/coach/history               the last 14 daily summaries
//   #/coach/builder                the plan builder (profile + memory + build)
//   #/coach/chat                  chat with the coach about the plan
//   #/coach/setup                 legacy — redirects to #/coach/builder
//
// Everything here reads from IndexedDB or computes live from the pure engine
// (js/coach-engine.js) — nothing on these screens touches the network. The
// exceptions are buttons the user presses ("Get started", "Build plan",
// "Analyse this session", chat) which call into js/coach.js, which owns the
// API queue.
//
// Model-written text (headlines, notes, plan reasons) is untrusted content and
// only ever reaches the DOM through textContent / the h() `text` prop — never
// innerHTML.
// ============================================================================

import {
  listExercises, getWorkout, listCoachInsights, getCoachInsightForWorkout, MUSCLE_GROUPS,
} from '../db.js';
import { muscleBalance, sessionDiff, projectPlanWeek } from '../coach-engine.js';
import { userMessageFor, normaliseNarrative } from '../coach-api.js';
import {
  getCoachState, getProfile, loadDataset, createPlan, saveProfile, sanitiseProfile,
  runSessionFeedback, dismissError, markCoachRead, onCoachUpdate,
  getMemory, addMemory, removeMemory,
} from '../coach.js';
import {
  h, Icon, gearButton, go, openSheet, closeSheet, sheetHeader,
  sheetRow, optionSheet, confirmSheet, textareaSheet, formatWeight, kgToDisplay,
  unitLabel, trimNum, formatDate, currentWorkout, setScreenCleanup,
  startPlannedWorkout, requestBottomScroll,
} from '../ui.js';
import { todayISO } from '../util.js';
import { stagger } from '../motion.js';
import { normalizeExerciseType } from '../exercise-types.js';
import {
  bullets, targetText, chatPanel, multiSelectSheet, weekSelector, tonePill,
} from './coach-shared.js';

// ----------------------------------------------------------------------------
// Vocabularies (mirrors of the enums pinned in coach-api.js — kept as display
// maps only; an unknown value falls back to the raw string, never to a crash).
// ----------------------------------------------------------------------------
const GOAL_OPTIONS = [
  { value: 'return-from-injury', label: 'Return from injury' },
  { value: 'build-muscle', label: 'Build muscle' },
  { value: 'get-stronger', label: 'Get stronger' },
  { value: 'general-fitness', label: 'General fitness' },
];
const SPLIT_OPTIONS = [
  { value: 'auto', label: 'Let coach decide' },
  { value: 'full-body', label: 'Full body' },
  { value: 'upper-lower', label: 'Upper–Lower' },
  { value: 'ppl', label: 'Push–Pull–Legs' },
];
const GROUP_PREF_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'include', label: 'Include' },
  { value: 'emphasise', label: 'Emph.' },
  { value: 'avoid', label: 'Avoid' },
];

const DAILY_TONES = {
  encouraging: { label: 'Encouraging', tone: 'good' },
  steady: { label: 'Steady', tone: 'neutral' },
  caution: { label: 'Caution', tone: 'warn' },
};
const SESSION_TONES = {
  great: { label: 'Great', tone: 'good' },
  solid: { label: 'Solid', tone: 'good' },
  mixed: { label: 'Mixed', tone: 'neutral' },
  'back-off': { label: 'Back off', tone: 'warn' },
};
const VERDICTS = {
  better: 'Better',
  worse: 'Worse',
  same: 'Same',
  new: 'New',
};
const FLAG_LABELS = {
  'volume-spike': 'Volume spike',
  'group-volume-spike': 'Muscle group spike',
  'rpe-creep': 'Effort creeping up',
  'e1rm-regression': 'Strength dip',
  'no-rest-day': 'No rest day',
  'frequency-drop': 'Training less often',
  'return-ramp': 'Return ramp',
  'low-hrv': 'Low HRV',
  'elevated-rhr': 'Resting heart rate up',
  'short-sleep': 'Short sleep',
  'weight-drop': 'Body weight dropping',
  other: 'Note',
};
const PLAN_CHANGES = {
  'weight-up': 'weight up',
  'weight-down': 'weight down',
  'reps-up': 'reps up',
  'reps-down': 'reps down',
  'sets-up': 'sets up',
  'sets-down': 'sets down',
  swap: 'swap',
  remove: 'remove',
  add: 'add',
  hold: 'hold',
};
/** Balance rows sort by how much they want attention. */
const STATUS_ORDER = { over: 0, under: 1, untrained: 2, on: 3, unscored: 4 };
const STATUS_CLASS = {
  over: 'coach-fill-over',
  under: 'coach-fill-under',
  untrained: 'coach-fill-untrained',
  on: 'coach-fill-on',
  unscored: 'coach-fill-untrained',
};

// ----------------------------------------------------------------------------
// Module-level render state
// ----------------------------------------------------------------------------
/** Bumped on every renderCoach so late async work from an old screen is dropped. */
let renderToken = 0;
/** The route the screen is currently showing — what a coach update re-renders. */
let currentParts = [];
/** Live subscription to js/coach.js. Registered ONCE and never re-registered
 * from inside a notification: onCoachUpdate iterates a Set, and adding to it
 * mid-notification would re-enter the same loop. */
let unsubCoach = null;
/** The week shown on #/coach/plan. Persists across coach-update re-renders of
 * the same route; reset (to the current week) whenever the route is left. */
let planSelectedWeek = null;
/** The open chat panel on #/coach/chat, destroyed on cleanup. */
let activeChatPanel = null;

function stopCoachSubscription() {
  if (unsubCoach) { unsubCoach(); unsubCoach = null; }
}
function ensureCoachSubscription() {
  if (unsubCoach) return;
  unsubCoach = onCoachUpdate(() => {
    const screen = document.getElementById('s-coach');
    if (!screen || screen.hidden) return; // another tab is showing; nothing to repaint
    renderCoach(currentParts).catch((err) => console.error('coach: refresh failed', err));
  });
}

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const titleCase = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');

/** "2 Sep" — the plan footer wants the date without the weekday. */
function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Volume: display units, thousands separated, e.g. "1,680 kg". */
function volumeText(kg) {
  if (kg == null || !Number.isFinite(Number(kg))) return '—';
  return `${Math.round(kgToDisplay(Number(kg))).toLocaleString('en-GB')} ${unitLabel().toLowerCase()}`;
}
/** e1RM: display units, always one decimal (domain rule). */
function e1rmText(kg) {
  if (kg == null || !Number.isFinite(Number(kg))) return '—';
  return `${kgToDisplay(Number(kg)).toFixed(1)} ${unitLabel().toLowerCase()}`;
}
/** One decimal, signed, e.g. "−1.2%". */
function pctText(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** A set from the engine — {w,r,rpe} or {weightKg,reps,rpe}; either is fine. */
function setText(s) {
  if (!s || typeof s !== 'object') return null;
  const w = numOrNull(s.w ?? s.weightKg);
  const r = numOrNull(s.r ?? s.reps);
  if (w == null && r == null) return null;
  const rpe = numOrNull(s.rpe);
  const base = `${w == null ? '—' : formatWeight(w)} × ${r == null ? '—' : trimNum(r)}`;
  return rpe == null ? base : `${base} @ RPE ${trimNum(rpe)}`;
}

function exName(id, exMap) {
  const ex = exMap.get(id);
  return ex ? ex.name : 'Unknown exercise';
}

/** Back-header in the picker style (mirrors stats.js). */
function backHeader(title, backHash = '#/coach') {
  return h('header', { class: 'pick-head coach-head' },
    h('button', {
      class: 'round-btn', type: 'button', 'aria-label': 'Back',
      'data-action': 'coach-back', onclick: () => go(backHash),
    }, Icon('back')),
    h('div', { class: 'pick-title', text: title }),
    h('span', { class: 'round-btn-ghost' }),
  );
}

function tabHead() {
  return h('div', { class: 'tab-head' },
    h('h1', { class: 'tab-title', text: 'Coach' }),
    gearButton(),
  );
}

function emptyLine(text) {
  return h('p', { class: 'coach-empty muted', text });
}

/** A label + value pair in the settings-row idiom. */
function pairRow(label, value) {
  if (value == null) return null;
  return h('div', { class: 'settings-row coach-pair' },
    h('span', { class: 'settings-label', text: label }),
    h('span', { class: 'settings-value', text: value }),
  );
}

/** A quiet full-width link row — used in both plan footers. */
function linkRow(label, action, onClick) {
  return h('button', {
    class: 'coach-link-row', type: 'button', 'data-action': action, onclick: onClick,
  },
    h('span', { text: label }),
    h('span', { class: 'coach-link-chev' }, Icon('chevron')),
  );
}

// ============================================================================
// Router entry
// ============================================================================
/**
 * @param {string[]} parts hash path after 'coach' — [] | ['balance'] |
 *   ['session', workoutId] | ['plan'] | ['history'] | ['builder'] | ['chat'] |
 *   ['setup'] (redirects)
 */
export async function renderCoach(parts = []) {
  const prevHead = currentParts[0];
  currentParts = Array.isArray(parts) ? parts.slice() : [];
  if (prevHead === 'plan' && currentParts[0] !== 'plan') planSelectedWeek = null;

  const screen = document.getElementById('s-coach');
  if (!screen) return;
  const token = ++renderToken;

  ensureCoachSubscription();
  setScreenCleanup(() => stopCoachSubscription());

  const [a, b] = currentParts;
  try {
    if (a === 'balance') return await renderBalanceScreen(screen, token);
    if (a === 'session' && b) return await renderSessionScreen(screen, b, token);
    if (a === 'plan') return await renderPlanScreen(screen, token);
    if (a === 'history') return await renderHistoryScreen(screen, token);
    if (a === 'builder') return await renderBuilderScreen(screen, token);
    if (a === 'chat') return await renderChatScreen(screen, token);
    if (a === 'setup') { location.replace('#/coach/builder'); return undefined; }
    if (a) { go('#/coach'); return undefined; }
    return await renderRoot(screen, token);
  } catch (err) {
    console.error('coach: render failed', err);
    if (token === renderToken) {
      screen.replaceChildren(h('div', { class: 'tab-screen coach-screen' },
        tabHead(),
        h('div', { class: 'tab-card coach-card' },
          emptyLine('The coach screen could not be shown. Try again in a moment.')),
      ));
    }
    return undefined;
  }
}

/** getCoachState never has to take the screen down with it. */
async function safeState() {
  try {
    return await getCoachState();
  } catch (err) {
    console.error('coach: state read failed', err);
    return null;
  }
}

// ============================================================================
// 1. The summary screen (#/coach)
// ============================================================================
async function renderRoot(screen, token) {
  const state = await safeState();
  if (token !== renderToken) return;

  // The unread dot belongs to "you haven't looked yet", so clear it once, and
  // only when it is actually set — markCoachRead notifies, which re-renders.
  if (state && state.unreadAt) markCoachRead().catch(() => {});

  const cards = [];

  if (!state || !state.enabled) {
    cards.push(introCard());
  } else if (!state.hasProfile) {
    const strip = statusStrip(state);
    if (strip) cards.push(strip);
    cards.push(profileCard());
  } else {
    const [exercises, active, balance] = await Promise.all([
      listExercises().catch(() => []),
      currentWorkout().catch(() => null),
      liveBalance(state.profile),
    ]);
    if (token !== renderToken) return;
    const exMap = new Map(exercises.map((e) => [e.id, e]));

    const strip = statusStrip(state);
    if (strip) cards.push(strip);
    if (state.plan && state.nextSession) cards.push(nextSessionCard(state, exMap, active));
    if (state.latestDaily) cards.push(todayCard(state.latestDaily));
    if (balance && balance.length) cards.push(balanceCard(balance));
    if (state.latestSession) cards.push(lastSessionCard(state.latestSession));
    const recovery = recoveryCard(state);
    if (recovery) cards.push(recovery);
    if (state.plan) cards.push(rootPlanFooter(state));
    if (cards.length === (strip ? 1 : 0)) {
      cards.push(h('div', { class: 'tab-card coach-card' },
        h('div', { class: 'coach-card-title', text: 'Nothing to show yet' }),
        emptyLine('The coach writes its first summary once you have finished a workout.')));
    }
  }

  screen.replaceChildren(h('div', { class: 'tab-screen coach-screen' }, tabHead(), ...cards));
  stagger(cards);
}

/** Live muscle balance for this ISO week — computed, never stored. */
async function liveBalance(profile) {
  try {
    const dataset = await loadDataset();
    const rows = muscleBalance(dataset, { weeks: 4, today: todayISO(), profile });
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('coach: balance failed', err);
    return [];
  }
}

// ---- no key ---------------------------------------------------------------
function introCard() {
  return h('div', { class: 'tab-card coach-card coach-intro' },
    h('div', { class: 'coach-card-title', text: 'An AI training coach' }),
    h('p', { class: 'coach-body', text: 'It reads your training log and writes a daily summary, feedback after every session, and a plan that adapts as you go.' }),
    h('p', { class: 'coach-body', text: 'It runs on your own Anthropic API key — roughly a few pence per session.' }),
    h('p', { class: 'coach-body', text: 'Your workout data is sent to Anthropic only when the coach runs.' }),
    h('p', { class: 'coach-body', text: 'Apple Health data is never sent unless you turn that on separately in Settings.' }),
    h('button', {
      class: 'coach-btn-primary', type: 'button', 'data-action': 'coach-open-settings',
      onclick: () => go('#/settings'),
    }, 'Set up in Settings'),
  );
}

// ---- key, no profile ------------------------------------------------------
function profileCard() {
  return h('div', { class: 'tab-card coach-card coach-setup-card' },
    h('div', { class: 'coach-card-title', text: 'Tell the coach about you' }),
    h('p', { class: 'coach-body', text: 'It needs your goal, how often you train, and anything it should work around.' }),
    h('p', { class: 'coach-body', text: 'It takes a minute, and you can change your answers whenever you like.' }),
    h('button', {
      class: 'coach-btn-primary', type: 'button', 'data-action': 'coach-setup',
      onclick: () => go('#/coach/builder'),
    }, 'Get started'),
  );
}

// ---- running / pending / error -------------------------------------------
function runningLabel(running) {
  if (running === 'plan') return 'Building your plan…';
  if (running === 'chat') return 'Coach is replying…';
  return 'Coach is thinking…';
}

function statusStrip(state) {
  const rows = [];
  if (state.running) {
    rows.push(h('div', { class: `coach-status-row coach-status-running coach-status-${state.running}` },
      h('span', { class: 'coach-status-dot' }),
      h('span', { class: 'coach-status-text', text: runningLabel(state.running) })));
  }
  if (state.pending) {
    rows.push(h('div', { class: 'coach-status-row' },
      h('span', { class: 'coach-status-text muted', text: 'Waiting for a connection — the coach will catch up.' })));
  }
  if (state.lastError) {
    const err = state.lastError;
    rows.push(h('div', { class: 'coach-status-row coach-status-error' },
      h('span', { class: 'coach-status-text', text: err.message || 'Something went wrong talking to the coach.' }),
      h('span', { class: 'coach-status-actions' },
        err.code === 'auth'
          ? h('button', {
              class: 'coach-text-btn', type: 'button', 'data-action': 'coach-open-settings',
              onclick: () => go('#/settings'),
            }, 'Settings')
          : null,
        h('button', {
          class: 'coach-text-btn', type: 'button', 'data-action': 'coach-dismiss-error',
          onclick: () => { dismissError().catch((e) => console.error('coach: dismiss failed', e)); },
        }, 'Dismiss'),
      )));
  }
  if (!rows.length) return null;
  return h('div', { class: 'coach-status' }, ...rows);
}

// ---- next session ---------------------------------------------------------
function nextSessionCard(state, exMap, active) {
  const s = state.nextSession;
  const plan = state.plan;
  const exercises = Array.isArray(s.exercises) ? s.exercises : [];
  const week = trimNum(Number(state.currentWeek) || 1);
  const weeks = trimNum(Number(plan.weeks) || 1);
  return h('div', { class: 'tab-card coach-card coach-next' },
    h('div', { class: 'coach-label', text: `Next session · Week ${week} of ${weeks}` }),
    h('div', { class: 'coach-card-title', text: s.name || 'Session' }),
    s.focus ? h('div', { class: 'coach-sub muted', text: s.focus }) : null,
    exercises.length
      ? h('div', { class: 'coach-ex-list' }, ...exercises.map((e) => planExerciseLine(e, exMap)))
      : emptyLine('No exercises in this session.'),
    h('button', {
      class: 'coach-btn-primary', type: 'button', 'data-action': 'coach-start-session',
      onclick: () => (active ? go('#/workout') : startPlannedWorkout(plan, s)),
    }, active ? 'Resume workout' : 'Start session'),
    linkRow('View whole plan', 'coach-view-plan', () => go('#/coach/plan')),
  );
}

function planExerciseLine(e, exMap) {
  return h('div', { class: 'coach-ex' },
    h('div', { class: 'coach-ex-main', text: targetText(e, { exMap, withName: true }) }),
    e.note ? h('div', { class: 'coach-ex-note muted', text: e.note }) : null,
  );
}

// ---- today ----------------------------------------------------------------
function todayCard(insight) {
  const n = normaliseNarrative('daily', (insight && insight.narrative) || {});
  const stale = insight.date && insight.date !== todayISO();
  return h('button', {
    class: 'tab-card coach-card coach-today', type: 'button',
    'data-action': 'coach-view-history', onclick: () => go('#/coach/history'),
  },
    h('div', { class: 'coach-card-head' },
      h('span', { class: 'coach-label', text: 'Today' }),
      tonePill(n.tone, DAILY_TONES),
    ),
    stale ? h('div', { class: 'coach-stale muted', text: `From ${formatDate(insight.date)}` }) : null,
    n.headline ? h('div', { class: 'coach-headline', text: n.headline }) : null,
    bullets(n.points),
    bullets(n.advice, { cls: 'coach-advice' }),
  );
}

// ---- balance --------------------------------------------------------------
function sortBalance(rows) {
  return rows.slice().sort((a, b) => {
    const oa = STATUS_ORDER[a.status] ?? 5;
    const ob = STATUS_ORDER[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    return (b.sets || 0) - (a.sets || 0);
  });
}

function balanceCard(rows) {
  const scored = sortBalance(rows.filter((r) => r.status !== 'unscored'));
  return h('button', {
    class: 'tab-card coach-card coach-balance', type: 'button',
    'data-action': 'coach-view-balance', onclick: () => go('#/coach/balance'),
  },
    h('div', { class: 'coach-card-head' },
      h('span', { class: 'coach-label', text: "This week's balance" }),
      h('span', { class: 'coach-link-chev' }, Icon('chevron')),
    ),
    scored.length
      ? h('div', { class: 'coach-bal-list' }, ...scored.map((r) => balanceRow(r)))
      : emptyLine('No data found for this week.'),
    h('p', { class: 'coach-note muted', text: 'Hard sets per muscle group this ISO week vs your current target band.' }),
  );
}

function balanceRow(r) {
  const sets = Number(r.sets) || 0;
  const min = numOrNull(r.min);
  const max = numOrNull(r.max);
  const ceiling = max && max > 0 ? max : Math.max(sets, 1);
  const pct = Math.max(0, Math.min(100, Math.round((sets / ceiling) * 100)));
  const band = min != null && max != null ? ` / ${trimNum(min)}–${trimNum(max)}` : '';
  const arrow = r.trend === 'up' ? '↑' : r.trend === 'down' ? '↓' : null;

  return h('div', { class: 'coach-bal-row', 'data-group': r.group },
    h('div', { class: 'coach-bal-head' },
      h('span', { class: 'coach-bal-name', text: titleCase(r.group) }),
      arrow ? h('span', { class: `coach-bal-trend coach-trend-${r.trend}`, text: arrow }) : null,
      h('span', { class: 'vol-row-val', text: `${trimNum(sets)}${band} sets` }),
    ),
    h('span', { class: 'vol-row-track' },
      h('span', {
        class: `vol-row-fill ${STATUS_CLASS[r.status] || 'coach-fill-on'}`,
        style: `width: ${pct}%`,
      }),
    ),
  );
}

// ---- last session ---------------------------------------------------------
function lastSessionCard(insight) {
  const n = normaliseNarrative('session', (insight && insight.narrative) || {});
  const better = Array.isArray(n.better) ? n.better.slice(0, 2) : [];
  const worse = Array.isArray(n.worse) ? n.worse.slice(0, 2) : [];
  return h('button', {
    class: 'tab-card coach-card coach-last', type: 'button',
    'data-action': 'coach-view-session',
    onclick: () => go(`#/coach/session/${insight.workoutId}`),
  },
    h('div', { class: 'coach-card-head' },
      h('span', { class: 'coach-label', text: 'Last session' }),
      tonePill(n.overallTone, SESSION_TONES),
    ),
    insight.date ? h('div', { class: 'coach-sub muted', text: formatDate(insight.date) }) : null,
    bullets(n.points),
    better.length || worse.length
      ? h('div', { class: 'coach-verdict-list' },
          ...better.map((b) => verdictLine('better', b)),
          ...worse.map((w) => verdictLine('worse', w)),
        )
      : null,
  );
}

function verdictLine(kind, item) {
  return h('div', { class: `coach-verdict coach-verdict-${kind}` },
    h('span', { class: 'coach-verdict-glyph', text: kind === 'better' ? '✓' : '✗' }),
    h('span', { class: 'coach-verdict-text', text: `${item.name || 'Exercise'} — ${item.note || ''}`.trim() }),
  );
}

// ---- recovery -------------------------------------------------------------
function recoveryCard(state) {
  if (!state.shareRecovery) return null;
  const r = state.latestDaily && state.latestDaily.metrics && state.latestDaily.metrics.recovery;
  if (!r) return null;

  const rows = [];
  if (r.sleepH != null) rows.push(pairRow('Sleep', `${trimNum(Number(r.sleepH))} h`));
  if (r.hrvMs != null) {
    rows.push(pairRow('HRV', r.hrvBaselineMs != null
      ? `${trimNum(Number(r.hrvMs))} ms (baseline ${trimNum(Number(r.hrvBaselineMs))})`
      : `${trimNum(Number(r.hrvMs))} ms`));
  }
  if (r.restingHr != null) {
    rows.push(pairRow('Resting HR', r.restingHrBaseline != null
      ? `${trimNum(Number(r.restingHr))} bpm (baseline ${trimNum(Number(r.restingHrBaseline))})`
      : `${trimNum(Number(r.restingHr))} bpm`));
  }
  if (r.weightKg != null) {
    rows.push(pairRow('Weight', r.weightTrend30dPct != null
      ? `${formatWeight(Number(r.weightKg))}, ${pctText(r.weightTrend30dPct)} / 30d`
      : formatWeight(Number(r.weightKg))));
  }
  const filled = rows.filter(Boolean);
  if (!filled.length) return null;

  const note = state.latestDaily.narrative && state.latestDaily.narrative.recoveryNote;
  return h('div', { class: 'tab-card coach-card coach-recovery' },
    h('div', { class: 'coach-label', text: 'Recovery' }),
    ...filled,
    note ? h('p', { class: 'coach-body coach-recovery-note', text: note }) : null,
  );
}

// ---- plan footer (root summary) -------------------------------------------
function rootPlanFooter(state) {
  const plan = state.plan;
  const week = trimNum(Number(state.currentWeek) || 1);
  const weeks = trimNum(Number(plan.weeks) || 1);
  const version = trimNum(Number(plan.version) || 1);
  return h('div', { class: 'coach-plan-footer' },
    h('p', { class: 'coach-footer-text muted', text: `Plan · week ${week} of ${weeks} · v${version}` }),
    linkRow('Open plan', 'coach-view-plan', () => go('#/coach/plan')),
    linkRow('Change the plan…', 'coach-open-chat', () => go('#/coach/chat')),
    linkRow('Plan builder', 'coach-open-builder', () => go('#/coach/builder')),
  );
}

// ============================================================================
// 2. Muscle balance (#/coach/balance)
// ============================================================================
async function renderBalanceScreen(screen, token) {
  const state = await safeState();
  if (token !== renderToken) return;
  const rows = state && state.hasProfile ? await liveBalance(state.profile) : [];
  if (token !== renderToken) return;

  const notes = new Map();
  const daily = state && state.latestDaily;
  const list = daily && daily.narrative && Array.isArray(daily.narrative.balanceNotes)
    ? daily.narrative.balanceNotes : [];
  for (const n of list) if (n && n.group) notes.set(n.group, n.note);

  const cards = sortBalance(rows).map((r) => h('div', { class: 'tab-card coach-card coach-bal-card' },
    balanceRow(r),
    weeklyBars(r.weekly),
    notes.get(r.group) ? h('p', { class: 'coach-body coach-bal-note', text: notes.get(r.group) }) : null,
  ));

  screen.replaceChildren(h('div', { class: 'coach-sub-screen' },
    backHeader('Muscle balance'),
    h('div', { class: 'coach-body-wrap' },
      ...(cards.length ? cards : [h('div', { class: 'tab-card coach-card' }, emptyLine('No data found.'))]),
      h('p', { class: 'coach-note muted', text: "Muscle groups are coarse — 'legs' covers quads, hamstrings, glutes and calves — so read this as a guide, not a verdict." }),
    ),
  ));
  stagger(cards);
}

/**
 * The last four ISO weeks as a small bar row. `weekly` arrives either as plain
 * numbers or as {week, sets} rows; both are accepted, and anything else is
 * simply not drawn.
 */
function weeklyBars(weekly) {
  const raw = Array.isArray(weekly) ? weekly : [];
  const points = raw.map((w, i) => {
    const value = typeof w === 'number' ? w : numOrNull(w && (w.sets ?? w.value ?? w.hardSets));
    const label = typeof w === 'object' && w && typeof w.week === 'string'
      ? w.week.slice(-3)
      : (i === raw.length - 1 ? 'Now' : `−${raw.length - 1 - i}`);
    return { value: value == null ? 0 : value, label };
  });
  if (!points.length) return null;
  const peak = Math.max(1, ...points.map((p) => p.value));
  return h('div', { class: 'bar-chart coach-weekly' }, ...points.map((p, i) => h('div', { class: 'bar-col' },
    h('span', { class: 'bar-val small', text: trimNum(p.value) }),
    h('span', { class: 'bar-track' },
      h('span', {
        class: 'bar-fill' + (i === points.length - 1 ? ' current' : ''),
        style: `height: ${Math.max(2, Math.round((p.value / peak) * 100))}%`,
      }),
    ),
    h('span', { class: 'bar-label', text: p.label }),
  )));
}

// ============================================================================
// 3. Session detail (#/coach/session/:workoutId)
// ============================================================================
async function renderSessionScreen(screen, workoutId, token) {
  const [workout, insight, exercises] = await Promise.all([
    getWorkout(workoutId).catch(() => null),
    getCoachInsightForWorkout(workoutId).catch(() => null),
    listExercises().catch(() => []),
  ]);
  if (token !== renderToken) return;

  if (!workout) {
    screen.replaceChildren(h('div', { class: 'coach-sub-screen' },
      backHeader('Session'),
      h('div', { class: 'coach-body-wrap' },
        h('div', { class: 'tab-card coach-card' }, emptyLine('Session not found.'))),
    ));
    return;
  }
  const exMap = new Map(exercises.map((e) => [e.id, e]));

  let diff = null;
  try {
    const dataset = await loadDataset();
    diff = sessionDiff(dataset, workoutId);
  } catch (err) {
    console.error('coach: session diff failed', err);
  }
  if (token !== renderToken) return;

  const name = (diff && diff.name) || workout.name || 'Session';
  const date = (diff && diff.date) || workout.date;
  const cards = [];

  if (diff) cards.push(sessionTotalsCard(diff));
  const exRows = diff && Array.isArray(diff.exercises) ? diff.exercises : [];
  for (const e of exRows) cards.push(exerciseDiffCard(e, exMap));
  if (!cards.length) cards.push(h('div', { class: 'tab-card coach-card' }, emptyLine('No data found for this session.')));

  if (insight) {
    const n = normaliseNarrative('session', insight.narrative || {});
    cards.push(sessionInsightCard(n));
    const changes = Array.isArray(n.planChanges) ? n.planChanges : [];
    if (changes.length) cards.push(planChangesCard(changes, exMap));
  } else {
    cards.push(analyseCard(workout));
  }

  screen.replaceChildren(h('div', { class: 'coach-sub-screen' },
    backHeader(`${name} · ${shortDate(date)}`),
    h('div', { class: 'coach-body-wrap' }, ...cards),
  ));
  stagger(cards);
}

function sessionTotalsCard(diff) {
  return h('div', { class: 'tab-card coach-card coach-session-totals' },
    h('div', { class: 'coach-label', text: 'Session' }),
    pairRow('Duration', diff.durationMin == null ? null : `${trimNum(Number(diff.durationMin))} min`),
    pairRow('Hard sets', diff.hardSets == null ? null : trimNum(Number(diff.hardSets))),
    pairRow('Volume', diff.volumeKg == null ? null : volumeText(diff.volumeKg)),
    pairRow('Average RPE', diff.avgRpe == null ? null : trimNum(Number(diff.avgRpe))),
  );
}

function exerciseDiffCard(e, exMap) {
  const lines = [];
  if (e.volumeKg != null) {
    lines.push(`Volume ${volumeText(e.volumeKg)}${e.volumePrevKg != null ? ` (was ${volumeText(e.volumePrevKg)})` : ''}`);
  }
  if (e.e1rm != null) {
    lines.push(`e1RM ${e1rmText(e.e1rm)}${e.e1rmPrev != null ? ` (was ${e1rmText(e.e1rmPrev)})` : ''}`);
  }
  const top = setText(e.topSet) || setText(Array.isArray(e.sets) ? e.sets[0] : null);
  if (top) lines.push(`Top set ${top}`);
  const prev = setText(e.prevTop);
  if (prev) lines.push(`Previous top ${prev}`);
  const same = sameWeightText(e.repsAtSameWeight);
  if (same) lines.push(same);
  if (e.avgRpe != null) {
    lines.push(`Average RPE ${trimNum(Number(e.avgRpe))}${e.prevAvgRpe != null ? ` (was ${trimNum(Number(e.prevAvgRpe))})` : ''}`);
  }

  return h('div', { class: 'tab-card coach-card coach-exdiff', 'data-exercise-id': e.id },
    h('div', { class: 'coach-card-head' },
      h('span', { class: 'coach-card-title', text: e.name || exName(e.id, exMap) }),
      e.verdict ? h('span', {
        class: `coach-chip coach-chip-${e.verdict}`,
        text: VERDICTS[e.verdict] || titleCase(e.verdict),
      }) : null,
    ),
    e.group ? h('div', { class: 'coach-sub muted', text: titleCase(e.group) }) : null,
    lines.length
      ? h('div', { class: 'coach-stat-lines' }, ...lines.map((t) => h('div', { class: 'coach-stat-line', text: t })))
      : emptyLine('No data found.'),
  );
}

/** `repsAtSameWeight` is either a plain rep count or {reps, prevReps, weightKg}. */
function sameWeightText(v) {
  if (v == null) return null;
  if (typeof v === 'number') return `Same weight: ${trimNum(v)} reps`;
  if (typeof v !== 'object') return null;
  const reps = numOrNull(v.reps ?? v.r);
  if (reps == null) return null;
  const prev = numOrNull(v.prevReps ?? v.was);
  const at = v.weightKg != null ? ` at ${formatWeight(Number(v.weightKg))}` : '';
  return `Same weight${at}: ${trimNum(reps)} reps${prev != null ? ` (was ${trimNum(prev)})` : ''}`;
}

function sessionInsightCard(n) {
  const better = Array.isArray(n.better) ? n.better : [];
  const worse = Array.isArray(n.worse) ? n.worse : [];
  const flags = Array.isArray(n.flags) ? n.flags : [];
  return h('div', { class: 'tab-card coach-card coach-session-read' },
    h('div', { class: 'coach-card-head' },
      h('span', { class: 'coach-label', text: 'The coach says' }),
      tonePill(n.overallTone, SESSION_TONES),
    ),
    bullets(n.points),
    better.length || worse.length
      ? h('div', { class: 'coach-verdict-list' },
          ...better.map((b) => verdictLine('better', b)),
          ...worse.map((w) => verdictLine('worse', w)),
        )
      : null,
    flags.length
      ? h('div', { class: 'coach-flag-list' }, ...flags.map((f) => h('div', { class: 'coach-flag' },
          h('span', { class: 'coach-flag-label', text: FLAG_LABELS[f.code] || FLAG_LABELS.other }),
          h('span', { class: 'coach-flag-msg', text: f.message || '' }),
        )))
      : null,
  );
}

function planChangesCard(changes, exMap) {
  return h('div', { class: 'tab-card coach-card coach-changes' },
    h('div', { class: 'coach-label', text: 'What changed in the plan' }),
    ...changes.map((c) => h('div', { class: 'coach-change' },
      h('span', { class: 'coach-change-main', text: planChangeText(c, exMap) }),
      c.reason ? h('span', { class: 'coach-change-reason muted', text: c.reason }) : null,
    )),
  );
}

function planChangeText(c, exMap) {
  const name = exName(c.exerciseId, exMap);
  const verb = PLAN_CHANGES[c.change] || c.change || 'change';
  const move = c.from && c.to ? ` ${c.from} → ${c.to}` : c.to ? ` → ${c.to}` : '';
  return `${name}: ${verb}${move}`;
}

function analyseCard(workout) {
  if (!workout.finishedAt) {
    return h('div', { class: 'tab-card coach-card' },
      emptyLine('The coach reads a session once it is finished.'));
  }
  const msg = h('p', { class: 'coach-inline-msg muted' });
  const btn = h('button', {
    class: 'coach-btn-primary', type: 'button', 'data-action': 'coach-analyse',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Analysing…';
      msg.textContent = '';
      msg.classList.remove('danger');
      try {
        const result = await runSessionFeedback(workout.id, { force: true });
        // A null result means the runner recorded an error; the status strip on
        // #/coach carries the detail, so keep this line short.
        if (!result) {
          btn.disabled = false;
          btn.textContent = 'Analyse this session';
          msg.textContent = 'The coach could not read this session. Try again shortly.';
          msg.classList.add('danger');
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Analyse this session';
        msg.textContent = userMessageFor(err);
        msg.classList.add('danger');
      }
    },
  }, 'Analyse this session');

  return h('div', { class: 'tab-card coach-card coach-analyse' },
    h('div', { class: 'coach-card-title', text: 'Not analysed yet' }),
    h('p', { class: 'coach-body', text: 'Ask the coach to read this session and revise the plan.' }),
    btn,
    msg,
  );
}

// ============================================================================
// 4. The whole plan (#/coach/plan)
// ============================================================================
async function renderPlanScreen(screen, token) {
  const state = await safeState();
  if (token !== renderToken) return;

  if (!state || !state.plan) {
    screen.replaceChildren(h('div', { class: 'coach-sub-screen' },
      backHeader('Your plan'),
      h('div', { class: 'coach-body-wrap' },
        h('div', { class: 'tab-card coach-card' }, emptyLine('No plan yet.'))),
    ));
    return;
  }

  const [exercises, active] = await Promise.all([
    listExercises().catch(() => []),
    currentWorkout().catch(() => null),
  ]);
  if (token !== renderToken) return;
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const plan = state.plan;
  const current = Number(state.currentWeek) || 1;
  if (planSelectedWeek == null) planSelectedWeek = current;
  const selected = planSelectedWeek;
  const nextId = state.nextSession ? state.nextSession.id : null;
  const deloadWeek = plan.overview && plan.overview.deloadWeek != null ? Number(plan.overview.deloadWeek) : null;

  const cards = [];

  // 1. What changed
  const sessionNarrative = state.latestSession ? normaliseNarrative('session', state.latestSession.narrative || {}) : null;
  const changes = sessionNarrative && Array.isArray(sessionNarrative.planChanges) ? sessionNarrative.planChanges : [];
  if (changes.length) cards.push(planChangesCard(changes, exMap));

  // 2. Overview
  cards.push(planOverviewCard(plan, deloadWeek));

  // 3. Week selector
  cards.push(weekSelector({
    weeks: plan.weeks, current, selected, deloadWeek,
    onPick: (week) => {
      planSelectedWeek = week;
      renderCoach(['plan']).catch((err) => console.error('coach: week switch failed', err));
    },
  }));

  // 4. Selected week
  let proj = null;
  try { proj = projectPlanWeek(plan, selected); } catch (err) { console.error('coach: projectPlanWeek failed', err); }
  const weekNote = Array.isArray(plan.weekNotes) ? plan.weekNotes.find((wn) => wn.week === selected) : null;
  if (weekNote) {
    cards.push(h('div', { class: 'tab-card coach-card' },
      weekNote.focus ? h('div', { class: 'coach-card-title', text: weekNote.focus }) : null,
      bullets(weekNote.points),
    ));
  }
  if (proj && (proj.isPast || proj.isDeload)) {
    cards.push(h('p', { class: 'coach-note muted coach-week-flag', text: proj.isDeload ? 'Deload week' : 'Past week' }));
  }
  const sessions = proj && Array.isArray(proj.sessions) ? proj.sessions : (plan.sessions || []);
  const isCurrentWeek = selected === current;
  for (const s of sessions) {
    const isNext = isCurrentWeek && s.id === nextId;
    cards.push(planSessionCard(s, exMap, { isNext, active, plan }));
  }
  if (!sessions.length) cards.push(h('div', { class: 'tab-card coach-card' }, emptyLine('No sessions this week.')));

  // 5. Footer
  cards.push(planScreenFooter(plan));

  screen.replaceChildren(h('div', { class: 'coach-sub-screen' },
    backHeader('Your plan'),
    h('div', { class: 'coach-body-wrap' }, ...cards),
  ));
  stagger(cards);
}

function planOverviewCard(plan, deloadWeek) {
  const overview = plan.overview;
  if (!overview) {
    return h('div', { class: 'tab-card coach-card' },
      h('div', { class: 'coach-label', text: 'Why this plan' }),
      plan.rationale ? bullets(plan.rationale) : emptyLine('No data found.'),
      plan.weeks ? h('p', { class: 'coach-note muted', text: `${trimNum(Number(plan.weeks))} weeks` }) : null,
    );
  }
  const focus = Array.isArray(overview.muscleFocus) ? overview.muscleFocus : [];
  const progression = Array.isArray(overview.progression) ? overview.progression : [];
  return h('div', { class: 'tab-card coach-card' },
    h('div', { class: 'coach-label', text: 'Why this plan' }),
    bullets(overview.points),
    focus.length ? h('div', { class: 'coach-muscle-focus' },
      h('div', { class: 'coach-sub-label', text: 'Muscle focus' }),
      ...focus.map((m) => h('div', { class: 'coach-muscle-focus-row' },
        h('span', { class: 'coach-muscle-focus-group', text: titleCase(m.group) }),
        h('span', { class: 'coach-muscle-focus-why muted', text: m.why || '' }),
      ))) : null,
    progression.length ? h('div', { class: 'coach-progression' },
      h('div', { class: 'coach-sub-label', text: 'Progression' }),
      bullets(progression)) : null,
    deloadWeek ? h('p', { class: 'coach-note muted', text: `Deload in week ${trimNum(deloadWeek)}` }) : null,
  );
}

function planSessionCard(s, exMap, { isNext, active, plan }) {
  return h('div', { class: 'tab-card coach-card coach-plan-session' + (isNext ? ' is-next' : ''), 'data-plan-session-id': s.id },
    h('div', { class: 'coach-card-head' },
      h('span', { class: 'coach-card-title', text: s.name || 'Session' }),
      isNext ? h('span', { class: 'coach-pill coach-pill-good', text: 'Next' }) : null,
    ),
    s.focus ? h('div', { class: 'coach-sub muted', text: s.focus }) : null,
    bullets(s.brief),
    h('div', { class: 'coach-plan-ex-list' }, ...(s.exercises || []).map((e) => planExerciseRow(e, exMap))),
    isNext ? h('button', {
      class: 'coach-btn-primary', type: 'button', 'data-action': 'coach-start-session',
      onclick: () => (active ? go('#/workout') : startPlannedWorkout(plan, s)),
    }, active ? 'Resume workout' : 'Start session') : null,
  );
}

/** A plan exercise row; expandable into Why/Goal/Note when the plan carries them. */
function planExerciseRow(e, exMap) {
  const hasDetail = !!(e.purpose || e.goal || e.note);
  if (!hasDetail) {
    return h('div', { class: 'coach-plan-ex-wrap' }, planExerciseLine(e, exMap));
  }
  const detail = h('div', { class: 'coach-plan-ex-detail', hidden: true },
    e.purpose ? detailLine('Why', e.purpose) : null,
    e.goal ? detailLine('Goal', e.goal) : null,
    e.note ? detailLine('Note', e.note) : null,
  );
  const row = h('button', {
    class: 'coach-plan-ex', type: 'button', 'data-action': 'coach-ex-toggle',
    onclick: () => {
      const opening = detail.hidden;
      detail.hidden = !opening;
      row.classList.toggle('is-open', opening);
    },
  },
    h('span', { class: 'coach-plan-ex-text', text: targetText(e, { exMap, withName: true }) }),
    h('span', { class: 'coach-plan-ex-chev' }, Icon('chevron')),
  );
  return h('div', { class: 'coach-plan-ex-wrap' }, row, detail);
}

function detailLine(label, text) {
  return h('div', { class: 'coach-plan-ex-detail-line' },
    h('span', { class: 'coach-plan-ex-detail-label', text: label }),
    h('span', { class: 'coach-plan-ex-detail-text', text }),
  );
}

function planScreenFooter(plan) {
  const version = trimNum(Number(plan.version) || 1);
  const source = plan.source === 'revised' ? 'revised' : plan.source === 'manual' ? 'manual' : 'created';
  return h('div', { class: 'coach-plan-footer' },
    linkRow('Ask for a change…', 'coach-open-chat', () => go('#/coach/chat')),
    linkRow('Rebuild plan…', 'coach-open-builder', () => go('#/coach/builder')),
    h('p', { class: 'coach-footer-text muted', text: `Plan v${version} · ${source} ${shortDate(plan.createdAt)}` }),
  );
}

// ============================================================================
// 5. Daily summaries (#/coach/history)
// ============================================================================
async function renderHistoryScreen(screen, token) {
  let rows = [];
  try {
    rows = await listCoachInsights({ kind: 'daily', limit: 14 });
  } catch (err) {
    console.error('coach: history read failed', err);
  }
  if (token !== renderToken) return;

  const cards = (rows || []).map((insight) => {
    const n = normaliseNarrative('daily', insight.narrative || {});
    return h('div', { class: 'tab-card coach-card coach-history-card', 'data-insight-id': insight.id },
      h('div', { class: 'coach-card-head' },
        h('span', { class: 'coach-label', text: insight.date ? formatDate(insight.date) : '' }),
        tonePill(n.tone, DAILY_TONES),
      ),
      n.headline ? h('div', { class: 'coach-headline', text: n.headline }) : null,
      bullets(n.points),
      bullets(n.advice, { cls: 'coach-advice' }),
    );
  });

  screen.replaceChildren(h('div', { class: 'coach-sub-screen' },
    backHeader('Daily summaries'),
    h('div', { class: 'coach-body-wrap' },
      ...(cards.length ? cards : [h('div', { class: 'tab-card coach-card' }, emptyLine('No data found.'))])),
  ));
  stagger(cards);
}

// ============================================================================
// 6. Plan builder (#/coach/builder)
// ============================================================================
async function renderBuilderScreen(screen, token) {
  const [profile, state, exercises] = await Promise.all([
    getProfile().catch(() => null),
    safeState(),
    listExercises().catch(() => []),
  ]);
  if (token !== renderToken) return;
  let memoryItems = await getMemory().catch(() => []);
  if (token !== renderToken) return;

  const draft = profile ? { ...profile } : sanitiseProfile({});
  draft.cardio = { ...draft.cardio };
  draft.core = { ...draft.core };
  draft.groupPrefs = { ...draft.groupPrefs };
  draft.avoidExerciseIds = [...(draft.avoidExerciseIds || [])];
  draft.favouriteExerciseIds = [...(draft.favouriteExerciseIds || [])];
  const hasPlan = !!(state && state.plan);

  const body = h('div', { class: 'coach-body-wrap coach-builder-body' });
  function paint() {
    body.replaceChildren(
      aboutCard(draft, paint),
      splitCard(draft, paint),
      muscleGroupsCard(draft, paint),
      cardioCard(draft, paint, exercises),
      coreCard(draft),
      exercisesCard(draft, exercises, paint),
      notesCard(draft, paint),
      memoryCard(memoryItems),
      builderFooter(draft, hasPlan),
    );
  }
  paint();

  screen.replaceChildren(h('div', { class: 'coach-sub-screen' },
    backHeader('Plan builder'),
    body,
  ));
}

function stepperRow(label, value, { min, max, step, format, onChange }) {
  let current = Math.min(max, Math.max(min, Number(value) || min));
  const val = h('span', { class: 'timer-val small', text: format(current) });
  const adjust = (delta) => {
    current = Math.min(max, Math.max(min, current + delta));
    val.textContent = format(current);
    onChange(current);
  };
  return h('div', { class: 'settings-row coach-sheet-stepper' },
    h('span', { class: 'settings-label', text: label }),
    h('div', { class: 'rest-stepper' },
      h('button', {
        class: 'round-btn', type: 'button', 'aria-label': `Decrease ${label.toLowerCase()}`,
        onclick: () => adjust(-step),
      }, Icon('minus')),
      val,
      h('button', {
        class: 'round-btn', type: 'button', 'aria-label': `Increase ${label.toLowerCase()}`,
        onclick: () => adjust(step),
      }, Icon('plus')),
    ),
  );
}

/** A label + iOS-style switch, mirroring settings.js's toggleRow but bound to
 * an arbitrary getter/setter instead of the global settings store. */
function switchRow(label, on, onChange) {
  const btn = h('button', {
    class: 'toggle' + (on ? ' on' : ''), type: 'button', role: 'switch',
    'aria-checked': on ? 'true' : 'false', 'aria-label': label,
  });
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    btn.classList.toggle('on', next);
    onChange(next);
  });
  return h('div', { class: 'settings-row' },
    h('span', { class: 'settings-label', text: label }),
    btn,
  );
}

function aboutCard(draft, paint) {
  const goalLabel = () => (GOAL_OPTIONS.find((o) => o.value === draft.goal) || {}).label || 'Choose';
  const dateInput = h('input', { class: 'sheet-input coach-date-input', type: 'date', 'aria-label': 'Return date' });
  dateInput.value = draft.returnDate || '';
  dateInput.addEventListener('change', () => {
    draft.returnDate = /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value) ? dateInput.value : null;
  });
  return h('div', { class: 'tab-card coach-card coach-builder-card' },
    h('div', { class: 'coach-card-title', text: 'About you' }),
    sheetRow({
      label: 'Goal', value: goalLabel(), chevron: true, action: 'coach-goal',
      onClick: () => optionSheet({
        title: 'Goal', options: GOAL_OPTIONS, current: draft.goal,
        onPick: (v) => { draft.goal = v; paint(); },
      }),
    }),
    stepperRow('Days per week', draft.daysPerWeek, {
      min: 1, max: 7, step: 1, format: (n) => String(n), onChange: (n) => { draft.daysPerWeek = n; },
    }),
    stepperRow('Session length', draft.sessionMinutes, {
      min: 20, max: 120, step: 5, format: (n) => `${n} min`, onChange: (n) => { draft.sessionMinutes = n; },
    }),
    h('div', { class: 'settings-row coach-sheet-date' },
      h('span', { class: 'settings-label', text: 'Return date' }),
      dateInput,
    ),
  );
}

function splitCard(draft, paint) {
  return h('div', { class: 'tab-card coach-card coach-builder-card' },
    h('div', { class: 'coach-card-title', text: 'Split' }),
    h('div', { class: 'seg-toggle coach-seg-wrap' },
      ...SPLIT_OPTIONS.map((o) => h('button', {
        class: 'seg-btn' + (draft.split === o.value ? ' on' : ''), type: 'button',
        onclick: () => { draft.split = o.value; paint(); },
      }, o.label)),
    ),
  );
}

function muscleGroupsCard(draft, paint) {
  const groups = MUSCLE_GROUPS.filter((g) => g !== 'cardio' && g !== 'other');
  return h('div', { class: 'tab-card coach-card coach-builder-card' },
    h('div', { class: 'coach-card-title', text: 'Muscle groups' }),
    ...groups.map((g) => groupPrefRow(g, draft, paint)),
    h('p', { class: 'coach-note muted', text: "Include means it appears every week even if you've never logged it. Emphasise means more sets." }),
  );
}

function groupPrefRow(group, draft, paint) {
  const current = draft.groupPrefs[group] || 'auto';
  return h('div', { class: 'settings-row coach-group-row' },
    h('span', { class: 'settings-label', text: titleCase(group) }),
    h('div', { class: 'seg-toggle coach-seg-4' },
      ...GROUP_PREF_OPTIONS.map((o) => h('button', {
        class: 'seg-btn' + (current === o.value ? ' on' : ''), type: 'button',
        onclick: () => {
          if (o.value === 'auto') delete draft.groupPrefs[group];
          else draft.groupPrefs[group] = o.value;
          paint();
        },
      }, o.label)),
    ),
  );
}

function cardioCard(draft, paint, exercises) {
  const rows = [switchRow('Include cardio', draft.cardio.include, (v) => { draft.cardio.include = v; paint(); })];
  if (draft.cardio.include) {
    rows.push(stepperRow('Minutes', draft.cardio.minutesPerSession, {
      min: 5, max: 30, step: 5, format: (n) => `${n} min`,
      onChange: (n) => { draft.cardio.minutesPerSession = n; },
    }));
    rows.push(switchRow('Standalone cardio day', draft.cardio.standaloneDay, (v) => { draft.cardio.standaloneDay = v; }));
    const cardioExercises = exercises.filter((e) => normalizeExerciseType(e.exerciseType) === 'cardio');
    const selectedNames = cardioExercises
      .filter((e) => draft.cardio.exerciseIds.includes(e.id))
      .map((e) => e.name);
    rows.push(sheetRow({
      label: 'Preferred cardio',
      sub: selectedNames.length ? selectedNames.join(', ') : 'Any',
      chevron: true, action: 'coach-cardio-pick',
      onClick: () => multiSelectSheet({
        title: 'Preferred cardio',
        groups: [{ label: 'Cardio', items: cardioExercises.map((e) => ({ id: e.id, label: e.name, sub: e.equipment })) }],
        selected: new Set(draft.cardio.exerciseIds),
        onSave: (set) => { draft.cardio.exerciseIds = [...set]; paint(); },
      }),
    }));
  }
  return h('div', { class: 'tab-card coach-card coach-builder-card' },
    h('div', { class: 'coach-card-title', text: 'Cardio' }),
    ...rows,
  );
}

function coreCard(draft) {
  return h('div', { class: 'tab-card coach-card coach-builder-card' },
    h('div', { class: 'coach-card-title', text: 'Core' }),
    switchRow('Include core work', draft.core.include, (v) => { draft.core.include = v; }),
  );
}

/** All non-cardio-type exercises, grouped by muscle group in MUSCLE_GROUPS order. */
function groupedExerciseGroups(exercises) {
  const buckets = new Map(MUSCLE_GROUPS.filter((g) => g !== 'cardio').map((g) => [g, []]));
  for (const e of exercises) {
    if (normalizeExerciseType(e.exerciseType) === 'cardio') continue;
    const g = buckets.has(e.muscleGroup) ? e.muscleGroup : 'other';
    buckets.get(g).push(e);
  }
  const groups = [];
  for (const [g, items] of buckets) {
    if (items.length) groups.push({ label: titleCase(g), items: items.map((e) => ({ id: e.id, label: e.name, sub: e.equipment })) });
  }
  return groups;
}

function exercisesCard(draft, exercises, paint) {
  const groups = groupedExerciseGroups(exercises);
  const nameFor = (id) => { const ex = exercises.find((e) => e.id === id); return ex ? ex.name : null; };
  const favCount = draft.favouriteExerciseIds.map(nameFor).filter(Boolean).length;
  const avoidCount = draft.avoidExerciseIds.map(nameFor).filter(Boolean).length;
  return h('div', { class: 'tab-card coach-card coach-builder-card' },
    h('div', { class: 'coach-card-title', text: 'Exercises' }),
    sheetRow({
      label: 'Favourite exercises',
      sub: favCount ? `${favCount} selected` : 'None',
      chevron: true, action: 'coach-fav-pick',
      onClick: () => multiSelectSheet({
        title: 'Favourite exercises', groups,
        selected: new Set(draft.favouriteExerciseIds),
        onSave: (set) => { draft.favouriteExerciseIds = [...set]; paint(); },
      }),
    }),
    sheetRow({
      label: 'Exercises to avoid',
      sub: avoidCount ? `${avoidCount} selected` : 'None',
      chevron: true, action: 'coach-avoid-pick',
      onClick: () => multiSelectSheet({
        title: 'Exercises to avoid', groups,
        selected: new Set(draft.avoidExerciseIds),
        onSave: (set) => { draft.avoidExerciseIds = [...set]; paint(); },
      }),
    }),
  );
}

function notesCard(draft, paint) {
  return h('div', { class: 'tab-card coach-card coach-builder-card' },
    h('div', { class: 'coach-card-title', text: 'Notes' }),
    sheetRow({
      label: 'Injury or limits', sub: draft.injuryNotes || 'None given',
      chevron: true, action: 'coach-injury',
      onClick: () => textareaSheet({
        title: 'Injury or limits', value: draft.injuryNotes,
        placeholder: 'e.g. left shoulder — no overhead pressing for now',
        onSave: (v) => { draft.injuryNotes = v; paint(); },
      }),
    }),
    sheetRow({
      label: 'Equipment', sub: draft.equipmentNotes || 'None given',
      chevron: true, action: 'coach-equipment',
      onClick: () => textareaSheet({
        title: 'Equipment', value: draft.equipmentNotes,
        placeholder: 'e.g. home gym, dumbbells to 30 kg, no barbell',
        onSave: (v) => { draft.equipmentNotes = v; paint(); },
      }),
    }),
    sheetRow({
      label: 'Anything else', sub: draft.notes || 'None given',
      chevron: true, action: 'coach-notes',
      onClick: () => textareaSheet({
        title: 'Anything else', value: draft.notes,
        placeholder: 'e.g. I want to train legs again, gently',
        onSave: (v) => { draft.notes = v; paint(); },
      }),
    }),
  );
}

function memoryCard(memoryItems) {
  const list = h('div', { class: 'coach-memory-list' });
  function paintList() {
    list.replaceChildren(
      ...(memoryItems.length
        ? memoryItems.map((m) => memoryItemRow(m, memoryItems, paintList))
        : [emptyLine('Nothing yet — the coach adds facts you tell it in chat.')]),
    );
  }
  paintList();
  return h('div', { class: 'tab-card coach-card coach-builder-card' },
    h('div', { class: 'coach-card-title', text: 'What the coach knows about you' }),
    list,
    h('button', {
      class: 'coach-text-btn', type: 'button', 'data-action': 'coach-memory-add',
      onclick: () => textareaSheet({
        title: 'Add a note', value: null,
        placeholder: 'e.g. Trains at a home gym with dumbbells up to 30 kg',
        onSave: async (v) => {
          if (!v) return;
          try {
            const item = await addMemory(v, 'user');
            if (item) { memoryItems.push(item); paintList(); }
          } catch (err) { console.error('coach: add memory failed', err); }
        },
      }),
    }, 'Add a note'),
  );
}

function memoryItemRow(m, memoryItems, paintList) {
  return h('div', { class: 'coach-memory-item' },
    h('span', { class: 'coach-memory-text', text: m.text }),
    h('button', {
      class: 'coach-memory-remove', type: 'button', 'data-action': 'coach-memory-remove', 'aria-label': 'Remove note',
      onclick: async () => {
        try { await removeMemory(m.id); } catch (err) { console.error('coach: remove memory failed', err); }
        const idx = memoryItems.indexOf(m);
        if (idx >= 0) memoryItems.splice(idx, 1);
        paintList();
      },
    }, Icon('close')),
  );
}

function builderFooter(draft, hasPlan) {
  const msg = h('p', { class: 'coach-inline-msg coach-builder-msg' });
  let savedTimer = null;
  const saveBtn = h('button', {
    class: 'coach-text-btn', type: 'button', 'data-action': 'coach-builder-save',
    onclick: async () => {
      msg.textContent = '';
      msg.classList.remove('danger');
      try {
        await saveProfile(draft);
        msg.textContent = 'Saved';
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => { if (msg.textContent === 'Saved') msg.textContent = ''; }, 2000);
      } catch (err) {
        msg.textContent = userMessageFor(err);
        msg.classList.add('danger');
      }
    },
  }, 'Save');
  const buildBtn = h('button', {
    class: 'coach-btn-primary', type: 'button', 'data-action': 'coach-builder-build',
    onclick: async () => {
      const original = buildBtn.textContent;
      buildBtn.disabled = true;
      buildBtn.textContent = 'Building your plan…';
      msg.textContent = '';
      msg.classList.remove('danger');
      try {
        await saveProfile(draft);
        await createPlan();
        go('#/coach/plan');
      } catch (err) {
        buildBtn.disabled = false;
        buildBtn.textContent = original;
        msg.textContent = userMessageFor(err);
        msg.classList.add('danger');
      }
    },
  }, hasPlan ? 'Rebuild plan' : 'Build plan');
  return h('div', { class: 'coach-builder-footer' },
    h('p', { class: 'coach-note muted', text: 'Nothing here is required. Your answers stay on this device and are sent to Anthropic only as part of the coach’s requests.' }),
    msg,
    h('div', { class: 'coach-builder-actions' }, saveBtn, buildBtn),
  );
}

// ============================================================================
// 7. Chat (#/coach/chat)
// ============================================================================
async function renderChatScreen(screen, token) {
  // Chat opens at the newest message, not scrolled to the top like every
  // other route — consumed once by the next route() pass (see js/ui.js).
  requestBottomScroll();
  const container = h('div', { class: 'coach-chat-container' });
  screen.replaceChildren(h('div', { class: 'coach-sub-screen coach-chat-screen' },
    backHeader('Change the plan'),
    h('div', { class: 'coach-body-wrap coach-chat-wrap' },
      h('p', { class: 'coach-note muted coach-chat-note', text: 'Tell the coach what to change. It will update the plan and list every change.' }),
      container,
    ),
  ));
  if (token !== renderToken) return;

  if (activeChatPanel) { try { activeChatPanel.destroy(); } catch (e) { /* ignore */ } activeChatPanel = null; }
  activeChatPanel = chatPanel({ thread: 'plan', container, compact: false });
  setScreenCleanup(() => {
    stopCoachSubscription();
    if (activeChatPanel) { try { activeChatPanel.destroy(); } catch (e) { /* ignore */ } activeChatPanel = null; }
  });
}
