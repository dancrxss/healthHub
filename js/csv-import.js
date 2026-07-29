// ============================================================================
// csv-import.js — generic workout-CSV → healthHub records. PURE MODULE: no
// DOM, no IndexedDB, no imports other than exercise-types.js. The Profile
// screen owns the UI (file picker, preview sheet) and db.bulkImport owns
// persistence; everything in here is deterministic data-in/data-out so the
// browser unit suite can cover it directly.
//
// Design rules (pinned by the orchestrator — do not change signatures):
//
// - GENERIC parsing: RFC 4180 (quoted fields, "" escapes, embedded commas and
//   newlines, CRLF/LF), delimiter sniffed from the header line (comma /
//   semicolon / tab). Columns are recognised by HEADER SYNONYMS, not position,
//   so any sane export shape maps — the reference file is
//   sample/export_29 Jul 2026.csv (RepCount: "Workout Start,Workout End,
//   Exercise,Weight,Reps,Notes,Kcal,Distance,Duration,Category,Name,
//   Bodyweight") but Strong/Hevy-style headers must work too.
// - DETERMINISTIC ids from natural keys (no uuid, no hashing): re-importing
//   the same file produces byte-identical records, so bulkImport upserts in
//   place and the import is idempotent. Never delete anything.
// - All weights stored in kg (numeric). If the weight HEADER names lb/lbs,
//   convert (× 1/2.20462, round 2 dp). Decimal commas ("12,5") accepted.
// - NEGATIVE weights mean assisted bodyweight (RepCount convention): store
//   Math.abs(), and infer exerciseType 'bw_assisted_reps' for new exercises.
// - Durations are seconds; "mm:ss" / "h:mm:ss" strings also accepted.
// - Warmup sets: only if a warmup column exists (isWarmup false otherwise) —
//   the PR/volume exclusion rules downstream depend on this being honest.
// - Timestamps: the export's times are local wall-clock, so emitted ISO
//   datetimes are NAKED (no Z / offset) — new Date() then reads them as local,
//   matching how the app displays them. Set completedAt is synthesised: sets
//   spread evenly across the workout's start→end window in row order (start +
//   (i+1)·window/(n+1)); no end ⇒ 3-minute spacing, finishedAt = start + 60 min.
// ============================================================================

import { normalizeExerciseType, setTypeFor } from './exercise-types.js';

/**
 * The logical fields a column can map to. detectColumns matches case- and
 * space-insensitively against synonym lists per field (e.g. weight: 'weight',
 * 'weight (kg)', 'kg', 'weight (lb)', 'lbs'…; start: 'workout start', 'date',
 * 'start time'…). A file is importable when it maps `exercise`, `start`, and
 * at least one of weight / reps / duration.
 * @typedef {'start'|'end'|'exercise'|'weight'|'reps'|'notes'|'kcal'|'distance'|
 *           'duration'|'category'|'name'|'bodyweight'|'setNumber'|'warmup'|'rpe'} ImportField
 */

// ---- Constants -------------------------------------------------------------

/** MUSCLE_GROUPS, copied from db.js (this module must not import the data layer). */
const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'biceps', 'triceps', 'abs', 'cardio', 'accessory', 'rehab', 'other'];

/** Category-column values that aren't literal MUSCLE_GROUPS members. */
const CATEGORY_SYNONYMS = {
  core: 'abs',
  ab: 'abs',
  stomach: 'abs',
  quads: 'legs',
  quadriceps: 'legs',
  hamstrings: 'legs',
  glutes: 'legs',
  calves: 'legs',
  leg: 'legs',
  delts: 'shoulders',
  delt: 'shoulders',
  deltoids: 'shoulders',
  shoulder: 'shoulders',
  lats: 'back',
  bicep: 'biceps',
  tricep: 'triceps',
  forearms: 'other',
  forearm: 'other',
  arms: 'other',
  arm: 'other',
  fullbody: 'other',
  'full body': 'other',
  conditioning: 'cardio',
  mobility: 'rehab',
  stretching: 'rehab',
  physio: 'rehab',
};

/**
 * Header synonyms per logical field, longest-first within each list. A header
 * is matched by EXACT equality against its normalised form, so 'workout start'
 * can never be mistaken for the 'workout' name column. Where the same string
 * would appear twice the earlier field in this table wins.
 * @type {Array<[ImportField, string[]]>}
 */
