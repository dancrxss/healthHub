// ============================================================================
// settings.js — central client settings store (localStorage-backed, typed
// defaults) plus the persisted layout of the customisable Statistics page.
// Pure module: no DOM, no IndexedDB. Every consumer reads through here so a
// default lives in exactly one place.
//
// Display units and the default rest duration keep their legacy storage keys
// ('settings.units' via ui.js helpers, 'settings.restSeconds' via timer.js) —
// this module only owns the NEW keys.
// ============================================================================

/**
 * Definitions for every boolean/enum setting: storage key + default.
 * getSetting/setSetting validate against this table.
 */
export const SETTING_DEFS = {
  // Workout log
  autofillWeight: { key: 'settings.autofillWeight', default: true },
  autoStartTimer: { key: 'settings.autoStartTimer', default: true },
  timerSound: { key: 'settings.timerSound', default: false },
  keepScreenOn: { key: 'settings.keepScreenOn', default: false },
  // Charts / statistics
  chartTrendLine: { key: 'settings.chart.trendLine', default: true },
  chartIncludeWarmup: { key: 'settings.chart.includeWarmup', default: false },
  countUnilateralTwice: { key: 'settings.countUnilateralTwice', default: false },
};

/** @param {keyof typeof SETTING_DEFS} name */
export function getSetting(name) {
  const def = SETTING_DEFS[name];
  if (!def) throw new Error(`unknown setting: ${name}`);
  const raw = localStorage.getItem(def.key);
  if (raw === null) return def.default;
  return raw === 'true';
}

/** @param {keyof typeof SETTING_DEFS} name @param {boolean} value */
export function setSetting(name, value) {
  const def = SETTING_DEFS[name];
  if (!def) throw new Error(`unknown setting: ${name}`);
  localStorage.setItem(def.key, value ? 'true' : 'false');
}

// ----------------------------------------------------------------------------
// String settings. Kept apart from SETTING_DEFS on purpose: getSetting() parses
// `raw === 'true'`, so a string routed through it silently reads as false.
// The Coach API key lives here (localStorage, synchronous) because route()
// must decide tab visibility without an async IndexedDB read. It is never
// logged and never sent anywhere except as the x-api-key header to Anthropic.
// ----------------------------------------------------------------------------

export const STRING_SETTING_DEFS = {
  coachApiKey: { key: 'coach.apiKey', default: '' },
};

/** @param {keyof typeof STRING_SETTING_DEFS} name @returns {string} */
export function getStringSetting(name) {
  const def = STRING_SETTING_DEFS[name];
  if (!def) throw new Error(`unknown string setting: ${name}`);
  try {
    const raw = localStorage.getItem(def.key);
    return raw === null ? def.default : raw;
  } catch {
    return def.default; // storage blocked (private mode) — behave as unset
  }
}

/** @param {keyof typeof STRING_SETTING_DEFS} name @param {string} value empty string clears */
export function setStringSetting(name, value) {
  const def = STRING_SETTING_DEFS[name];
  if (!def) throw new Error(`unknown string setting: ${name}`);
  const v = typeof value === 'string' ? value.trim() : '';
  if (v === '') localStorage.removeItem(def.key);
  else localStorage.setItem(def.key, v);
}

// ----------------------------------------------------------------------------
// Statistics page layout — the ordered list of module cards on #/stats.
//
// ModuleSpec:
//   {string} id       stable per card (uid-ish; defaults use 'default-*')
//   {'metric'|'prs'} kind   'prs' is the special personal-records picker card
//   For kind 'metric':
//   {{kind:'overall'|'exercise'|'category', id?:string}} scope
//       exercise scope: id = exerciseId; category scope: id = muscleGroup
//   {string} metric   a stats-data.js metric id valid for the scope
//   {'line'|'bar'|'pie'} chart
//   {'day'|'week'|'month'|'year'} groupBy
//   {'3m'|'6m'|'1y'|'all'} range
// ----------------------------------------------------------------------------

const LAYOUT_KEY = 'settings.statsLayout';

export const DEFAULT_STATS_LAYOUT = [
  { id: 'default-freq', kind: 'metric', scope: { kind: 'overall' }, metric: 'workouts', chart: 'bar', groupBy: 'week', range: '3m' },
  { id: 'default-volume', kind: 'metric', scope: { kind: 'overall' }, metric: 'volume', chart: 'bar', groupBy: 'week', range: '3m' },
  { id: 'default-prs', kind: 'prs' },
];

const CHARTS = ['line', 'bar', 'pie'];
const GROUPS = ['day', 'week', 'month', 'year'];
const RANGES = ['3m', '6m', '1y', 'all'];

/** One stored module, validated; null if hopeless. */
function sanitiseModule(m) {
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return null;
  if (m.kind === 'prs') return { id: m.id, kind: 'prs' };
  if (m.kind !== 'metric') return null;
  const scopeKind = m.scope && ['overall', 'exercise', 'category'].includes(m.scope.kind) ? m.scope.kind : null;
  if (!scopeKind || typeof m.metric !== 'string' || !m.metric) return null;
  if (scopeKind !== 'overall' && (typeof m.scope.id !== 'string' || !m.scope.id)) return null;
  return {
    id: m.id,
    kind: 'metric',
    scope: scopeKind === 'overall' ? { kind: 'overall' } : { kind: scopeKind, id: m.scope.id },
    metric: m.metric,
    chart: CHARTS.includes(m.chart) ? m.chart : 'line',
    groupBy: GROUPS.includes(m.groupBy) ? m.groupBy : 'week',
    range: RANGES.includes(m.range) ? m.range : '3m',
  };
}

/** The saved layout, validated per-module; falls back to the default. */
export function getStatsLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_STATS_LAYOUT.map((m) => ({ ...m }));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_STATS_LAYOUT.map((m) => ({ ...m }));
    const clean = parsed.map(sanitiseModule).filter(Boolean);
    return clean.length ? clean : DEFAULT_STATS_LAYOUT.map((m) => ({ ...m }));
  } catch {
    return DEFAULT_STATS_LAYOUT.map((m) => ({ ...m }));
  }
}

export function setStatsLayout(layout) {
  const clean = (Array.isArray(layout) ? layout : []).map(sanitiseModule).filter(Boolean);
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(clean));
}

export function resetStatsLayout() {
  localStorage.removeItem(LAYOUT_KEY);
}
