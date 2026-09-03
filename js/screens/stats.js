// ============================================================================
// screens/stats.js — the Statistics tab and everything under it.
//
// Routes (the router hands us the hash path after 'stats'; the tab bar stays):
//   #/stats                                  the customisable module grid + nav
//   #/stats/exercises                        exercises with logged sets
//   #/stats/exercise/:id                     per-exercise metric list
//   #/stats/exercise/:id/chart/:metric       chart detail
//   #/stats/categories                       muscle groups with logged sets
//   #/stats/category/:group                  per-category metric list
//   #/stats/category/:group/chart/:metric    chart detail
//   #/stats/overall/:metric                  chart detail
//
// The grid is driven entirely by settings.js (getStatsLayout/setStatsLayout);
// metric lists come from the stats-data.js catalogues — nothing here hand-writes
// a metric. Series values always arrive in kg and are converted to the user's
// display units at THIS layer (kgToDisplay / getUnits) before reaching charts.js.
//
// User text only ever via textContent / h() — never innerHTML.
// ============================================================================

import {
  listExercises, listWorkouts, listSetsForWorkout, listSetsForExercise,
  getExercise, getWorkout, MUSCLE_GROUPS,
} from '../db.js';
import { getPRs } from '../queries.js';
import { renderChart } from '../charts.js';
import {
  OVERALL_METRICS, EXERCISE_METRICS, CATEGORY_METRICS,
  computeSeries, categoryBreakdown,
} from '../stats-data.js';
import {
  getSetting, getStatsLayout, setStatsLayout, resetStatsLayout,
} from '../settings.js';
import {
  h, Icon, gearButton, go, openSheet, closeSheet, sheetHeader, sheetGroup,
  sheetRow, optionSheet, confirmSheet, formatWeight, formatDate, getUnits,
  kgToDisplay, mmss, trimNum, setScreenCleanup,
} from '../ui.js';
import { uid } from '../util.js';
import { playOnce, playOut, stagger, flip, springHome, motionOK } from '../motion.js';
import { healthAvailable, getHealthSummary, onHealthUpdate } from '../health.js';

const PR_STORAGE_KEY = 'stats.prExercise';
const CHART_PREFS_KEY = 'stats.chartPrefs';

const GROUP_OPTIONS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];
const RANGE_OPTIONS = [
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
];
const CHART_TYPES = [
  { value: 'line', label: 'Line' },
  { value: 'bar', label: 'Bar' },
  { value: 'pie', label: 'Pie' },
];
/** Only these overall metrics split meaningfully across muscle groups. */
const PIE_METRICS = ['volume', 'sets', 'reps', 'workouts'];

// ----------------------------------------------------------------------------
// Module-level render state
// ----------------------------------------------------------------------------
/** Live charts for the current screen: {handle, owner}. Destroyed on render. */
const liveCharts = [];
/** Bumped on every renderStats so late async work from an old screen is dropped. */
let renderToken = 0;
/** Grid edit mode (drag handles + remove + add). Reset on any sub-route. */
let editing = false;
/** True for the one render caused by toggling edit mode (lighter entrance). */
let editToggled = false;
/** Cached exercise/logged index for the current stats visit. */
let indexCache = null;
/** Context from the last main-grid render (exercise map etc.) for card refreshes. */
let gridCtx = null;

function destroyCharts() {
  for (const c of liveCharts.splice(0)) {
    try { c.handle.destroy(); } catch (err) { /* a half-built chart is still gone */ }
  }
}
/** Destroy only the charts living inside `el` (a card about to be replaced). */
function destroyChartsIn(el) {
  for (let i = liveCharts.length - 1; i >= 0; i -= 1) {
    if (!el.contains(liveCharts[i].owner)) continue;
    try { liveCharts[i].handle.destroy(); } catch (err) { /* ignore */ }
    liveCharts.splice(i, 1);
  }
}
function track(handle, token, owner) {
  if (!handle) return;
  if (token !== renderToken) { try { handle.destroy(); } catch (err) { /* ignore */ } return; }
  liveCharts.push({ handle, owner });
}

/** Live subscription to Apple Health updates while the grid screen is shown. */
let unsubHealthStats = null;
function stopHealthSubscription() {
  if (unsubHealthStats) { unsubHealthStats(); unsubHealthStats = null; }
}

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function metricsFor(scopeKind) {
  if (scopeKind === 'exercise') return EXERCISE_METRICS;
  if (scopeKind === 'category') return CATEGORY_METRICS;
  return OVERALL_METRICS;
}
function metricDef(scopeKind, id) {
  const list = metricsFor(scopeKind);
  return list.find((m) => m.id === id) || list[0];
}
function seriesOpts() {
  return {
    includeWarmup: getSetting('chartIncludeWarmup'),
    countUnilateralTwice: getSetting('countUnilateralTwice'),
  };
}
function pieAllowed(scope, metricId) {
  return scope.kind === 'overall' && PIE_METRICS.includes(metricId);
}

/** Series values are kg; charts show the user's display unit. */
function toChartPoints(points, unit) {
  if (unit !== 'kg') return points;
  return points.map((p) => ({ ...p, value: kgToDisplay(p.value) }));
}
function chartUnit(unit) {
  return unit === 'kg' ? getUnits() : (unit || '');
}
/** Short axis text: 1.2k / 12k / 3.4M, integers stay whole. */
function compactNum(n) {
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1000) return (n / 1000).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10);
}
/** Headline formatting — kg goes through formatWeight so units follow settings. */
function formatMetricValue(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'kg') return formatWeight(v);
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  const s = n.toLocaleString('en-GB');
  return unit ? `${s} ${unit}` : s;
}

export function chartHash(scope, metricId) {
  if (scope.kind === 'exercise') return `#/stats/exercise/${scope.id}/chart/${metricId}`;
  if (scope.kind === 'category') return `#/stats/category/${scope.id}/chart/${metricId}`;
  return `#/stats/overall/${metricId}`;
}

function emptyChart(box, text = 'Nothing logged yet.') {
  box.replaceChildren(h('p', { class: 'stats-empty muted', text }));
}

/** Back-header in the picker style: round back button, centred title. */
function backHeader(title, backHash) {
  return h('header', { class: 'pick-head stats-head' },
    h('button', {
      class: 'round-btn', type: 'button', 'aria-label': 'Back',
      'data-action': 'stats-back', onclick: () => go(backHash),
    }, Icon('back')),
    h('div', { class: 'pick-title', text: title }),
    h('span', { class: 'round-btn-ghost' }),
  );
}

/** A list row inside a .stats-nav-card (styled like a sheet row). */
function navRow({ label, sub, value, attrs = {}, onClick }) {
  return h('button', {
    class: 'sheet-row stats-nav-row', type: 'button', onclick: onClick, ...attrs,
  },
    h('span', { class: 'sheet-row-label' },
      h('span', { text: label }),
      sub ? h('span', { class: 'sheet-row-sub', text: sub }) : null,
    ),
    value != null ? h('span', { class: 'sheet-row-value', text: value }) : null,
    h('span', { class: 'sheet-row-chev' }, Icon('chevron')),
  );
}

