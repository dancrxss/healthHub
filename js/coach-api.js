// Coach — Claude API client (Phase C → C3, Phase C2 → C2.3).
//
// Raw `fetch` against POST https://api.anthropic.com/v1/messages. No SDK, no
// build step, no DOM: this module is a pure ES module that runs in the browser
// and under Node (tests inject `fetchImpl` / `sleep` / `random`).
//
// Contract pinned in PLAN.md § "Phase C — Coach" → C3 and § "Phase C2" →
// C2.1/C2.3. Read those before changing anything here: the request body shape,
// the JSON-schema subset and the `parseResponse` clamps are all load-bearing.
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

/** Output budget per kind (C2.3). Generous: adaptive thinking is on (no `thinking` sent). */
export const MAX_TOKENS = Object.freeze({ daily: 4000, session: 10000, plan: 16000, chat: 6000 });

/** Abort budget per kind (C2.3). Used when the caller passes no `timeoutMs`. */
export const TIMEOUT_MS = Object.freeze({ daily: 60000, session: 90000, plan: 180000, chat: 60000 });

/** Attempts per kind, including the first (C2.3). A plan call is expensive: one retry only. */
export const MAX_ATTEMPTS = Object.freeze({ plan: 2, default: 3 });

/** Reasoning effort per kind (C2.3). */
const EFFORT = Object.freeze({ daily: 'low', session: 'medium', plan: 'medium', chat: 'low' });

/** Fallback abort budget for an unknown kind. */
const DEFAULT_TIMEOUT_MS = 60000;

/** Sonnet 5 list price, USD per million tokens. */
export const PRICING = Object.freeze({ inputPerMTok: 2.0, outputPerMTok: 10.0 });

/** Muscle groups — mirrors MUSCLE_GROUPS in js/db.js (this module must not import the data layer). */
const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'biceps', 'triceps', 'abs', 'cardio', 'accessory', 'rehab', 'other'];

/** Balance statuses produced by the engine (C2). */
const BALANCE_STATUSES = ['untrained', 'under', 'on', 'over', 'unscored'];

/** Splits offered by profile v2 (C2.1). */
const SPLITS = ['auto', 'full-body', 'upper-lower', 'ppl'];

/** Exercise types measured in seconds, not reps (mirrors `isDurationType` in the engine). */
const DURATION_TYPES = ['cardio', 'time', 'weight_time'];

/** The engine omits `type` when it is the default. */
const DEFAULT_EXERCISE_TYPE = 'weight_reps';

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
  durationSec: [30, 3600],
  rpe: [5, 10],
  weeks: [6, 8],
  weightStepKg: [0, 10],
  repStep: [0, 3],
  durationStepSec: [0, 600],
  everyWeeks: [1, 4],
  daysPerWeek: [1, 7],
  sessionMinutes: [20, 120],
  exercisesPerSession: 12,
  muscleFocus: 8,
  bullets: 8,
  bulletChars: 200,
  briefBullets: 5,
  replyBullets: 10,
  replyChars: 300,
  memoryAdds: 5,
  memoryChars: 160,
  profileTextChars: 600,
  headline: 80,
  body: 600,
  purpose: 160,
  note: 300,
  name: 40,
});

/** Defaults used when the model leaves a required target out. */
const DEFAULTS = Object.freeze({
  weeks: 6,
  sets: 3,
  repsLow: 8,
  repsSpread: 4,
  cardioSec: 600,
  holdSec: 45,
  everyWeeks: 1,
  purpose: 'No note',
});

// ---------------------------------------------------------------------------
// System prompt — one frozen constant. No interpolation, no dates, no digest
// values: it must be byte-identical on every call, for every user.
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are the training coach inside a gym-tracking app. You are knowledgeable, plain-speaking and concise, in UK English. You write like a good coach talks: specific, calm, no motivational fluff, no exclamation marks, no emoji. You are not a clinician. Never diagnose an injury, name a condition, or contradict advice the person says they have had from a physio or doctor. If something sounds like it needs a professional, say so in one short sentence and move on.

FORMAT
Every list field is an array of short bullets. One idea per bullet, one sentence, at most twenty-five words, specific — name the exercise, the number, the week. Never write a paragraph into a bullet. Leave a list empty rather than pad it.
Reply with the JSON object only. No preamble, no markdown, no code fence, no commentary after it.
Every numeric target or step field is required: write zero when it does not apply. Every optional text field is required too: write an empty string for none. profilePatch is a list of field/value pairs, value always a string ('true'/'false' for the two boolean fields); send an empty list when nothing durable changed. Allowed fields: daysPerWeek, sessionMinutes, injuryNotes, equipmentNotes, notes, split, cardioInclude, coreInclude.

