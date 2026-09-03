// ============================================================================
// screens/home.js — the Home tab (#/home), the default tab (Phase C2, PLAN.md
// §"Phase C2" C2.5). A digest of the app: the last finished session, the
// coach's read on it (or a nudge to get one), a strip of the Statistics
// modules the user has chosen as "key stats", and — with a coach key — a
// live chat thread onto the shared coach memory.
//
// Nothing here talks to the network directly: session analysis and chat both
// go through js/coach.js's queue, exactly like the Coach tab. Model-written
// text only ever reaches the DOM via textContent / the h() `text` prop / the
// coach-shared.js bullets() helper — never innerHTML.
// ============================================================================

import {
  h, Icon, go, gearButton, startWorkout, setScreenCleanup, formatWeight,
} from '../ui.js';
import { listWorkouts, listSetsForWorkout, listExercises } from '../db.js';
import { workoutRow } from './log.js';
import { getCoachState, runSessionFeedback, onCoachUpdate } from '../coach.js';
import { normaliseNarrative } from '../coach-api.js';
import { bullets, tonePill, chatPanel } from './coach-shared.js';
import { getStatsLayout } from '../settings.js';
import { chartHash, moduleHeadline } from './stats.js';
import { OVERALL_METRICS, EXERCISE_METRICS, CATEGORY_METRICS } from '../stats-data.js';

/** Mirrors screens/coach.js v1's SESSION_TONES — kept local since that file
 * is off-limits here (another agent is rewriting it in parallel). */
const SESSION_TONES = {
  great: { label: 'Great', tone: 'good' },
  solid: { label: 'Solid', tone: 'good' },
  mixed: { label: 'Mixed', tone: 'neutral' },
  'back-off': { label: 'Back off', tone: 'warn' },
};

// ----------------------------------------------------------------------------
// State the coach-update subscription needs to refresh IN PLACE — never a
// full-screen rebuild, so the chat panel's textarea (and any half-typed
// draft) survives a session-analysis result landing.
// ----------------------------------------------------------------------------
let liveSessionSection = null;
let liveLastWorkout = null;

// ============================================================================
// Entry
// ============================================================================
export async function renderHome(parts = []) {
  const screen = document.getElementById('s-home');
  if (!screen) return;

  liveSessionSection = null;
  liveLastWorkout = null;

  const [exercises, lastWorkout, state] = await Promise.all([
    listExercises().catch(() => []),
    lastFinishedWorkout(),
    getCoachState().catch(() => null),
  ]);
  const exMap = new Map(exercises.map((e) => [e.id, e]));

  const head = h('div', { class: 'tab-head' },
    h('h1', { class: 'tab-title', text: 'Home' }),
    gearButton(),
  );

  const lastSection = await buildLastSessionSection(lastWorkout, exMap);
  const sessionSection = await buildSessionSummarySection(state, lastWorkout);
  const statsSection = await buildKeyStatsSection(state);

  let chat = null;
  let chatSection = null;
  if (state && state.enabled) {
    const chatContainer = h('div', { class: 'home-chat-container' });
    chatSection = h('div', { class: 'home-section' },
      h('div', { class: 'home-label', text: 'Coach' }),
      chatContainer,
      h('button', {
        class: 'coach-link-row', type: 'button', 'data-action': 'home-open-coach',
        onclick: () => go('#/coach'),
      }, h('span', { text: 'Open Coach' }), h('span', { class: 'coach-link-chev' }, Icon('chevron'))),
    );
    chat = chatPanel({ thread: 'home', container: chatContainer, compact: true });
  }

  const children = [head, lastSection];
  if (sessionSection) children.push(sessionSection);
  children.push(statsSection);
  if (chatSection) children.push(chatSection);

  screen.replaceChildren(h('div', { class: 'tab-screen home-screen' }, ...children));

  liveSessionSection = sessionSection || null;
  liveLastWorkout = lastWorkout;

  const unsub = onCoachUpdate(() => {
    refreshSessionSection().catch((err) => console.error('home: session refresh failed', err));
  });
  setScreenCleanup(() => {
    unsub();
    if (chat) chat.destroy();
    liveSessionSection = null;
    liveLastWorkout = null;
  });
}

// ============================================================================
// 1. Last session
// ============================================================================
async function lastFinishedWorkout() {
  const workouts = await listWorkouts('0000');
  const finished = workouts.filter((w) => w.finishedAt);
  finished.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return finished[0] || null;
}

async function buildLastSessionSection(workout, exMap) {
  const label = h('div', { class: 'home-label', text: 'Last session' });
  if (!workout) {
    return h('div', { class: 'home-section', 'data-action': 'home-last-session' },
      label,
      h('div', { class: 'tab-card home-empty' },
        h('p', { class: 'muted', text: 'No sessions yet. Start one from the Log tab.' }),
        h('button', {
          class: 'coach-btn-primary', type: 'button', 'data-action': 'home-start',
          onclick: () => startWorkout(),
        }, 'Start workout'),
      ),
    );
  }
  const sets = await listSetsForWorkout(workout.id);
  return h('div', { class: 'home-section', 'data-action': 'home-last-session' },
    label,
    // workoutRow() is a bare .workout-card (its month-card parent normally
    // supplies the card chrome) — give it one of its own here.
    h('div', { class: 'home-last-card' }, workoutRow({ workout, sets }, exMap)),
  );
}