const FIELD_SYNONYMS = [
  ['start', ['workout start', 'workout date', 'start time', 'started at', 'session start', 'start', 'date', 'datetime', 'day']],
  ['end', ['workout end', 'end time', 'finished at', 'session end', 'end', 'finish']],
  ['exercise', ['exercise name', 'exercise title', 'exercise', 'movement', 'lift']],
  ['weight', ['weight (kg)', 'weight kg', 'weight (lb)', 'weight (lbs)', 'weight lb', 'weight lbs', 'weight', 'pounds', 'kg', 'lbs', 'lb', 'load']],
  ['reps', ['repetitions', 'reps done', 'reps', 'rep']],
  ['duration', ['duration (seconds)', 'duration seconds', 'duration (s)', 'duration sec', 'duration', 'seconds', 'secs', 'time']],
  ['distance', ['distance (km)', 'distance km', 'distance (m)', 'distance m', 'distance', 'metres', 'meters', 'km']],
  ['kcal', ['calories', 'energy', 'kcal', 'cal']],
  ['category', ['muscle group', 'body part', 'bodypart', 'category', 'muscle', 'group']],
  ['name', ['workout name', 'routine name', 'name', 'workout', 'title', 'routine', 'session']],
  ['bodyweight', ['bodyweight (kg)', 'body weight (kg)', 'body weight', 'bodyweight', 'bw']],
  ['setNumber', ['set number', 'set order', 'set index', 'set no', 'set']],
  ['warmup', ['is warmup', 'warm-up', 'warm up', 'warmup']],
  ['rpe', ['rpe rating', 'rpe']],
  ['notes', ['comments', 'comment', 'description', 'notes', 'note']],
];

/** Flat synonym -> field lookup (first field in FIELD_SYNONYMS wins). */
const SYNONYM_INDEX = (() => {
  const m = new Map();
  for (const [field, list] of FIELD_SYNONYMS) {
    for (const syn of list) if (!m.has(syn)) m.set(syn, field);
  }
  return m;
})();

const MINUTE_MS = 60 * 1000;
const MAX_WARNINGS = 10;

// ---- Small helpers ---------------------------------------------------------

/** Slug used inside every generated id: "Face pulls " -> "face-pulls". */
function kebab(value) {
  const slug = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unnamed';
}

/** Normalise a header cell for synonym matching. */
function normaliseHeader(value) {
  return String(value == null ? '' : value)
    .replace(/^\uFEFF/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-z0-9(]+/, '')
    .replace(/[^a-z0-9)]+$/, '');
}

/** The logical field a raw header maps to, or null. */
function lookupField(header) {
  return SYNONYM_INDEX.get(normaliseHeader(header)) || null;
}

/**
 * Lenient number parse. Trims, accepts a decimal comma ("12,5"), returns null
 * for blanks and anything that isn't a plain number — absent, not zero.
 */