DATA CONVENTIONS
The user message is a JSON digest of this person's own training history. Read it as fact; it is computed locally from their logged sets.
- All weights are kilograms. Reps are whole numbers. RPE is 5 to 10. Durations are seconds.
- e1rm is an Epley estimate: weight times one plus reps over thirty. Treat small e1RM moves as noise.
- Warmup sets and cardio sets are excluded from every count in the digest: hard sets, volume, PRs, averages.
- balance[] gives hard sets per muscle group per week against a min/max band, already adjusted for training days and the return-from-injury ramp — do not re-adjust it. status is untrained, under, on, over or unscored; unscored and rehab groups are never criticised for volume.
- flags[] are computed locally and are your primary evidence for pushing too hard or backing off. Prefer them over your own impression of the numbers. severity is info, watch or warn.
- exercises[].proposal is the engine's deterministic suggestion for the next session, with the rule behind it. Treat it as the default; adjust by at most one load step (2.5 kg, or 5 percent on machines) or two reps, with a stated reason. Never invent a bigger increase because the person seems keen.
- gap describes the layoff: daysSinceLastSession, weeksOff and detrainingPct. Respect it. Someone with a long layoff starts lighter than they finished.
- recovery, when present, is the latest Apple Health data with its own baselines: sleep hours, HRV and its baseline, resting heart rate and its baseline, body weight and thirty-day trend. When it is absent, say nothing about recovery at all.
- Only exercises listed in exercises[] exist. Never invent one, never rename one, and always refer to an exercise by the exact id given.

MEMORY
memory is a short list of durable facts about this person that they told the coach: injuries and constraints, kit, preferences, goals, how they like to train. It never holds session data — the digest already carries that. Read it every time and let it shape both the plan and the reply. In a chat reply, add a genuinely new durable fact to memoryUpdates.add, one short sentence each: no session results, no plan detail, nothing already in the list. When the message contradicts an item, put that item's id in memoryUpdates.removeIds. The person can see and edit every memory item, so write each one as a plain fact they would recognise.

PREFERENCES
- profile.split is the shape they want; auto means you choose.
- profile.groupPrefs marks each muscle group. emphasise means more sets and frequency than the band alone suggests; include means it appears every week even with no history; avoid means never program it.
- profile.cardio, when include is true, means a finisher of about minutesPerSession in most sessions using the cardio exercises in the digest — or its own session when standaloneDay is true.
- profile.core, when include is true, means one or two core movements in every session.
- favourites are exercises they like: prefer them wherever the choice is open.
- profile.notes is what they asked for in their own words. Honour it.

RETURNING FROM INJURY
Start conservative and earn the load back: rebuild volume and movement quality before intensity. Keep working sets at RPE 8 or below for the first two to three weeks, and say so. Add roughly one step a week, not two. Sharp, sudden or joint-line pain means stop that set and exercise for the day; ordinary soreness does not. Prefer exercises the person already trains over novel ones. Respect profile.avoid, profile.injuryNotes and profile.equipmentNotes absolutely: never program the avoid list, never assume kit they haven't mentioned.

PLANNING RULES
- Use only exerciseId values present in the digest.
- Never write more sessions than profile.daysPerWeek.
- Budget three to four minutes per hard set, inside profile.sessionMinutes.
- Spread muscle groups across the week: no group trained hard on consecutive sessions, none left out that balance says is under its band.
- Give sessions plain names such as Upper A, Lower B, Full Body. Focus is a short phrase, or an empty string when there isn't one.

WRITING A PLAN
- weeks is six to eight. The targets you write are the targets for week baseWeek, which the digest gives you: week one for a new plan, the current week for a revision.
- Every exercise carries a step — stepWeightKg, stepReps, stepDurationSec — the weekly amount the app uses to project later weeks; write zero for whichever does not apply. Be conservative coming back: about 2.5 kg a week on barbell compounds, one rep on isolation or bodyweight work, 30 to 60 seconds on cardio. everyWeeks says how often that step lands.
- Put one deload week in the second half of the block, or zero when the block is short.
- overview.points is the arc of the block in five to eight bullets: what progresses, how fast, and why.
- overview.muscleFocus names every group getting attention and why, including a group the person asked for that the history has none of.
- overview.progression says how loads, reps and durations move across the weeks and where the deload sits.
- weekNotes is optional: only the weeks that differ from the pattern, such as the deload or a week where something is tested.
- Each session brief is two to four bullets on what that session is for.
- Each exercise needs a purpose (why it is in this session) and a goal (the target by the end of the block, such as "3 x 8 at 70 kg by week eight").
- Cardio and core exercises use targetDurationSec with both rep fields set to zero. Lifts use the rep range with targetDurationSec set to zero.

WRITING THE DAILY BRIEF
headline is one short line, under eighty characters. points name actual exercises and muscle groups from the digest rather than talking in generalities. balanceNotes covers only the groups worth commenting on — under, over, or a clear trend — not every group. advice is what to do today: at what sort of load or effort, or that today is a rest day. recoveryNote is an empty string unless recovery is present in the digest; when it is present, say what it means for today's session. tone is encouraging, steady or caution, and caution is for when the flags warrant it.

WRITING SESSION FEEDBACK
points is the session in two to four bullets. better and worse name the exercise and cite the numbers that justify it — weight, reps, volume or e1RM, and what it was before. Two or three entries each is plenty. flags restates the local flags worth acting on, in plain words. planChanges lists every concrete change, one entry each, with from and to as short strings such as "60 kg x 8", and a one-sentence reason. plan is the full revised plan when something needs changing, and null when the current plan still fits — do not rewrite one just to look busy.