// ============================================================================
// 2. Session summary — the coach's read on the last session, or a nudge
// ============================================================================
function verdictLine(kind, item) {
  return h('div', { class: `coach-verdict coach-verdict-${kind}` },
    h('span', { class: 'coach-verdict-glyph', text: kind === 'better' ? '✓' : '✗' }),
    h('span', { class: 'coach-verdict-text', text: `${item.name || 'Exercise'} — ${item.note || ''}`.trim() }),
  );
}

function analyseButton(workout) {
  const btn = h('button', {
    class: 'tab-card home-analyse-btn', type: 'button', 'data-action': 'home-analyse',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Analysing…';
      try {
        const result = await runSessionFeedback(workout.id, { force: true });
        if (!result) { btn.disabled = false; btn.textContent = 'Analyse this session'; }
      } catch (err) {
        console.error('home: analyse failed', err);
        btn.disabled = false;
        btn.textContent = 'Analyse this session';
      }
    },
  }, 'Analyse this session');
  return btn;
}

async function buildSessionSummarySection(state, workout) {
  if (!workout) return null;
  const label = h('div', { class: 'home-label', text: 'Coach' });

  if (state && state.latestSession && state.latestSession.workoutId === workout.id) {
    const n = normaliseNarrative('session', state.latestSession.narrative || {}) || {};
    const better = Array.isArray(n.better) ? n.better.slice(0, 2) : [];
    const worse = Array.isArray(n.worse) ? n.worse.slice(0, 2) : [];
    const card = h('button', {
      class: 'tab-card coach-card home-session-card', type: 'button',
      onclick: () => go(`#/coach/session/${workout.id}`),
    },
      h('div', { class: 'coach-card-head' },
        h('span', { class: 'coach-label', text: 'Session summary' }),
        tonePill(n.overallTone, SESSION_TONES),
      ),
      bullets(n.points),
      (better.length || worse.length) ? h('div', { class: 'coach-verdict-list' },
        ...better.map((b) => verdictLine('better', b)),
        ...worse.map((w) => verdictLine('worse', w)),
      ) : null,
    );
    return h('div', { class: 'home-section' }, label, card);
  }

  if (state && state.enabled) {
    return h('div', { class: 'home-section' }, label, analyseButton(workout));
  }

  return h('div', { class: 'home-section' }, label,
    h('button', {
      class: 'home-coach-cta muted', type: 'button', 'data-action': 'coach-open-settings',
      onclick: () => go('#/settings'),
    }, 'Add your Anthropic key in Settings to get coaching on every session.'),
  );
}

/** Swaps the session-summary section in place — never touches the chat panel
 * or the stats strip, so neither loses its live state. */
async function refreshSessionSection() {
  if (!liveSessionSection || !liveSessionSection.isConnected) return;
  const state = await getCoachState().catch(() => null);
  const next = await buildSessionSummarySection(state, liveLastWorkout);
  if (next && liveSessionSection.parentNode) {
    liveSessionSection.replaceWith(next);
    liveSessionSection = next;
  }
}

// ============================================================================
// 3. Key stats — mirrors the Statistics modules the user chose (Home + PRs)
// ============================================================================
/** Immediate placeholder label — the real title (with an exercise/category
 * name where relevant) lands a beat later via moduleHeadline. */
function quickLabel(spec) {
  const list = spec.scope.kind === 'exercise' ? EXERCISE_METRICS
    : spec.scope.kind === 'category' ? CATEGORY_METRICS : OVERALL_METRICS;
  const def = list.find((m) => m.id === spec.metric);
  return def ? def.label : '';
}

function statTile(spec) {
  const titleEl = h('span', { class: 'home-stat-title', text: quickLabel(spec) });
  const valueEl = h('span', { class: 'home-stat-value', text: '—' });
  const tile = h('button', {
    class: 'home-stat', type: 'button', 'data-action': 'home-stat', 'data-module-id': spec.id,
    onclick: () => go(chartHash(spec.scope, spec.metric)),
  }, titleEl, valueEl);
  requestAnimationFrame(() => {
    moduleHeadline(spec)
      .then(({ title, value }) => { titleEl.textContent = title; valueEl.textContent = value; })
      .catch(() => { valueEl.textContent = '—'; });
  });
  return tile;
}

function recentPRsLine(state) {
  const prs = state && Array.isArray(state.recentPRs) ? state.recentPRs : [];
  if (!prs.length) return h('p', { class: 'home-prs muted', text: 'No new PRs this week.' });
  const text = `New PRs this week: ${prs.map((p) => `${p.name || 'Exercise'} ${formatWeight(p.value)} e1RM`).join(' · ')}`;
  return h('p', { class: 'home-prs', text });
}

async function buildKeyStatsSection(state) {
  const layout = getStatsLayout().filter((m) => m.kind === 'metric');
  const body = layout.length
    ? h('div', { class: 'home-stats' }, ...layout.map((spec) => statTile(spec)))
    : h('p', { class: 'home-empty muted', text: 'Add cards from Statistics to see them here.' });
  return h('div', { class: 'home-section' },
    h('div', { class: 'home-label', text: 'Key stats' }),
    body,
    recentPRsLine(state),
  );
}
