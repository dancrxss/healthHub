// Coach — Claude API client (Phase C, C3).
//
// Raw `fetch` against POST https://api.anthropic.com/v1/messages. No SDK, no
// build step, no DOM: this module is a pure ES module that runs in the browser
// and under Node (tests inject `fetchImpl` / `sleep` / `random`).
//
// Contract pinned in PLAN.md § "Phase C — Coach" → C3. Read that before
// changing anything here: the request body shape, the JSON-schema subset and
// the `parseResponse` clamps are all load-bearing.
//
// The API key is only ever placed in the `x-api-key` header. It is never
// logged, never put in a URL or body, and never attached to an error.

/** Model, pinned. No picker (C0). */
export const COACH_MODEL = 'claude-sonnet-5';

/** Messages endpoint. */
export const COACH_API_URL = 'https://api.anthropic.com/v1/messages';

/** Token-counting endpoint, used by `testApiKey` (cheapest valid call). */
export const COACH_COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';

/** Wire version header. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Output budget per kind. Generous: adaptive thinking is on (no `thinking` sent). */
export const MAX_TOKENS = Object.freeze({ daily: 4000, session: 8000, plan: 8000 });

/** Sonnet 5 list price, USD per million tokens. */
export const PRICING = Object.freeze({ inputPerMTok: 2.0, outputPerMTok: 10.0 });

/** Muscle groups — mirrors MUSCLE_GROUPS in js/db.js (this module must not import the data layer). */
const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'biceps', 'triceps', 'abs', 'cardio', 'accessory', 'rehab', 'other'];

/** Balance statuses produced by the engine (C2). */
const BALANCE_STATUSES = ['untrained', 'under', 'on', 'over', 'unscored'];

/** Local flag codes (C2) plus a catch-all for anything the model coins. */
const FLAG_CODES = [
  'volume-spike', 'group-volume-spike', 'rpe-creep', 'e1rm-regression', 'no-rest-day',
  'frequency-drop', 'return-ramp', 'low-hrv', 'elevated-rhr', 'short-sleep', 'weight-drop',
  'other',
];

/** Tones. */
const DAILY_TONES = ['encouraging', 'steady', 'caution'];
const SESSION_TONES = ['great', 'solid', 'mixed', 'back-off'];

/** Plan-change verbs. */
const PLAN_CHANGES = ['weight-up', 'weight-down', 'reps-up', 'reps-down', 'sets-up', 'sets-down', 'swap', 'remove', 'add', 'hold'];

/** Clamp bounds — enforced here, never in the schema (the schema subset forbids min/max). */
const LIMITS = Object.freeze({
  sets: [1, 8],
  reps: [1, 30],
  weightKg: [0, 500],
  rpe: [5, 10],
  weeks: [1, 16],
  exercisesPerSession: 10,
  headline: 80,
  body: 600,
  note: 300,
  name: 40,
});

// ---------------------------------------------------------------------------
// System prompt — one frozen constant. No interpolation, no dates, no digest
// values: it must be byte-identical on every call, for every user.
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are the training coach inside a gym-tracking app. You are knowledgeable, plain-speaking and concise, in UK English. You write like a good coach talks: specific, calm, no motivational fluff, no exclamation marks, no emoji. You are not a clinician. Never diagnose an injury, name a condition, or contradict advice the person says they have had from a physio or doctor. If something sounds like it needs a professional, say so in one short sentence and move on.

DATA CONVENTIONS
The user message is a JSON digest of this person's own training history. Read it as fact; it is computed locally from their logged sets.
- All weights are kilograms. Reps are whole numbers. RPE is 5 to 10.
- e1rm is an Epley estimate: weight times one plus reps over thirty. Treat small e1RM moves as noise.
- Warmup sets and cardio sets are excluded from every count in the digest: hard sets, volume, PRs, averages.
- balance[] gives hard sets per muscle group per week against a min and max band. Those bands are already adjusted for the person's training days and for the return-from-injury ramp, so do not re-adjust them. status is untrained, under, on, over or unscored. Groups marked unscored (cardio, other) and rehab work are never criticised for volume.
- flags[] are computed locally and are your primary evidence for "pushing too hard" or "backing off". Prefer them over your own impression of the numbers. severity is info, watch or warn.
- exercises[].proposal is the local engine's deterministic suggestion for the next session, with the rule that produced it. Treat it as the default. You may adjust it by at most one load step (2.5 kg, or 5 percent on machines) or two reps, and only with a stated reason. Never jump loads and never invent a bigger increase because the person seems keen.
- gap describes the layoff: daysSinceLastSession, weeksOff and detrainingPct. Respect it. Someone with a long layoff starts lighter than they finished.
- recovery, when present, is the latest Apple Health data with its own baselines: sleep hours, HRV and its baseline, resting heart rate and its baseline, body weight and thirty-day trend. When it is absent, say nothing about recovery at all.
- Only exercises listed in exercises[] exist. Never invent one, never rename one, and always refer to an exercise by the exact id given.