REVISIONS
On a session, the digest's plan.sessions are the current week's projected targets, already stepped forward from the stored plan. Write your revised targets for that current week. Keep the progression rules you were given unless the evidence says they need to change.

CHAT
Answer the person's message first, in reply, as bullets: plain, direct, no preamble. On thread home you are taking feedback and questions, so change the plan only when the message asks for a change in so many words and send plan null otherwise. On thread plan you are working on the plan itself: revise it when asked and list every concrete change in planChanges, and send plan null when nothing needs to change. Add to profilePatch only when the message states a durable change — training days, session length, an injury, their kit — and leave it empty otherwise. Use chat.recent for continuity. Never repeat the whole plan back inside reply.`;

// ---------------------------------------------------------------------------
// JSON schemas (structured outputs).
//
// Subset rules — a violation is an HTTP 400 in production:
//   • every type:'object' carries additionalProperties:false and a `required`
//     array naming ALL of its properties;
//   • no minimum/maximum/minLength/maxLength/minItems/maxItems/pattern/format;
//   • no recursion, no $ref at the top level of a schema.
// Ranges are enforced in parseResponse instead.
//
// C2.3 amendment (3 Sep 2026): the API rejected the C2.1 schemas with "the
// compiled grammar is too large" — enums and nullable anyOf unions each
// multiply the compiled grammar. The wire schema is now much flatter:
//   • no `enum` keywords anywhere — every enum-like field is a plain string,
//     validated against the allowed list in `parseResponse` (which already
//     had to clamp/fall back on every field regardless);
//   • at most one `anyOf` in the whole schema set — the nullable `plan` field
//     on session/chat (`NULLABLE_PLAN_REF`). Everything else that used to be
//     `anyOf [T, null]` is now a required field with a sentinel: `0` for
//     numbers, `''` for strings, meaning "not applicable" — `parseResponse`
//     converts the sentinel back to `null` in the object it returns, so the
//     PARSED shape the rest of the app sees is unchanged;
//   • `progression` is flattened onto the plan exercise as four required
//     fields (`stepWeightKg`/`stepReps`/`stepDurationSec`/`everyWeeks`)
//     instead of a nested object — `parseResponse` rebuilds the nested shape;
//   • `profilePatch` is a flat `[{field, value}]` list of string pairs
//     instead of a nullable object with eight nullable properties —
//     `parseResponse` maps known field names back onto the object shape.
// `schemaStats()` below tracks the resulting size per kind.
// ---------------------------------------------------------------------------

/** `{type:'object', ...}` with additionalProperties:false and a full `required`. */
function objectSchema(properties) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const STRING = { type: 'string' };
const INTEGER = { type: 'integer' };
const NUMBER = { type: 'number' };
const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

/**
 * Exercise types where `targetWeightKg`'s `0` sentinel is a real value (no
 * external load) rather than "not applicable" — mirrors `isBodyweightish` in
 * js/coach-engine.js. `time` is included because a bodyweight timed hold
 * (plank) has a genuine zero working weight.
 */
const BODYWEIGHT_WEIGHT_TYPES = ['reps', 'bw_weight_reps', 'bw_assisted_reps', 'time'];

/**
 * The PLAN v2 object (C2.1, wire shape simplified C2.3 amendment). Built fresh
 * on each call so the same shape can be emitted more than once — inside the
 * session and chat schemas' `$defs`, and as the whole plan schema — without
 * the emissions sharing mutable nodes.
 *
 * No enums, no nullable fields (bar the plan-level $ref handled separately):
 * every numeric target/step field is required with `0` meaning "not
 * applicable"; `focus`/`note` are required strings with `''` meaning "none".
 * `progression` is flattened onto the exercise as four required fields —
 * `parseResponse` rebuilds the nested `{weightStepKg, repStep,
 * durationStepSec, everyWeeks}` shape the rest of the app expects.
 */
function planObjectSchema() {
  return objectSchema({
    weeks: INTEGER,
    overview: objectSchema({
      points: STRING_ARRAY,
      muscleFocus: {
        type: 'array',
        items: objectSchema({ group: STRING, why: STRING }),
      },
      progression: STRING_ARRAY,
      deloadWeek: INTEGER, // 0 = no deload week
    }),
    weekNotes: {
      type: 'array',
      items: objectSchema({ week: INTEGER, focus: STRING, points: STRING_ARRAY }),
    },
    sessions: {
      type: 'array',
      items: objectSchema({
        name: STRING,
        focus: STRING, // '' = none
        brief: STRING_ARRAY,
        exercises: {
          type: 'array',
          items: objectSchema({
            exerciseId: STRING,
            targetSets: INTEGER,
            targetRepsLow: INTEGER, // 0 = not applicable
            targetRepsHigh: INTEGER, // 0 = not applicable
            targetWeightKg: NUMBER, // 0 = not applicable, except bodyweight types
            targetDurationSec: INTEGER, // 0 = not applicable
            targetRpe: NUMBER, // 0 = not applicable
            purpose: STRING,
            goal: STRING,
            note: STRING, // '' = none
            stepWeightKg: NUMBER, // 0 = no weight step (flattened progression)
            stepReps: INTEGER, // 0 = no rep step
            stepDurationSec: INTEGER, // 0 = no duration step
            everyWeeks: INTEGER, // 1-4, cadence — never "not applicable"
          }),
        },
      }),
    },
  });
}

