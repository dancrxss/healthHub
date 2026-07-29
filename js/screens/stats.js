// ============================================================================
// screens/stats.js — Statistics tab (#/stats). Three cards built from the
// frozen query layer: sessions/week, weekly volume per muscle group, and
// per-exercise PRs. All charts are pure CSS bars — no libraries, no canvas.
//
// User text only ever via textContent / h() — never innerHTML.
// ============================================================================

import { listExercises } from '../db.js';
import {
  getTrainingFrequency, getWeeklyVolume, getPRs, getRecentWorkouts,
} from '../queries.js';
import {
  h, Icon, gearButton, formatWeight, formatDate, getUnits, kgToDisplay, optionSheet,
} from '../ui.js';

const PR_STORAGE_KEY = 'stats.prExercise';
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Compact rounded weight for chart values, e.g. "3,240 kg" — kg/lb per settings. */
function formatVolume(kg) {
  const val = Math.round(kgToDisplay(kg));
  return `${val.toLocaleString('en-GB')} ${getUnits()}`;
}
/** Just the week number out of an ISO week id, e.g. "2026-W30" -> "W30". */
function weekLabel(isoWeek) {
  return 'W' + isoWeek.split('-W')[1];
}

// ============================================================================
// Render
// ============================================================================
export async function renderStats() {
  const screen = document.getElementById('s-stats');

  const [freq, vol, recentSessions, allExercises] = await Promise.all([
    getTrainingFrequency(8),
    getWeeklyVolume(8),
    getRecentWorkouts('0000'),
    listExercises(),
  ]);
  const exMap = new Map(allExercises.map((e) => [e.id, e]));

  const loggedIds = new Set();
  for (const { sets } of recentSessions) for (const s of sets) loggedIds.add(s.exerciseId);
  const loggedExercises = allExercises.filter((e) => loggedIds.has(e.id));

  const stored = localStorage.getItem(PR_STORAGE_KEY);
  const initialPr = stored && loggedIds.has(stored) ? stored : null;

  const prCard = await buildPrCard(loggedExercises, exMap, initialPr);

  screen.replaceChildren(h('div', { class: 'tab-screen' },
    h('div', { class: 'tab-head' },
      h('h1', { class: 'tab-title', text: 'Statistics' }),
      h('div', { class: 'tab-head-actions' }, gearButton()),
    ),
    frequencyCard(freq),
    volumeCard(vol),
    prCard,
  ));
}

// ---- card 1: workouts per week ----------------------------------------
function frequencyCard(freq) {
  const maxSessions = Math.max(1, ...freq.map((f) => f.sessionsTotal));
  const totalSessions = freq.reduce((sum, f) => sum + f.sessionsTotal, 0);

  const bars = freq.map((f, i) => {
    const pct = Math.round((f.sessionsTotal / maxSessions) * 100);
    const isCurrent = i === freq.length - 1;
    return h('div', { class: 'bar-col' },
      h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill' + (isCurrent ? ' current' : ''), style: `height:${pct}%` })),
      h('span', { class: 'bar-val', text: String(f.sessionsTotal) }),
      h('span', { class: 'bar-label', text: weekLabel(f.isoWeek) }),
    );
  });

  return h('div', { class: 'tab-card stat-card' },
    h('div', { class: 'stat-card-head' },
      h('span', { class: 'stat-card-title', text: 'Workouts per week' }),
      h('span', { class: 'stat-card-headline', text: String(totalSessions) }),
    ),
    h('div', { class: 'bar-chart' }, ...bars),
  );
}

