// ============================================================================
// screens/exercise-insights.js — the two per-exercise read-outs shared by the
// workout screen (exercise ⋯ menu / card footer) and Statistics:
//
//   prSheet(exercise)        Personal Records — real sets, not a rep table
//   prRecordNodes(prs)       the same body, for the Statistics PR card
//   progressSheet(exercise)  Progress — a scatter of one dot per session
//
// Progress plots each finished session's TOP SET: the first working set done
// (calc.js topSetSeriesFrom). Sessions differ in how many sets they have, so
// the first working set is the like-for-like comparison. The Y axis is the
// user's choice and depends on what the exercise type logs.
//
// User text only ever via textContent / h() — never innerHTML.
// ============================================================================

import {
  h, openSheet, closeSheet, sheetHeader,
  formatWeight, formatDate, kgToDisplay, unitLabel, trimNum, mmss,
} from '../ui.js';
import { getPRs, getTopSetSeries } from '../queries.js';
import { renderChart } from '../charts.js';
import { fieldsForType, normalizeExerciseType } from '../exercise-types.js';
import { getSetting } from '../settings.js';

const num = (n) => Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 1 });

// ============================================================================
// Personal Records
// ============================================================================

/** "14 kg × 12", "12 reps" (bodyweight), "14 kg" (no reps). */
function setText(weightKg, reps) {
  if (reps > 0) return weightKg > 0 ? `${formatWeight(weightKg)} × ${reps}` : `${reps} reps`;
  return weightKg > 0 ? formatWeight(weightKg) : '—';
}

function distanceText(m) {
  return m >= 1000 ? `${num(m / 1000)} km` : `${Math.round(m).toLocaleString('en-GB')} m`;
}

/** One record line: what it is and the set that earned it, with the figure on the right. */
function recordRow(label, value, sub) {
  return h('div', { class: 'pr-rec' },
    h('span', { class: 'pr-rec-main' },
      h('span', { class: 'pr-rec-label', text: label }),
      sub ? h('span', { class: 'pr-rec-sub', text: sub }) : null,
    ),
    h('span', { class: 'pr-rec-val', text: value }),
  );
}

/**
 * The Personal Records body for a prsFrom() result. Every figure is a set that
 * was actually logged. Returns [] when there is nothing to show.
 * @returns {Node[]}
 */
export function prRecordNodes(prs) {
  const { bestE1RM, heaviest, bestSet, mostReps, byWeight = [], longest, furthest, mostKcal } = prs || {};
  const nodes = [];
  const recs = [];

  if (heaviest) {
    const weighted = heaviest.weightKg > 0;
    // Hero: the heaviest weight ever lifted and the most reps done at it — or,
    // for unweighted work, the most reps in one set.
    nodes.push(h('div', { class: 'pr-best' },
      h('div', { class: 'pr-best-label', text: weighted ? 'Heaviest set' : 'Most reps' }),
      h('div', { class: 'pr-best-val', text: weighted ? setText(heaviest.weightKg, heaviest.reps) : `${mostReps.reps} reps` }),
      h('div', { class: 'pr-best-sub', text: formatDate(weighted ? heaviest.date : mostReps.date) }),
    ));
    if (weighted) {
      if (bestSet) {
        recs.push(recordRow('Best set (weight × reps)', formatWeight(bestSet.loadKg),
          `${setText(bestSet.weightKg, bestSet.reps)} · ${formatDate(bestSet.date)}`));
      }
      if (bestE1RM) {
        recs.push(recordRow('Best estimated 1RM', formatWeight(bestE1RM.value),
          `${setText(bestE1RM.weightKg, bestE1RM.reps)} · ${formatDate(bestE1RM.date)}`));
      }
      if (mostReps) {
        recs.push(recordRow('Most reps in a set', String(mostReps.reps),
          `${setText(mostReps.weightKg, mostReps.reps)} · ${formatDate(mostReps.date)}`));
      }
    }
  }
  if (longest) {
    recs.push(recordRow('Longest', mmss(longest.durationSeconds),
      `${longest.weightKg > 0 ? `${formatWeight(longest.weightKg)} · ` : ''}${formatDate(longest.date)}`));
  }
  if (furthest) {
    recs.push(recordRow('Furthest', distanceText(furthest.distanceM),
      `${furthest.weightKg > 0 ? `${formatWeight(furthest.weightKg)} · ` : ''}${formatDate(furthest.date)}`));
  }
  if (mostKcal) {
    recs.push(recordRow('Most kcal', `${Math.round(mostKcal.kcal).toLocaleString('en-GB')} kcal`, formatDate(mostKcal.date)));
  }
  if (recs.length) nodes.push(h('div', { class: 'pr-table pr-recs' }, ...recs));

  // Best reps at each weight — heaviest first. Only when weight was used.
  const weights = byWeight.filter((r) => r.weightKg > 0);
  if (weights.length) {
    nodes.push(h('div', { class: 'sheet-label pr-section', text: 'Most reps at each weight' }));
    nodes.push(h('div', { class: 'pr-table' },
      h('div', { class: 'pr-row pr-head' },
        h('span', { text: 'Weight' }), h('span', { text: 'Reps' }), h('span', { text: 'Date' })),
      ...weights.map((r) => h('div', { class: 'pr-row' },
        h('span', { text: formatWeight(r.weightKg) }),
        h('span', { text: String(r.reps) }),
        h('span', { text: formatDate(r.date) }),
      )),
    ));
  }
  return nodes;
}