RETURNING FROM INJURY
Start conservative and earn the load back. Rebuild volume and movement quality before intensity. Keep working sets at RPE 8 or below for the first two to three weeks back, and say so. Add roughly one step a week, not two. Sharp, sudden or joint-line pain means stop the set and the exercise for that day; ordinary muscle soreness does not. Prefer exercises the person already trains over novel ones. Respect profile.avoid, profile.injuryNotes and profile.equipmentNotes absolutely: never program something on the avoid list, and never assume kit they have not mentioned.

PLANNING RULES
- Use only exerciseId values present in the digest.
- Never write more sessions than profile.daysPerWeek.
- Budget roughly three to four minutes per hard set, and keep each session inside profile.sessionMinutes.
- Spread the muscle groups across the week: no group trained hard on consecutive sessions, and no group left out that the balance data says is under its band.
- Give sessions plain names such as Upper A, Lower B, Full Body. Focus is a short phrase or null.
- Every exercise needs targetSets, a rep range, and either a target weight in kg or null when it is bodyweight or genuinely unknown.

WRITING THE DAILY BRIEF
headline is one short line, under eighty characters, no full stop needed. body is a short paragraph that names actual exercises and muscle groups from the digest rather than talking in generalities. balanceNotes covers only the groups worth commenting on — under, over, or a clear trend — not every group. todayAdvice is one paragraph and must be actionable: what to do today, at what sort of load or effort, or that today is a rest day. recoveryNote is null unless recovery is present in the digest; when it is present, say what it means for today's session in one or two sentences. tone is encouraging, steady or caution, and caution is for when the flags warrant it.

WRITING SESSION FEEDBACK
better and worse each name the exercise and cite the numbers that justify it: the weight, the reps, the volume or the e1RM, and what it was before. Two or three entries each is plenty; leave a list empty rather than padding it. flags restates the local flags that are worth acting on, in plain words a person would use. planChanges lists every concrete change you are making, one entry each, with from and to as short readable strings such as "60 kg x 8" and a reason in one sentence. plan is the full revised plan when something needs changing, and null when the current plan still fits — do not rewrite a plan just to look busy.