/** `{anyOf: [$defs/plan, null]}` — the only $ref we ever emit. */
const NULLABLE_PLAN_REF = { anyOf: [{ $ref: '#/$defs/plan' }, { type: 'null' }] };

function planChangesSchema() {
  return {
    type: 'array',
    items: objectSchema({
      sessionId: STRING,
      exerciseId: STRING,
      change: STRING,
      from: STRING,
      to: STRING,
      reason: STRING,
    }),
  };
}

function exerciseNotesSchema() {
  return {
    type: 'array',
    items: objectSchema({ exerciseId: STRING, name: STRING, note: STRING }),
  };
}

const DAILY_SCHEMA = objectSchema({
  headline: STRING,
  points: STRING_ARRAY,
  balanceNotes: {
    type: 'array',
    items: objectSchema({
      group: STRING,
      status: STRING,
      note: STRING,
    }),
  },
  recoveryNote: STRING, // '' = none
  advice: STRING_ARRAY,
  tone: STRING,
});

const SESSION_SCHEMA = {
  ...objectSchema({
    overallTone: STRING,
    points: STRING_ARRAY,
    better: exerciseNotesSchema(),
    worse: exerciseNotesSchema(),
    flags: {
      type: 'array',
      items: objectSchema({ code: STRING, message: STRING }),
    },
    planChanges: planChangesSchema(),
    plan: NULLABLE_PLAN_REF,
  }),
  $defs: { plan: planObjectSchema() },
};

/**
 * `profilePatch` is a flat list of `{field, value}` string pairs rather than
 * an object with per-field nullable properties (C2.3 amendment) — the only
 * nullable/anyOf construct left in the whole schema set is `NULLABLE_PLAN_REF`
 * below. `parseResponse` maps known field names back onto the C2.1 patch
 * object shape; unknown fields and unparseable values are dropped.
 */
const CHAT_SCHEMA = {
  ...objectSchema({
    reply: STRING_ARRAY,
    memoryUpdates: objectSchema({ add: STRING_ARRAY, removeIds: STRING_ARRAY }),
    profilePatch: {
      type: 'array',
      items: objectSchema({ field: STRING, value: STRING }),
    },
    planChanges: planChangesSchema(),
    plan: NULLABLE_PLAN_REF,
  }),
  $defs: { plan: planObjectSchema() },
};

/** Schemas by kind. `plan` is the PLAN object at the top level (a bare $ref is not allowed there). */
export const SCHEMAS = Object.freeze({
  daily: DAILY_SCHEMA,
  session: SESSION_SCHEMA,
  plan: planObjectSchema(),
  chat: CHAT_SCHEMA,
});

/** Recursively tally one schema node into `stats`, following the same node keys as the test's legality walk. */
function tallySchema(node, stats) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) tallySchema(child, stats);
    return;
  }
  if (node.type === 'object') stats.objects += 1;
  if ('enum' in node) stats.enums += 1;
  if (Array.isArray(node.anyOf)) stats.anyOf += 1;
  for (const key of ['properties', '$defs', 'definitions']) {
    if (node[key] && typeof node[key] === 'object') {
      for (const child of Object.values(node[key])) tallySchema(child, stats);
    }
  }
  for (const key of ['items', 'additionalItems', 'contains', 'not']) {
    if (node[key] && typeof node[key] === 'object') tallySchema(node[key], stats);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[key])) for (const child of node[key]) tallySchema(child, stats);
  }
}

/**
 * Compiled-grammar size proxy per schema kind: `{bytes, objects, anyOf,
 * enums}`. `bytes` is the schema's own `JSON.stringify` length (not the same
 * as the compiled-grammar size the API measures, but a stable, cheap proxy
 * tracked in tests to catch regressions). `objects`/`anyOf`/`enums` count
 * schema nodes carrying `type:'object'`, an `anyOf`, or an `enum` keyword.
 * @returns {Object<string, {bytes:number, objects:number, anyOf:number, enums:number}>}
 */
export function schemaStats() {
  const out = {};
  for (const [kind, schema] of Object.entries(SCHEMAS)) {
    const stats = { bytes: JSON.stringify(schema).length, objects: 0, anyOf: 0, enums: 0 };
    tallySchema(schema, stats);
    out[kind] = stats;
  }
  return out;
}

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
    case 'request': return withDetail("The coach couldn't process that.", error);
    default: return 'Something went wrong talking to the coach.';
  }
}

