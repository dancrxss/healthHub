// Pure-Node unit tests for js/coach-api.js — zero dependencies, Node built-ins only.
// Run: `node tests/coach-api.test.mjs`  (exits non-zero on any failure).
//
// Never touches the network: `fetchImpl`, `sleep` and `random` are injected.
// The digest fixtures are hand-written to the shape documented in PLAN.md
// § "Phase C2" (C2.1 shapes / C2.2 digest shape / C2.3 API contract) — this
// file deliberately does not import js/coach-engine.js.

import assert from 'node:assert/strict';
import {
  COACH_MODEL,
  COACH_API_URL,
  COACH_COUNT_TOKENS_URL,
  ANTHROPIC_VERSION,
  MAX_TOKENS,
  TIMEOUT_MS,
  MAX_ATTEMPTS,
  SYSTEM_PROMPT,
  SCHEMAS,
  schemaStats,
  PRICING,
  CoachApiError,
  buildHeaders,
  buildRequest,
  timeoutFor,
  attemptsFor,
  extractText,
  parseResponse,
  estimateCostUsd,
  usageFrom,
  userMessageFor,
  normaliseNarrative,
  callCoach,
  testApiKey,
} from '../js/coach-api.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Fixtures — digests, hand-built to the C2.1/C2.2 shape.
// ---------------------------------------------------------------------------

const KEY = 'sk-ant-test-key-not-real';

/** profile v2 (C2.1): all the new fields, plus the v1 fields that survive. */
const profileV2 = {
  version: 2,
  split: 'auto',
  groupPrefs: {},
  cardio: { include: true, minutesPerSession: 10, standaloneDay: false, exerciseIds: ['ex-run'] },
  core: { include: true },
  favouriteExerciseIds: ['ex-bench'],
  notes: null,
  goal: 'return-from-injury',
  daysPerWeek: 3,
  sessionMinutes: 45,
  injuryNotes: 'left shoulder, cleared by physio',
  equipmentNotes: 'commercial gym',
  avoid: [],
};

/** Two known memory ids — used to test memoryUpdates.removeIds filtering. */
const memoryV2 = [
  { id: 'm-1', text: 'Left shoulder impingement, cleared by physio.', addedAt: '2099-01-01', source: 'user' },
  { id: 'm-2', text: 'Prefers dumbbells over barbells for pressing.', addedAt: '2099-01-02', source: 'chat-home' },
];

/** The `plan` echo carried on every digest kind (C2.2) — slim, projected current week. */
const planEcho = { version: 2, weeks: 6, baseWeek: 1, currentWeek: 1, deloadWeek: null, sessions: [] };

/**
 * Digest for kind 'daily' / 'plan'. daysPerWeek 3. Exercises cover all three
 * type families: default weight_reps (bench/squat/row), cardio (run), and
 * time (plank) plus one weight_time (carry) — `type` is omitted for the
 * default, per the engine's byte-saving convention.
 */
const dailyDigest = {
  schemaVersion: 2,
  kind: 'daily',
  today: '2099-01-05',
  profile: profileV2,
  memory: memoryV2,
  plan: planEcho,
  gap: { daysSinceLastSession: 21, weeksOff: 3, status: 'long-layoff', detrainingPct: 0.02 },
  week: { isoWeek: '2099-W01', sessions: 1, hardSets: 12, volumeKg: 4200, avgRpe: 7.5 },
  balance: [
    { g: 'chest', sets: 4, min: 10, max: 20, status: 'under', trend: 'flat' },
    { g: 'legs', sets: 14, min: 12, max: 22, status: 'on', trend: 'up' },
  ],
  flags: [{ code: 'return-ramp', severity: 'info', detail: 'Week 1 back' }],
  exercises: [
    { id: 'ex-bench', name: 'Bench Press', group: 'chest', lastDate: '2098-12-15', workWeightKg: 60, topReps: 8, e1rm: 76, e1rmPrev: 74, bestE1rm: 90, weeksSince: 3, proposal: { weightKg: 50, repsLow: 6, repsHigh: 8, sets: 3, rule: 'layoff' } },
    { id: 'ex-squat', name: 'Back Squat', group: 'legs', lastDate: '2098-12-15', workWeightKg: 90, topReps: 5, e1rm: 105, e1rmPrev: 103, bestE1rm: 120, weeksSince: 3, proposal: { weightKg: 70, repsLow: 5, repsHigh: 8, sets: 3, rule: 'layoff' } },
    { id: 'ex-row', name: 'Barbell Row', group: 'back', lastDate: '2098-12-15', workWeightKg: 55, topReps: 10, e1rm: 73, e1rmPrev: 70, bestE1rm: 80, weeksSince: 3, proposal: { weightKg: 45, repsLow: 8, repsHigh: 12, sets: 3, rule: 'layoff' } },
    { id: 'ex-run', name: 'Treadmill Run', group: 'cardio', type: 'cardio', lastDurationSec: 1200, proposal: { durationSec: 900 } },
    { id: 'ex-plank', name: 'Plank', group: 'abs', type: 'time', lastDurationSec: 40, proposal: { durationSec: 45 } },
    { id: 'ex-carry', name: 'Farmer Carry', group: 'accessory', type: 'weight_time', lastDurationSec: 30, proposal: { durationSec: 40 } },
  ],
};

/** Digest for kind 'session' — session.exercises adds one id not in exercises[]. */
const sessionDigest = {
  ...dailyDigest,
  kind: 'session',
  session: {
    workoutId: 'w-101',
    date: '2099-01-05',
    name: 'Upper A',
    durationMin: 48,
    hardSets: 11,
    volumeKg: 3900,
    avgRpe: 7.8,
    exercises: [
      { id: 'ex-bench', name: 'Bench Press', verdict: 'better', volumeKg: 1200, volumePrevKg: 1100, e1rm: 76, e1rmPrev: 74, sets: [{ w: 60, r: 8, rpe: 7.5 }], prevTop: { w: 57.5, r: 8, rpe: 8 } },
      { id: 'ex-ohp', name: 'Overhead Press', verdict: 'new', volumeKg: 600, volumePrevKg: 0, e1rm: 45, e1rmPrev: null, sets: [{ w: 30, r: 10, rpe: 7 }], prevTop: null },
    ],
  },
};

/** `library` (C2.2/C2.3 amendment 2): ids here are NOT in `exercises[]` or
 * `session.exercises[]` — the only way `parseResponse` can know them is via
 * `digest.library`. 'ex-deadlift' is the default weight_reps type (no |type
 * suffix); 'ex-bike' is a duration type (|cardio suffix). */
const library = {
  back: ['ex-deadlift|Deadlift'],
  cardio: ['ex-bike|Assault Bike|cardio'],
};

const planDigest = { ...dailyDigest, kind: 'plan', library };

/** Digest for kind 'chat' — carries the thread + short transcript (C2.2). */
const chatDigest = {
  ...dailyDigest,
  kind: 'chat',
  chat: {
    thread: 'home',
    recent: [
      { role: 'user', text: 'How is my bench doing?' },
      { role: 'coach', text: 'Bench is trending up nicely.' },
    ],
    message: 'Can we add cardio on Fridays?',
  },
};

const DIGESTS_BY_KIND = { daily: dailyDigest, session: sessionDigest, plan: planDigest, chat: chatDigest };

function messageResponse(payload, extra = {}) {
  return {
    id: 'msg_test',
    model: COACH_MODEL,
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    usage: { input_tokens: 1200, output_tokens: 340 },
    ...extra,
  };
}

const goodDaily = {
  headline: 'Chest is lagging — start there',
  points: ['Bench Press has not been trained in three weeks.', 'Chest sits under its weekly band.'],
  balanceNotes: [{ group: 'chest', status: 'under', note: 'Four hard sets against a floor of ten.' }],
  recoveryNote: null,
  advice: ['Open with Bench Press at fifty kilos for three sets of eight.', 'Finish with Barbell Row.'],
  tone: 'steady',
};

/** A minimal, valid v2 plan payload — override fields per-test. */
function planPayload(overrides = {}) {
  return {
    weeks: 6,
    overview: {
      points: ['Rebuild volume before intensity.'],
      muscleFocus: [{ group: 'chest', why: 'Under its band after the layoff.' }],
      progression: ['Add 2.5 kg a week on compounds.'],
      deloadWeek: 4,
    },
    weekNotes: [{ week: 4, focus: 'Deload', points: ['Cut sets by one.'] }],
    sessions: [
      {
        name: 'Upper A',
        focus: 'push',
        brief: ['Chest and shoulders, moderate volume.'],
        exercises: [
          {
            exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8,
            targetWeightKg: 50, targetDurationSec: 0, targetRpe: 7,
            purpose: 'Main chest press.', goal: '3x8 at 70kg by week eight.', note: 'Stop two shy.',
            stepWeightKg: 2.5, stepReps: 1, stepDurationSec: 0, everyWeeks: 1,
          },
        ],
      },
    ],
    ...overrides,
  };
}