/** The headline figure for a PR card: "14 kg × 12", "20 reps", "12:30"… or ''. */
export function prHeadline(prs) {
  const { heaviest, mostReps, longest, furthest } = prs || {};
  if (heaviest) return heaviest.weightKg > 0 ? setText(heaviest.weightKg, heaviest.reps) : `${mostReps.reps} reps`;
  if (longest) return mmss(longest.durationSeconds);
  if (furthest) return distanceText(furthest.distanceM);
  return '';
}

export async function prSheet(exercise) {
  const title = exercise ? exercise.name : 'Personal Records';
  const nodes = exercise ? prRecordNodes(await getPRs(exercise.id)) : [];
  openSheet(h('div', { 'data-sheet': 'prs' },
    sheetHeader(title, { onClose: () => closeSheet() }),
    ...(nodes.length ? nodes : [h('p', { class: 'sheet-message muted', text: 'No records yet.' })]),
  ));
}

// ============================================================================
// Progress
// ============================================================================

const RANGES = [
  { id: '3m', label: '3M', days: 92 },
  { id: '6m', label: '6M', days: 183 },
  { id: '1y', label: '1Y', days: 366 },
  { id: 'all', label: 'All', days: null },
];

/**
 * Y-axis choices. `needs` are the set-grid fields the exercise type must log;
 * `value(p)` reads a topSetSeries point and returns null when that session has
 * nothing for this metric (the dot is simply left out).
 */
const METRICS = [
  {
    id: 'weight', label: 'Weight', needs: ['weight'], kind: 'weight',
    hint: 'The weight on your top set, whatever the reps.',
    value: (p, ctx) => (p.weightKg > 0 || ctx.bodyweight ? p.weightKg : null),
  },
  {
    id: 'load', label: 'Load', needs: ['weight', 'reps'], kind: 'weight',
    hint: 'Top-set load: weight × reps.',
    value: (p) => (p.loadKg != null && p.loadKg > 0 ? p.loadKg : null),
  },
  {
    id: 'reps', label: 'Reps', needs: ['reps'], kind: 'count', unit: 'reps',
    hint: 'Reps on your top set.',
    value: (p) => (p.reps > 0 ? p.reps : null),
  },
  {
    id: 'e1rm', label: 'Est. 1RM', needs: ['weight', 'reps'], kind: 'weight',
    hint: 'Estimated one-rep max from your top set (Epley).',
    value: (p) => (p.e1rm != null && p.e1rm > 0 ? p.e1rm : null),
  },
  {
    id: 'time', label: 'Time', needs: ['time'], kind: 'time',
    hint: 'Duration of your first set.',
    value: (p) => p.durationSeconds,
  },
  {
    id: 'distance', label: 'Distance', needs: ['distance'], kind: 'distance',
    hint: 'Distance of your first set.',
    value: (p) => p.distanceM,
  },
  {
    id: 'speed', label: 'Speed', needs: ['time', 'distance'], kind: 'count', unit: 'km/h',
    hint: 'Average speed of your first set.',
    value: (p) => (p.durationSeconds && p.distanceM ? (p.distanceM / 1000) / (p.durationSeconds / 3600) : null),
  },
  {
    id: 'kcal', label: 'Kcal', needs: ['kcal'], kind: 'count', unit: 'kcal',
    hint: 'Calories logged on your first set.',
    value: (p) => p.kcal,
  },
];