function parseNumber(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Integer flavour of parseNumber (reps, set numbers). */
function parseInteger(value) {
  const n = parseNumber(value);
  return n === null ? null : Math.round(n);
}

/** Seconds from a plain number, "mm:ss" or "h:mm:ss". */
function parseDuration(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (/^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(s)) {
    const parts = s.split(':').map((p) => Number(p));
    return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  const n = parseNumber(s);
  return n === null ? null : Math.round(n);
}

/** Truthy-looking warmup cell. */
function parseBoolean(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return false;
  return s === '1' || s === 'y' || s === 'x' || s === 'yes' || s === 'true' || s === 'warmup' || s === 'warm-up' || s === 'warm up';
}

/**
 * Parse a local wall-clock timestamp. Accepts "YYYY-MM-DD HH:MM(:SS)",
 * "YYYY-MM-DDTHH:MM(:SS)", a bare "YYYY-MM-DD", and day-first "DD/MM/YYYY
 * ( HH:MM(:SS))". Date-only values get 09:00 and flag `synthesised` so the
 * caller can warn once. Returns epoch ms in UTC terms — the components are
 * treated as if they were UTC so arithmetic and formatting stay DST-free, and
 * formatDateTime writes them back out naked (no Z), i.e. local wall clock.
 */
function parseDateTime(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  let y; let mo; let d; let h = 9; let mi = 0; let sec = 0; let synthesised = false;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
    if (m[4] === undefined) synthesised = true;
    else { h = +m[4]; mi = +m[5]; sec = m[6] === undefined ? 0 : +m[6]; }
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
    if (m[4] === undefined) synthesised = true;
    else { h = +m[4]; mi = +m[5]; sec = m[6] === undefined ? 0 : +m[6]; }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, sec);
  return Number.isFinite(ms) ? { ms, synthesised } : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Naked local ISO datetime (no Z, no offset) from epoch ms. */
function formatDateTime(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** ISO date (YYYY-MM-DD) from epoch ms. */
function formatDate(ms) {
  return formatDateTime(ms).slice(0, 10);
}

/** The `YYYYMMDD-HHMM` key that anchors every generated workout/set id. */
function dateTimeKey(ms) {
  const iso = formatDateTime(ms);
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/** Category cell -> a MUSCLE_GROUPS value; blank/unknown -> 'other'. */
function muscleGroupFor(category) {
  const s = String(category == null ? '' : category).trim().toLowerCase();
  if (!s) return 'other';
  if (MUSCLE_GROUPS.includes(s)) return s;
  return CATEGORY_SYNONYMS[s] || 'other';
}

/**
 * Parse CSV text into rows of raw string fields. RFC 4180: quoted fields,
 * doubled-quote escapes, embedded delimiters/newlines inside quotes, CRLF and
 * LF endings, trailing newline optional. Wholly-empty rows are dropped.
 * @param {string} text
 * @param {','|';'|'\t'} [delimiter] default: sniffDelimiter on the first line
 * @returns {string[][]}
 */
export function parseCSV(text, delimiter) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const delim = delimiter || sniffDelimiter(firstLine(src));
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c !== '"') { field += c; continue; }
      if (src[i + 1] === '"') { field += '"'; i += 1; continue; }
      inQuotes = false;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\r') { if (src[i + 1] === '\n') i += 1; endRow(); continue; }
    if (c === '\n') { endRow(); continue; }
    field += c;
  }
  // A file with no trailing newline still has a pending row to flush.
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** The first physical line of a file, ignoring newlines inside quoted fields. */
function firstLine(text) {
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === '\n' || c === '\r')) return text.slice(0, i);
  }
  return text;
}

/**
 * Sniff the delimiter from the header line: the candidate (, ; \t) with the
 * most occurrences OUTSIDE quoted regions. Ties/none default to ','.
 * @param {string} headerLine
 * @returns {','|';'|'\t'}
 */
export function sniffDelimiter(headerLine) {
  const line = String(headerLine == null ? '' : headerLine);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && counts[c] !== undefined) counts[c] += 1;
  }
  // Ties (and an empty line) keep the comma — the overwhelmingly common case.
  let best = ',';
  for (const cand of [';', '\t']) if (counts[cand] > counts[best]) best = cand;
  return best;
}

/**
 * Map a header row onto logical import fields by synonym.
 * @param {string[]} headerRow
 * @returns {{
 *   map: Partial<Record<ImportField, number>>,  // field -> column index
 *   unrecognised: string[],                     // headers nothing matched
 *   weightUnit: 'kg'|'lb',                      // from the weight header text
 * }}
 */
export function detectColumns(headerRow) {
  const headers = Array.isArray(headerRow) ? headerRow : [];
  const map = {};
  const unrecognised = [];
  for (let i = 0; i < headers.length; i += 1) {
    const field = lookupField(headers[i]);
    if (!field) {
      const raw = String(headers[i] == null ? '' : headers[i]).trim();
      if (raw) unrecognised.push(raw);
      continue;
    }
    // First column wins: a second header for the same field is ignored (the
    // caller warns about it — see duplicateHeaders below).
    if (map[field] === undefined) map[field] = i;
  }
  const weightHeader = map.weight === undefined ? '' : normaliseHeader(headers[map.weight]);
  const weightUnit = /(^|[^a-z])(lb|lbs|pound|pounds)([^a-z]|$)/.test(weightHeader) ? 'lb' : 'kg';
  return { map, unrecognised, weightUnit };
}