// ----------------------------------------------------------------------------
// Data index — which exercises / muscle groups actually have logged sets.
// One pass over the workouts' sets (db.js has no "all sets" reader); cached for
// the duration of a visit and invalidated whenever the grid re-renders.
// ----------------------------------------------------------------------------
async function loadIndex() {
  if (indexCache) return indexCache;
  indexCache = (async () => {
    const [exercises, workouts] = await Promise.all([listExercises(), listWorkouts('0000')]);
    const exMap = new Map(exercises.map((e) => [e.id, e]));
    const setLists = await Promise.all(workouts.map((w) => listSetsForWorkout(w.id)));
    const loggedIds = new Set();
    for (const sets of setLists) for (const s of sets) loggedIds.add(s.exerciseId);
    const loggedExercises = exercises.filter((e) => loggedIds.has(e.id));
    const loggedGroups = MUSCLE_GROUPS.filter((g) =>
      loggedExercises.some((e) => e.muscleGroup === g));
    return { exMap, exercises, loggedIds, loggedExercises, loggedGroups };
  })();
  return indexCache;
}

// ============================================================================
// Router entry
// ============================================================================
/** @param {string[]} subParts hash path after 'stats' */
export async function renderStats(subParts = []) {
  destroyCharts();
  const token = ++renderToken;
  const screen = document.getElementById('s-stats');
  const [a, b, c, d] = subParts;

  if (a) editing = false; // edit mode is a property of the grid screen only

  if (!a) return renderGrid(screen, token);
  if (a === 'exercises') return renderExerciseList(screen);
  if (a === 'categories') return renderCategoryList(screen);
  if (a === 'exercise' && b && c === 'chart' && d) {
    return renderChartScreen(screen, { kind: 'exercise', id: b }, d, token);
  }
  if (a === 'exercise' && b) return renderExerciseDetail(screen, b);
  if (a === 'category' && b && c === 'chart' && d) {
    return renderChartScreen(screen, { kind: 'category', id: b }, d, token);
  }
  if (a === 'category' && b) return renderCategoryDetail(screen, b);
  if (a === 'overall' && b) return renderChartScreen(screen, { kind: 'overall' }, b, token);

  go('#/stats');
  return undefined;
}

// ============================================================================
// 1 + 2. The module grid (#/stats)
// ============================================================================
async function renderGrid(screen, token) {
  destroyCharts();
  indexCache = null; // the grid is the entry point: pick up any new training
  const layout = getStatsLayout();
  const { exMap, loggedExercises, loggedGroups } = await loadIndex();
  if (token !== renderToken) return;
  gridCtx = { exMap, loggedExercises, loggedGroups, token };

  const grid = h('div', { class: 'stats-grid' });
  for (const spec of layout) grid.append(buildModuleCard(spec, gridCtx));
  if (editing) {
    grid.append(h('button', {
      class: 'stats-add-card', type: 'button', 'data-action': 'module-add',
      onclick: () => addCardSheet(),
    }, Icon('plus'), h('span', { text: 'Add card' })));
  }

  const head = h('div', { class: 'tab-head' },
    h('h1', { class: 'tab-title', text: 'Statistics' }),
    h('div', { class: 'tab-head-actions' },
      h('button', {
        class: 'stats-edit-btn', type: 'button', 'data-action': 'stats-edit',
        onclick: () => { editing = !editing; editToggled = true; rerenderGrid(); },
      }, editing ? 'Done' : 'Edit'),
      gearButton(),
    ),
  );

  const nav = h('div', { class: 'tab-card stats-nav-card' },
    navRow({ label: 'Exercises', attrs: { 'data-stat-nav': 'exercises' }, onClick: () => go('#/stats/exercises') }),
    navRow({ label: 'Categories', attrs: { 'data-stat-nav': 'categories' }, onClick: () => go('#/stats/categories') }),
  );

  const overall = h('div', { class: 'tab-card stats-nav-card' },
    ...OVERALL_METRICS.map((m) => navRow({
      label: m.label,
      attrs: { 'data-metric': m.id },
      onClick: () => go(`#/stats/overall/${m.id}`),
    })),
  );

  let healthSection = null;
  try { healthSection = await buildHealthSection(token); } catch (err) { console.error('stats: health section failed', err); }
  if (token !== renderToken) return;

  screen.replaceChildren(h('div', { class: 'tab-screen' + (editing ? ' stats-editing' : '') },
    head,
    grid,
    nav,
    h('div', { class: 'stats-section-label', text: 'Overall Statistics' }),
    overall,
    healthSection,
  ));

  // The page assembles as ONE motion: module cards and the navigation below
  // share a single stagger sequence rather than reading as two lists. Toggling
  // edit mode gets the lighter `settle` instead — the list is already on
  // screen and merely changing mode; a full rise would read as a page reload.
  const staggerItems = [...grid.children, nav, overall];
  if (healthSection) staggerItems.push(healthSection);
  stagger(staggerItems, editToggled ? 'anim-card-settle' : 'anim-card-in');
  editToggled = false;

  if (editing) bindDragAndDrop(grid);

  // Re-armed on every grid render (edit toggle, layout change) rather than
  // only once, since a stale subscription would otherwise stack duplicates.
  if (healthAvailable()) {
    stopHealthSubscription();
    unsubHealthStats = onHealthUpdate(() => {
      refreshHealthSection().catch((err) => console.error('stats: health refresh failed', err));
    });
    setScreenCleanup(() => stopHealthSubscription());
  }
}

/** Rebuild the whole grid (layout changed / edit mode toggled). */
function rerenderGrid() {
  renderGrid(document.getElementById('s-stats'), ++renderToken)
    .catch((err) => console.error('stats: grid render failed', err));
}

/** Re-render a single module card in place (config changes, PR picks). */
function refreshModule(id) {
  const screen = document.getElementById('s-stats');
  const el = screen.querySelector(`.stats-grid [data-module-id="${CSS.escape(id)}"]`);
  const spec = getStatsLayout().find((m) => m.id === id);
  if (!el || !spec || !gridCtx) { rerenderGrid(); return; }
  destroyChartsIn(el);
  const next = buildModuleCard(spec, gridCtx);
  el.replaceWith(next);
  // One card changed, not the list: it settles on its own, with no stagger.
  playOnce(next, 'anim-card-settle');
}

function buildModuleCard(spec, ctx) {
  const card = h('div', {
    class: 'tab-card stat-card stats-module', 'data-module-id': spec.id,
  });
  if (spec.kind === 'prs') buildPrsModule(card, spec, ctx);
  else buildMetricModule(card, spec, ctx);
  return card;
}

function moduleHead(spec, title, headlineEl, onConfig, openable = false) {
  return h('div', { class: 'stats-module-head' },
    editing ? h('button', {
      class: 'stats-drag-handle', type: 'button', 'aria-label': 'Reorder card',
      'data-action': 'module-drag',
    }, Icon('move')) : null,
    h('span', { class: 'stat-card-title stats-module-title', text: title }),
    headlineEl,
    // A chevron on an openable card: the affordance for "tap the card (not the
    // chart) to open the full screen".
    openable && !editing ? h('span', { class: 'stats-module-chev' }, Icon('chevron')) : null,
    h('button', {
      class: 'stats-module-btn', type: 'button', 'aria-label': 'Card options',
      'data-action': 'module-config', onclick: onConfig,
    }, Icon('dots')),
    editing ? h('button', {
      class: 'stats-module-btn stats-module-remove', type: 'button',
      'aria-label': 'Remove card', 'data-action': 'module-remove',
      onclick: () => removeModule(spec),
    }, Icon('close')) : null,
  );
}