/** The Y-axis options an exercise type supports, in display order. */
export function progressMetricsFor(exerciseType) {
  const fields = fieldsForType(exerciseType);
  return METRICS.filter((m) => m.needs.every((f) => fields.includes(f)));
}

/** What the session's top set was, in words: "14 kg × 12", "5:00 · 1,200 m". */
function pointText(p) {
  const parts = [];
  if (p.reps > 0 || p.weightKg > 0) parts.push(setText(p.weightKg, p.reps));
  if (p.durationSeconds) parts.push(mmss(p.durationSeconds));
  if (p.distanceM) parts.push(distanceText(p.distanceM));
  if (p.kcal) parts.push(`${Math.round(p.kcal).toLocaleString('en-GB')} kcal`);
  return parts.join(' · ') || '—';
}

/**
 * Turn raw metric values into chart numbers + a unit, in the user's display
 * units. Time and distance pick the unit that keeps the axis readable.
 * @returns {{unit: string, scale: (v:number)=>number, text: (v:number)=>string}}
 */
function scalerFor(metric, rawValues) {
  const max = rawValues.length ? Math.max(...rawValues) : 0;
  if (metric.kind === 'weight') {
    return { unit: unitLabel().toLowerCase(), scale: (v) => kgToDisplay(v), text: (v) => formatWeight(v) };
  }
  if (metric.kind === 'time') {
    return max >= 600
      ? { unit: 'min', scale: (v) => v / 60, text: (v) => mmss(v) }
      : { unit: 's', scale: (v) => v, text: (v) => mmss(v) };
  }
  if (metric.kind === 'distance') {
    return max >= 2000
      ? { unit: 'km', scale: (v) => v / 1000, text: (v) => distanceText(v) }
      : { unit: 'm', scale: (v) => v, text: (v) => distanceText(v) };
  }
  return { unit: metric.unit || '', scale: (v) => v, text: (v) => `${trimNum(Math.round(v * 10) / 10)} ${metric.unit || ''}`.trim() };
}

function statTile(label, value, sub) {
  return h('div', { class: 'progress-stat' },
    h('span', { class: 'progress-stat-label', text: label }),
    h('span', { class: 'progress-stat-val', text: value }),
    h('span', { class: 'progress-stat-sub', text: sub || '' }),
  );
}

const METRIC_KEY = (type) => `progress.metric.${type}`;
const RANGE_KEY = 'progress.range';

/**
 * The Progress sheet: a scatter of the exercise's top set per session, with a
 * selectable Y axis and time range. Opened from the exercise ⋯ menu, the card
 * footer and the Statistics exercise screen.
 */