/** Headers that matched a field already claimed by an earlier column. */
function duplicateHeaders(headers, map) {
  const claimed = new Set(Object.values(map));
  const dupes = [];
  for (let i = 0; i < headers.length; i += 1) {
    if (claimed.has(i)) continue;
    if (lookupField(headers[i])) dupes.push(String(headers[i]).trim());
  }
  return dupes;
}

/** Metres per unit for the mapped distance column ('… (km)' headers scale up). */
function distanceScaleFor(headers, map) {
  if (map.distance === undefined) return 1;
  return /(^|[^a-z])km([^a-z]|$)/.test(normaliseHeader(headers[map.distance])) ? 1000 : 1;
}

/** An empty (failed) plan carrying the reason. */
function failedPlan(error, warnings, rows) {
  return {
    ok: false,
    error,
    exercises: [],
    workouts: [],
    sets: [],
    collidingWorkoutIds: [],
    stats: {
      rows: rows || 0,
      skippedRows: 0,
      workouts: 0,
      sets: 0,
      newExercises: 0,
      matchedExercises: 0,
      firstDate: null,
      lastDate: null,
    },
    warnings: capWarnings(warnings || []),
  };
}

/** Keep the warning list readable — 10 lines plus a tally of the rest. */
function capWarnings(list) {
  if (list.length <= MAX_WARNINGS) return list.slice();
  return list.slice(0, MAX_WARNINGS).concat([`…and ${list.length - MAX_WARNINGS} more`]);
}

/**
 * exerciseType for a new exercise, from the aggregate shape of its rows. The
 * priority order is pinned in the buildImportPlan docblock.
 */
function inferExerciseType(agg) {
  if (agg.cardioCategory) return 'cardio';
  if (agg.negativeWeight) return 'bw_assisted_reps';
  if (agg.repsAndWeight) return 'weight_reps';
  if (agg.reps) return 'reps';
  if (agg.durationAndDistance) return 'cardio';
  if (agg.duration) return 'time';
  return 'weight_reps';
}

/**
 * Build a complete, ready-to-persist import plan from raw CSV text.
 *
 * Exercise resolution: names are matched trim/case-insensitively against
 * `existingExercises` (seed AND custom — the user's library). Unmatched names
 * become NEW custom ExerciseRecords with id `import-<kebab-name>`,
 * equipment 'other', muscleGroup from the category column (mapped onto
 * MUSCLE_GROUPS values, with sensible synonyms; unknown/blank → 'other') and
 * exerciseType inferred from that exercise's rows in priority order:
 *   category 'cardio' → 'cardio';  any negative weight → 'bw_assisted_reps';
 *   reps+weight → 'weight_reps';  reps only → 'reps';
 *   duration+distance → 'cardio';  duration only → 'time';  else 'weight_reps'.
 * createdAt = first occurrence's date at T00:00:00 (deterministic).
 *
 * Workout grouping: rows sharing a start timestamp (plus name, when present)
 * are one workout. id `import-w-<YYYYMMDD-HHMM>[-<kebab-name>]` (collisions
 * within one file get a -2, -3… suffix in first-seen order — still
 * deterministic for the same file). date = start date; name / bodyweightKg
 * from their columns (null when absent); notes null (row notes belong to the
 * SETS); entries[] in first-appearance order, supersetGroup/note null;
 * finishedAt from end (fallback start + 60 min).
 *
 * Sets: id `import-s-<workout-key>-<kebab-exercise>-<setNumber>`; setNumber
 * from its column when present, else a per-workout-per-exercise running
 * counter from 1. setType via setTypeFor(resolved exercise type); cardio sets
 * force weightKg 0 / reps 0 (db.js contract) with duration/distance/kcal
 * carried; strength sets carry weightKg (abs, kg), reps, rpe, notes, isWarmup,
 * and duration/distance/kcal when their columns hold values.
 *
 * Rows with no exercise name or an unparseable start date are skipped and
 * counted (a sample lands in warnings). Duplicate-day detection: any imported
 * workout whose date already carries a workout in `existingWorkouts` (by
 * `date`, excluding ids starting 'import-') is listed in collidingWorkoutIds —
 * the UI decides whether to drop them before persisting; the records
 * themselves stay pure db.js shapes with NO extra fields.
 *
 * @param {string} text                      raw CSV file contents
 * @param {ExerciseRecord[]} existingExercises  current library (db.listExercises())
 * @param {WorkoutRecord[]} existingWorkouts    current workouts (db.listWorkouts('0000'))
 * @returns {{
 *   ok: boolean,
 *   error: string|null,          // set when !ok: what failed + what WAS recognised
 *   exercises: ExerciseRecord[], // NEW custom exercises only (never existing ones)
 *   workouts: WorkoutRecord[],
 *   sets: SetRecord[],
 *   collidingWorkoutIds: string[],
 *   stats: {
 *     rows: number, skippedRows: number,
 *     workouts: number, sets: number,
 *     newExercises: number, matchedExercises: number,
 *     firstDate: string|null, lastDate: string|null,  // ISO dates
 *   },
 *   warnings: string[],
 * }}
 */