function moduleTitle(spec, def, ctx) {
  if (spec.scope.kind === 'exercise') {
    const ex = ctx.exMap.get(spec.scope.id);
    return `${ex ? ex.name : 'Exercise'} · ${def.label}`;
  }
  if (spec.scope.kind === 'category') return `${titleCase(spec.scope.id)} · ${def.label}`;
  return def.label;
}

/**
 * The Home tab's key-stats tiles want a module's title + latest value without
 * building a chart or holding the grid's exercise-map context (Phase C2,
 * PLAN.md §"Phase C2" C2.5). Same read as loadModuleChart below — pie sums
 * categoryBreakdown, everything else takes computeSeries's last point — just
 * returned instead of painted into a live chart.
 * @param {Object} spec a kind:'metric' module spec (settings.js ModuleSpec)
 * @returns {Promise<{title: string, value: string}>}
 */
export async function moduleHeadline(spec) {
  const def = metricDef(spec.scope.kind, spec.metric);
  let title = def.label;
  if (spec.scope.kind === 'exercise') {
    const ex = await getExercise(spec.scope.id);
    title = `${ex ? ex.name : 'Exercise'} · ${def.label}`;
  } else if (spec.scope.kind === 'category') {
    title = `${titleCase(spec.scope.id)} · ${def.label}`;
  }
  let value = '—';
  try {
    if (spec.chart === 'pie' && pieAllowed(spec.scope, def.id)) {
      const { slices, unit } = await categoryBreakdown({ metric: def.id, range: spec.range, ...seriesOpts() });
      if (slices && slices.length) value = formatMetricValue(slices.reduce((a, s) => a + s.value, 0), unit);
    } else {
      const { points, unit } = await computeSeries({
        scope: spec.scope, metric: def.id, groupBy: spec.groupBy, range: spec.range, ...seriesOpts(),
      });
      if (points && points.length) value = formatMetricValue(points[points.length - 1].value, unit);
    }
  } catch (err) {
    console.error('stats: module headline failed', err);
  }
  return { title, value };
}

function buildMetricModule(card, spec, ctx) {
  const def = metricDef(spec.scope.kind, spec.metric);
  const headline = h('span', { class: 'stat-card-headline stats-module-headline', text: '—' });
  const box = h('div', { class: 'stats-chart stats-chart-mini' });
  // The chart itself is for READING: a tap there scrubs the value readout and
  // a drag scrolls the page (charts.js sets touch-action: pan-y on a static
  // chart). It must never navigate — so its clicks stop here, and the card's
  // own chrome around it is what opens the full screen.
  box.addEventListener('click', (e) => e.stopPropagation());
  const body = h('div', { class: 'stats-module-body' }, box);

  card.replaceChildren(
    moduleHead(spec, moduleTitle(spec, def, ctx), headline, () => moduleConfigSheet(spec), true),
    body,
  );
  makeCardOpenable(card, () => go(chartHash(spec.scope, def.id)));
  loadModuleChart(spec, def, box, headline, ctx.token);
}

/**
 * Tapping a card's chrome — its head, padding, the margin around the chart —
 * opens the full chart screen. Taps that landed on a control (or on the chart,
 * which stops its own clicks above) are ignored, and nothing fires in edit
 * mode, where the card belongs to the drag/remove interaction instead.
 *
 * A plain click listener is deliberate: the browser withholds click after a
 * touch that scrolled, so scrolling with a finger on the card can never open
 * anything.
 */
function makeCardOpenable(card, open) {
  card.classList.add('stats-module-openable');
  card.setAttribute('data-action', 'card-open');
  card.addEventListener('click', (e) => {
    if (editing) return;
    if (e.target.closest('button, input, a, .stats-chart')) return;
    open();
  });
}

async function loadModuleChart(spec, def, box, headlineEl, token) {
  try {
    if (spec.chart === 'pie' && pieAllowed(spec.scope, def.id)) {
      const { slices, unit } = await categoryBreakdown({
        metric: def.id, range: spec.range, ...seriesOpts(),
      });
      if (token !== renderToken) return;
      if (!slices || !slices.length) { emptyChart(box); return; }
      headlineEl.textContent = formatMetricValue(
        slices.reduce((a, s) => a + s.value, 0), unit);
      const points = slices.map((s) => ({
        t: null, label: titleCase(s.label),
        value: unit === 'kg' ? kgToDisplay(s.value) : s.value,
      }));
      track(renderChart(box, {
        type: 'pie', points, unit: chartUnit(unit), yFormat: compactNum, interactive: false,
      }), token, box);
      return;
    }

    const { points, unit } = await computeSeries({
      scope: spec.scope, metric: def.id, groupBy: spec.groupBy, range: spec.range,
      ...seriesOpts(),
    });
    if (token !== renderToken) return;
    if (!points || !points.length) { emptyChart(box); return; }
    headlineEl.textContent = formatMetricValue(points[points.length - 1].value, unit);
    const type = spec.chart === 'pie' ? 'line' : spec.chart;
    track(renderChart(box, {
      type,
      points: toChartPoints(points, unit),
      unit: chartUnit(unit),
      yFormat: compactNum,
      trend: type === 'line' && getSetting('chartTrendLine'),
      interactive: false,
    }), token, box);
  } catch (err) {
    console.error('stats: module chart failed', err);
    if (token === renderToken) emptyChart(box);
  }
}

// ---- the personal-records module (ported from the original card) -----------
function buildPrsModule(card, spec, ctx) {
  const stored = localStorage.getItem(PR_STORAGE_KEY);
  const initial = stored && ctx.exMap.has(stored) ? stored : null;

  const draw = async (id) => {
    const selected = id ? ctx.exMap.get(id) : null;
    const headline = h('span', { class: 'stat-card-headline stats-module-headline', text: '' });

    const pickerRow = h('button', {
      class: 'pr-picker-row', type: 'button', 'data-action': 'pr-pick',
      onclick: () => exercisePickSheet({
        title: 'Choose exercise',
        exercises: ctx.loggedExercises,
        current: id,
        onPick: (v) => { localStorage.setItem(PR_STORAGE_KEY, v); draw(v); },
      }),
    },
      h('span', { class: 'pr-picker-label', text: selected ? selected.name : 'Choose an exercise' }),
      h('span', { class: 'pr-picker-chev' }, Icon('chevron')),
    );

    const body = [];
    if (!selected) {
      body.push(h('p', {
        class: 'stat-empty muted',
        text: ctx.loggedExercises.length
          ? 'Pick an exercise to see its personal records.'
          : 'Log some sets to see personal records here.',
      }));
    } else {
      const { byReps, bestE1RM } = await getPRs(selected.id);
      if (!bestE1RM) {
        body.push(h('p', { class: 'stat-empty muted', text: 'No working sets logged for this exercise yet.' }));
      } else {
        headline.textContent = formatWeight(bestE1RM.value);
        body.push(h('div', { class: 'pr-headline' },
          h('span', {
            class: 'pr-headline-val',
            text: `${formatWeight(bestE1RM.weightKg)} × ${bestE1RM.reps} → e1RM ${formatWeight(bestE1RM.value)}`,
          }),
        ));
        body.push(h('div', { class: 'pr-table' },
          h('div', { class: 'pr-row pr-head' },
            h('span', { text: 'Reps' }), h('span', { text: 'Best' }), h('span', { text: 'Date' })),
          ...byReps.map((r) => h('div', { class: 'pr-row' },
            h('span', { text: String(r.reps) }),
            h('span', { text: formatWeight(r.weightKg) }),
            h('span', { text: formatDate(r.date) }),
          )),
        ));
      }
    }

    card.replaceChildren(
      moduleHead(spec, 'Personal Records', headline,
        () => prsConfigSheet(spec, ctx, id, draw)),
      ...body,
    );
  };

  // Synchronous first paint so the card exists immediately; PRs fill in after.
  card.replaceChildren(
    moduleHead(spec, 'Personal Records',
      h('span', { class: 'stat-card-headline stats-module-headline', text: '' }),
      () => prsConfigSheet(spec, ctx, initial, draw)),
    h('p', { class: 'stat-empty muted', text: 'Loading…' }),
  );
  draw(initial).catch((err) => console.error('stats: PR card failed', err));
}