Reply with the JSON object only. No preamble, no markdown, no code fence, no commentary after it.`;

// ---------------------------------------------------------------------------
// JSON schemas (structured outputs).
//
// Subset rules — a violation is an HTTP 400 in production:
//   • every type:'object' carries additionalProperties:false and a `required`
//     array naming ALL of its properties;
//   • nullable is anyOf [T, {type:'null'}], never a type array;
//   • no minimum/maximum/minLength/maxLength/minItems/maxItems/pattern/format;
//   • no recursion.
// Ranges are enforced in parseResponse instead.
// ---------------------------------------------------------------------------

/** `{type:'object', ...}` with additionalProperties:false and a full `required`. */
function objectSchema(properties) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const STRING = { type: 'string' };
const INTEGER = { type: 'integer' };
const NULLABLE_STRING = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const NULLABLE_NUMBER = { anyOf: [{ type: 'number' }, { type: 'null' }] };

function enumSchema(values) {
  return { type: 'string', enum: [...values] };
}

/**
 * The PLAN object. Built fresh on each call so the same shape can be emitted
 * twice — once inside the session schema's `$defs`, once as the whole plan
 * schema — without the two sharing mutable nodes.
 */
function planObjectSchema() {
  return objectSchema({
    weeks: INTEGER,
    rationale: STRING,
    sessions: {
      type: 'array',
      items: objectSchema({
        name: STRING,
        focus: NULLABLE_STRING,
        exercises: {
          type: 'array',
          items: objectSchema({
            exerciseId: STRING,
            targetSets: INTEGER,
            targetRepsLow: INTEGER,
            targetRepsHigh: INTEGER,
            targetWeightKg: NULLABLE_NUMBER,
            targetRpe: NULLABLE_NUMBER,
            note: NULLABLE_STRING,
          }),
        },
      }),
    },
  });
}

const DAILY_SCHEMA = objectSchema({
  headline: STRING,
  body: STRING,
  balanceNotes: {
    type: 'array',
    items: objectSchema({
      group: enumSchema(MUSCLE_GROUPS),
      status: enumSchema(BALANCE_STATUSES),
      note: STRING,
    }),
  },
  recoveryNote: NULLABLE_STRING,
  todayAdvice: STRING,
  tone: enumSchema(DAILY_TONES),
});

const SESSION_SCHEMA = {
  ...objectSchema({
    overallTone: enumSchema(SESSION_TONES),
    summary: STRING,
    better: {
      type: 'array',
      items: objectSchema({ exerciseId: STRING, name: STRING, note: STRING }),
    },
    worse: {
      type: 'array',
      items: objectSchema({ exerciseId: STRING, name: STRING, note: STRING }),
    },
    flags: {
      type: 'array',
      items: objectSchema({ code: enumSchema(FLAG_CODES), message: STRING }),
    },
    planChanges: {
      type: 'array',
      items: objectSchema({
        sessionId: STRING,
        exerciseId: STRING,
        change: enumSchema(PLAN_CHANGES),
        from: STRING,
        to: STRING,
        reason: STRING,
      }),
    },
    plan: { anyOf: [{ $ref: '#/$defs/plan' }, { type: 'null' }] },
  }),
  $defs: { plan: planObjectSchema() },
};

/** Schemas by kind. `plan` is the PLAN object at the top level (a bare $ref is not allowed there). */
export const SCHEMAS = Object.freeze({
  daily: DAILY_SCHEMA,
  session: SESSION_SCHEMA,
  plan: planObjectSchema(),
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A Coach API failure with a stable `code` the UI switches on.
 * Codes: offline · auth · request · model · rate-limit · server · refusal ·
 *        truncated · parse.
 */
export class CoachApiError extends Error {
  constructor(code, message, { status = null, retryable = false, detail = null } = {}) {
    super(message || code);
    this.name = 'CoachApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/** Short, plain UK-English copy for the UI. Never leaks status codes or the key. */
export function userMessageFor(error) {
  const code = error && error.code;
  switch (code) {
    case 'offline': return 'No connection — the coach will catch up next time you open the app.';
    case 'auth': return 'Your API key was rejected. Check it in Settings → Coach.';
    case 'model': return "This API key can't use Claude Sonnet 5.";
    case 'rate-limit': return 'Rate limited — trying again shortly.';
    case 'server': return 'Claude is busy — the coach will try again later.';
    case 'refusal': return 'The coach declined to answer this one.';
    case 'truncated':
    case 'parse':
    case 'request': return "The coach couldn't process that.";
    default: return 'Something went wrong talking to the coach.';
  }
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/** The four headers, and only those four. The key appears nowhere else. */
export function buildHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': String(apiKey || ''),
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/**
 * Pure request builder.
 * @returns {{url: string, body: object}} body is a plain object (not stringified).
 */
export function buildRequest({ kind, digest }) {
  if (!Object.prototype.hasOwnProperty.call(MAX_TOKENS, kind)) {
    throw new CoachApiError('request', `Unknown coach kind: ${kind}`);
  }
  return {
    url: COACH_API_URL,
    body: {
      model: COACH_MODEL,
      max_tokens: MAX_TOKENS[kind],
      system: SYSTEM_PROMPT,
      output_config: {
        effort: kind === 'daily' ? 'low' : 'medium',
        format: { type: 'json_schema', schema: SCHEMAS[kind] },
      },
      messages: [{ role: 'user', content: JSON.stringify(digest) }],
    },
  };
}

// ---------------------------------------------------------------------------
// Response reading
// ---------------------------------------------------------------------------

/** Concatenate every text block; the JSON payload is the whole of it. */
export function extractText(responseJson) {
  const blocks = (responseJson && Array.isArray(responseJson.content)) ? responseJson.content : [];
  let out = '';
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/** @returns {{inputTokens: number, outputTokens: number}} */
export function usageFrom(responseJson) {
  const usage = (responseJson && responseJson.usage) || {};
  return {
    inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
    outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
  };
}

/** USD, at Sonnet 5 list price. */
export function estimateCostUsd(usage) {
  const inputTokens = Number(usage && usage.inputTokens) || 0;
  const outputTokens = Number(usage && usage.outputTokens) || 0;
  return (inputTokens / 1e6) * PRICING.inputPerMTok + (outputTokens / 1e6) * PRICING.outputPerMTok;
}

// ---------------------------------------------------------------------------
// Cleaning helpers
// ---------------------------------------------------------------------------

/** Trim to `limit` characters at a word boundary, adding an ellipsis. */
function truncate(value, limit) {
  const s = (value == null ? '' : String(value)).trim();
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  const base = space > Math.floor(limit * 0.6) ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s.,;:!?—-]+$/, '')}…`;
}