// ---- card 2: weekly volume ----------------------------------------------
function volumeCard(vol) {
  const totals = vol.map((v) => Object.values(v.perMuscleGroup).reduce((a, b) => a + b, 0));
  const maxVol = Math.max(1, ...totals);
  const currentTotal = totals[totals.length - 1] || 0;

  const bars = vol.map((v, i) => {
    const pct = Math.round((totals[i] / maxVol) * 100);
    const isCurrent = i === vol.length - 1;
    return h('div', { class: 'bar-col' },
      h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill' + (isCurrent ? ' current' : ''), style: `height:${pct}%` })),
      h('span', { class: 'bar-val small', text: Math.round(kgToDisplay(totals[i])).toLocaleString('en-GB') }),
      h('span', { class: 'bar-label', text: weekLabel(v.isoWeek) }),
    );
  });

  const current = vol[vol.length - 1] || { perMuscleGroup: {} };
  const rows = Object.entries(current.perMuscleGroup)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const maxGroup = Math.max(1, ...rows.map(([, v]) => v));

  const breakdown = rows.length
    ? rows.map(([group, v]) => h('div', { class: 'vol-row' },
        h('span', { class: 'vol-row-label', text: titleCase(group) }),
        h('div', { class: 'vol-row-track' }, h('div', { class: 'vol-row-fill', style: `width:${Math.round((v / maxGroup) * 100)}%` })),
        h('span', { class: 'vol-row-val', text: formatVolume(v) }),
      ))
    : [h('p', { class: 'stat-empty muted', text: 'No volume logged this week.' })];

  return h('div', { class: 'tab-card stat-card' },
    h('div', { class: 'stat-card-head' },
      h('span', { class: 'stat-card-title', text: 'Weekly volume' }),
      h('span', { class: 'stat-card-headline', text: formatVolume(currentTotal) }),
    ),
    h('div', { class: 'bar-chart' }, ...bars),
    h('div', { class: 'vol-breakdown' }, ...breakdown),
  );
}

// ---- card 3: personal records ---------------------------------------------
async function buildPrCard(loggedExercises, exMap, initialId) {
  const card = h('div', { class: 'tab-card stat-card' });

  const renderInner = async (id) => {
    const selected = id ? exMap.get(id) : null;

    const pickerRow = h('button', {
      class: 'pr-picker-row', type: 'button',
      onclick: () => optionSheet({
        title: 'Choose exercise',
        options: loggedExercises.map((e) => ({ value: e.id, label: e.name })),
        current: id,
        onPick: (v) => { localStorage.setItem(PR_STORAGE_KEY, v); renderInner(v); },
      }),
    },
      h('span', { class: 'pr-picker-label', text: selected ? selected.name : 'Choose an exercise' }),
      h('span', { class: 'pr-picker-chev' }, Icon('chevron')),
    );

    const body = [];
    if (!selected) {
      body.push(h('p', {
        class: 'stat-empty muted',
        text: loggedExercises.length ? 'Pick an exercise to see its personal records.' : 'Log some sets to see personal records here.',
      }));
    } else {
      const { byReps, bestE1RM } = await getPRs(selected.id);
      if (!bestE1RM) {
        body.push(h('p', { class: 'stat-empty muted', text: 'No working sets logged for this exercise yet.' }));
      } else {
        body.push(h('div', { class: 'pr-headline' },
          h('span', { class: 'pr-headline-val', text: `${formatWeight(bestE1RM.weightKg)} × ${bestE1RM.reps} → e1RM ${formatWeight(bestE1RM.value)}` }),
        ));
        body.push(h('div', { class: 'pr-table' },
          h('div', { class: 'pr-row pr-head' }, h('span', { text: 'Reps' }), h('span', { text: 'Best' }), h('span', { text: 'Date' })),
          ...byReps.map((r) => h('div', { class: 'pr-row' },
            h('span', { text: String(r.reps) }),
            h('span', { text: formatWeight(r.weightKg) }),
            h('span', { text: formatDate(r.date) }),
          )),
        ));
      }
    }

    card.replaceChildren(
      h('div', { class: 'stat-card-head' }, h('span', { class: 'stat-card-title', text: 'Personal records' })),
      pickerRow,
      ...body,
    );
  };

  await renderInner(initialId);
  return card;
}