function prsConfigSheet(spec, ctx, currentId, draw) {
  openSheet(h('div', {},
    sheetHeader('Personal Records', { onClose: () => closeSheet() }),
    sheetGroup(
      sheetRow({
        label: 'Choose exercise', chevron: true,
        onClick: () => {
          closeSheet();
          exercisePickSheet({
            title: 'Choose exercise', exercises: ctx.loggedExercises, current: currentId,
            onPick: (v) => { localStorage.setItem(PR_STORAGE_KEY, v); draw(v); },
          });
        },
      }),
      sheetRow({
        label: 'Remove card', danger: true, action: 'module-remove',
        onClick: () => { closeSheet(); removeModule(spec); },
      }),
    ),
  ));
}

// ---- per-card configuration ------------------------------------------------
function moduleConfigSheet(spec) {
  const defs = metricsFor(spec.scope.kind);
  const def = metricDef(spec.scope.kind, spec.metric);
  const isPie = spec.chart === 'pie';

  const chartOptions = CHART_TYPES.filter((t) => t.value !== 'pie' || pieAllowed(spec.scope, def.id));
  const chartLabel = (CHART_TYPES.find((t) => t.value === spec.chart) || CHART_TYPES[0]).label;
  const groupLabel = (GROUP_OPTIONS.find((g) => g.value === spec.groupBy) || GROUP_OPTIONS[1]).label;
  const rangeLabel = (RANGE_OPTIONS.find((r) => r.value === spec.range) || RANGE_OPTIONS[0]).label;

  openSheet(h('div', {},
    sheetHeader('Card options', { onClose: () => closeSheet() }),
    sheetGroup(
      sheetRow({
        label: 'Metric', value: def.label, chevron: true,
        onClick: () => {
          closeSheet();
          optionSheet({
            title: 'Metric',
            options: defs.map((m) => ({ value: m.id, label: m.label })),
            current: def.id,
            onPick: (v) => patchModule(spec.id, {
              metric: v,
              chart: pieAllowed(spec.scope, v) ? spec.chart : (spec.chart === 'pie' ? 'line' : spec.chart),
            }),
          });
        },
      }),
      sheetRow({
        label: 'Chart type', value: chartLabel, chevron: true,
        onClick: () => {
          closeSheet();
          optionSheet({
            title: 'Chart type', options: chartOptions, current: spec.chart,
            onPick: (v) => patchModule(spec.id, { chart: v }),
          });
        },
      }),
      isPie ? null : sheetRow({
        label: 'Group by', value: groupLabel, chevron: true,
        onClick: () => {
          closeSheet();
          optionSheet({
            title: 'Group by', options: GROUP_OPTIONS, current: spec.groupBy,
            onPick: (v) => patchModule(spec.id, { groupBy: v }),
          });
        },
      }),
      sheetRow({
        label: 'Range', value: rangeLabel, chevron: true,
        onClick: () => {
          closeSheet();
          optionSheet({
            title: 'Range', options: RANGE_OPTIONS, current: spec.range,
            onPick: (v) => patchModule(spec.id, { range: v }),
          });
        },
      }),
    ),
    sheetGroup(
      sheetRow({
        label: 'Open full chart', chevron: true, action: 'module-open',
        onClick: () => { closeSheet(); go(chartHash(spec.scope, def.id)); },
      }),
      sheetRow({
        label: 'Remove card', danger: true, action: 'module-remove',
        onClick: () => { closeSheet(); removeModule(spec); },
      }),
    ),
  ));
}

function patchModule(id, patch) {
  const layout = getStatsLayout().map((m) => (m.id === id ? { ...m, ...patch } : m));
  setStatsLayout(layout);
  refreshModule(id);
}

function removeModule(spec) {
  confirmSheet({
    title: 'Remove card?',
    message: 'It can be added again from Edit.',
    confirmLabel: 'Remove', danger: true,
    onConfirm: async () => {
      // Collapse the card, glide the survivors up into the gap, and only then
      // re-render. Without the FLIP the remaining cards would jump.
      const screen = document.getElementById('s-stats');
      const grid = screen && screen.querySelector('.stats-grid');
      const card = grid && grid.querySelector(`[data-module-id="${CSS.escape(spec.id)}"]`);
      setStatsLayout(getStatsLayout().filter((m) => m.id !== spec.id));
      if (card && grid) {
        const survivors = [...grid.children].filter((el) => el !== card);
        await playOut(card, 'anim-card-out');
        flip(survivors, () => card.remove());
      }
      rerenderGrid();
    },
  });
}

// ---- add card --------------------------------------------------------------
function addCardSheet() {
  openSheet(h('div', {},
    sheetHeader('Add card', { onClose: () => closeSheet() }),
    sheetGroup(
      sheetRow({
        label: 'Overall', sub: 'Whole training history', chevron: true,
        onClick: () => { closeSheet(); pickMetricThenAdd({ kind: 'overall' }); },
      }),
      sheetRow({
        label: 'Exercise…', sub: 'One exercise over time', chevron: true,
        onClick: async () => {
          closeSheet();
          const { loggedExercises } = await loadIndex();
          exercisePickSheet({
            title: 'Choose exercise', exercises: loggedExercises, current: null,
            onPick: (id) => pickMetricThenAdd({ kind: 'exercise', id }),
          });
        },
      }),
      sheetRow({
        label: 'Category…', sub: 'One muscle group over time', chevron: true,
        onClick: async () => {
          closeSheet();
          const { loggedGroups } = await loadIndex();
          const groups = loggedGroups.length ? loggedGroups : MUSCLE_GROUPS;
          optionSheet({
            title: 'Choose category',
            options: groups.map((g) => ({ value: g, label: titleCase(g) })),
            current: null,
            onPick: (id) => pickMetricThenAdd({ kind: 'category', id }),
          });
        },
      }),
      sheetRow({
        label: 'Personal records', sub: 'The exercise PR table', chevron: true,
        onClick: () => { closeSheet(); addModule({ id: uid(), kind: 'prs' }); },
      }),
    ),
    sheetGroup(
      sheetRow({
        label: 'Reset layout', danger: true, action: 'stats-reset',
        onClick: () => {
          closeSheet();
          confirmSheet({
            title: 'Reset layout?',
            message: 'The Statistics grid returns to its default cards.',
            confirmLabel: 'Reset', danger: true,
            onConfirm: () => {
              resetStatsLayout();
              rerenderGrid();
            },
          });
        },
      }),
    ),
  ));
}