/** A trimmed, truncated string; `''` when absent. */
function str(value, limit) {
  return typeof value === 'string' ? truncate(value, limit) : '';
}

/** A trimmed, truncated string, or null when absent/empty. */
function nullableStr(value, limit) {
  if (typeof value !== 'string') return null;
  const out = truncate(value, limit);
  return out === '' ? null : out;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInt(value, [lo, hi], fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Round to the nearest 0.5 and clamp; null passes through. */
function clampHalf(value, [lo, hi]) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n * 2) / 2));
}

// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------

function knownExerciseIds(kind, digest) {
  const ids = new Set();
  for (const ex of asArray(digest && digest.exercises)) {
    if (ex && typeof ex.id === 'string') ids.add(ex.id);
  }
  if (kind === 'session') {
    for (const ex of asArray(digest && digest.session && digest.session.exercises)) {
      if (ex && typeof ex.id === 'string') ids.add(ex.id);
    }
  }
  return ids;
}

function maxSessionsFor(digest) {
  const days = digest && digest.profile ? Number(digest.profile.daysPerWeek) : NaN;
  return Math.max(1, Number.isFinite(days) ? Math.round(days) : 7);
}

/** Clean one plan exercise, or null when its exercise is unknown to us. */
function cleanPlanExercise(raw, knownIds) {
  if (!raw || typeof raw !== 'object') return null;
  const exerciseId = typeof raw.exerciseId === 'string' ? raw.exerciseId : '';
  if (!knownIds.has(exerciseId)) return null;
  const targetRepsLow = clampInt(raw.targetRepsLow, LIMITS.reps, LIMITS.reps[0]);
  const targetRepsHigh = clampInt(raw.targetRepsHigh, [targetRepsLow, LIMITS.reps[1]], targetRepsLow);
  return {
    exerciseId,
    targetSets: clampInt(raw.targetSets, LIMITS.sets, 3),
    targetRepsLow,
    targetRepsHigh,
    targetWeightKg: clampHalf(raw.targetWeightKg, LIMITS.weightKg),
    targetRpe: clampHalf(raw.targetRpe, LIMITS.rpe),
    note: nullableStr(raw.note, LIMITS.note),
  };
}

/**
 * Clean a PLAN object. Unknown exercises are dropped, empty sessions are
 * dropped, session ids are assigned locally (`ps-N`) and never taken from the
 * model. Returns null when nothing usable survives.
 */
function cleanPlan(raw, knownIds, maxSessions) {
  if (!raw || typeof raw !== 'object') return null;
  const sessions = [];
  for (const rawSession of asArray(raw.sessions)) {
    if (sessions.length >= maxSessions) break;
    if (!rawSession || typeof rawSession !== 'object') continue;
    const exercises = [];
    for (const rawEx of asArray(rawSession.exercises)) {
      if (exercises.length >= LIMITS.exercisesPerSession) break;
      const ex = cleanPlanExercise(rawEx, knownIds);
      if (ex) exercises.push(ex);
    }
    if (exercises.length === 0) continue;
    sessions.push({
      id: `ps-${sessions.length + 1}`,
      order: sessions.length + 1,
      name: str(rawSession.name, LIMITS.name) || `Session ${sessions.length + 1}`,
      focus: nullableStr(rawSession.focus, LIMITS.note),
      exercises,
    });
  }
  if (sessions.length === 0) return null;
  return {
    weeks: clampInt(raw.weeks, LIMITS.weeks, 4),
    rationale: str(raw.rationale, LIMITS.body),
    sessions,
  };
}