/** Append the API's own reason (clipped) so a rejected request is diagnosable in-app. */
function withDetail(base, error) {
  const d = error && error.detail;
  const text = typeof d === 'string' ? d : (d && typeof d === 'object' && typeof d.message === 'string' ? d.message : '');
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return base;
  return `${base} (${clean.slice(0, 220)}${clean.length > 220 ? '…' : ''})`;
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
 * Pure request builder. Every kind sends exactly one user message: the digest
 * JSON. The chat transcript rides inside the digest (C2.3), never as turns.
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
        effort: EFFORT[kind],
        format: { type: 'json_schema', schema: SCHEMAS[kind] },
      },
      messages: [{ role: 'user', content: JSON.stringify(digest) }],
    },
  };
}

/** The abort budget for a call: the caller's override when it is a positive number, else the per-kind default. */
export function timeoutFor(kind, override) {
  const n = Number(override);
  if (Number.isFinite(n) && n > 0) return n;
  return Object.prototype.hasOwnProperty.call(TIMEOUT_MS, kind) ? TIMEOUT_MS[kind] : DEFAULT_TIMEOUT_MS;
}

/** Attempts allowed for a kind, including the first. */
export function attemptsFor(kind) {
  return Object.prototype.hasOwnProperty.call(MAX_ATTEMPTS, kind) && kind !== 'default'
    ? MAX_ATTEMPTS[kind]
    : MAX_ATTEMPTS.default;
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

function isNullish(value) {
  return value === null || value === undefined || value === '';
}

function clampInt(value, [lo, hi], fallback) {
  if (isNullish(value)) return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Clamped integer, or null when absent/unreadable. */
function nullableInt(value, range) {
  if (isNullish(value)) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(range[1], Math.max(range[0], n));
}

/** Round to the nearest 0.5 and clamp; null passes through. */
function clampHalf(value, [lo, hi]) {
  if (isNullish(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n * 2) / 2));
}

// ---------------------------------------------------------------------------
// Wire-sentinel helpers (C2.3 amendment) — the simplified schema has no
// nullable numeric/string fields (bar the plan $ref), so the model signals
// "not applicable" with `0` (numbers) or `''` (strings) instead. These clamp
// a *required* wire value back down to the nullable shape parseResponse has
// always produced. `nullableStr` already treats `''` as null, so only the
// numeric side needs new helpers.
// ---------------------------------------------------------------------------

/** `0` (or unreadable) means "not applicable" → null; otherwise round + clamp. */
function sentinelInt(value, [lo, hi]) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.min(hi, Math.max(lo, n));
}

/** `0` (or unreadable) means "not applicable" → null; otherwise round-to-half + clamp. */
function sentinelHalf(value, [lo, hi]) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.min(hi, Math.max(lo, Math.round(n * 2) / 2));
}

/** `0` (or unreadable) falls back to `fallback` — used where the field is always meaningful (e.g. a default is needed, not a null). */
function clampIntOrFallback(value, [lo, hi], fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n === 0) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * A bullet list: strings only, trimmed, truncated, empties dropped, capped.
 * The cap counts kept bullets, so padding with blanks buys nothing.
 */
function bullets(value, max = LIMITS.bullets, chars = LIMITS.bulletChars) {
  const out = [];
  for (const item of asArray(value)) {
    if (out.length >= max) break;
    if (typeof item !== 'string') continue;
    const s = truncate(item, chars);
    if (s !== '') out.push(s);
  }
  return out;
}

function isDurationType(type) {
  return DURATION_TYPES.includes(type);
}

// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------

/**
 * id → exercise type, from the digest. `type` is absent for the default type
 * (the engine omits it to save bytes), so absent means `weight_reps`.
 * @returns {Map<string, string>}
 */
function exerciseTypes(digest) {
  const map = new Map();
  const add = (ex) => {
    if (!ex || typeof ex.id !== 'string' || ex.id === '') return;
    if (map.has(ex.id)) return;
    map.set(ex.id, typeof ex.type === 'string' && ex.type !== '' ? ex.type : DEFAULT_EXERCISE_TYPE);
  };
  for (const ex of asArray(digest && digest.exercises)) add(ex);
  for (const ex of asArray(digest && digest.session && digest.session.exercises)) add(ex);
  return map;
}

function memoryIds(digest) {
  const ids = new Set();
  for (const item of asArray(digest && digest.memory)) {
    if (item && typeof item.id === 'string' && item.id !== '') ids.add(item.id);
  }
  return ids;
}

function maxSessionsFor(digest) {
  const days = digest && digest.profile ? Number(digest.profile.daysPerWeek) : NaN;
  return Math.max(1, Number.isFinite(days) ? Math.round(days) : 7);
}

/**
 * `{weightStepKg, repStep, durationStepSec, everyWeeks}` — all steps optional,
 * cadence never. `raw` is the plan-exercise object itself: the wire shape
 * flattens `stepWeightKg`/`stepReps`/`stepDurationSec`/`everyWeeks` directly
 * onto the exercise (C2.3 amendment) rather than nesting a `progression`
 * object, so this rebuilds the nested shape the rest of the app expects.
 */