function pickMetricThenAdd(scope) {
  const defs = metricsFor(scope.kind);
  optionSheet({
    title: 'Choose metric',
    options: defs.map((m) => ({ value: m.id, label: m.label })),
    current: null,
    onPick: (metric) => {
      const def = metricDef(scope.kind, metric);
      addModule({
        id: uid(), kind: 'metric', scope, metric: def.id,
        chart: def.agg === 'count' ? 'bar' : 'line',
        groupBy: 'week', range: '3m',
      });
    },
  });
}

function addModule(spec) {
  setStatsLayout([...getStatsLayout(), spec]);
  rerenderGrid();
}

/** A searchable exercise list in a bottom sheet. */
function exercisePickSheet({ title, exercises, current, onPick }) {
  const group = h('div', { class: 'sheet-group' });
  const input = h('input', {
    class: 'sheet-input', type: 'search', 'aria-label': 'Search exercises',
    placeholder: 'Search exercises',
  });
  const fill = () => {
    const q = input.value.trim().toLowerCase();
    const items = (exercises || []).filter((e) => !q || e.name.toLowerCase().includes(q));
    group.replaceChildren(...(items.length
      ? items.slice(0, 80).map((e) => sheetRow({
          label: e.name, sub: titleCase(e.muscleGroup),
          value: current === e.id ? '✓' : null,
          onClick: () => { closeSheet(); onPick(e.id); },
        }))
      : [h('p', { class: 'sheet-message muted', text: exercises && exercises.length ? 'No matches.' : 'Nothing logged yet.' })]));
  };
  input.addEventListener('input', fill);
  fill();
  openSheet(h('div', {},
    sheetHeader(title, { onClose: () => closeSheet() }),
    h('div', { class: 'sheet-group' }, h('div', { class: 'sheet-input-row' }, input)),
    group,
  ));
}

// ============================================================================
// Drag and drop reordering (pointer events + FLIP).
//
// State machine:
//   idle -> pointerdown on .stats-drag-handle -> dragging -> pointerup/cancel -> idle
//
// While dragging, the card is transformed (never re-laid-out): its translateY is
// derived from layout coordinates only —
//     translate = (startOffsetTop + pointerDelta + scrollDelta) - card.offsetTop
// offsetTop is immune to transforms, so the sum stays exact even after the card
// is moved in the DOM. Siblings animate with FLIP: measure their rects, mutate
// the DOM, apply the inverted delta with transitions off, then transition to
// identity. Measuring mid-flight is intentional — a new FLIP continues from
// wherever the sibling currently is, so chained swaps stay smooth.
// ============================================================================
function bindDragAndDrop(grid) {
  for (const handle of grid.querySelectorAll('.stats-drag-handle')) {
    handle.addEventListener('pointerdown', (e) => startDrag(e, grid));
  }
}

/** Clamp a tilt angle symmetrically; NaN-safe (a stray velocity means level). */
function clampTilt(deg, max) {
  if (!Number.isFinite(deg)) return 0;
  return deg < -max ? -max : deg > max ? max : deg;
}

function startDrag(e, grid) {
  if (e.button != null && e.button > 0) return;
  const handle = e.currentTarget;
  const card = handle.closest('.stats-module');
  if (!card) return;
  e.preventDefault();

  const cards = () => [...grid.children].filter((el) => el.classList.contains('stats-module'));
  const startOffsetTop = card.offsetTop;
  const startPointerY = e.clientY;
  const startScrollY = window.scrollY;
  let pointerY = e.clientY;
  let translateY = 0;
  let active = true;
  let scrollRAF = null;

  card.classList.add('dragging');
  grid.classList.add('stats-grid-dragging');
  document.body.classList.add('stats-dragging');
  // Capture on the GRID, not the handle: reordering runs insertBefore on the
  // card, and that momentary disconnect would strip capture from anything
  // inside it — the drag would freeze at the first swap. The grid never moves.
  try { grid.setPointerCapture(e.pointerId); } catch (err) { /* mouse w/o capture */ }

  // Carry physics: the card leans into its own motion. Velocity is smoothed
  // from successive pointer deltas (raw per-frame deltas jitter badly) and the
  // tilt is clamped hard — past ~2deg it stops reading as weight and starts
  // reading as a bug. Computed inside the existing update path; no second loop.
  let velocity = 0;
  let lastPointerY = e.clientY;
  const MAX_TILT = 2;

  const applyTransform = () => {
    const wanted = startOffsetTop + (pointerY - startPointerY) + (window.scrollY - startScrollY);
    translateY = Math.round(wanted - card.offsetTop);
    const tilt = motionOK() ? clampTilt(velocity * 0.06, MAX_TILT) : 0;
    card.style.transform = `translateY(${translateY}px) scale(1.03) rotate(${tilt}deg)`;
  };

  const flip = (mutate) => {
    const others = cards().filter((el) => el !== card);
    const first = others.map((el) => [el, el.getBoundingClientRect().top]);
    mutate();
    const moved = [];
    for (const [el, top] of first) {
      const dy = top - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      moved.push(el);
    }
    if (!moved.length) return;
    void grid.offsetHeight; // flush the inverted state before transitioning back
    requestAnimationFrame(() => {
      for (const el of moved) {
        el.style.transition = 'transform 180ms ease';
        el.style.transform = '';
      }
    });
  };

  const maybeReorder = () => {
    const list = cards();
    if (list.length < 2) return;
    const midY = card.offsetTop + translateY + card.offsetHeight / 2;
    const siblings = list.filter((el) => el !== card);
    const target = siblings.find((el) => midY < el.offsetTop + el.offsetHeight / 2) || null;
    const currentNext = list[list.indexOf(card) + 1] || null;
    if (target === currentNext) return;
    flip(() => {
      if (target) grid.insertBefore(card, target);
      else {
        const last = siblings[siblings.length - 1];
        last.after(card);
      }
    });
    applyTransform();
  };

  const update = () => { applyTransform(); maybeReorder(); };

  const EDGE = 92;
  const autoScroll = () => {
    if (!active) return;
    const vh = window.innerHeight;
    let speed = 0;
    if (pointerY < EDGE) speed = -Math.min(18, Math.ceil((EDGE - pointerY) / 5));
    else if (pointerY > vh - EDGE) speed = Math.min(18, Math.ceil((pointerY - (vh - EDGE)) / 5));
    if (speed) {
      const before = window.scrollY;
      window.scrollBy(0, speed);
      if (window.scrollY !== before) update();
    }
    scrollRAF = requestAnimationFrame(autoScroll);
  };

  const onMove = (ev) => {
    if (!active || ev.pointerId !== e.pointerId) return;
    pointerY = ev.clientY;
    // Exponential smoothing: mostly history, a little of the new delta.
    velocity = velocity * 0.7 + (pointerY - lastPointerY) * 0.3;
    lastPointerY = pointerY;
    update();
  };

  const finish = (ev) => {
    if (!active) return;
    if (ev && ev.pointerId !== undefined && ev.pointerId !== e.pointerId) return;
    active = false;
    if (scrollRAF) cancelAnimationFrame(scrollRAF);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    try { grid.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }

    // Drop: the card springs into its slot on the house curve rather than
    // easing flatly into it. springHome sets the final (empty) transform
    // immediately and animates FROM the lifted one, so the DOM is correct even
    // if the animation is skipped or cut short.
    const clear = () => {
      if (cleared) return;
      cleared = true;
      card.style.transition = '';
      card.style.transform = '';
      card.classList.remove('dragging');
      grid.classList.remove('stats-grid-dragging');
      document.body.classList.remove('stats-dragging');
    };
    let cleared = false;
    const from = card.style.transform || `translateY(${translateY}px) scale(1.03)`;
    const anim = springHome(card, from, { duration: 420 });
    if (anim && anim.finished) anim.finished.then(clear).catch(clear);
    setTimeout(clear, 460); // fallback: WAAPI unsupported, or the tab is hidden

    const order = cards().map((el) => el.dataset.moduleId);
    const layout = getStatsLayout();
    const byId = new Map(layout.map((m) => [m.id, m]));
    const next = order.map((id) => byId.get(id)).filter(Boolean);
    for (const m of layout) if (!order.includes(m.id)) next.push(m);
    setStatsLayout(next);
  };

  // Window-level listeners: they hear the pointer wherever capture routes it —
  // including after a card reorder — and are removed in finish().
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  applyTransform();
  scrollRAF = requestAnimationFrame(autoScroll);
}