function cleanDaily(raw) {
  return {
    headline: str(raw.headline, LIMITS.headline),
    body: str(raw.body, LIMITS.body),
    balanceNotes: asArray(raw.balanceNotes)
      .filter((n) => n && typeof n === 'object')
      .map((n) => ({
        group: oneOf(n.group, MUSCLE_GROUPS, 'other'),
        status: oneOf(n.status, BALANCE_STATUSES, 'unscored'),
        note: str(n.note, LIMITS.note),
      })),
    recoveryNote: nullableStr(raw.recoveryNote, LIMITS.note),
    todayAdvice: str(raw.todayAdvice, LIMITS.note),
    tone: oneOf(raw.tone, DAILY_TONES, 'steady'),
  };
}

function cleanExerciseNotes(list, knownIds) {
  return asArray(list)
    .filter((n) => n && typeof n === 'object' && knownIds.has(n.exerciseId))
    .map((n) => ({
      exerciseId: n.exerciseId,
      name: str(n.name, LIMITS.name),
      note: str(n.note, LIMITS.note),
    }));
}

function cleanSession(raw, knownIds, maxSessions) {
  return {
    overallTone: oneOf(raw.overallTone, SESSION_TONES, 'solid'),
    summary: str(raw.summary, LIMITS.body),
    better: cleanExerciseNotes(raw.better, knownIds),
    worse: cleanExerciseNotes(raw.worse, knownIds),
    flags: asArray(raw.flags)
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({ code: oneOf(f.code, FLAG_CODES, 'other'), message: str(f.message, LIMITS.note) })),
    planChanges: asArray(raw.planChanges)
      .filter((c) => c && typeof c === 'object' && knownIds.has(c.exerciseId))
      .map((c) => ({
        sessionId: str(c.sessionId, LIMITS.name),
        exerciseId: c.exerciseId,
        change: oneOf(c.change, PLAN_CHANGES, 'hold'),
        from: str(c.from, LIMITS.name),
        to: str(c.to, LIMITS.name),
        reason: str(c.reason, LIMITS.note),
      })),
    plan: cleanPlan(raw.plan, knownIds, maxSessions),
  };
}

/**
 * Validate + clean a Messages response into the narrative object for `kind`.
 * Throws CoachApiError('refusal' | 'truncated' | 'parse').
 */
export function parseResponse(kind, responseJson, { digest } = {}) {
  const stopReason = responseJson && responseJson.stop_reason;
  if (stopReason === 'refusal') {
    throw new CoachApiError('refusal', 'The coach declined to answer', {
      retryable: false,
      detail: (responseJson && responseJson.stop_details) || null,
    });
  }
  if (stopReason === 'max_tokens') {
    throw new CoachApiError('truncated', 'The reply was cut short', { retryable: true });
  }

  const text = extractText(responseJson);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CoachApiError('parse', 'The coach returned something we could not read', {
      retryable: false,
      detail: text.slice(0, 200),
    });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CoachApiError('parse', 'The coach returned something we could not read', { retryable: false });
  }

  const knownIds = knownExerciseIds(kind, digest);
  const maxSessions = maxSessionsFor(digest);

  if (kind === 'daily') return cleanDaily(raw);
  if (kind === 'session') return cleanSession(raw, knownIds, maxSessions);
  if (kind === 'plan') {
    const plan = cleanPlan(raw, knownIds, maxSessions);
    if (!plan) throw new CoachApiError('parse', 'The coach returned an empty plan', { retryable: false });
    return plan;
  }
  throw new CoachApiError('request', `Unknown coach kind: ${kind}`);
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRY_DELAYS_MS = [1000, 4000];
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_CAP_MS = 30000;

function isOffline() {
  return typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
}

/** `Retry-After` in seconds or as an HTTP-date, capped at 30 s. */
function retryAfterMs(response) {
  let raw = null;
  try {
    raw = response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('retry-after')
      : null;
  } catch { raw = null; }
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, seconds * 1000));
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - Date.now()));
  return 0;
}