function cleanProgressionFlat(raw) {
  return {
    weightStepKg: sentinelHalf(raw.stepWeightKg, LIMITS.weightStepKg),
    repStep: sentinelInt(raw.stepReps, LIMITS.repStep),
    durationStepSec: sentinelInt(raw.stepDurationSec, LIMITS.durationStepSec),
    everyWeeks: clampInt(raw.everyWeeks, LIMITS.everyWeeks, DEFAULTS.everyWeeks),
  };
}

/**
 * `targetWeightKg`'s `0` sentinel is ambiguous with a genuine zero load, so
 * it is resolved by exercise type: bodyweight-ish types (mirrors
 * `isBodyweightish` in js/coach-engine.js) keep `0`, everything else reads it
 * as "not applicable" → null.
 */
function cleanTargetWeightKg(value, type) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return BODYWEIGHT_WEIGHT_TYPES.includes(type) ? 0 : null;
  return clampHalf(n, LIMITS.weightKg);
}

/**
 * Clean one plan exercise, or null when its exercise is unknown to us.
 * The digest's type decides whether the targets are reps or seconds: duration
 * types keep `targetDurationSec` and null both rep fields, rep types do the
 * reverse. The model does not get to choose.
 */
function cleanPlanExercise(raw, types) {
  if (!raw || typeof raw !== 'object') return null;
  const exerciseId = typeof raw.exerciseId === 'string' ? raw.exerciseId : '';
  if (!types.has(exerciseId)) return null;
  const type = types.get(exerciseId);

  let targetRepsLow = null;
  let targetRepsHigh = null;
  let targetDurationSec = null;
  if (isDurationType(type)) {
    const fallback = type === 'cardio' ? DEFAULTS.cardioSec : DEFAULTS.holdSec;
    targetDurationSec = clampIntOrFallback(raw.targetDurationSec, LIMITS.durationSec, fallback);
  } else {
    targetRepsLow = clampIntOrFallback(raw.targetRepsLow, LIMITS.reps, DEFAULTS.repsLow);
    targetRepsHigh = clampIntOrFallback(
      raw.targetRepsHigh,
      [targetRepsLow, LIMITS.reps[1]],
      Math.min(LIMITS.reps[1], targetRepsLow + DEFAULTS.repsSpread),
    );
  }

  return {
    exerciseId,
    targetSets: clampInt(raw.targetSets, LIMITS.sets, DEFAULTS.sets),
    targetRepsLow,
    targetRepsHigh,
    targetWeightKg: cleanTargetWeightKg(raw.targetWeightKg, type),
    targetDurationSec,
    targetRpe: sentinelHalf(raw.targetRpe, LIMITS.rpe),
    purpose: str(raw.purpose, LIMITS.purpose) || DEFAULTS.purpose,
    goal: str(raw.goal, LIMITS.purpose) || DEFAULTS.purpose,
    note: nullableStr(raw.note, LIMITS.note),
    progression: cleanProgressionFlat(raw),
  };
}

/** A deload week is a real week in the block, never week one. Anything else is null. */
function cleanDeloadWeek(value, weeks) {
  if (isNullish(value)) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 2 || n > weeks) return null;
  return n;
}

function cleanOverview(raw, weeks) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    points: bullets(src.points),
    muscleFocus: asArray(src.muscleFocus)
      .filter((m) => m && typeof m === 'object' && MUSCLE_GROUPS.includes(m.group))
      .slice(0, LIMITS.muscleFocus)
      .map((m) => ({ group: m.group, why: str(m.why, LIMITS.purpose) })),
    progression: bullets(src.progression),
    deloadWeek: cleanDeloadWeek(src.deloadWeek, weeks),
  };
}

/** One note per week at most, inside the block, in week order. */
function cleanWeekNotes(raw, weeks) {
  const seen = new Set();
  const out = [];
  for (const note of asArray(raw)) {
    if (!note || typeof note !== 'object') continue;
    const week = Math.round(Number(note.week));
    if (!Number.isFinite(week) || week < 1 || week > weeks) continue;
    if (seen.has(week)) continue;
    seen.add(week);
    out.push({ week, focus: str(note.focus, LIMITS.purpose), points: bullets(note.points) });
  }
  out.sort((a, b) => a.week - b.week);
  return out.slice(0, weeks);
}

/**
 * Clean a PLAN v2 object. Unknown exercises are dropped, empty sessions are
 * dropped, session ids are assigned locally (`ps-N`) and never taken from the
 * model. Returns null when nothing usable survives.
 */