// ============================================================================
// Health section (native shell only — absent entirely in the PWA). Sits below
// "Overall Statistics" on the grid screen; not part of the customisable
// layout, so it carries no module chrome (drag handle, remove, config sheet).
// ============================================================================
/** "7:32" — hours:minutes, matching mmss()'s look for a duration. */
function hmm(totalSeconds) {
  const mins = Math.max(0, Math.round((totalSeconds || 0) / 60));
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}
function shortDayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function healthMetricCard(title, value, atIso) {
  return h('div', { class: 'tab-card stat-card health-metric-card' },
    h('div', { class: 'stats-module-head' },
      h('span', { class: 'stat-card-title stats-module-title', text: title }),
      h('span', { class: 'stat-card-headline stats-module-headline', text: value }),
    ),
    atIso ? h('p', { class: 'health-metric-sub muted', text: formatDate(atIso) }) : null,
  );
}

function weightCard(weight, token) {
  const box = h('div', { class: 'stats-chart stats-chart-mini' });
  const card = h('div', { class: 'tab-card stat-card health-metric-card' },
    h('div', { class: 'stats-module-head' },
      h('span', { class: 'stat-card-title stats-module-title', text: 'Weight' }),
      h('span', { class: 'stat-card-headline stats-module-headline', text: formatWeight(weight.latestKg) }),
    ),
    h('div', { class: 'stats-module-body' }, box),
  );

  const trend = (weight.trend || [])
    .slice()
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .map((p) => ({ t: new Date(p.at).getTime(), label: shortDayLabel(p.at), value: kgToDisplay(p.kg) }));

  if (trend.length) {
    track(renderChart(box, {
      type: 'line', points: trend, unit: getUnits(), yFormat: compactNum, interactive: false,
    }), token, box);
  } else {
    emptyChart(box, 'No data found — check Settings → Health → Data Access on your iPhone.');
  }
  return card;
}

function sleepCard(sleep) {
  const asleep = hmm(sleep.totalAsleepSeconds);
  const breakdown = `Deep ${hmm(sleep.deepSeconds)} · REM ${hmm(sleep.remSeconds)} · Core ${hmm(sleep.coreSeconds)}`;
  return h('div', { class: 'tab-card stat-card health-metric-card' },
    h('div', { class: 'stats-module-head' },
      h('span', { class: 'stat-card-title stats-module-title', text: 'Sleep Last Night' }),
      h('span', { class: 'stat-card-headline stats-module-headline', text: asleep }),
    ),
    h('p', { class: 'health-metric-sub muted', text: breakdown }),
  );
}

/** Builds the health cards for whatever fields are non-null; empty array when
 * there is nothing to show (the caller omits the section entirely). */
function healthCardsFor(summary, token) {
  if (!summary) return [];
  const cards = [];
  if (summary.weight) cards.push(weightCard(summary.weight, token));
  if (summary.restingHr) cards.push(healthMetricCard('Resting Heart Rate', `${Math.round(summary.restingHr.bpm)} bpm`, summary.restingHr.at));
  if (summary.hrv) cards.push(healthMetricCard('Heart Rate Variability', `${Math.round(summary.hrv.ms)} ms`, summary.hrv.at));
  if (summary.sleepLastNight) cards.push(sleepCard(summary.sleepLastNight));
  if (summary.vo2max) cards.push(healthMetricCard('VO₂max', `${trimNum(summary.vo2max.value)} mL/kg/min`, summary.vo2max.at));
  if (summary.activeEnergyToday) {
    cards.push(healthMetricCard('Active Energy Today', `${Math.round(summary.activeEnergyToday.kcal).toLocaleString('en-GB')} kcal`, null));
  }
  return cards;
}

async function buildHealthSection(token) {
  if (!healthAvailable()) return null;
  let summary = null;
  try { summary = await getHealthSummary(); } catch (err) { console.error('stats: health summary failed', err); }
  if (token !== renderToken) return null;
  const cards = healthCardsFor(summary, token);
  if (!cards.length) return null;
  return h('div', { class: 'health-section' },
    h('div', { class: 'stats-section-label', text: 'Health' }),
    ...cards,
  );
}

/** Rebuilds the Health section in place on a health.js update event. Adds or
 * removes the whole section as data appears/disappears; otherwise only its
 * own charts are torn down first, never the grid's. */
async function refreshHealthSection() {
  const screen = document.getElementById('s-stats');
  const wrap = screen && screen.querySelector('.tab-screen');
  if (!wrap) return; // a sub-route is showing, or the screen moved on
  const existing = wrap.querySelector('.health-section');
  let summary = null;
  try { summary = await getHealthSummary(); } catch (err) { console.error('stats: health summary refresh failed', err); }
  const cards = healthCardsFor(summary, renderToken);
  if (!cards.length) {
    if (existing) { destroyChartsIn(existing); existing.remove(); }
    return;
  }
  if (existing) {
    destroyChartsIn(existing);
    existing.replaceChildren(h('div', { class: 'stats-section-label', text: 'Health' }), ...cards);
  } else {
    wrap.append(h('div', { class: 'health-section' },
      h('div', { class: 'stats-section-label', text: 'Health' }), ...cards));
  }
}

// ============================================================================
// 3. Exercises list (#/stats/exercises)
// ============================================================================
async function renderExerciseList(screen) {
  const { loggedExercises } = await loadIndex();
  const list = h('div', { class: 'tab-card stats-nav-card' });
  const input = h('input', {
    class: 'pick-search', type: 'search', 'aria-label': 'Search', placeholder: 'Search Exercises',
  });

  const fill = () => {
    const q = input.value.trim().toLowerCase();
    const items = loggedExercises.filter((e) => !q || e.name.toLowerCase().includes(q));
    list.replaceChildren(...(items.length
      ? items.map((e) => navRow({
          label: e.name, sub: titleCase(e.muscleGroup),
          attrs: { 'data-exercise-id': e.id },
          onClick: () => go(`#/stats/exercise/${e.id}`),
        }))
      : [h('p', { class: 'stat-empty muted', text: loggedExercises.length ? 'No matches.' : 'Nothing logged yet.' })]));
  };
  input.addEventListener('input', fill);
  fill();

  screen.replaceChildren(h('div', { class: 'stats-screen' },
    backHeader('Exercises', '#/stats'),
    h('div', { class: 'pick-search-wrap' }, Icon('search'), input),
    h('div', { class: 'stats-body' }, list),
  ));
}