/** Pull `error.message` out of an Anthropic error body without ever touching headers. */
async function errorDetail(response) {
  try {
    const body = await response.json();
    if (body && body.error && typeof body.error.message === 'string') return body.error.message;
    if (typeof body === 'string') return body.slice(0, 300);
    return body ? JSON.stringify(body).slice(0, 300) : null;
  } catch {
    return null;
  }
}

async function errorForStatus(response) {
  const status = response.status;
  const detail = await errorDetail(response);
  if (status === 401 || status === 403) {
    return new CoachApiError('auth', 'The API key was rejected', { status, retryable: false, detail });
  }
  if (status === 400) {
    return new CoachApiError('request', 'The coach request was rejected', { status, retryable: false, detail });
  }
  if (status === 404) {
    return new CoachApiError('model', 'This key cannot use the coach model', { status, retryable: false, detail });
  }
  if (status === 429) {
    const err = new CoachApiError('rate-limit', 'Rate limited', { status, retryable: true, detail });
    err.retryAfterMs = retryAfterMs(response);
    return err;
  }
  if (status >= 500) {
    return new CoachApiError('server', 'Claude is unavailable', { status, retryable: true, detail });
  }
  return new CoachApiError('request', 'The coach request failed', { status, retryable: false, detail });
}

function networkError(err) {
  if (isOffline() || err instanceof TypeError) {
    return new CoachApiError('offline', 'No connection', { retryable: false, detail: err ? err.message : null });
  }
  return new CoachApiError('offline', 'The coach request could not be completed', {
    retryable: false,
    detail: err ? err.message : null,
  });
}

/** Abort controller wired to `timeoutMs` and, when given, an external signal. */
function makeAbort(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    done() {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Call the Coach.
 * @returns {Promise<{narrative: object, usage: {inputTokens:number,outputTokens:number}, raw: {id:string|null, model:string|null, stopReason:string|null}}>}
 */
export async function callCoach({
  kind,
  digest,
  apiKey,
  signal,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  random = Math.random,
  timeoutMs = 60000,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new CoachApiError('auth', 'No API key set', { retryable: false });
  }

  const { url, body } = buildRequest({ kind, digest });
  const headers = buildHeaders(apiKey);
  let maxTokens = body.max_tokens;
  let truncatedRetryUsed = false;
  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_ATTEMPTS) {
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      const wait = Math.max(base, lastError && lastError.retryAfterMs ? lastError.retryAfterMs : 0)
        + Math.round(random() * 500);
      await sleep(wait);
    }
    attempt += 1;

    const abort = makeAbort(signal, timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, max_tokens: maxTokens }),
        signal: abort.signal,
      });
    } catch (err) {
      const timedOut = abort.timedOut;
      abort.done();
      if (signal && signal.aborted && !timedOut) throw err; // caller cancelled — surface as-is
      throw networkError(err);
    }
    abort.done();

    if (!response || !response.ok) {
      const err = await errorForStatus(response || { status: 0 });
      lastError = err;
      if (err.retryable && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }

    let json;
    try {
      json = await response.json();
    } catch (err) {
      throw new CoachApiError('parse', 'The coach returned something we could not read', { retryable: false });
    }

    try {
      const narrative = parseResponse(kind, json, { digest });
      return {
        narrative,
        usage: usageFrom(json),
        raw: { id: json.id || null, model: json.model || null, stopReason: json.stop_reason || null },
      };
    } catch (err) {
      lastError = err;
      const canRetryTruncated = err instanceof CoachApiError
        && err.code === 'truncated'
        && !truncatedRetryUsed
        && attempt < MAX_ATTEMPTS;
      if (canRetryTruncated) {
        truncatedRetryUsed = true;
        maxTokens = Math.round(maxTokens * 1.5);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new CoachApiError('server', 'The coach could not be reached', { retryable: true });
}

/**
 * Cheap key check: count the tokens of a one-word message. Never sends a digest.
 * @returns {Promise<{ok: true}>}
 */
export async function testApiKey(apiKey, { fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new CoachApiError('auth', 'No API key set', { retryable: false });
  }
  let response;
  try {
    response = await fetchImpl(COACH_COUNT_TOKENS_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({ model: COACH_MODEL, messages: [{ role: 'user', content: 'ping' }] }),
    });
  } catch (err) {
    throw networkError(err);
  }
  if (!response || !response.ok) throw await errorForStatus(response || { status: 0 });
  return { ok: true };
}
