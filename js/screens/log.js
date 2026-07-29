// ============================================================================
// screens/log.js — Log tab (#/log). Workouts grouped by calendar month, newest
// first, each month rendered as one rounded card of workout rows (day badge,
// name, duration, "Nx Exercise" summary lines). The shell's resume bar links
// to the in-progress workout; the header "+" starts or resumes one.
//
// Matches screenshot 2 (month groups, day-badge workout cards).
// User text only ever via textContent / h() — never innerHTML.
// ============================================================================

import { listExercises } from '../db.js';
import { getRecentWorkouts } from '../queries.js';
import {
  h, Icon, go, gearButton,
  currentWorkout, getEntries, displayName, startWorkout,
} from '../ui.js';

const MONTH_FORMAT = { month: 'long', year: 'numeric' };
const WEEKDAY_FORMAT = { weekday: 'short' };

// ============================================================================
// Render
// ============================================================================
export async function renderLogTab() {
  const screen = document.getElementById('s-log');

  const [active, sessions, exercises] = await Promise.all([
    currentWorkout(),
    getRecentWorkouts('0000'),
    listExercises(),
  ]);
  const exMap = new Map(exercises.map((e) => [e.id, e]));

  const children = [
    h('div', { class: 'tab-head' },
      h('h1', { class: 'tab-title', text: 'Log' }),
      h('div', { class: 'tab-head-actions' },
        h('button', {
          class: 'round-btn tab-head-btn', 'data-action': 'start-workout', type: 'button',
          'aria-label': active ? 'Resume workout' : 'Start workout',
          onclick: () => (active ? go('#/workout') : startWorkout()),
        }, Icon('plus')),
        gearButton(),
      ),
    ),
  ];

  if (!sessions.length) {
    children.push(h('p', { class: 'log-empty muted', text: 'No workouts yet. Tap + to start your first.' }));
  } else {
    children.push(...buildMonthGroups(sessions, exMap));
  }

  screen.replaceChildren(h('div', { class: 'tab-screen' }, ...children));
}

// ---- month grouping ------------------------------------------------------
function buildMonthGroups(sessions, exMap) {
  // sessions is already newest-first (getRecentWorkouts), so a Map preserves
  // the correct display order as we insert.
  const groups = new Map(); // monthKey -> { label, items: [{workout, sets}] }
  for (const item of sessions) {
    const key = item.workout.date.slice(0, 7); // YYYY-MM
    if (!groups.has(key)) {
      const label = new Date(item.workout.date + 'T00:00:00').toLocaleDateString('en-GB', MONTH_FORMAT);
      groups.set(key, { label, items: [] });
    }
    groups.get(key).items.push(item);
  }

  const out = [];
  for (const { label, items } of groups.values()) {
    out.push(h('div', { class: 'month-group' },
      h('span', { class: 'month-group-name', text: label }),
      h('span', { class: 'month-group-count', text: `${items.length} Workout${items.length === 1 ? '' : 's'}` }),
    ));
    out.push(h('div', { class: 'month-card' }, ...items.map((item) => workoutRow(item, exMap))));
  }
  return out;
}

// ---- workout row -----------------------------------------------------------
function workoutRow({ workout, sets }, exMap) {
  const d = new Date(workout.date + 'T00:00:00');
  const weekday = d.toLocaleDateString('en-GB', WEEKDAY_FORMAT);
  const day = d.getDate();

  return h('button', {
    class: 'workout-card', 'data-workout-id': workout.id, type: 'button',
    onclick: () => go('#/workout/' + workout.id),
  },
    h('span', { class: 'wc-badge' },
      h('span', { class: 'wc-badge-day', text: weekday }),
      h('span', { class: 'wc-badge-num', text: String(day) }),
    ),
    h('span', { class: 'wc-main' },
      h('span', { class: 'wc-title-row' },
        h('span', { class: 'wc-name', text: displayName(workout) }),
        h('span', { class: 'wc-duration', text: durationLabel(workout) }),
      ),
      ...exerciseLines(workout, sets, exMap).map((line) => h('span', { class: 'wc-line', text: line })),
    ),
  );
}

function durationLabel(workout) {
  if (!workout.finishedAt) return 'in progress';
  const mins = Math.round((new Date(workout.finishedAt) - new Date(workout.startedAt)) / 60000);
  return `${Math.max(0, mins)} min`;
}

/** "Nx Exercise Name" lines in entry order; finished workouts skip zero-set entries. */
function exerciseLines(workout, sets, exMap) {
  const entries = getEntries(workout, sets);
  const countByExercise = new Map();
  for (const s of sets) countByExercise.set(s.exerciseId, (countByExercise.get(s.exerciseId) || 0) + 1);

  const lines = [];
  for (const entry of entries) {
    const count = countByExercise.get(entry.exerciseId) || 0;
    if (count === 0 && workout.finishedAt) continue; // finished: skip empty entries
    const exercise = exMap.get(entry.exerciseId);
    const name = exercise ? exercise.name : 'Unknown exercise';
    lines.push(`${count}x ${name}`);
  }
  return lines;
}