// ============================================================================
// 4. Per-exercise metric list (#/stats/exercise/:id)
// ============================================================================
async function renderExerciseDetail(screen, exerciseId) {
  const exercise = await getExercise(exerciseId);
  if (!exercise) { go('#/stats/exercises'); return; }

  const rows = EXERCISE_METRICS.map((m) => navRow({
    label: m.label,
    attrs: { 'data-metric': m.id },
    onClick: () => go(`#/stats/exercise/${exerciseId}/chart/${m.id}`),
  }));
  rows.push(navRow({
    label: 'Personal Records', attrs: { 'data-stat-nav': 'prs' },
    onClick: () => exercisePrSheet(exercise),
  }));
  rows.push(navRow({
    label: 'History', attrs: { 'data-stat-nav': 'history' },
    onClick: () => exerciseHistorySheet(exercise),
  }));

  screen.replaceChildren(h('div', { class: 'stats-screen' },
    backHeader(exercise.name, '#/stats/exercises'),
    h('div', { class: 'stats-body' }, h('div', { class: 'tab-card stats-nav-card' }, ...rows)),
  ));
}

async function exercisePrSheet(exercise) {
  const { byReps, bestE1RM } = await getPRs(exercise.id);
  const body = [sheetHeader(exercise.name, { onClose: () => closeSheet() })];
  if (!bestE1RM) {
    body.push(h('p', { class: 'sheet-message muted', text: 'No working sets logged yet.' }));
  } else {
    body.push(h('div', { class: 'pr-best' },
      h('div', { class: 'pr-best-label', text: 'Best estimated 1RM' }),
      h('div', { class: 'pr-best-val', text: formatWeight(bestE1RM.value) }),
      h('div', {
        class: 'pr-best-sub',
        text: `${formatWeight(bestE1RM.weightKg)} × ${bestE1RM.reps} · ${formatDate(bestE1RM.date)}`,
      }),
    ));
    body.push(h('div', { class: 'pr-table' },
      h('div', { class: 'pr-row pr-head' },
        h('span', { text: 'Reps' }), h('span', { text: 'Best' }), h('span', { text: 'Date' })),
      ...byReps.map((r) => h('div', { class: 'pr-row' },
        h('span', { text: String(r.reps) }),
        h('span', { text: formatWeight(r.weightKg) }),
        h('span', { text: formatDate(r.date) }),
      )),
    ));
  }
  openSheet(h('div', {}, ...body));
}

/** One line per set: "60 kg × 8", "12 reps", "5:00 · 1,200 m". */
function setSummary(s) {
  const parts = [];
  if (s.reps) parts.push(s.weightKg ? `${formatWeight(s.weightKg)} × ${s.reps}` : `${s.reps} reps`);
  else if (s.weightKg) parts.push(formatWeight(s.weightKg));
  if (s.durationSeconds) parts.push(mmss(s.durationSeconds));
  if (s.distanceM) parts.push(`${Math.round(s.distanceM).toLocaleString('en-GB')} m`);
  if (s.kcal) parts.push(`${Math.round(s.kcal).toLocaleString('en-GB')} kcal`);
  return parts.length ? parts.join(' · ') : '—';
}

async function exerciseHistorySheet(exercise) {
  const sets = await listSetsForExercise(exercise.id);
  const byWorkout = new Map();
  for (const s of sets) {
    if (!byWorkout.has(s.workoutId)) byWorkout.set(s.workoutId, []);
    byWorkout.get(s.workoutId).push(s);
  }
  const workouts = (await Promise.all([...byWorkout.keys()].map((id) => getWorkout(id))))
    .filter((w) => w && w.finishedAt)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.startedAt < b.startedAt ? 1 : -1)))
    .slice(0, 5);

  const body = [sheetHeader(exercise.name, { onClose: () => closeSheet() })];
  if (!workouts.length) {
    body.push(h('p', { class: 'sheet-message muted', text: 'No previous sessions yet.' }));
  }
  for (const w of workouts) {
    const wSets = byWorkout.get(w.id).slice().sort((a, b) => a.setNumber - b.setNumber);
    body.push(h('div', { class: 'sheet-history' },
      h('div', { class: 'sheet-history-date', text: formatDate(w.date) }),
      ...wSets.map((s) => h('div', { class: 'sheet-history-set' },
        h('span', { class: 'shs-badge', text: s.isWarmup ? 'W' : String(s.setNumber) }),
        h('span', { text: setSummary(s) }),
      )),
    ));
  }
  openSheet(h('div', {}, ...body));
}

// ============================================================================
// 5. Categories (#/stats/categories, #/stats/category/:group)
// ============================================================================
async function renderCategoryList(screen) {
  const { loggedGroups } = await loadIndex();
  const rows = loggedGroups.length
    ? loggedGroups.map((g) => navRow({
        label: titleCase(g),
        attrs: { 'data-group': g },
        onClick: () => go(`#/stats/category/${g}`),
      }))
    : [h('p', { class: 'stat-empty muted', text: 'Nothing logged yet.' })];

  screen.replaceChildren(h('div', { class: 'stats-screen' },
    backHeader('Categories', '#/stats'),
    h('div', { class: 'stats-body' }, h('div', { class: 'tab-card stats-nav-card' }, ...rows)),
  ));
}

async function renderCategoryDetail(screen, group) {
  if (!MUSCLE_GROUPS.includes(group)) { go('#/stats/categories'); return; }
  const rows = CATEGORY_METRICS.map((m) => navRow({
    label: m.label,
    attrs: { 'data-metric': m.id },
    onClick: () => go(`#/stats/category/${group}/chart/${m.id}`),
  }));
  screen.replaceChildren(h('div', { class: 'stats-screen' },
    backHeader(titleCase(group), '#/stats/categories'),
    h('div', { class: 'stats-body' }, h('div', { class: 'tab-card stats-nav-card' }, ...rows)),
  ));
}

// ============================================================================
// 6. Chart detail screens
// ============================================================================
function prefsKey(scopeKind) {
  return `${CHART_PREFS_KEY}.${scopeKind}`;
}
function readPrefs(scopeKind, metricId) {
  try {
    const raw = localStorage.getItem(prefsKey(scopeKind));
    const all = raw ? JSON.parse(raw) : null;
    const p = all && typeof all === 'object' ? all[metricId] : null;
    if (!p || typeof p !== 'object') return null;
    return p;
  } catch (err) {
    return null;
  }
}
function writePrefs(scopeKind, metricId, prefs) {
  try {
    const raw = localStorage.getItem(prefsKey(scopeKind));
    const all = raw ? JSON.parse(raw) : {};
    const next = all && typeof all === 'object' ? all : {};
    next[metricId] = prefs;
    localStorage.setItem(prefsKey(scopeKind), JSON.stringify(next));
  } catch (err) { /* private mode — prefs are a nicety */ }
}