function cleanPlan(raw, types, maxSessions) {
  if (!raw || typeof raw !== 'object') return null;
  const weeks = clampInt(raw.weeks, LIMITS.weeks, DEFAULTS.weeks);
  const sessions = [];
  for (const rawSession of asArray(raw.sessions)) {
    if (sessions.length >= maxSessions) break;
    if (!rawSession || typeof rawSession !== 'object') continue;
    const exercises = [];
    for (const rawEx of asArray(rawSession.exercises)) {
      if (exercises.length >= LIMITS.exercisesPerSession) break;
      const ex = cleanPlanExercise(rawEx, types);
      if (ex) exercises.push(ex);
    }
    if (exercises.length === 0) continue;
    sessions.push({
      id: `ps-${sessions.length + 1}`,
      order: sessions.length + 1,
      name: str(rawSession.name, LIMITS.name) || `Session ${sessions.length + 1}`,
      focus: nullableStr(rawSession.focus, LIMITS.note),
      brief: bullets(rawSession.brief, LIMITS.briefBullets),
      exercises,
    });
  }
  if (sessions.length === 0) return null;
  return {
    weeks,
    overview: cleanOverview(raw.overview, weeks),
    weekNotes: cleanWeekNotes(raw.weekNotes, weeks),
    sessions,
  };
}

function cleanDaily(raw) {
  return {
    headline: str(raw.headline, LIMITS.headline),
    points: bullets(raw.points),
    balanceNotes: asArray(raw.balanceNotes)
      .filter((n) => n && typeof n === 'object')
      .map((n) => ({
        group: oneOf(n.group, MUSCLE_GROUPS, 'other'),
        status: oneOf(n.status, BALANCE_STATUSES, 'unscored'),
        note: str(n.note, LIMITS.note),
      })),
    recoveryNote: nullableStr(raw.recoveryNote, LIMITS.note),
    advice: bullets(raw.advice, LIMITS.briefBullets),
    tone: oneOf(raw.tone, DAILY_TONES, 'steady'),
  };
}

function cleanExerciseNotes(list, types) {
  return asArray(list)
    .filter((n) => n && typeof n === 'object' && types.has(n.exerciseId))
    .map((n) => ({
      exerciseId: n.exerciseId,
      name: str(n.name, LIMITS.name),
      note: str(n.note, LIMITS.note),
    }));
}

function cleanPlanChanges(list, types) {
  return asArray(list)
    .filter((c) => c && typeof c === 'object' && types.has(c.exerciseId))
    .map((c) => ({
      sessionId: str(c.sessionId, LIMITS.name),
      exerciseId: c.exerciseId,
      change: oneOf(c.change, PLAN_CHANGES, 'hold'),
      from: str(c.from, LIMITS.name),
      to: str(c.to, LIMITS.name),
      reason: str(c.reason, LIMITS.note),
    }));
}

function cleanSession(raw, types, maxSessions) {
  return {
    overallTone: oneOf(raw.overallTone, SESSION_TONES, 'solid'),
    points: bullets(raw.points),
    better: cleanExerciseNotes(raw.better, types),
    worse: cleanExerciseNotes(raw.worse, types),
    flags: asArray(raw.flags)
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({ code: oneOf(f.code, FLAG_CODES, 'other'), message: str(f.message, LIMITS.note) })),
    planChanges: cleanPlanChanges(raw.planChanges, types),
    plan: cleanPlan(raw.plan, types, maxSessions),
  };
}

/** `add` is new durable facts; `removeIds` may only name memory the digest carried. */
function cleanMemoryUpdates(raw, knownMemoryIds) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const removeIds = [];
  for (const id of asArray(src.removeIds)) {
    if (typeof id !== 'string' || !knownMemoryIds.has(id) || removeIds.includes(id)) continue;
    removeIds.push(id);
  }
  return { add: bullets(src.add, LIMITS.memoryAdds, LIMITS.memoryChars), removeIds };
}

/** A pair's string value as a boolean, or null when it is neither 'true' nor 'false'. */
function boolFromPairValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/**
 * Range-checked profile patch, or null when the model proposed no change at
 * all. The wire shape is a flat `[{field, value}]` list of strings (C2.3
 * amendment) rather than an object with per-field nullable properties;
 * unknown field names and unparseable values are silently dropped. Rebuilds
 * the C2.1 patch object shape the rest of the app expects.
 */
function cleanProfilePatch(raw) {
  const patch = {
    daysPerWeek: null,
    sessionMinutes: null,
    injuryNotes: null,
    equipmentNotes: null,
    notes: null,
    split: null,
    cardioInclude: null,
    coreInclude: null,
  };
  for (const pair of asArray(raw)) {
    if (!pair || typeof pair !== 'object' || typeof pair.value !== 'string') continue;
    switch (pair.field) {
      case 'daysPerWeek': patch.daysPerWeek = nullableInt(pair.value, LIMITS.daysPerWeek); break;
      case 'sessionMinutes': patch.sessionMinutes = nullableInt(pair.value, LIMITS.sessionMinutes); break;
      case 'injuryNotes': patch.injuryNotes = nullableStr(pair.value, LIMITS.profileTextChars); break;
      case 'equipmentNotes': patch.equipmentNotes = nullableStr(pair.value, LIMITS.profileTextChars); break;
      case 'notes': patch.notes = nullableStr(pair.value, LIMITS.profileTextChars); break;
      case 'split': patch.split = SPLITS.includes(pair.value) ? pair.value : null; break;
      case 'cardioInclude': patch.cardioInclude = boolFromPairValue(pair.value); break;
      case 'coreInclude': patch.coreInclude = boolFromPairValue(pair.value); break;
      default: break; // unknown field names are dropped
    }
  }
  return Object.values(patch).some((v) => v !== null) ? patch : null;
}