const goodPlan = planPayload({
  sessions: [
    ...planPayload().sessions,
    {
      name: 'Cardio Finisher',
      focus: null,
      brief: ['Easy aerobic work.'],
      exercises: [
        {
          exerciseId: 'ex-run', targetSets: 1, targetRepsLow: 0, targetRepsHigh: 0,
          targetWeightKg: 0, targetDurationSec: 900, targetRpe: 0,
          purpose: 'Aerobic base.', goal: '20 minutes by week eight.', note: '',
          stepWeightKg: 0, stepReps: 0, stepDurationSec: 60, everyWeeks: 2,
        },
        {
          exerciseId: 'ex-plank', targetSets: 3, targetRepsLow: 0, targetRepsHigh: 0,
          targetWeightKg: 0, targetDurationSec: 45, targetRpe: 0,
          purpose: 'Core stability.', goal: 'Hold 60 seconds by week eight.', note: '',
          stepWeightKg: 0, stepReps: 0, stepDurationSec: 10, everyWeeks: 2,
        },
      ],
    },
  ],
});

const goodSession = {
  overallTone: 'solid',
  points: ['Bench moved up.', 'Everything else held steady.'],
  better: [{ exerciseId: 'ex-bench', name: 'Bench Press', note: 'Sixty kilos for eight, up from 57.5.' }],
  worse: [],
  flags: [{ code: 'return-ramp', message: 'First week back — keep the lid on.' }],
  planChanges: [{ sessionId: 'ps-1', exerciseId: 'ex-bench', change: 'weight-up', from: '57.5 kg x 8', to: '60 kg x 8', reason: 'Cleared the top of the range at RPE 7.5.' }],
  plan: goodPlan,
};

/** The wire shape (C2.3 amendment): a flat list of {field, value} string pairs. */
const goodChat = {
  reply: ['Yes, we can add a Friday cardio day.', 'I have adjusted the plan below.'],
  memoryUpdates: { add: ['Wants a dedicated Friday cardio session.'], removeIds: ['m-1'] },
  profilePatch: [
    { field: 'daysPerWeek', value: '4' },
    { field: 'cardioInclude', value: 'true' },
  ],
  planChanges: [],
  plan: null,
};

/** The parsed shape `goodChat.profilePatch` above should clean up into (C2.1 patch object). */
const goodChatProfilePatch = {
  daysPerWeek: 4, sessionMinutes: null, injuryNotes: null, equipmentNotes: null,
  notes: null, split: null, cardioInclude: true, coreInclude: null,
};

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

function makeResponse({ status = 200, body = {}, headers = {} }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

/** Returns a fetch stub that replays `queue`, recording every call on `.calls`. */
function fakeFetch(queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch: unexpected extra call');
    if (next.throwErr) throw next.throwErr;
    return makeResponse(next);
  };
  fn.calls = calls;
  return fn;
}

function recordingSleep() {
  const delays = [];
  const fn = async (ms) => { delays.push(ms); };
  fn.delays = delays;
  return fn;
}

// ---------------------------------------------------------------------------
// 1. buildRequest shape — per kind: model, max_tokens, effort, format.type,
//    one user message == JSON.stringify(digest), system === SYSTEM_PROMPT.
// ---------------------------------------------------------------------------

const EXPECTED = {
  daily: { maxTokens: 4000, effort: 'low' },
  session: { maxTokens: 10000, effort: 'medium' },
  plan: { maxTokens: 16000, effort: 'medium' },
  chat: { maxTokens: 6000, effort: 'low' },
};

for (const kind of ['daily', 'session', 'plan', 'chat']) {
  check(`buildRequest: ${kind} shape`, () => {
    const digest = DIGESTS_BY_KIND[kind];
    const { url, body } = buildRequest({ kind, digest });
    assert.equal(url, COACH_API_URL);
    assert.equal(body.model, COACH_MODEL);
    assert.equal(body.max_tokens, EXPECTED[kind].maxTokens);
    assert.equal(body.max_tokens, MAX_TOKENS[kind]);
    assert.equal(body.output_config.effort, EXPECTED[kind].effort);
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.output_config.format.schema, SCHEMAS[kind]);
    assert.equal(body.system, SYSTEM_PROMPT);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[0].content, JSON.stringify(digest));
  });
}

check('buildRequest: unknown kind is rejected', () => {
  assert.throws(() => buildRequest({ kind: 'weekly', digest: dailyDigest }), (err) => err instanceof CoachApiError);
});

// ---------------------------------------------------------------------------
// 2. Forbidden request fields
// ---------------------------------------------------------------------------

check('buildRequest: never sends thinking/sampling/tool params or a prefill', () => {
  for (const kind of ['daily', 'session', 'plan', 'chat']) {
    const { body } = buildRequest({ kind, digest: DIGESTS_BY_KIND[kind] });
    for (const forbidden of ['thinking', 'temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'stop_sequences', 'cache_control', 'betas', 'system_cache_control']) {
      assert.equal(Object.prototype.hasOwnProperty.call(body, forbidden), false, `${kind} body must not carry ${forbidden}`);
    }
    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes('cache_control'), false, `${kind} body must not mention cache_control`);
    assert.equal(body.messages.length, 1, `${kind} must send exactly one message (no assistant prefill)`);
    assert.equal(body.messages.every((m) => m.role === 'user'), true);
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  }
});

// ---------------------------------------------------------------------------
// 3. SYSTEM_PROMPT is frozen and digest-independent
// ---------------------------------------------------------------------------

check('SYSTEM_PROMPT: identical across every kind and digest', () => {
  const systems = ['daily', 'session', 'plan', 'chat'].map((kind) => buildRequest({ kind, digest: DIGESTS_BY_KIND[kind] }).body.system);
  for (const s of systems) assert.equal(s, SYSTEM_PROMPT);
});

check('SYSTEM_PROMPT: no interpolation, no 4-digit numbers, under 9000 chars', () => {
  assert.equal(typeof SYSTEM_PROMPT, 'string');
  assert.equal(SYSTEM_PROMPT.includes('${'), false, 'system prompt must not interpolate');
  assert.equal(/\b\d{4}\b/.test(SYSTEM_PROMPT), false, 'system prompt must not contain a 4-digit number');
  assert.ok(SYSTEM_PROMPT.length < 9000, `system prompt is ${SYSTEM_PROMPT.length} chars`);
  assert.ok(SYSTEM_PROMPT.length > 1500, 'system prompt looks truncated');
});

check('SYSTEM_PROMPT: covers memory, targetDurationSec, baseWeek, bullets and chat threads', () => {
  for (const word of ['memory', 'memoryUpdates', 'targetDurationSec', 'baseWeek', 'bullet', 'thread']) {
    assert.ok(SYSTEM_PROMPT.includes(word), `system prompt should mention "${word}"`);
  }
});

// ---------------------------------------------------------------------------
// 3b. SYSTEM_PROMPT — C2.3 amendment 2: expert-coach role, historyByGroup, library
// ---------------------------------------------------------------------------

check('SYSTEM_PROMPT: covers historyByGroup, library and the expert-trainer role (powerlifting, physio)', () => {
  for (const word of ['historyByGroup', 'library', 'powerlifting', 'physio']) {
    assert.ok(SYSTEM_PROMPT.includes(word), `system prompt should mention "${word}"`);
  }
});

check('SYSTEM_PROMPT: no longer tells the coach only exercises[] exists', () => {
  assert.equal(SYSTEM_PROMPT.includes('Only exercises listed'), false);
  assert.equal(SYSTEM_PROMPT.includes('never rename one'), false);
});

// ---------------------------------------------------------------------------
// 4. Schema legality walk — all four schemas, incl. $defs.
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format',
];

function walkSchema(node, path, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSchema(child, `${path}[${i}]`, visit));
    return;
  }
  visit(node, path);
  for (const key of ['properties', '$defs', 'definitions']) {
    if (node[key] && typeof node[key] === 'object') {
      for (const [name, child] of Object.entries(node[key])) walkSchema(child, `${path}/${key}/${name}`, visit);
    }
  }
  for (const key of ['items', 'additionalItems', 'contains', 'not']) {
    if (node[key] && typeof node[key] === 'object') walkSchema(node[key], `${path}/${key}`, visit);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[key])) node[key].forEach((child, i) => walkSchema(child, `${path}/${key}[${i}]`, visit));
  }
}

