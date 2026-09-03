// ============================================================================
// screens/coach.js — the Coach tab (#/coach) and every screen under it.
//
// Routes (the router hands us the hash path after 'coach'; the tab bar stays):
//   #/coach                       the summary screen (status, next session,
//                                 today, balance, last session, recovery)
//   #/coach/balance               muscle balance in full, all groups
//   #/coach/session/:workoutId    per-exercise session diff + the coach's read
//   #/coach/plan                  the whole plan, session by session
//   #/coach/history               the last 14 daily summaries
//   #/coach/setup                 the summary screen + the "About you" sheet
//
// Everything here reads from IndexedDB or computes live from the pure engine
// (js/coach-engine.js) — nothing on these screens touches the network. The one
// exception is a button the user presses: "Get started", "Regenerate…" and
// "Analyse this session" call into js/coach.js, which owns the API queue.
//
// Model-written text (headlines, notes, plan reasons) is untrusted content and
// only ever reaches the DOM through textContent / the h() `text` prop — never
// innerHTML.
// ============================================================================

import {
  listExercises, getWorkout, listCoachInsights, getCoachInsightForWorkout,
} from '../db.js';
import { muscleBalance, sessionDiff } from '../coach-engine.js';
import { userMessageFor } from '../coach-api.js';
import {
  getCoachState, getProfile, loadDataset, createPlan, saveProfile,
  runSessionFeedback, dismissError, markCoachRead, onCoachUpdate,
} from '../coach.js';
import {
  h, Icon, gearButton, go, openSheet, closeSheet, sheetHeader,
  sheetRow, optionSheet, confirmSheet, textareaSheet, formatWeight, kgToDisplay,
  unitLabel, trimNum, formatDate, currentWorkout, setScreenCleanup,
  startPlannedWorkout,
} from '../ui.js';
import { todayISO } from '../util.js';
import { stagger } from '../motion.js';

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

/** "3 × 6–8 @ 60 kg" — the @ half is dropped when the plan set no weight. */
function targetText(e) {
  const lo = numOrNull(e.targetRepsLow);
  const hi = numOrNull(e.targetRepsHigh);
  const reps = lo == null && hi == null ? '—'
    : lo != null && hi != null && lo !== hi ? `${trimNum(lo)}–${trimNum(hi)}`
      : trimNum(lo ?? hi);
  const sets = numOrNull(e.targetSets);
  const base = `${sets == null ? '—' : trimNum(sets)} × ${reps}`;
  return e.targetWeightKg == null ? base : `${base} @ ${formatWeight(Number(e.targetWeightKg))}`;
}

function tonePill(value, map) {
  const def = map[value];
  if (!def) return null;
  return h('span', { class: `coach-pill coach-pill-${def.tone}`, text: def.label });
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

// ============================================================================
// Router entry
// ============================================================================
/**
 * @param {string[]} parts hash path after 'coach' — [] | ['balance'] |
 *   ['session', workoutId] | ['plan'] | ['history'] | ['setup']
 */
export async function renderCoach(parts = []) {
  currentParts = Array.isArray(parts) ? parts.slice() : [];
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
    if (a === 'setup') return await renderSetupRoute(screen, token);
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
    if (state.plan) cards.push(planFooter(state.plan));
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
      onclick: () => openCoachSetupSheet({ profile: null, onDone: () => go('#/coach') }),
    }, 'Get started'),
  );
}