async function renderChartScreen(screen, scope, metricId, token) {
  const defs = metricsFor(scope.kind);
  const def = defs.find((m) => m.id === metricId) || defs[0];

  let title = def.label;
  let backHash = '#/stats';
  if (scope.kind === 'exercise') {
    const ex = await getExercise(scope.id);
    if (!ex) { go('#/stats/exercises'); return; }
    title = ex.name;
    backHash = `#/stats/exercise/${scope.id}`;
  } else if (scope.kind === 'category') {
    if (!MUSCLE_GROUPS.includes(scope.id)) { go('#/stats/categories'); return; }
    title = titleCase(scope.id);
    backHash = `#/stats/category/${scope.id}`;
  }
  if (token !== renderToken) return;

  const saved = readPrefs(scope.kind, def.id) || {};
  const state = {
    metric: def.id,
    groupBy: GROUP_OPTIONS.some((g) => g.value === saved.groupBy) ? saved.groupBy : 'week',
    range: RANGE_OPTIONS.some((r) => r.value === saved.range) ? saved.range : '6m',
    chart: CHART_TYPES.some((c) => c.value === saved.chart) ? saved.chart : 'line',
    horizontal: saved.horizontal === true,
  };
  if (state.chart === 'pie' && !pieAllowed(scope, state.metric)) state.chart = 'line';

  // ---- controls ----
  const metricValue = h('span', { class: 'chart-select-value', text: def.label });
  const groupValue = h('span', {
    class: 'chart-select-value',
    text: (GROUP_OPTIONS.find((g) => g.value === state.groupBy) || GROUP_OPTIONS[1]).label,
  });

  const metricSelect = h('div', { class: 'chart-select-wrap' },
    h('span', { class: 'chart-select-label', text: 'Chart' }),
    h('button', {
      class: 'chart-select', type: 'button', 'data-action': 'chart-metric',
      onclick: () => optionSheet({
        title: 'Chart',
        options: defs.map((m) => ({ value: m.id, label: m.label })),
        current: state.metric,
        onPick: (v) => { go(chartHash(scope, v)); },
      }),
    }, metricValue, h('span', { class: 'chart-select-chev' }, Icon('down'))),
  );

  const groupSelect = h('div', { class: 'chart-select-wrap' },
    h('span', { class: 'chart-select-label', text: 'Group By' }),
    h('button', {
      class: 'chart-select', type: 'button', 'data-action': 'chart-groupby',
      onclick: () => optionSheet({
        title: 'Group By', options: GROUP_OPTIONS, current: state.groupBy,
        onPick: (v) => { state.groupBy = v; groupValue.textContent = (GROUP_OPTIONS.find((g) => g.value === v) || GROUP_OPTIONS[1]).label; persist(); draw(); },
      }),
    }, groupValue, h('span', { class: 'chart-select-chev' }, Icon('down'))),
  );

  // The active range is marked by ONE indicator that slides between the pills
  // rather than a background that cuts from button to button. The pills are
  // equal-width (flex: 1), so the indicator is a fraction of the row and moves
  // by whole multiples of itself — transform only, no layout.
  const rangeIndicator = h('span', { class: 'seg-indicator', 'aria-hidden': 'true' });
  const moveIndicator = () => {
    const i = Math.max(0, RANGE_OPTIONS.findIndex((r) => r.value === state.range));
    rangeIndicator.style.setProperty('--seg-index', String(i));
  };
  const rangeButtons = RANGE_OPTIONS.map((r) => h('button', {
    class: 'seg-btn' + (state.range === r.value ? ' on' : ''),
    type: 'button', 'data-range': r.value,
    onclick: () => {
      state.range = r.value;
      for (const b of rangeButtons) b.classList.toggle('on', b.dataset.range === r.value);
      moveIndicator();
      persist(); draw();
    },
  }, r.label));
  const rangeRow = h('div', {
    class: 'seg-toggle chart-ranges',
    style: `--seg-count:${RANGE_OPTIONS.length}`,
  }, rangeIndicator, ...rangeButtons);
  moveIndicator();

  const typeOptions = CHART_TYPES.filter((t) => t.value !== 'pie' || pieAllowed(scope, state.metric));
  const typeButtons = typeOptions.map((t) => h('button', {
    class: 'seg-btn' + (state.chart === t.value ? ' on' : ''),
    type: 'button', 'data-chart-type': t.value,
    onclick: () => {
      state.chart = t.value;
      for (const b of typeButtons) b.classList.toggle('on', b.dataset.chartType === t.value);
      syncControls(); persist(); draw();
    },
  }, t.label));
  const typeRow = h('div', { class: 'seg-toggle chart-type-row' }, ...typeButtons);

  const axisBtn = h('button', {
    class: 'chart-axis-btn', type: 'button', 'data-action': 'chart-axis',
    onclick: () => { state.horizontal = !state.horizontal; syncControls(); persist(); draw(); },
  }, Icon('swap'), h('span', { text: 'Flip axis' }));

  const box = h('div', { class: 'stats-chart chart-detail' });

  const syncControls = () => {
    groupSelect.hidden = state.chart === 'pie';
    axisBtn.hidden = state.chart !== 'bar';
    axisBtn.classList.toggle('on', state.horizontal);
  };
  const persist = () => writePrefs(scope.kind, state.metric, {
    groupBy: state.groupBy, range: state.range, chart: state.chart, horizontal: state.horizontal,
  });

  let handle = null;
  const draw = async () => {
    const myToken = token;
    try {
      let spec;
      if (state.chart === 'pie' && pieAllowed(scope, state.metric)) {
        const { slices, unit } = await categoryBreakdown({
          metric: state.metric, range: state.range, ...seriesOpts(),
        });
        if (myToken !== renderToken) return;
        if (!slices || !slices.length) { dropChart(); emptyChart(box); return; }
        spec = {
          type: 'pie',
          points: slices.map((s) => ({
            t: null, label: titleCase(s.label),
            value: unit === 'kg' ? kgToDisplay(s.value) : s.value,
          })),
          unit: chartUnit(unit), yFormat: compactNum, interactive: false,
        };
      } else {
        const { points, unit } = await computeSeries({
          scope, metric: state.metric, groupBy: state.groupBy, range: state.range,
          ...seriesOpts(),
        });
        if (myToken !== renderToken) return;
        if (!points || !points.length) { dropChart(); emptyChart(box); return; }
        spec = {
          type: state.chart === 'pie' ? 'line' : state.chart,
          points: toChartPoints(points, unit),
          unit: chartUnit(unit),
          yFormat: compactNum,
          trend: state.chart === 'line' && getSetting('chartTrendLine'),
          horizontal: state.chart === 'bar' && state.horizontal,
          interactive: true,
        };
      }
      if (handle) {
        handle.update(spec);
      } else {
        box.replaceChildren();
        handle = renderChart(box, spec);
        track(handle, myToken, box);
      }
    } catch (err) {
      console.error('stats: chart failed', err);
      dropChart();
      emptyChart(box, 'Nothing logged yet.');
    }
  };
  const dropChart = () => {
    if (!handle) return;
    const idx = liveCharts.findIndex((c) => c.handle === handle);
    if (idx >= 0) liveCharts.splice(idx, 1);
    try { handle.destroy(); } catch (err) { /* ignore */ }
    handle = null;
  };

  syncControls();
  destroyCharts();
  screen.replaceChildren(h('div', { class: 'stats-screen chart-screen' },
    backHeader(title, backHash),
    h('div', { class: 'stats-body' },
      h('div', { class: 'chart-selectors' }, metricSelect, groupSelect),
      rangeRow,
    ),
    box,
    h('div', { class: 'stats-body chart-controls' }, typeRow, axisBtn),
  ));
  await draw();
}