function resolvePointer(root, ref) {
  if (!ref.startsWith('#/')) return undefined;
  let cur = root;
  for (const raw of ref.slice(2).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!cur || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const EXPECTED_REFS = { daily: 0, session: 1, plan: 0, chat: 1 };

for (const kind of ['daily', 'session', 'plan', 'chat']) {
  check(`schema ${kind}: every object node is closed with a full required list`, () => {
    const root = SCHEMAS[kind];
    assert.equal(root.type, 'object', 'top-level schema must be an object schema');
    walkSchema(root, kind, (node, path) => {
      if (node.type !== 'object') return;
      assert.equal(node.additionalProperties, false, `${path}: additionalProperties must be false`);
      assert.ok(Array.isArray(node.required), `${path}: required must be an array`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties || {}).sort(), `${path}: required must list every property`);
    });
  });

  check(`schema ${kind}: no forbidden keywords and no type arrays`, () => {
    walkSchema(SCHEMAS[kind], kind, (node, path) => {
      for (const kw of FORBIDDEN_KEYWORDS) {
        assert.equal(Object.prototype.hasOwnProperty.call(node, kw), false, `${path}: forbidden keyword ${kw}`);
      }
      if ('type' in node) assert.equal(typeof node.type, 'string', `${path}: type must be a string, not an array`);
      if ('nullable' in node) assert.fail(`${path}: use anyOf for nullables, not "nullable"`);
    });
  });

  // C2.3 amendment: the API rejected the v2 schemas as too large a compiled
  // grammar. The wire schema now carries zero `enum` keywords (parseResponse
  // validates against the allowed lists instead) and at most one `anyOf` per
  // schema — the single nullable-plan $ref.
  check(`schema ${kind}: zero enum keywords, at most one anyOf`, () => {
    let anyOfCount = 0;
    walkSchema(SCHEMAS[kind], kind, (node, path) => {
      assert.equal('enum' in node, false, `${path}: enum keywords are forbidden — the wire schema must stay enum-free`);
      if (Array.isArray(node.anyOf)) anyOfCount += 1;
    });
    assert.ok(anyOfCount <= 1, `${kind} schema carries ${anyOfCount} anyOf nodes, expected at most 1`);
  });

  check(`schema ${kind}: every $ref resolves inside the same schema`, () => {
    const root = SCHEMAS[kind];
    let refs = 0;
    walkSchema(root, kind, (node, path) => {
      if (typeof node.$ref !== 'string') return;
      refs += 1;
      assert.ok(node.$ref.startsWith('#/'), `${path}: only local refs allowed`);
      assert.notEqual(resolvePointer(root, node.$ref), undefined, `${path}: ${node.$ref} does not resolve`);
    });
    assert.equal(refs, EXPECTED_REFS[kind], `${kind} schema should carry ${EXPECTED_REFS[kind]} ref(s)`);
  });
}

check('schema session/chat: plan is nullable via anyOf against $defs/plan', () => {
  const NULLABLE_PLAN_REF = { anyOf: [{ $ref: '#/$defs/plan' }, { type: 'null' }] };
  assert.deepEqual(SCHEMAS.session.properties.plan, NULLABLE_PLAN_REF);
  assert.deepEqual(SCHEMAS.chat.properties.plan, NULLABLE_PLAN_REF);
  assert.equal(SCHEMAS.session.$defs.plan.type, 'object');
  assert.equal(SCHEMAS.chat.$defs.plan.type, 'object');
});

check('schema plan: top level is the plan object itself (PLAN v2 required list)', () => {
  assert.deepEqual([...SCHEMAS.plan.required].sort(), ['overview', 'sessions', 'weekNotes', 'weeks']);
});

check('schema: PLAN v2 is emitted identically in all three places, never sharing nodes', () => {
  assert.deepEqual(SCHEMAS.plan, SCHEMAS.session.$defs.plan);
  assert.deepEqual(SCHEMAS.plan, SCHEMAS.chat.$defs.plan);
  assert.notEqual(SCHEMAS.plan, SCHEMAS.session.$defs.plan, 'session emission must not share nodes with the top-level plan schema');
  assert.notEqual(SCHEMAS.plan, SCHEMAS.chat.$defs.plan, 'chat emission must not share nodes with the top-level plan schema');
  assert.notEqual(SCHEMAS.session.$defs.plan, SCHEMAS.chat.$defs.plan, 'session and chat emissions must not share nodes with each other');
});

check('schema plan: exercise fields carry a flattened progression (no nested object)', () => {
  const exerciseProps = SCHEMAS.plan.properties.sessions.items.properties.exercises.items.properties;
  assert.deepEqual(
    Object.keys(exerciseProps).sort(),
    [
      'everyWeeks', 'exerciseId', 'goal', 'note', 'purpose',
      'stepDurationSec', 'stepReps', 'stepWeightKg',
      'targetDurationSec', 'targetRepsHigh', 'targetRepsLow', 'targetRpe', 'targetSets', 'targetWeightKg',
    ],
  );
  for (const field of ['targetRepsLow', 'targetRepsHigh', 'targetDurationSec', 'stepReps', 'stepDurationSec', 'everyWeeks']) {
    assert.deepEqual(exerciseProps[field], { type: 'integer' }, `${field} must be a plain required integer`);
  }
  for (const field of ['targetWeightKg', 'targetRpe', 'stepWeightKg']) {
    assert.deepEqual(exerciseProps[field], { type: 'number' }, `${field} must be a plain required number`);
  }
  assert.deepEqual(exerciseProps.note, { type: 'string' });
});

check('schema chat: profilePatch is a flat field/value pair list, not a nullable object', () => {
  const patchSchema = SCHEMAS.chat.properties.profilePatch;
  assert.equal(patchSchema.type, 'array');
  assert.equal('anyOf' in patchSchema, false, 'profilePatch must not be nullable on the wire — an empty list means no change');
  assert.deepEqual(Object.keys(patchSchema.items.properties).sort(), ['field', 'value']);
  assert.deepEqual(patchSchema.items.properties.field, { type: 'string' });
  assert.deepEqual(patchSchema.items.properties.value, { type: 'string' });
  assert.deepEqual(patchSchema.items.required.sort(), ['field', 'value']);
});

check('schema daily: plain required strings, no enum or nullable', () => {
  assert.deepEqual(SCHEMAS.daily.properties.tone, { type: 'string' });
  assert.deepEqual(SCHEMAS.daily.properties.recoveryNote, { type: 'string' });
  assert.deepEqual(SCHEMAS.daily.properties.balanceNotes.items.properties.group, { type: 'string' });
  assert.deepEqual(SCHEMAS.daily.properties.balanceNotes.items.properties.status, { type: 'string' });
});

check('schema session: flag code and plan-change fields are plain strings (validated in parseResponse, not the schema)', () => {
  assert.deepEqual(SCHEMAS.session.properties.flags.items.properties.code, { type: 'string' });
  assert.deepEqual(SCHEMAS.session.properties.planChanges.items.properties.change, { type: 'string' });
});

// ---------------------------------------------------------------------------
// 4b. schemaStats — compiled-grammar size proxy (C2.3 amendment). The API
// rejected the v2 schemas with "the compiled grammar is too large"; these
// thresholds guard against the wire schema creeping back up. Pre-amendment
// sizes (for reference, not re-derived here): daily 775 · plan 2349 ·
// session 3929 · chat 4018 bytes.
// ---------------------------------------------------------------------------

check('schemaStats: bytes shrink well below the pre-amendment sizes, zero enums, ≤1 anyOf', () => {
  const stats = schemaStats();
  const PRE_AMENDMENT_BYTES = { daily: 775, plan: 2349, session: 3929, chat: 4018 };
  const MAX_BYTES = { daily: 700, plan: 2000, session: 3300, chat: 3000 };
  for (const kind of ['daily', 'session', 'plan', 'chat']) {
    assert.ok(stats[kind].bytes < MAX_BYTES[kind], `${kind} schema is ${stats[kind].bytes} bytes, expected < ${MAX_BYTES[kind]}`);
    assert.ok(
      stats[kind].bytes < PRE_AMENDMENT_BYTES[kind],
      `${kind} schema must shrink below its pre-amendment size of ${PRE_AMENDMENT_BYTES[kind]} bytes`,
    );
    assert.equal(stats[kind].enums, 0, `${kind} schema must carry zero enum keywords`);
    assert.ok(stats[kind].anyOf <= 1, `${kind} schema must carry at most one anyOf node`);
  }
  assert.equal(stats.daily.anyOf, 0, 'daily has no nullable-plan field to carry an anyOf');
  assert.equal(stats.plan.anyOf, 0, 'the top-level plan schema has no anyOf either');
  assert.equal(stats.session.anyOf, 1, 'session keeps exactly the one nullable-plan anyOf');
  assert.equal(stats.chat.anyOf, 1, 'chat keeps exactly the one nullable-plan anyOf');
});

// ---------------------------------------------------------------------------
// 5. Headers
// ---------------------------------------------------------------------------

check('buildHeaders: exactly four headers, key only in x-api-key', () => {
  const headers = buildHeaders(KEY);
  assert.deepEqual(Object.keys(headers).sort(), [
    'anthropic-dangerous-direct-browser-access',
    'anthropic-version',
    'content-type',
    'x-api-key',
  ]);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(headers['x-api-key'], KEY);
  for (const [name, value] of Object.entries(headers)) {
    if (name !== 'x-api-key') assert.equal(String(value).includes(KEY), false, `${name} leaks the key`);
  }
  assert.equal(COACH_API_URL.includes(KEY), false);
});

check('buildRequest: the key never reaches the body', () => {
  const { body } = buildRequest({ kind: 'daily', digest: dailyDigest });
  assert.equal(JSON.stringify(body).includes(KEY), false);
});

// ---------------------------------------------------------------------------
// 6. parseResponse — happy paths
// ---------------------------------------------------------------------------

check('extractText: concatenates every text block', () => {
  assert.equal(extractText({ content: [{ type: 'text', text: '{"a":' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: '1}' }] }), '{"a":1}');
  assert.equal(extractText(null), '');
});

check('parseResponse daily: happy path', () => {
  const out = parseResponse('daily', messageResponse(goodDaily), { digest: dailyDigest });
  assert.deepEqual(out, goodDaily);
});

check('parseResponse session: happy path assigns ps-N ids and order', () => {
  const out = parseResponse('session', messageResponse(goodSession), { digest: sessionDigest });
  assert.equal(out.overallTone, 'solid');
  assert.deepEqual(out.better.map((b) => b.exerciseId), ['ex-bench']);
  assert.deepEqual(out.worse, []);
  assert.deepEqual(out.flags, [{ code: 'return-ramp', message: 'First week back — keep the lid on.' }]);
  assert.equal(out.planChanges.length, 1);
  assert.deepEqual(out.plan.sessions.map((s) => s.id), ['ps-1', 'ps-2']);
  assert.deepEqual(out.plan.sessions.map((s) => s.order), [1, 2]);
  assert.equal(out.plan.weeks, 6);
  assert.equal(out.plan.overview.deloadWeek, 4);
});

check('parseResponse plan: happy path', () => {
  const out = parseResponse('plan', messageResponse(goodPlan), { digest: planDigest });
  assert.equal(out.weeks, 6);
  assert.equal(out.sessions.length, 2);
  assert.equal(out.sessions[0].id, 'ps-1');
  assert.equal(out.sessions[0].exercises[0].exerciseId, 'ex-bench');
  assert.deepEqual(out.overview.muscleFocus, [{ group: 'chest', why: 'Under its band after the layoff.' }]);
});

check('parseResponse chat: happy path', () => {
  const out = parseResponse('chat', messageResponse(goodChat), { digest: chatDigest });
  assert.deepEqual(out.reply, goodChat.reply);
  assert.deepEqual(out.memoryUpdates, { add: goodChat.memoryUpdates.add, removeIds: ['m-1'] });
  assert.deepEqual(out.profilePatch, goodChatProfilePatch);
  assert.equal(out.profilePatch.daysPerWeek, 4);
  assert.equal(out.plan, null);
});

check('parseResponse: session-only exercise ids count as known', () => {
  const payload = { ...goodSession, better: [{ exerciseId: 'ex-ohp', name: 'Overhead Press', note: 'First time back.' }] };
  const out = parseResponse('session', messageResponse(payload), { digest: sessionDigest });
  assert.deepEqual(out.better.map((b) => b.exerciseId), ['ex-ohp']);
  // ...but not for a daily digest, which has no session block.
  const daily = parseResponse('session', messageResponse(payload), { digest: dailyDigest });
  assert.deepEqual(daily.better, []);
});

// ---------------------------------------------------------------------------
// 6b. parseResponse — duration vs. rep types, driven by the digest's type map
// ---------------------------------------------------------------------------

check('parseResponse plan: a cardio exercise keeps duration and nulls reps', () => {
  const payload = planPayload({
    sessions: [{
      name: 'Cardio', focus: null, brief: [],
      exercises: [{
        exerciseId: 'ex-run', targetSets: 1, targetRepsLow: 8, targetRepsHigh: 12,
        targetWeightKg: 50, targetDurationSec: 720, targetRpe: 6,
        purpose: 'Aerobic base.', goal: '12 minutes.', note: '',
        stepWeightKg: 1, stepReps: 1, stepDurationSec: 30, everyWeeks: 1,
      }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  const ex = out.sessions[0].exercises[0];
  assert.equal(ex.targetDurationSec, 720);
  assert.equal(ex.targetRepsLow, null);
  assert.equal(ex.targetRepsHigh, null);
  assert.equal(ex.note, null, 'the "" wire sentinel becomes null in the parsed shape');
  assert.deepEqual(ex.progression, { weightStepKg: 1, repStep: 1, durationStepSec: 30, everyWeeks: 1 });
});

check('parseResponse plan: an exerciseId known only via digest.library is kept, not dropped', () => {
  const payload = planPayload({
    sessions: [{
      name: 'Pull', focus: null, brief: [],
      exercises: [{
        exerciseId: 'ex-deadlift', targetSets: 3, targetRepsLow: 4, targetRepsHigh: 6,
        targetWeightKg: 100, targetDurationSec: 0, targetRpe: 8,
        purpose: 'Main pull.', goal: '3x5 at 120kg by week eight.', note: '',
        stepWeightKg: 2.5, stepReps: 0, stepDurationSec: 0, everyWeeks: 1,
      }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions.length, 1, 'the library-only exercise must not be dropped as unknown');
  const ex = out.sessions[0].exercises[0];
  assert.equal(ex.exerciseId, 'ex-deadlift');
  assert.equal(ex.targetRepsLow, 4);
  assert.equal(ex.targetRepsHigh, 6);
  assert.equal(ex.targetDurationSec, null, 'default weight_reps type from the library, not a duration type');
});

check('parseResponse plan: a library entry with a |cardio suffix is treated as a duration type', () => {
  const payload = planPayload({
    sessions: [{
      name: 'Conditioning', focus: null, brief: [],
      exercises: [{
        exerciseId: 'ex-bike', targetSets: 1, targetRepsLow: 8, targetRepsHigh: 12,
        targetWeightKg: 0, targetDurationSec: 600, targetRpe: 6,
        purpose: 'Aerobic base.', goal: '10 minutes by week eight.', note: '',
        stepWeightKg: 0, stepReps: 0, stepDurationSec: 30, everyWeeks: 1,
      }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions.length, 1, 'the library-only cardio exercise must not be dropped as unknown');
  const ex = out.sessions[0].exercises[0];
  assert.equal(ex.exerciseId, 'ex-bike');
  assert.equal(ex.targetDurationSec, 600);
  assert.equal(ex.targetRepsLow, null, 'the library |cardio suffix makes this a duration type, so reps are nulled');
  assert.equal(ex.targetRepsHigh, null);
});

check('parseResponse plan: a time plank keeps duration (defaulted) and nulls reps', () => {
  const payload = planPayload({
    sessions: [{
      name: 'Core', focus: null, brief: [],
      exercises: [{
        exerciseId: 'ex-plank', targetSets: 3, targetRepsLow: 10, targetRepsHigh: 15,
        targetWeightKg: null, targetDurationSec: null, targetRpe: null,
        purpose: 'Core hold.', goal: 'Hold longer.', note: null,
      }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  const ex = out.sessions[0].exercises[0];
  assert.equal(ex.targetDurationSec, 45, 'missing duration on a time type defaults to 45s');
  assert.equal(ex.targetRepsLow, null);
  assert.equal(ex.targetRepsHigh, null);
});

check('parseResponse plan: a missing cardio duration defaults to 600s', () => {
  const payload = planPayload({
    sessions: [{
      name: 'Cardio', focus: null, brief: [],
      exercises: [{ exerciseId: 'ex-run', targetSets: 1, purpose: 'Base.', goal: 'Base.', note: null }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions[0].exercises[0].targetDurationSec, 600);
});

check('parseResponse plan: an explicit 0 wire sentinel for cardio duration also defaults to 600s', () => {
  const payload = planPayload({
    sessions: [{
      name: 'Cardio', focus: '', brief: [],
      exercises: [{
        exerciseId: 'ex-run', targetSets: 1, targetRepsLow: 0, targetRepsHigh: 0,
        targetWeightKg: 0, targetDurationSec: 0, targetRpe: 0,
        purpose: 'Base.', goal: 'Base.', note: '',
        stepWeightKg: 0, stepReps: 0, stepDurationSec: 0, everyWeeks: 1,
      }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions[0].exercises[0].targetDurationSec, 600, 'the 0 sentinel means "not applicable", so the default fallback applies');
});

check('parseResponse plan: a weight_time carry keeps duration and nulls reps', () => {
  const payload = planPayload({
    sessions: [{
      name: 'Carries', focus: null, brief: [],
      exercises: [{
        exerciseId: 'ex-carry', targetSets: 3, targetRepsLow: 5, targetRepsHigh: 8,
        targetWeightKg: 40, targetDurationSec: 50, targetRpe: 7,
        purpose: 'Grip and core.', goal: '60s holds.', note: null,
      }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  const ex = out.sessions[0].exercises[0];
  assert.equal(ex.targetDurationSec, 50);
  assert.equal(ex.targetRepsLow, null);
  assert.equal(ex.targetRepsHigh, null);
  assert.equal(ex.targetWeightKg, 40, 'weight_time still carries a load');
});

check('parseResponse plan: a lift (weight_reps) keeps reps and nulls duration', () => {
  const payload = planPayload({
    sessions: [{
      name: 'Upper', focus: null, brief: [],
      exercises: [{
        exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 10,
        targetWeightKg: 60, targetDurationSec: 900, targetRpe: 7,
        purpose: 'Press.', goal: 'Progress.', note: null,
      }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  const ex = out.sessions[0].exercises[0];
  assert.equal(ex.targetDurationSec, null);
  assert.equal(ex.targetRepsLow, 6);
  assert.equal(ex.targetRepsHigh, 10);
});

// ---------------------------------------------------------------------------
// 6c. parseResponse — plan-level clamps
// ---------------------------------------------------------------------------

check('parseResponse plan: weeks 12 clamps to 8, deloadWeek 1 clamps to null', () => {
  const payload = planPayload({ weeks: 12, overview: { ...planPayload().overview, deloadWeek: 1 } });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.weeks, 8);
  assert.equal(out.overview.deloadWeek, null, 'a deload week before week 2 is invalid');
});

check('parseResponse plan: weeks 0 clamps up to 6 (the minimum)', () => {
  const payload = planPayload({ weeks: 0 });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.weeks, 6);
});

check('parseResponse plan: weekNotes dedupe by week, drop out-of-range, sort', () => {
  const payload = planPayload({
    weeks: 6,
    weekNotes: [
      { week: 3, focus: 'A', points: ['first'] },
      { week: 3, focus: 'B', points: ['duplicate, dropped'] },
      { week: 0, focus: 'C', points: ['out of range'] },
      { week: 99, focus: 'D', points: ['out of range'] },
      { week: 5, focus: 'E', points: ['fifth'] },
    ],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.deepEqual(out.weekNotes.map((n) => n.week), [3, 5]);
  assert.equal(out.weekNotes[0].focus, 'A', 'first occurrence of a duplicated week wins');
});

check('parseResponse plan: 9 brief bullets truncate to 5', () => {
  const payload = planPayload({
    sessions: [{ ...planPayload().sessions[0], brief: Array.from({ length: 9 }, (_, i) => `Bullet ${i + 1}`) }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions[0].brief.length, 5);
});

check('parseResponse plan: a 300-char purpose truncates to 160', () => {
  const long = 'x'.repeat(300);
  const payload = planPayload({
    sessions: [{
      ...planPayload().sessions[0],
      exercises: [{ ...planPayload().sessions[0].exercises[0], purpose: long }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.ok(out.sessions[0].exercises[0].purpose.length <= 160);
});

check('parseResponse plan: progression clamps — stepWeightKg 20 → 10, everyWeeks 0 → 1, stepDurationSec 0 sentinel → null', () => {
  const payload = planPayload({
    sessions: [{
      ...planPayload().sessions[0],
      exercises: [{
        ...planPayload().sessions[0].exercises[0],
        stepWeightKg: 20, stepReps: 1, stepDurationSec: 0, everyWeeks: 0,
      }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  const prog = out.sessions[0].exercises[0].progression;
  assert.equal(prog.weightStepKg, 10);
  assert.equal(prog.repStep, 1);
  assert.equal(prog.durationStepSec, null, 'the 0 wire sentinel means "no duration step"');
  assert.equal(prog.everyWeeks, 1);
});

check('parseResponse plan: missing step fields become all nulls plus everyWeeks 1', () => {
  const base = planPayload().sessions[0].exercises[0];
  const { stepWeightKg, stepReps, stepDurationSec, everyWeeks, ...withoutSteps } = base;
  const payload = planPayload({ sessions: [{ ...planPayload().sessions[0], exercises: [withoutSteps] }] });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.deepEqual(out.sessions[0].exercises[0].progression, {
    weightStepKg: null, repStep: null, durationStepSec: null, everyWeeks: 1,
  });
});

check('parseResponse plan: an unknown muscleFocus group is dropped, known ones kept', () => {
  const payload = planPayload({
    overview: { ...planPayload().overview, muscleFocus: [{ group: 'quads', why: 'x' }, { group: 'chest', why: 'y' }] },
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.deepEqual(out.overview.muscleFocus, [{ group: 'chest', why: 'y' }]);
});

check('parseResponse plan: targetSets 99 clamps to 8', () => {
  const payload = planPayload({
    sessions: [{ ...planPayload().sessions[0], exercises: [{ ...planPayload().sessions[0].exercises[0], targetSets: 99 }] }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions[0].exercises[0].targetSets, 8);
});

check('parseResponse plan: reps out of range clamp, and low is never above high', () => {
  const payload = planPayload({
    sessions: [{
      ...planPayload().sessions[0],
      exercises: [{ ...planPayload().sessions[0].exercises[0], targetRepsLow: 99, targetRepsHigh: 4 }],
    }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  const ex = out.sessions[0].exercises[0];
  assert.equal(ex.targetRepsLow, 30);
  assert.equal(ex.targetRepsHigh, 30, 'high is lifted to at least low');
});

check('parseResponse plan: sessions trimmed to profile.daysPerWeek (3)', () => {
  const session = (name) => ({
    name, focus: null, brief: [],
    exercises: [{ exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 50, targetRpe: 7, purpose: 'x', goal: 'y', note: null }],
  });
  const payload = planPayload({ sessions: ['A', 'B', 'C', 'D', 'E'].map(session) });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions.length, 3, 'planDigest.profile.daysPerWeek is 3');
  assert.deepEqual(out.sessions.map((s) => s.name), ['A', 'B', 'C']);
  assert.deepEqual(out.sessions.map((s) => s.id), ['ps-1', 'ps-2', 'ps-3']);
});

check('parseResponse plan: exercises capped at 12 per session', () => {
  const base = planPayload().sessions[0].exercises[0];
  const payload = planPayload({ sessions: [{ ...planPayload().sessions[0], exercises: Array.from({ length: 16 }, () => ({ ...base })) }] });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions[0].exercises.length, 12);
});

check('parseResponse: unknown exerciseIds are dropped everywhere', () => {
  const payload = {
    ...goodSession,
    better: [
      { exerciseId: 'ex-ghost', name: 'Ghost Press', note: 'Not a real exercise.' },
      { exerciseId: 'ex-bench', name: 'Bench Press', note: 'Real.' },
    ],
    worse: [{ exerciseId: 'ex-ghost', name: 'Ghost', note: 'Nope.' }],
    planChanges: [{ sessionId: 'ps-1', exerciseId: 'ex-ghost', change: 'add', from: '-', to: '-', reason: 'Invented.' }],
    plan: planPayload({
      sessions: [
        { name: 'Ghost day', focus: null, brief: [], exercises: [{ exerciseId: 'ex-ghost', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 40, targetRpe: 7, purpose: 'x', goal: 'y', note: null }] },
        { name: 'Real day', focus: null, brief: [], exercises: [{ exerciseId: 'ex-squat', targetSets: 3, targetRepsLow: 5, targetRepsHigh: 8, targetWeightKg: 70, targetRpe: 7, purpose: 'x', goal: 'y', note: null }] },
      ],
    }),
  };
  const out = parseResponse('session', messageResponse(payload), { digest: sessionDigest });
  assert.deepEqual(out.better.map((b) => b.exerciseId), ['ex-bench']);
  assert.deepEqual(out.worse, []);
  assert.deepEqual(out.planChanges, []);
  assert.equal(out.plan.sessions.length, 1, 'the all-ghost session must be dropped');
  assert.equal(out.plan.sessions[0].name, 'Real day');
  assert.equal(out.plan.sessions[0].id, 'ps-1', 'ids renumber after the drop');
});

check('parseResponse session: an all-unknown plan collapses to null', () => {
  const payload = {
    ...goodSession,
    plan: planPayload({ sessions: [{ name: 'Ghost', focus: null, brief: [], exercises: [{ exerciseId: 'ex-ghost', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 40, targetRpe: 7, purpose: 'x', goal: 'y', note: null }] }] }),
  };
  const out = parseResponse('session', messageResponse(payload), { digest: sessionDigest });
  assert.equal(out.plan, null);
});

check('parseResponse session: explicit null plan stays null', () => {
  const out = parseResponse('session', messageResponse({ ...goodSession, plan: null }), { digest: sessionDigest });
  assert.equal(out.plan, null);
});

check('parseResponse chat: an all-unknown plan collapses to null too', () => {
  const payload = {
    ...goodChat,
    plan: planPayload({ sessions: [{ name: 'Ghost', focus: null, brief: [], exercises: [{ exerciseId: 'ex-ghost', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 40, targetRpe: 7, purpose: 'x', goal: 'y', note: null }] }] }),
  };
  const out = parseResponse('chat', messageResponse(payload), { digest: chatDigest });
  assert.equal(out.plan, null);
});

check('parseResponse plan: an empty plan throws', () => {
  const payload = planPayload({ sessions: [] });
  assert.throws(
    () => parseResponse('plan', messageResponse(payload), { digest: planDigest }),
    (err) => err instanceof CoachApiError && err.code === 'parse' && /empty plan/i.test(err.message),
  );
});

check('parseResponse: never trusts a model-supplied session id', () => {
  const payload = planPayload({
    sessions: [{ id: 'evil-id', order: 99, name: 'A', focus: null, brief: [], exercises: [{ exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 50, targetRpe: 7, purpose: 'x', goal: 'y', note: null }] }],
  });
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions[0].id, 'ps-1');
  assert.equal(out.sessions[0].order, 1);
});

check('parseResponse: truncates long copy at a word boundary', () => {
  const headline = 'This headline runs on and on and on far past the eighty character budget that the interface allows';
  const out = parseResponse('daily', messageResponse({ ...goodDaily, headline }), { digest: dailyDigest });
  assert.ok(out.headline.length <= 80, `headline is ${out.headline.length} chars`);
  assert.ok(out.headline.endsWith('…'));
  assert.equal(out.headline.includes('  '), false);
  assert.ok(headline.startsWith(out.headline.slice(0, -1)), 'truncation must be a prefix of the original');
});

check('parseResponse: notes and names get their own budgets', () => {
  const long = 'word '.repeat(400);
  const payload = {
    ...goodSession,
    points: [long],
    better: [{ exerciseId: 'ex-bench', name: long, note: long }],
    flags: [{ code: 'rpe-creep', message: long }],
  };
  const out = parseResponse('session', messageResponse(payload), { digest: sessionDigest });
  assert.ok(out.points[0].length <= 200);
  assert.ok(out.better[0].name.length <= 40);
  assert.ok(out.better[0].note.length <= 300);
  assert.ok(out.flags[0].message.length <= 300);
});

check('parseResponse: missing arrays coerce to []', () => {
  const out = parseResponse('session', messageResponse({ overallTone: 'great', points: ['ok'] }), { digest: sessionDigest });
  assert.deepEqual(out.better, []);
  assert.deepEqual(out.worse, []);
  assert.deepEqual(out.flags, []);
  assert.deepEqual(out.planChanges, []);
  assert.equal(out.plan, null);
  const daily = parseResponse('daily', messageResponse({ headline: 'hi' }), { digest: dailyDigest });
  assert.deepEqual(daily.balanceNotes, []);
  assert.equal(daily.recoveryNote, null);
  assert.equal(daily.tone, 'steady', 'an absent tone falls back');
});

check('parseResponse: off-enum values fall back rather than throwing', () => {
  const out = parseResponse('daily', messageResponse({
    ...goodDaily,
    tone: 'ecstatic',
    balanceNotes: [{ group: 'quads', status: 'wrecked', note: 'x' }],
  }), { digest: dailyDigest });
  assert.equal(out.tone, 'steady');
  assert.deepEqual(out.balanceNotes, [{ group: 'other', status: 'unscored', note: 'x' }]);
});

check('parseResponse: unparseable text throws parse', () => {
  assert.throws(
    () => parseResponse('daily', messageResponse('not json at all'), { digest: dailyDigest }),
    (err) => err instanceof CoachApiError && err.code === 'parse' && err.retryable === false,
  );
});

// ---------------------------------------------------------------------------
// 6d. parseResponse — chat-specific clamps
// ---------------------------------------------------------------------------

check('parseResponse chat: reply capped at 10 x 300 chars', () => {
  const payload = { ...goodChat, reply: Array.from({ length: 14 }, (_, i) => `Reply bullet number ${i + 1} `.repeat(20)) };
  const out = parseResponse('chat', messageResponse(payload), { digest: chatDigest });
  assert.equal(out.reply.length, 10);
  for (const line of out.reply) assert.ok(line.length <= 300);
});

check('parseResponse chat: memoryUpdates.add capped at 5 x 160 chars', () => {
  const payload = { ...goodChat, memoryUpdates: { add: Array.from({ length: 8 }, (_, i) => `Fact ${i + 1} `.repeat(40)), removeIds: [] } };
  const out = parseResponse('chat', messageResponse(payload), { digest: chatDigest });
  assert.equal(out.memoryUpdates.add.length, 5);
  for (const fact of out.memoryUpdates.add) assert.ok(fact.length <= 160);
});

check('parseResponse chat: removeIds is filtered to known digest memory ids', () => {
  const payload = { ...goodChat, memoryUpdates: { add: [], removeIds: ['m-1', 'm-unknown', 'm-1', 'm-2'] } };
  const out = parseResponse('chat', messageResponse(payload), { digest: chatDigest });
  assert.deepEqual(out.memoryUpdates.removeIds, ['m-1', 'm-2'], 'unknown ids dropped, duplicates dropped, order kept');
});

check('parseResponse chat: profilePatch pairs are range-checked', () => {
  const payload = {
    ...goodChat,
    profilePatch: [
      { field: 'daysPerWeek', value: '15' },
      { field: 'sessionMinutes', value: '5' },
      { field: 'injuryNotes', value: 'x'.repeat(700) },
      { field: 'split', value: 'nonsense' },
      { field: 'cardioInclude', value: 'true' },
    ],
  };
  const out = parseResponse('chat', messageResponse(payload), { digest: chatDigest });
  assert.equal(out.profilePatch.daysPerWeek, 7);
  assert.equal(out.profilePatch.sessionMinutes, 20);
  assert.equal(out.profilePatch.injuryNotes.length, 600, 'profile text fields clamp at 600 chars');
  assert.equal(out.profilePatch.split, null, 'an invalid split value is dropped');
  assert.equal(out.profilePatch.cardioInclude, true);
  assert.equal(out.profilePatch.equipmentNotes, null, 'a field with no pair stays null');
  assert.equal(out.profilePatch.coreInclude, null);
});

check('parseResponse chat: coreInclude/cardioInclude read "false" as false, not as absent', () => {
  const payload = { ...goodChat, profilePatch: [{ field: 'coreInclude', value: 'false' }] };
  const out = parseResponse('chat', messageResponse(payload), { digest: chatDigest });
  assert.equal(out.profilePatch.coreInclude, false);
  assert.equal(out.profilePatch.cardioInclude, null);
});

check('parseResponse chat: an empty profilePatch list becomes null', () => {
  const out = parseResponse('chat', messageResponse({ ...goodChat, profilePatch: [] }), { digest: chatDigest });
  assert.equal(out.profilePatch, null);
});

check('parseResponse chat: a profilePatch list of unrecognised field names also collapses to null', () => {
  const payload = { ...goodChat, profilePatch: [{ field: 'nonsense', value: 'x' }, { field: 'alsoNonsense', value: 'y' }] };
  const out = parseResponse('chat', messageResponse(payload), { digest: chatDigest });
  assert.equal(out.profilePatch, null);
});

check('parseResponse chat: unknown field names are dropped, known ones kept', () => {
  const payload = { ...goodChat, profilePatch: [{ field: 'daysPerWeek', value: '4' }, { field: 'bogusField', value: 'x' }] };
  const out = parseResponse('chat', messageResponse(payload), { digest: chatDigest });
  assert.equal(out.profilePatch.daysPerWeek, 4);
  assert.equal('bogusField' in out.profilePatch, false);
});

check('parseResponse chat: a malformed (non-array) profilePatch collapses to null rather than throwing', () => {
  const out = parseResponse('chat', messageResponse({ reply: ['ok'] }), { digest: chatDigest });
  assert.equal(out.profilePatch, null);
});

// ---------------------------------------------------------------------------
// 7. stop_reason handling
// ---------------------------------------------------------------------------

check('parseResponse: refusal', () => {
  const json = messageResponse(goodDaily, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'other' } });
  assert.throws(
    () => parseResponse('daily', json, { digest: dailyDigest }),
    (err) => err instanceof CoachApiError
      && err.code === 'refusal'
      && err.retryable === false
      && err.detail.category === 'other',
  );
});

check('parseResponse: max_tokens becomes a retryable truncated error', () => {
  const json = messageResponse('{"headline":"cut off', { stop_reason: 'max_tokens' });
  assert.throws(
    () => parseResponse('daily', json, { digest: dailyDigest }),
    (err) => err instanceof CoachApiError && err.code === 'truncated' && err.retryable === true,
  );
});

// ---------------------------------------------------------------------------
// 8-11. callCoach
// ---------------------------------------------------------------------------

await checkAsync('callCoach: 429, 429, 200 resolves after two backoffs (~1000 then ~4000)', async () => {
  const fetchImpl = fakeFetch([
    { status: 429, body: { error: { message: 'slow down' } } },
    { status: 429, body: { error: { message: 'slow down' } } },
    { status: 200, body: messageResponse(goodDaily) },
  ]);
  const sleep = recordingSleep();
  const out = await callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, sleep, random: () => 0 });
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleep.delays, [1000, 4000]);
  assert.deepEqual(out.narrative, goodDaily);
  assert.deepEqual(out.usage, { inputTokens: 1200, outputTokens: 340 });
  assert.deepEqual(out.raw, { id: 'msg_test', model: COACH_MODEL, stopReason: 'end_turn' });
});

await checkAsync('callCoach: jitter is added on top of the base delay', async () => {
  const fetchImpl = fakeFetch([
    { status: 500, body: {} },
    { status: 200, body: messageResponse(goodDaily) },
  ]);
  const sleep = recordingSleep();
  await callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, sleep, random: () => 1 });
  assert.deepEqual(sleep.delays, [1500]);
});

await checkAsync('callCoach: sends the pinned headers and body on every attempt', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: messageResponse(goodDaily) }]);
  await callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, sleep: recordingSleep(), random: () => 0 });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, COACH_API_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-api-key'], KEY);
  assert.equal(call.init.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(call.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(call.init.signal, 'an abort signal must be attached');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, COACH_MODEL);
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.equal(call.init.body.includes(KEY), false, 'the key must never reach the body');
});

await checkAsync('callCoach: 401 is auth, one call, no retry', async () => {
  const fetchImpl = fakeFetch([{ status: 401, body: { error: { message: 'invalid x-api-key' } } }]);
  const sleep = recordingSleep();
  await assert.rejects(
    callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, sleep, random: () => 0 }),
    (err) => err instanceof CoachApiError && err.code === 'auth' && err.status === 401 && err.retryable === false,
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleep.delays, []);
});

await checkAsync('callCoach: 400 keeps the API message in detail; 404 is model', async () => {
  const bad = fakeFetch([{ status: 400, body: { error: { message: 'output_config.format: unsupported keyword' } } }]);
  await assert.rejects(
    callCoach({ kind: 'plan', digest: planDigest, apiKey: KEY, fetchImpl: bad, sleep: recordingSleep(), random: () => 0 }),
    (err) => err.code === 'request' && err.detail === 'output_config.format: unsupported keyword',
  );
  assert.equal(bad.calls.length, 1);

  const missing = fakeFetch([{ status: 404, body: { error: { message: 'model not found' } } }]);
  await assert.rejects(
    callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl: missing, sleep: recordingSleep(), random: () => 0 }),
    (err) => err.code === 'model' && err.status === 404,
  );
  assert.equal(missing.calls.length, 1);
});

await checkAsync('callCoach: 500 three times throws server after three calls (daily: 3 attempts)', async () => {
  const fetchImpl = fakeFetch([
    { status: 500, body: {} },
    { status: 503, body: {} },
    { status: 529, body: {} },
  ]);
  const sleep = recordingSleep();
  await assert.rejects(
    callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, sleep, random: () => 0 }),
    (err) => err instanceof CoachApiError && err.code === 'server' && err.retryable === true,
  );
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleep.delays, [1000, 4000]);
});

await checkAsync('callCoach: plan kind gets only 2 attempts — 500 twice throws after exactly 2 fetches', async () => {
  const fetchImpl = fakeFetch([
    { status: 500, body: {} },
    { status: 500, body: {} },
  ]);
  const sleep = recordingSleep();
  await assert.rejects(
    callCoach({ kind: 'plan', digest: planDigest, apiKey: KEY, fetchImpl, sleep, random: () => 0 }),
    (err) => err instanceof CoachApiError && err.code === 'server',
  );
  assert.equal(fetchImpl.calls.length, 2, 'MAX_ATTEMPTS.plan is 2');
  assert.deepEqual(sleep.delays, [1000]);
});

await checkAsync('callCoach: Retry-After seconds are honoured', async () => {
  const fetchImpl = fakeFetch([
    { status: 429, body: {}, headers: { 'Retry-After': '2' } },
    { status: 200, body: messageResponse(goodDaily) },
  ]);
  const sleep = recordingSleep();
  await callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, sleep, random: () => 0 });
  assert.equal(sleep.delays.length, 1);
  assert.ok(sleep.delays[0] >= 2000, `expected >= 2000 ms, got ${sleep.delays[0]}`);
});

await checkAsync('callCoach: an absurd Retry-After is capped at 30 s', async () => {
  const fetchImpl = fakeFetch([
    { status: 429, body: {}, headers: { 'retry-after': '600' } },
    { status: 200, body: messageResponse(goodDaily) },
  ]);
  const sleep = recordingSleep();
  await callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, sleep, random: () => 0 });
  assert.equal(sleep.delays[0], 30000);
});

await checkAsync('callCoach: truncated retries once at 1.5x max_tokens', async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: messageResponse('{"overallTone":"sol', { stop_reason: 'max_tokens' }) },
    { status: 200, body: messageResponse(goodSession) },
  ]);
  const sleep = recordingSleep();
  const out = await callCoach({ kind: 'session', digest: sessionDigest, apiKey: KEY, fetchImpl, sleep, random: () => 0 });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).max_tokens, 10000);
  assert.equal(JSON.parse(fetchImpl.calls[1].init.body).max_tokens, 15000);
  assert.equal(out.narrative.overallTone, 'solid');
});

await checkAsync('callCoach: truncated twice gives up as truncated', async () => {
  const truncatedBody = messageResponse('{"overallTone":"sol', { stop_reason: 'max_tokens' });
  const fetchImpl = fakeFetch([
    { status: 200, body: truncatedBody },
    { status: 200, body: truncatedBody },
  ]);
  await assert.rejects(
    callCoach({ kind: 'session', digest: sessionDigest, apiKey: KEY, fetchImpl, sleep: recordingSleep(), random: () => 0 }),
    (err) => err instanceof CoachApiError && err.code === 'truncated',
  );
  assert.equal(fetchImpl.calls.length, 2);
});

await checkAsync('callCoach: refusal is not retried', async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: messageResponse(goodDaily, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'other' } }) },
  ]);
  await assert.rejects(
    callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, sleep: recordingSleep(), random: () => 0 }),
    (err) => err.code === 'refusal',
  );
  assert.equal(fetchImpl.calls.length, 1);
});

await checkAsync('callCoach: a network TypeError becomes offline, not retried', async () => {
  const fetchImpl = fakeFetch([{ throwErr: new TypeError('Failed to fetch') }]);
  await assert.rejects(
    callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, sleep: recordingSleep(), random: () => 0 }),
    (err) => err instanceof CoachApiError && err.code === 'offline' && err.retryable === false,
  );
  assert.equal(fetchImpl.calls.length, 1);
});

await checkAsync('callCoach: an empty key throws auth with zero fetch calls', async () => {
  for (const key of ['', '   ', null, undefined]) {
    const fetchImpl = fakeFetch([]);
    await assert.rejects(
      callCoach({ kind: 'daily', digest: dailyDigest, apiKey: key, fetchImpl, sleep: recordingSleep(), random: () => 0 }),
      (err) => err instanceof CoachApiError && err.code === 'auth',
    );
    assert.equal(fetchImpl.calls.length, 0);
  }
});

await checkAsync('callCoach: an already-aborted external signal surfaces the abort', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async (url, init) => {
    if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error('should not get here');
  };
  await assert.rejects(
    callCoach({ kind: 'daily', digest: dailyDigest, apiKey: KEY, fetchImpl, signal: controller.signal, sleep: recordingSleep(), random: () => 0 }),
    (err) => err.name === 'AbortError',
  );
});

// ---------------------------------------------------------------------------
// 11b. Timeouts and attempts
// ---------------------------------------------------------------------------

check('TIMEOUT_MS and timeoutFor: per-kind defaults and override behaviour', () => {
  assert.deepEqual(TIMEOUT_MS, { daily: 60000, session: 90000, plan: 180000, chat: 60000 });
  for (const kind of ['daily', 'session', 'plan', 'chat']) {
    assert.equal(timeoutFor(kind, undefined), TIMEOUT_MS[kind]);
    assert.equal(timeoutFor(kind, null), TIMEOUT_MS[kind]);
    assert.equal(timeoutFor(kind, 0), TIMEOUT_MS[kind]);
    assert.equal(timeoutFor(kind, -5), TIMEOUT_MS[kind]);
    assert.equal(timeoutFor(kind, NaN), TIMEOUT_MS[kind]);
    assert.equal(timeoutFor(kind, 5000), 5000, 'a positive override wins');
  }
  assert.equal(timeoutFor('unknown-kind', undefined), 60000, 'unknown kinds fall back to the default timeout');
});

check('MAX_ATTEMPTS and attemptsFor: plan gets 2, everything else gets 3', () => {
  assert.deepEqual(MAX_ATTEMPTS, { plan: 2, default: 3 });
  assert.equal(attemptsFor('plan'), 2);
  for (const kind of ['daily', 'session', 'chat', 'unknown-kind']) {
    assert.equal(attemptsFor(kind), 3);
  }
});

// ---------------------------------------------------------------------------
// 12. Copy and cost
// ---------------------------------------------------------------------------

check('userMessageFor: pinned copy', () => {
  const cases = {
    offline: 'No connection — the coach will catch up next time you open the app.',
    auth: 'Your API key was rejected. Check it in Settings → Coach.',
    model: "This API key can't use Claude Sonnet 5.",
    'rate-limit': 'Rate limited — trying again shortly.',
    server: 'Claude is busy — the coach will try again later.',
    refusal: 'The coach declined to answer this one.',
    truncated: "The coach couldn't process that.",
    parse: "The coach couldn't process that.",
    request: "The coach couldn't process that.",
  };
  for (const [code, copy] of Object.entries(cases)) {
    assert.equal(userMessageFor(new CoachApiError(code, 'internal detail')), copy, code);
  }
  assert.equal(userMessageFor(new Error('boom')), 'Something went wrong talking to the coach.');
  assert.equal(userMessageFor(null), 'Something went wrong talking to the coach.');
  assert.equal(userMessageFor(new CoachApiError('who-knows', 'x')), 'Something went wrong talking to the coach.');
});

check('userMessageFor: never leaks a key or a status code', () => {
  const err = new CoachApiError('auth', `bad key ${KEY}`, { status: 401, detail: KEY });
  assert.equal(userMessageFor(err).includes(KEY), false);
  assert.equal(/401/.test(userMessageFor(err)), false);
});

check('estimateCostUsd / usageFrom', () => {
  assert.equal(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }), 2);
  assert.equal(estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000 }), 10);
  assert.equal(estimateCostUsd({ inputTokens: 0, outputTokens: 0 }), 0);
  assert.ok(Math.abs(estimateCostUsd({ inputTokens: 500_000, outputTokens: 100_000 }) - 2) < 1e-9);
  assert.equal(PRICING.inputPerMTok, 2.0);
  assert.equal(PRICING.outputPerMTok, 10.0);
  assert.deepEqual(usageFrom(messageResponse(goodDaily)), { inputTokens: 1200, outputTokens: 340 });
  assert.deepEqual(usageFrom({}), { inputTokens: 0, outputTokens: 0 });
});

// ---------------------------------------------------------------------------
// 13. testApiKey
// ---------------------------------------------------------------------------

await checkAsync('testApiKey: posts to count_tokens with the same headers', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { input_tokens: 12 } }]);
  const out = await testApiKey(KEY, { fetchImpl });
  assert.deepEqual(out, { ok: true });
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, COACH_COUNT_TOKENS_URL);
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, buildHeaders(KEY));
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, COACH_MODEL);
  assert.equal(body.messages.length, 1);
  assert.equal(JSON.stringify(body).includes('schemaVersion'), false, 'must not send a digest');
});

await checkAsync('testApiKey: 401 throws auth; empty key never calls out', async () => {
  const fetchImpl = fakeFetch([{ status: 401, body: { error: { message: 'invalid x-api-key' } } }]);
  await assert.rejects(testApiKey(KEY, { fetchImpl }), (err) => err instanceof CoachApiError && err.code === 'auth');
  assert.equal(fetchImpl.calls.length, 1);

  const unused = fakeFetch([]);
  await assert.rejects(testApiKey('', { fetchImpl: unused }), (err) => err.code === 'auth');
  assert.equal(unused.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 14. normaliseNarrative — v1 → v2 shim
// ---------------------------------------------------------------------------

check('normaliseNarrative: v1 daily {body, todayAdvice} becomes {points, advice}', () => {
  const v1 = { headline: 'Chest lagging', body: 'Bench has not moved.', todayAdvice: 'Push it today.', tone: 'steady' };
  const out = normaliseNarrative('daily', v1);
  assert.deepEqual(out.points, ['Bench has not moved.']);
  assert.deepEqual(out.advice, ['Push it today.']);
  assert.equal(out.headline, 'Chest lagging');
});

check('normaliseNarrative: v1 session {summary} becomes {points}', () => {
  const v1 = { overallTone: 'solid', summary: 'Bench moved up.', better: [], worse: [], flags: [], planChanges: [], plan: null };
  const out = normaliseNarrative('session', v1);
  assert.deepEqual(out.points, ['Bench moved up.']);
});

check('normaliseNarrative: v1 chat {text} becomes {reply}', () => {
  const v1 = { text: 'Sure, adding cardio Friday.' };
  const out = normaliseNarrative('chat', v1);
  assert.deepEqual(out.reply, ['Sure, adding cardio Friday.']);
});

check('normaliseNarrative: v1 plan {rationale} becomes overview.points, adds empty weekNotes', () => {
  const v1 = { weeks: 6, rationale: 'Rebuild volume first.', sessions: [] };
  const out = normaliseNarrative('plan', v1);
  assert.deepEqual(out.overview.points, ['Rebuild volume first.']);
  assert.deepEqual(out.overview.muscleFocus, []);
  assert.equal(out.overview.deloadWeek, null);
  assert.deepEqual(out.weekNotes, []);
});

check('normaliseNarrative: already-v2 input is returned unchanged (same reference)', () => {
  assert.equal(normaliseNarrative('daily', goodDaily), goodDaily);
  assert.equal(normaliseNarrative('plan', goodPlan), goodPlan);
  const sessionOut = normaliseNarrative('session', goodSession);
  assert.equal(sessionOut, goodSession);
  const chatOut = normaliseNarrative('chat', goodChat);
  assert.equal(chatOut, goodChat);
});

check('normaliseNarrative: null-safe', () => {
  assert.equal(normaliseNarrative('daily', null), null);
  assert.equal(normaliseNarrative('daily', undefined), undefined);
  assert.deepEqual(normaliseNarrative('daily', ['not', 'an', 'object']), ['not', 'an', 'object']);
});

console.log(`\nAll ${passed} assertions passed.`);
process.exit(0);