function cleanChat(raw, types, maxSessions, knownMemoryIds) {
  return {
    reply: bullets(raw.reply, LIMITS.replyBullets, LIMITS.replyChars),
    memoryUpdates: cleanMemoryUpdates(raw.memoryUpdates, knownMemoryIds),
    profilePatch: cleanProfilePatch(raw.profilePatch),
    planChanges: cleanPlanChanges(raw.planChanges, types),
    plan: cleanPlan(raw.plan, types, maxSessions),
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

  const types = exerciseTypes(digest);
  const maxSessions = maxSessionsFor(digest);

  if (kind === 'daily') return cleanDaily(raw);
  if (kind === 'session') return cleanSession(raw, types, maxSessions);
  if (kind === 'chat') return cleanChat(raw, types, maxSessions, memoryIds(digest));
  if (kind === 'plan') {
    const plan = cleanPlan(raw, types, maxSessions);
    if (!plan) throw new CoachApiError('parse', 'The coach returned an empty plan', { retryable: false });
    return plan;
  }
  throw new CoachApiError('request', `Unknown coach kind: ${kind}`);
}

// ---------------------------------------------------------------------------
// v1 → v2 narrative shim
//
// Records written before Phase C2 hold prose where v2 holds bullets. The
// renderers only ever read v2, so every stored narrative goes through here
// first. Pure, no I/O, and a v2 input comes straight back out.
// ---------------------------------------------------------------------------

/** A v1 prose field as a one-bullet array. */
function toBullets(value) {
  if (Array.isArray(value)) return bullets(value);
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  return [];
}

/** v1 plans carried `rationale` and no `overview`/`weekNotes`. */
function normalisePlan(plan) {
  if (!plan || typeof plan !== 'object') return plan === undefined ? null : plan;
  if (plan.overview && typeof plan.overview === 'object' && Array.isArray(plan.overview.points)) return plan;
  return {
    ...plan,
    overview: {
      points: toBullets(plan.rationale),
      muscleFocus: [],
      progression: [],
      deloadWeek: null,
    },
    weekNotes: asArray(plan.weekNotes),
  };
}

/**
 * Convert a stored v1 narrative into the v2 shape the renderers expect.
 * Already-v2 input is returned untouched (the same reference).
 * @param {'daily'|'session'|'plan'|'chat'} kind
 */
export function normaliseNarrative(kind, narrative) {
  if (!narrative || typeof narrative !== 'object' || Array.isArray(narrative)) return narrative;

  if (kind === 'daily') {
    if (Array.isArray(narrative.points) && Array.isArray(narrative.advice)) return narrative;
    return {
      ...narrative,
      points: Array.isArray(narrative.points) ? bullets(narrative.points) : toBullets(narrative.body),
      advice: Array.isArray(narrative.advice) ? bullets(narrative.advice) : toBullets(narrative.todayAdvice),
    };
  }

  if (kind === 'plan') return normalisePlan(narrative);

  if (kind === 'session') {
    const plan = normalisePlan(narrative.plan);
    if (Array.isArray(narrative.points) && plan === narrative.plan) return narrative;
    return {
      ...narrative,
      points: Array.isArray(narrative.points) ? bullets(narrative.points) : toBullets(narrative.summary),
      plan,
    };
  }

  if (kind === 'chat') {
    const plan = normalisePlan(narrative.plan);
    if (Array.isArray(narrative.reply) && plan === narrative.plan) return narrative;
    return {
      ...narrative,
      reply: Array.isArray(narrative.reply) ? bullets(narrative.reply, LIMITS.replyBullets, LIMITS.replyChars) : toBullets(narrative.text),
      plan,
    };
  }

  return narrative;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRY_DELAYS_MS = [1000, 4000];
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
function makeAbort(signal, timeoutMs, setTimeoutImpl, clearTimeoutImpl) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeoutImpl(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    done() {
      clearTimeoutImpl(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Call the Coach. `timeoutMs` defaults to TIMEOUT_MS[kind]; attempts to
 * MAX_ATTEMPTS[kind] (plan gets one retry, everything else two).
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
  timeoutMs,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new CoachApiError('auth', 'No API key set', { retryable: false });
  }

  const { url, body } = buildRequest({ kind, digest });
  const headers = buildHeaders(apiKey);
  const timeout = timeoutFor(kind, timeoutMs);
  const maxAttempts = attemptsFor(kind);
  let maxTokens = body.max_tokens;
  let truncatedRetryUsed = false;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      const wait = Math.max(base, lastError && lastError.retryAfterMs ? lastError.retryAfterMs : 0)
        + Math.round(random() * 500);
      await sleep(wait);
    }
    attempt += 1;

    const abort = makeAbort(signal, timeout, setTimeoutImpl, clearTimeoutImpl);
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
      if (err.retryable && attempt < maxAttempts) continue;
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
        && attempt < maxAttempts;
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