export function buildImportPlan(text, existingExercises, existingWorkouts) {
  const warnings = [];
  const rows = parseCSV(text);
  if (rows.length === 0) return failedPlan('The file is empty — no rows found.', warnings, 0);

  // ---- Columns ----
  const headers = rows[0];
  const { map, unrecognised, weightUnit } = detectColumns(headers);
  const distanceScale = distanceScaleFor(headers, map);
  const dataRows = rows.slice(1);

  const missing = [];
  if (map.exercise === undefined) missing.push('exercise name');
  if (map.start === undefined) missing.push('workout start date');
  if (map.weight === undefined && map.reps === undefined && map.duration === undefined) {
    missing.push('at least one of weight / reps / duration');
  }
  if (missing.length > 0) {
    const found = Object.keys(map).sort();
    return failedPlan(
      `Could not read this file: missing ${missing.join(', ')}. `
      + `Recognised columns: ${found.length ? found.join(', ') : 'none'}. `
      + `Unrecognised headers: ${unrecognised.length ? unrecognised.join(', ') : 'none'}.`,
      warnings,
      dataRows.length
    );
  }

  if (unrecognised.length > 0) warnings.push(`Ignored ${unrecognised.length} unrecognised column(s): ${unrecognised.join(', ')}.`);
  for (const dupe of duplicateHeaders(headers, map)) warnings.push(`Ignored duplicate column "${dupe}" — an earlier column already supplies that field.`);
  if (weightUnit === 'lb') warnings.push('Weights were in lb and have been converted to kg.');

  const cell = (row, field) => (map[field] === undefined ? '' : (row[map[field]] === undefined ? '' : row[map[field]]));

  // ---- Pass 1: rows -> normalised items (skipping the unusable) ----
  const items = [];
  const skipped = [];
  let synthesisedTimes = false;
  for (let i = 0; i < dataRows.length; i += 1) {
    const row = dataRows[i];
    const lineNo = i + 2; // 1-based, header included — matches what a user sees
    const exerciseName = String(cell(row, 'exercise')).trim();
    if (!exerciseName) { skipped.push(lineNo); continue; }
    const start = parseDateTime(cell(row, 'start'));
    if (!start) { skipped.push(lineNo); continue; }
    if (start.synthesised) synthesisedTimes = true;
    const end = parseDateTime(cell(row, 'end'));

    const rawWeight = parseNumber(cell(row, 'weight'));
    const weightKg = rawWeight === null
      ? null
      : (weightUnit === 'lb' ? Math.round((Math.abs(rawWeight) / 2.20462) * 100) / 100 : Math.abs(rawWeight));
    const distanceRaw = parseNumber(cell(row, 'distance'));
    const notes = String(cell(row, 'notes')).trim();

    items.push({
      startMs: start.ms,
      endMs: end ? end.ms : null,
      date: formatDate(start.ms),
      workoutName: String(cell(row, 'name')).trim() || null,
      bodyweightKg: parseNumber(cell(row, 'bodyweight')),
      exerciseName,
      exerciseKey: exerciseName.toLowerCase(),
      category: String(cell(row, 'category')).trim(),
      negative: rawWeight !== null && rawWeight < 0,
      weightKg,
      reps: parseInteger(cell(row, 'reps')),
      durationSeconds: parseDuration(cell(row, 'duration')),
      distanceM: distanceRaw === null ? null : distanceRaw * distanceScale,
      kcal: parseNumber(cell(row, 'kcal')),
      rpe: parseNumber(cell(row, 'rpe')),
      isWarmup: map.warmup === undefined ? false : parseBoolean(cell(row, 'warmup')),
      setNumber: parseInteger(cell(row, 'setNumber')),
      notes: notes || null,
    });
  }

  if (synthesisedTimes) warnings.push('Some rows carried a date but no time — those workouts were placed at 09:00.');
  if (skipped.length > 0) {
    const sample = skipped.slice(0, 3).join(', ');
    warnings.push(`Skipped ${skipped.length} row(s) with no exercise name or an unreadable date (line${skipped.length > 1 ? 's' : ''} ${sample}${skipped.length > 3 ? '…' : ''}).`);
  }

  // ---- Pass 2: resolve exercises (match the library, else mint new ones) ----
  const existingByName = new Map();
  for (const ex of existingExercises || []) {
    const key = String(ex && ex.name ? ex.name : '').trim().toLowerCase();
    if (key && !existingByName.has(key)) existingByName.set(key, ex);
  }

  const groupsByExercise = new Map(); // exerciseKey -> aggregate + items
  for (const item of items) {
    let agg = groupsByExercise.get(item.exerciseKey);
    if (!agg) {
      agg = {
        name: item.exerciseName,
        category: item.category,
        date: item.date,
        cardioCategory: false,
        negativeWeight: false,
        repsAndWeight: false,
        reps: false,
        durationAndDistance: false,
        duration: false,
      };
      groupsByExercise.set(item.exerciseKey, agg);
    }
    if (muscleGroupFor(item.category) === 'cardio') agg.cardioCategory = true;
    if (item.negative) agg.negativeWeight = true;
    if (item.reps !== null && item.weightKg !== null) agg.repsAndWeight = true;
    if (item.reps !== null) agg.reps = true;
    if (item.durationSeconds !== null && item.distanceM !== null) agg.durationAndDistance = true;
    if (item.durationSeconds !== null) agg.duration = true;
  }

  const resolved = new Map();   // exerciseKey -> { id, type }
  const newExercises = [];
  const matchedIds = new Set();
  const usedExerciseIds = new Set();
  for (const [key, agg] of groupsByExercise) {
    const existing = existingByName.get(key);
    if (existing) {
      matchedIds.add(existing.id);
      resolved.set(key, { id: existing.id, type: normalizeExerciseType(existing.exerciseType) });
      continue;
    }
    let id = `import-${kebab(agg.name)}`;
    if (usedExerciseIds.has(id)) {
      // Two different names slugged the same way — keep them separate records.
      let n = 2;
      while (usedExerciseIds.has(`${id}-${n}`)) n += 1;
      warnings.push(`Two exercise names produced the same id "${id}" — the second became "${id}-${n}".`);
      id = `${id}-${n}`;
    }
    usedExerciseIds.add(id);
    const type = inferExerciseType(agg);
    newExercises.push({
      id,
      name: agg.name,
      muscleGroup: muscleGroupFor(agg.category),
      equipment: 'other',
      exerciseType: type,
      isUnilateral: false,
      isCustom: true,
      createdAt: `${agg.date}T00:00:00`,
      syncedAt: null,
    });
    resolved.set(key, { id, type });
  }

  // ---- Pass 3: group rows into workouts, in first-appearance order ----
  // Rows sharing a start are one workout; the name only splits them when the
  // same start genuinely carries two different names (a name written on just
  // the first row of a session must not tear that session in two).
  const namesByStart = new Map();
  for (const item of items) {
    if (!namesByStart.has(item.startMs)) namesByStart.set(item.startMs, new Set());
    if (item.workoutName) namesByStart.get(item.startMs).add(item.workoutName);
  }

  const groups = new Map();
  for (const item of items) {
    const names = namesByStart.get(item.startMs);
    const shared = names.size <= 1;
    const groupName = shared ? (names.size === 1 ? [...names][0] : null) : item.workoutName;
    const key = shared ? String(item.startMs) : `${item.startMs}|${item.workoutName || ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        startMs: item.startMs,
        endMs: item.endMs,
        date: item.date,
        name: groupName,
        bodyweightKg: item.bodyweightKg,
        items: [],
      };
      groups.set(key, group);
    }
    if (group.endMs === null && item.endMs !== null) group.endMs = item.endMs;
    if (group.bodyweightKg === null && item.bodyweightKg !== null) group.bodyweightKg = item.bodyweightKg;
    group.items.push(item);
  }

  const workouts = [];
  const sets = [];
  const usedWorkoutIds = new Set();
  for (const group of groups.values()) {
    // Workout id: date-time key, plus the name when there is one; same-key
    // clashes inside one file get -2, -3… in first-seen order.
    const keyPart = dateTimeKey(group.startMs) + (group.name ? `-${kebab(group.name)}` : '');
    let workoutKey = keyPart;
    if (usedWorkoutIds.has(`import-w-${workoutKey}`)) {
      let n = 2;
      while (usedWorkoutIds.has(`import-w-${keyPart}-${n}`)) n += 1;
      workoutKey = `${keyPart}-${n}`;
    }
    const workoutId = `import-w-${workoutKey}`;
    usedWorkoutIds.add(workoutId);

    const hasWindow = group.endMs !== null && group.endMs > group.startMs;
    const step = hasWindow ? (group.endMs - group.startMs) / (group.items.length + 1) : 3 * MINUTE_MS;
    const finishedMs = group.endMs !== null ? group.endMs : group.startMs + 60 * MINUTE_MS;

    const entries = [];
    const seenExercises = new Set();
    const setCounters = new Map();
    let previousMs = group.startMs;
    for (let i = 0; i < group.items.length; i += 1) {
      const item = group.items[i];
      const ex = resolved.get(item.exerciseKey);
      if (!seenExercises.has(ex.id)) {
        seenExercises.add(ex.id);
        entries.push({ exerciseId: ex.id, supersetGroup: null, note: null });
      }
      const counted = (setCounters.get(ex.id) || 0) + 1;
      setCounters.set(ex.id, counted);
      const setNumber = item.setNumber === null ? counted : item.setNumber;

      // Sets are spread across the session window, always strictly increasing.
      let completedMs = group.startMs + Math.round((step * (i + 1)) / 1000) * 1000;
      if (completedMs <= previousMs) completedMs = previousMs + 1000;
      previousMs = completedMs;

      const setType = setTypeFor(ex.type);
      const isCardio = setType === 'cardio';
      sets.push({
        id: `import-s-${workoutKey}-${kebab(item.exerciseName)}-${setNumber}`,
        workoutId,
        exerciseId: ex.id,
        setNumber,
        setType,
        weightKg: isCardio ? 0 : (item.weightKg === null ? 0 : item.weightKg),
        reps: isCardio ? 0 : (item.reps === null ? 0 : item.reps),
        durationSeconds: item.durationSeconds,
        distanceM: item.distanceM,
        kcal: item.kcal,
        rpe: item.rpe,
        isWarmup: item.isWarmup,
        notes: item.notes,
        completedAt: formatDateTime(completedMs),
        syncedAt: null,
      });
    }

    workouts.push({
      id: workoutId,
      date: group.date,
      startedAt: formatDateTime(group.startMs),
      finishedAt: formatDateTime(finishedMs),
      templateId: null,
      notes: null,
      name: group.name,
      bodyweightKg: group.bodyweightKg,
      entries,
      syncedAt: null,
    });
  }

  // ---- Duplicate-day detection (real workouts only, not earlier imports) ----
  const takenDates = new Set();
  for (const w of existingWorkouts || []) {
    if (w && w.date && !String(w.id).startsWith('import-')) takenDates.add(w.date);
  }
  const collidingWorkoutIds = workouts.filter((w) => takenDates.has(w.date)).map((w) => w.id);
  if (collidingWorkoutIds.length > 0) warnings.push(`${collidingWorkoutIds.length} imported workout(s) fall on a day that already has a workout.`);

  const dates = workouts.map((w) => w.date).sort();
  return {
    ok: true,
    error: null,
    exercises: newExercises,
    workouts,
    sets,
    collidingWorkoutIds,
    stats: {
      rows: dataRows.length,
      skippedRows: skipped.length,
      workouts: workouts.length,
      sets: sets.length,
      newExercises: newExercises.length,
      matchedExercises: matchedIds.size,
      firstDate: dates.length ? dates[0] : null,
      lastDate: dates.length ? dates[dates.length - 1] : null,
    },
    warnings: capWarnings(warnings),
  };
}