export async function progressSheet(exercise) {
  if (!exercise) return;
  const type = normalizeExerciseType(exercise.exerciseType);
  let metrics = progressMetricsFor(type);
  const header = sheetHeader(exercise.name, { onClose: () => closeSheet() });

  if (!metrics.length) {
    openSheet(h('div', { 'data-sheet': 'progress' }, header,
      h('p', { class: 'sheet-message muted', text: 'This exercise type has nothing to chart.' })));
    return;
  }

  const series = await getTopSetSeries(exercise.id);
  if (!series.length) {
    openSheet(h('div', { 'data-sheet': 'progress' }, header,
      h('p', { class: 'sheet-message muted', text: 'No finished sessions with this exercise yet.' })));
    return;
  }

  const ctx = { bodyweight: type === 'bw_weight_reps' || type === 'bw_assisted_reps' };
  // Only offer measures this exercise actually has numbers for: unweighted
  // chin-ups have no weight, load or 1RM to plot — just reps — and a cardio
  // machine that never logged distance has no distance or speed.
  const withData = metrics.filter((m) => series.some((p) => {
    const v = m.value(p, ctx);
    return v != null && Number.isFinite(v) && v > 0;
  }));
  if (withData.length) metrics = withData;
  let metricId = localStorage.getItem(METRIC_KEY(type));
  if (!metrics.some((m) => m.id === metricId)) metricId = metrics[0].id;
  let rangeId = localStorage.getItem(RANGE_KEY);
  if (!RANGES.some((r) => r.id === rangeId)) rangeId = 'all';

  const chartBox = h('div', { class: 'progress-chart' });
  const emptyNote = h('p', { class: 'sheet-message muted progress-empty', hidden: true });
  const stats = h('div', { class: 'progress-stats' });
  const hint = h('p', { class: 'progress-hint muted' });
  let chart = null;

  const segButtons = (items, current, attr, onPick) => h('div', { class: 'seg-toggle progress-seg' },
    ...items.map((it) => h('button', {
      class: 'seg-btn' + (it.id === current ? ' on' : ''), type: 'button',
      'data-action': attr, [`data-${attr === 'progress-metric' ? 'metric' : 'range'}`]: it.id,
      'aria-pressed': it.id === current ? 'true' : 'false',
      onclick: (e) => {
        for (const b of e.currentTarget.parentElement.children) {
          const on = b === e.currentTarget;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        onPick(it.id);
      },
    }, it.label)),
  );

  function draw() {
    const metric = metrics.find((m) => m.id === metricId);
    const range = RANGES.find((r) => r.id === rangeId);
    const since = range.days == null ? -Infinity : Date.now() - range.days * 86400000;
    const rows = series
      .filter((p) => p.t >= since)
      .map((p) => ({ p, raw: metric.value(p, ctx) }))
      .filter((r) => r.raw != null && Number.isFinite(r.raw));
    const sc = scalerFor(metric, rows.map((r) => r.raw));

    hint.textContent = `${metric.hint} One dot per session — your first working set.`;
    stats.replaceChildren();

    if (!rows.length) {
      if (chart) { chart.destroy(); chart = null; }
      chartBox.hidden = true;
      emptyNote.hidden = false;
      emptyNote.textContent = range.days == null
        ? 'Nothing logged for this measure yet.'
        : 'No sessions in this period. Try a longer range.';
      return;
    }
    chartBox.hidden = false;
    emptyNote.hidden = true;

    const spec = {
      type: 'scatter',
      points: rows.map(({ p, raw }) => ({
        t: p.t,
        label: formatDate(p.date),
        tip: `${formatDate(p.date)} · ${pointText(p)}`,
        value: sc.scale(raw),
      })),
      unit: sc.unit,
      xTickFormat: (t) => formatDate(t),
      trend: rows.length >= 3 && getSetting('chartTrendLine'),
      interactive: true,
    };
    if (chart) chart.update(spec); else chart = renderChart(chartBox, spec);

    const first = rows[0];
    const latest = rows[rows.length - 1];
    let best = rows[0];
    for (const r of rows) if (r.raw > best.raw) best = r;
    stats.append(
      statTile('Latest', sc.text(latest.raw), formatDate(latest.p.date)),
      statTile('Best', sc.text(best.raw), formatDate(best.p.date)),
    );
    if (rows.length >= 2 && first.raw > 0) {
      const pct = ((latest.raw - first.raw) / first.raw) * 100;
      const sign = pct > 0 ? '+' : '';
      stats.append(statTile('Change', `${sign}${trimNum(Math.round(pct * 10) / 10)}%`, `vs ${formatDate(first.p.date)}`));
    }
  }

  const backdrop = openSheet(h('div', { 'data-sheet': 'progress', class: 'progress-sheet' },
    header,
    metrics.length > 1
      ? segButtons(metrics, metricId, 'progress-metric', (id) => { metricId = id; localStorage.setItem(METRIC_KEY(type), id); draw(); })
      : h('div', { class: 'sheet-label', text: metrics[0].label }),
    chartBox,
    emptyNote,
    segButtons(RANGES, rangeId, 'progress-range', (id) => { rangeId = id; localStorage.setItem(RANGE_KEY, id); draw(); }),
    stats,
    hint,
  ));

  // The chart needs a laid-out box; the sheet is in the DOM as soon as
  // openSheet returns, so draw now and tidy the chart's observers when the
  // sheet goes away (close button, backdrop tap or a route change).
  draw();
  const root = backdrop && backdrop.parentElement;
  if (root && typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => {
      if (backdrop.isConnected) return;
      mo.disconnect();
      if (chart) { chart.destroy(); chart = null; }
    });
    mo.observe(root, { childList: true });
  }
}