// ---- running / pending / error -------------------------------------------
function statusStrip(state) {
  const rows = [];
  if (state.running) {
    rows.push(h('div', { class: 'coach-status-row coach-status-running' },
      h('span', { class: 'coach-status-dot' }),
      h('span', { class: 'coach-status-text', text: 'Coach is thinking…' })));
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
  const exercises = Array.isArray(s.exercises) ? s.exercises : [];
  return h('div', { class: 'tab-card coach-card coach-next' },
    h('div', { class: 'coach-label', text: 'Next session' }),
    h('div', { class: 'coach-card-title', text: s.name || 'Session' }),
    s.focus ? h('div', { class: 'coach-sub muted', text: s.focus }) : null,
    exercises.length
      ? h('div', { class: 'coach-ex-list' }, ...exercises.map((e) => planExerciseLine(e, exMap)))
      : emptyLine('No exercises in this session.'),
    h('button', {
      class: 'coach-btn-primary', type: 'button', 'data-action': 'coach-start-session',
      onclick: () => (active ? go('#/workout') : startPlannedWorkout(state.plan, s)),
    }, active ? 'Resume workout' : 'Start session'),
    h('button', {
      class: 'coach-link-row', type: 'button', 'data-action': 'coach-view-plan',
      onclick: () => go('#/coach/plan'),
    },
      h('span', { text: 'View whole plan' }),
      h('span', { class: 'coach-link-chev' }, Icon('chevron')),
    ),
  );
}

function planExerciseLine(e, exMap) {
  return h('div', { class: 'coach-ex' },
    h('div', { class: 'coach-ex-main', text: `${exName(e.exerciseId, exMap)} · ${targetText(e)}` }),
    e.note ? h('div', { class: 'coach-ex-note muted', text: e.note }) : null,
  );
}

// ---- today ----------------------------------------------------------------
function todayCard(insight) {
  const n = (insight && insight.narrative) || {};
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
    n.body ? h('p', { class: 'coach-body', text: n.body }) : null,
    n.todayAdvice ? h('div', { class: 'coach-advice', text: n.todayAdvice }) : null,
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
  const n = (insight && insight.narrative) || {};
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
    n.summary ? h('p', { class: 'coach-body', text: n.summary }) : null,
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

// ---- plan footer ----------------------------------------------------------
function planFooter(plan) {
  const err = h('p', { class: 'coach-inline-msg muted' });
  const label = `Plan v${trimNum(Number(plan.version) || 1)} · ${plan.source === 'revised' ? 'revised' : 'created'} ${shortDate(plan.createdAt)}`;
  return h('div', { class: 'coach-plan-footer' },
    h('div', { class: 'coach-plan-footer-row' },
      h('span', { class: 'coach-footer-text muted', text: label }),
      h('button', {
        class: 'coach-text-btn', type: 'button', 'data-action': 'coach-regenerate',
        onclick: () => regeneratePlan(err),
      }, 'Regenerate…'),
    ),
    err,
  );
}

function regeneratePlan(msgEl) {
  confirmSheet({
    title: 'Build a new plan?',
    message: 'The coach writes a fresh plan from your history and profile. Your old plans are kept.',
    confirmLabel: 'Build plan',
    onConfirm: async () => {
      msgEl.textContent = 'Building your plan…';
      msgEl.classList.remove('danger');
      try {
        await createPlan();
        msgEl.textContent = '';
      } catch (err) {
        msgEl.textContent = userMessageFor(err);
        msgEl.classList.add('danger');
      }
    },
  });
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
    cards.push(sessionInsightCard(insight));
    const changes = insight.narrative && Array.isArray(insight.narrative.planChanges)
      ? insight.narrative.planChanges : [];
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

function sessionInsightCard(insight) {
  const n = insight.narrative || {};
  const better = Array.isArray(n.better) ? n.better : [];
  const worse = Array.isArray(n.worse) ? n.worse : [];
  const flags = Array.isArray(n.flags) ? n.flags : [];
  return h('div', { class: 'tab-card coach-card coach-session-read' },
    h('div', { class: 'coach-card-head' },
      h('span', { class: 'coach-label', text: 'The coach says' }),
      tonePill(n.overallTone, SESSION_TONES),
    ),
    n.summary ? h('p', { class: 'coach-body', text: n.summary }) : null,
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
  const nextId = state.nextSession ? state.nextSession.id : null;

  const cards = [];
  const changes = state.latestSession && state.latestSession.narrative
    && Array.isArray(state.latestSession.narrative.planChanges)
    ? state.latestSession.narrative.planChanges : [];
  if (changes.length) cards.push(planChangesCard(changes, exMap));

  if (plan.rationale) {
    cards.push(h('div', { class: 'tab-card coach-card' },
      h('div', { class: 'coach-label', text: 'Why this plan' }),
      h('p', { class: 'coach-body', text: plan.rationale }),
      plan.weeks ? h('p', { class: 'coach-note muted', text: `${trimNum(Number(plan.weeks))} weeks` }) : null,
    ));
  }

  for (const s of plan.sessions || []) {
    const isNext = s.id === nextId;
    cards.push(h('div', { class: 'tab-card coach-card coach-plan-session' + (isNext ? ' is-next' : ''), 'data-plan-session-id': s.id },
      h('div', { class: 'coach-card-head' },
        h('span', { class: 'coach-card-title', text: s.name || 'Session' }),
        isNext ? h('span', { class: 'coach-pill coach-pill-good', text: 'Next' }) : null,
      ),
      s.focus ? h('div', { class: 'coach-sub muted', text: s.focus }) : null,
      h('div', { class: 'coach-ex-list' }, ...(s.exercises || []).map((e) => planExerciseLine(e, exMap))),
      isNext ? h('button', {
        class: 'coach-btn-primary', type: 'button', 'data-action': 'coach-start-session',
        onclick: () => (active ? go('#/workout') : startPlannedWorkout(plan, s)),
      }, active ? 'Resume workout' : 'Start session') : null,
    ));
  }

  cards.push(planFooter(plan));

  screen.replaceChildren(h('div', { class: 'coach-sub-screen' },
    backHeader('Your plan'),
    h('div', { class: 'coach-body-wrap' }, ...cards),
  ));
  stagger(cards);
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
    const n = insight.narrative || {};
    return h('div', { class: 'tab-card coach-card coach-history-card', 'data-insight-id': insight.id },
      h('div', { class: 'coach-card-head' },
        h('span', { class: 'coach-label', text: insight.date ? formatDate(insight.date) : '' }),
        tonePill(n.tone, DAILY_TONES),
      ),
      n.headline ? h('div', { class: 'coach-headline', text: n.headline }) : null,
      n.body ? h('p', { class: 'coach-body', text: n.body }) : null,
      n.todayAdvice ? h('div', { class: 'coach-advice', text: n.todayAdvice }) : null,
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
// 6. Setup route (#/coach/setup) — the summary screen with the sheet on top
// ============================================================================
async function renderSetupRoute(screen, token) {
  await renderRoot(screen, token);
  if (token !== renderToken) return;
  // A coach update re-renders this route; the sheet must not stack.
  const root = document.getElementById('sheet-root');
  if (root && root.childElementCount > 0) return;
  const profile = await getProfile().catch(() => null);
  if (token !== renderToken) return;
  openCoachSetupSheet({ profile, onDone: () => go('#/coach') });
}

// ============================================================================
// The "About you" sheet
// ============================================================================
/**
 * @param {{profile: Object|null, onDone?: (profile: Object|null) => void}} opts
 *   onDone runs after the profile is saved — and, when there is no plan yet,
 *   after createPlan has come back.
 */
export function openCoachSetupSheet({ profile = null, onDone } = {}) {
  const values = {
    goal: (profile && profile.goal) || 'return-from-injury',
    daysPerWeek: (profile && profile.daysPerWeek) || 3,
    sessionMinutes: (profile && profile.sessionMinutes) || 60,
    injuryNotes: (profile && profile.injuryNotes) || null,
    equipmentNotes: (profile && profile.equipmentNotes) || null,
    returnDate: (profile && profile.returnDate) || null,
  };
  // Whether Save has to build a plan as well. Prefetched so the button can say
  // so the moment it is pressed; a failed read simply means "build one".
  let hasPlan = false;
  getCoachState().then((s) => { hasPlan = !!(s && s.plan); }).catch(() => { hasPlan = false; });

  let saving = false;
  const group = h('div', { class: 'sheet-group' });
  const message = h('p', { class: 'sheet-message danger coach-sheet-error' });
  const saveBtn = h('button', {
    class: 'sheet-btn coach-sheet-save', type: 'button', 'data-action': 'coach-setup-save',
    onclick: () => save(),
  }, 'Save');

  const goalLabel = () => {
    const found = GOAL_OPTIONS.find((o) => o.value === values.goal);
    return found ? found.label : 'Choose';
  };

  /** A stepper row in the Settings `restRow` idiom. */
  function stepperRow(label, key, { min, max, step, format }) {
    const val = h('span', { class: 'timer-val small', text: format(values[key]) });
    const adjust = (delta) => {
      const next = Math.min(max, Math.max(min, (Number(values[key]) || min) + delta));
      values[key] = next;
      val.textContent = format(next);
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

  function dateRow() {
    const input = h('input', { class: 'sheet-input coach-date-input', type: 'date', 'aria-label': 'Return date' });
    input.value = values.returnDate || '';
    input.addEventListener('change', () => {
      values.returnDate = /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : null;
    });
    return h('div', { class: 'settings-row coach-sheet-date' },
      h('span', { class: 'settings-label', text: 'Return date' }),
      input,
    );
  }

  function paint() {
    group.replaceChildren(
      sheetRow({
        label: 'Goal', value: goalLabel(), chevron: true, action: 'coach-goal',
        onClick: () => optionSheet({
          title: 'Goal', options: GOAL_OPTIONS, current: values.goal,
          onPick: (v) => { values.goal = v; paint(); },
        }),
      }),
      stepperRow('Days per week', 'daysPerWeek', {
        min: 1, max: 7, step: 1, format: (n) => String(n),
      }),
      stepperRow('Session length', 'sessionMinutes', {
        min: 20, max: 120, step: 5, format: (n) => `${n} min`,
      }),
      sheetRow({
        label: 'Injury or limits', sub: values.injuryNotes || 'None given',
        chevron: true, action: 'coach-injury',
        onClick: () => textareaSheet({
          title: 'Injury or limits', value: values.injuryNotes,
          placeholder: 'e.g. left shoulder — no overhead pressing for now',
          onSave: (v) => { values.injuryNotes = v; paint(); },
        }),
      }),
      sheetRow({
        label: 'Equipment', sub: values.equipmentNotes || 'None given',
        chevron: true, action: 'coach-equipment',
        onClick: () => textareaSheet({
          title: 'Equipment', value: values.equipmentNotes,
          placeholder: 'e.g. home gym, dumbbells to 30 kg, no barbell',
          onSave: (v) => { values.equipmentNotes = v; paint(); },
        }),
      }),
      dateRow(),
    );
  }

  async function save() {
    if (saving) return;
    saving = true;
    const needsPlan = !profile || !hasPlan;
    saveBtn.disabled = true;
    saveBtn.textContent = needsPlan ? 'Building your plan…' : 'Saving…';
    message.textContent = '';
    try {
      let saved;
      if (needsPlan) {
        await createPlan({ ...values });
        saved = await getProfile().catch(() => null);
      } else {
        saved = await saveProfile({ ...values });
      }
      closeSheet();
      if (onDone) onDone(saved);
    } catch (err) {
      saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      message.textContent = userMessageFor(err);
    }
  }

  paint();

  openSheet(h('div', { class: 'coach-setup-sheet' },
    sheetHeader('About you', { onSave: () => save(), onClose: () => closeSheet() }),
    group,
    h('p', { class: 'sheet-note muted', text: 'Your answers stay on this device and are sent to Anthropic only as part of the coach’s summary.' }),
    message,
    h('div', { class: 'sheet-actions' }, saveBtn),
  ));
}
