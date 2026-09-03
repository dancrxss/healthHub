// Pure-Node unit tests for js/coach-api.js — zero dependencies, Node built-ins only.
// Run: `node tests/coach-api.test.mjs`  (exits non-zero on any failure).
//
// Never touches the network: `fetchImpl`, `sleep` and `random` are injected.
// The digest fixtures are hand-written to the shape documented in PLAN.md C2 —
// this file deliberately does not import js/coach-engine.js.

import assert from 'node:assert/strict';
import {
  COACH_MODEL,
  COACH_API_URL,
  COACH_COUNT_TOKENS_URL,
  ANTHROPIC_VERSION,
  MAX_TOKENS,
  SYSTEM_PROMPT,
  SCHEMAS,
  PRICING,
  CoachApiError,
  buildHeaders,
  buildRequest,
  extractText,
  parseResponse,
  estimateCostUsd,
  usageFrom,
  userMessageFor,
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
// Fixtures
// ---------------------------------------------------------------------------

const KEY = 'sk-ant-test-key-not-real';

/** Digest for kind 'daily' / 'plan'. daysPerWeek 3, three known exercises. */
const dailyDigest = {
  schemaVersion: 1,
  kind: 'daily',
  today: '2099-01-05',
  profile: {
    goal: 'return-from-injury',
    daysPerWeek: 3,
    sessionMinutes: 45,
    injuryNotes: 'left shoulder, cleared by physio',
    equipmentNotes: 'commercial gym',
    avoid: [],
  },
  gap: { daysSinceLastSession: 21, weeksOff: 3, status: 'long-layoff', detrainingPct: 0.02 },
  week: { isoWeek: '2099-W01', sessions: 1, hardSets: 12, volumeKg: 4200, avgRpe: 7.5 },
  balance: [
    { g: 'chest', sets: 4, min: 10, max: 20, status: 'under', trend: 'flat' },
    { g: 'legs', sets: 14, min: 12, max: 22, status: 'on', trend: 'up' },
  ],
  flags: [{ code: 'return-ramp', severity: 'info', detail: 'Week 1 back' }],
  exercises: [
    { id: 'ex-bench', name: 'Bench Press', group: 'chest', type: 'strength', lastDate: '2098-12-15', workWeightKg: 60, topReps: 8, e1rm: 76, e1rmPrev: 74, bestE1rm: 90, weeksSince: 3, proposal: { weightKg: 50, repsLow: 6, repsHigh: 8, sets: 3, rule: 'layoff' } },
    { id: 'ex-squat', name: 'Back Squat', group: 'legs', type: 'strength', lastDate: '2098-12-15', workWeightKg: 90, topReps: 5, e1rm: 105, e1rmPrev: 103, bestE1rm: 120, weeksSince: 3, proposal: { weightKg: 70, repsLow: 5, repsHigh: 8, sets: 3, rule: 'layoff' } },
    { id: 'ex-row', name: 'Barbell Row', group: 'back', type: 'strength', lastDate: '2098-12-15', workWeightKg: 55, topReps: 10, e1rm: 73, e1rmPrev: 70, bestE1rm: 80, weeksSince: 3, proposal: { weightKg: 45, repsLow: 8, repsHigh: 12, sets: 3, rule: 'layoff' } },
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

const planDigest = { ...dailyDigest, kind: 'plan' };

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
  body: 'Bench Press has not been trained in three weeks and chest sits under its band.',
  balanceNotes: [{ group: 'chest', status: 'under', note: 'Four hard sets against a floor of ten.' }],
  recoveryNote: null,
  todayAdvice: 'Open with Bench Press at fifty kilos for three sets of eight, then Barbell Row.',
  tone: 'steady',
};

const goodPlan = {
  weeks: 6,
  rationale: 'Rebuild volume before intensity after a three-week layoff.',
  sessions: [
    { name: 'Upper A', focus: 'push', exercises: [{ exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 50, targetRpe: 7, note: 'Stop two shy.' }] },
    { name: 'Lower A', focus: null, exercises: [{ exerciseId: 'ex-squat', targetSets: 3, targetRepsLow: 5, targetRepsHigh: 8, targetWeightKg: 70, targetRpe: 7.5, note: null }] },
  ],
};

const goodSession = {
  overallTone: 'solid',
  summary: 'Bench moved up, everything else held.',
  better: [{ exerciseId: 'ex-bench', name: 'Bench Press', note: 'Sixty kilos for eight, up from 57.5.' }],
  worse: [],
  flags: [{ code: 'return-ramp', message: 'First week back — keep the lid on.' }],
  planChanges: [{ sessionId: 'ps-1', exerciseId: 'ex-bench', change: 'weight-up', from: '57.5 kg x 8', to: '60 kg x 8', reason: 'Cleared the top of the range at RPE 7.5.' }],
  plan: goodPlan,
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
// 1. buildRequest shape
// ---------------------------------------------------------------------------

check('buildRequest: daily shape', () => {
  const { url, body } = buildRequest({ kind: 'daily', digest: dailyDigest });
  assert.equal(url, COACH_API_URL);
  assert.equal(body.model, COACH_MODEL);
  assert.equal(body.max_tokens, 4000);
  assert.equal(body.max_tokens, MAX_TOKENS.daily);
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema, SCHEMAS.daily);
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content, JSON.stringify(dailyDigest));
});

check('buildRequest: session shape (medium effort, 8000 tokens)', () => {
  const { body } = buildRequest({ kind: 'session', digest: sessionDigest });
  assert.equal(body.max_tokens, 8000);
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.schema, SCHEMAS.session);
  assert.equal(body.messages[0].content, JSON.stringify(sessionDigest));
});

check('buildRequest: plan shape (medium effort, 8000 tokens)', () => {
  const { body } = buildRequest({ kind: 'plan', digest: planDigest });
  assert.equal(body.max_tokens, 8000);
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.schema, SCHEMAS.plan);
});

check('buildRequest: unknown kind is rejected', () => {
  assert.throws(() => buildRequest({ kind: 'weekly', digest: dailyDigest }), (err) => err instanceof CoachApiError);
});

// ---------------------------------------------------------------------------
// 2. Forbidden request fields
// ---------------------------------------------------------------------------

check('buildRequest: never sends thinking/sampling/tool params or a prefill', () => {
  for (const kind of ['daily', 'session', 'plan']) {
    const { body } = buildRequest({ kind, digest: dailyDigest });
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

check('SYSTEM_PROMPT: identical across different digests', () => {
  const a = buildRequest({ kind: 'daily', digest: dailyDigest }).body.system;
  const b = buildRequest({ kind: 'session', digest: sessionDigest }).body.system;
  assert.equal(a, b);
  assert.equal(a, SYSTEM_PROMPT);
});

check('SYSTEM_PROMPT: no interpolation, no dates, under 6000 chars', () => {
  assert.equal(typeof SYSTEM_PROMPT, 'string');
  assert.equal(SYSTEM_PROMPT.includes('${'), false, 'system prompt must not interpolate');
  assert.equal(/\b(19|20)\d{2}\b/.test(SYSTEM_PROMPT), false, 'system prompt must not contain a year');
  assert.ok(SYSTEM_PROMPT.length < 6000, `system prompt is ${SYSTEM_PROMPT.length} chars`);
  assert.ok(SYSTEM_PROMPT.length > 1500, 'system prompt looks truncated');
});

// ---------------------------------------------------------------------------
// 4. Schema legality walk
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

for (const kind of ['daily', 'session', 'plan']) {
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

  check(`schema ${kind}: every $ref resolves inside the same schema`, () => {
    const root = SCHEMAS[kind];
    let refs = 0;
    walkSchema(root, kind, (node, path) => {
      if (typeof node.$ref !== 'string') return;
      refs += 1;
      assert.ok(node.$ref.startsWith('#/'), `${path}: only local refs allowed`);
      assert.notEqual(resolvePointer(root, node.$ref), undefined, `${path}: ${node.$ref} does not resolve`);
    });
    if (kind === 'session') assert.equal(refs, 1, 'session schema should reference $defs/plan exactly once');
    else assert.equal(refs, 0, `${kind} schema should carry no refs`);
  });
}

check('schema session: plan is nullable via anyOf against $defs/plan', () => {
  const plan = SCHEMAS.session.properties.plan;
  assert.deepEqual(plan, { anyOf: [{ $ref: '#/$defs/plan' }, { type: 'null' }] });
  assert.equal(SCHEMAS.session.$defs.plan.type, 'object');
});

check('schema plan: top level is the plan object itself', () => {
  assert.deepEqual([...SCHEMAS.plan.required].sort(), ['rationale', 'sessions', 'weeks']);
  assert.deepEqual(SCHEMAS.plan, SCHEMAS.session.$defs.plan);
  assert.notEqual(SCHEMAS.plan, SCHEMAS.session.$defs.plan, 'the two emissions must not share nodes');
});

check('schema daily: enums and nullables', () => {
  assert.deepEqual(SCHEMAS.daily.properties.tone.enum, ['encouraging', 'steady', 'caution']);
  assert.deepEqual(SCHEMAS.daily.properties.recoveryNote, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  const groups = SCHEMAS.daily.properties.balanceNotes.items.properties.group.enum;
  assert.deepEqual(groups, ['chest', 'back', 'legs', 'shoulders', 'biceps', 'triceps', 'abs', 'cardio', 'accessory', 'rehab', 'other']);
});

check('schema session: flag codes cover the engine list plus other', () => {
  const codes = SCHEMAS.session.properties.flags.items.properties.code.enum;
  for (const c of ['volume-spike', 'group-volume-spike', 'rpe-creep', 'e1rm-regression', 'no-rest-day', 'frequency-drop', 'return-ramp', 'low-hrv', 'elevated-rhr', 'short-sleep', 'weight-drop', 'other']) {
    assert.ok(codes.includes(c), `missing flag code ${c}`);
  }
  assert.equal(codes.length, 12);
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
// 6. parseResponse
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
});

check('parseResponse plan: happy path', () => {
  const out = parseResponse('plan', messageResponse(goodPlan), { digest: planDigest });
  assert.equal(out.weeks, 6);
  assert.equal(out.sessions.length, 2);
  assert.equal(out.sessions[0].id, 'ps-1');
  assert.equal(out.sessions[0].exercises[0].exerciseId, 'ex-bench');
});

check('parseResponse: session-only exercise ids count as known', () => {
  const payload = { ...goodSession, better: [{ exerciseId: 'ex-ohp', name: 'Overhead Press', note: 'First time back.' }] };
  const out = parseResponse('session', messageResponse(payload), { digest: sessionDigest });
  assert.deepEqual(out.better.map((b) => b.exerciseId), ['ex-ohp']);
  // ...but not for a daily digest, which has no session block.
  const daily = parseResponse('session', messageResponse(payload), { digest: dailyDigest });
  assert.deepEqual(daily.better, []);
});

check('parseResponse: clamps sets, reps, weight and RPE', () => {
  const payload = {
    weeks: 99,
    rationale: 'x',
    sessions: [{
      name: 'Upper A',
      focus: null,
      exercises: [{ exerciseId: 'ex-bench', targetSets: 99, targetRepsLow: 12, targetRepsHigh: 4, targetWeightKg: 72.3, targetRpe: 12, note: null }],
    }],
  };
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  const ex = out.sessions[0].exercises[0];
  assert.equal(out.weeks, 16);
  assert.equal(ex.targetSets, 8);
  assert.equal(ex.targetRepsLow, 12);
  assert.equal(ex.targetRepsHigh, 12, 'high must be lifted to at least low');
  assert.equal(ex.targetWeightKg, 72.5);
  assert.equal(ex.targetRpe, 10);
});

check('parseResponse: weight and RPE floors, and out-of-range reps', () => {
  const payload = {
    weeks: 0,
    rationale: 'x',
    sessions: [{
      name: 'Lower',
      focus: null,
      exercises: [{ exerciseId: 'ex-squat', targetSets: 0, targetRepsLow: 99, targetRepsHigh: 99, targetWeightKg: 900, targetRpe: 1, note: null }],
    }],
  };
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  const ex = out.sessions[0].exercises[0];
  assert.equal(out.weeks, 1);
  assert.equal(ex.targetSets, 1);
  assert.equal(ex.targetRepsLow, 30);
  assert.equal(ex.targetRepsHigh, 30);
  assert.equal(ex.targetWeightKg, 500);
  assert.equal(ex.targetRpe, 5);
});

check('parseResponse: null weight and RPE survive', () => {
  const payload = {
    weeks: 4,
    rationale: 'x',
    sessions: [{ name: 'Full', focus: null, exercises: [{ exerciseId: 'ex-row', targetSets: 3, targetRepsLow: 8, targetRepsHigh: 12, targetWeightKg: null, targetRpe: null, note: null }] }],
  };
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions[0].exercises[0].targetWeightKg, null);
  assert.equal(out.sessions[0].exercises[0].targetRpe, null);
});

check('parseResponse: sessions trimmed to daysPerWeek (3)', () => {
  const session = (name) => ({ name, focus: null, exercises: [{ exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 50, targetRpe: 7, note: null }] });
  const payload = { weeks: 4, rationale: 'x', sessions: ['A', 'B', 'C', 'D', 'E'].map(session) };
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions.length, 3);
  assert.deepEqual(out.sessions.map((s) => s.name), ['A', 'B', 'C']);
  assert.deepEqual(out.sessions.map((s) => s.id), ['ps-1', 'ps-2', 'ps-3']);
});

check('parseResponse: exercises capped at 10 per session', () => {
  const exercise = () => ({ exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 50, targetRpe: 7, note: null });
  const payload = { weeks: 4, rationale: 'x', sessions: [{ name: 'A', focus: null, exercises: Array.from({ length: 14 }, exercise) }] };
  const out = parseResponse('plan', messageResponse(payload), { digest: planDigest });
  assert.equal(out.sessions[0].exercises.length, 10);
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
    plan: {
      weeks: 4,
      rationale: 'x',
      sessions: [
        { name: 'Ghost day', focus: null, exercises: [{ exerciseId: 'ex-ghost', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 40, targetRpe: 7, note: null }] },
        { name: 'Real day', focus: null, exercises: [{ exerciseId: 'ex-squat', targetSets: 3, targetRepsLow: 5, targetRepsHigh: 8, targetWeightKg: 70, targetRpe: 7, note: null }] },
      ],
    },
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
    plan: { weeks: 4, rationale: 'x', sessions: [{ name: 'Ghost', focus: null, exercises: [{ exerciseId: 'ex-ghost', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 40, targetRpe: 7, note: null }] }] },
  };
  const out = parseResponse('session', messageResponse(payload), { digest: sessionDigest });
  assert.equal(out.plan, null);
});

check('parseResponse session: explicit null plan stays null', () => {
  const out = parseResponse('session', messageResponse({ ...goodSession, plan: null }), { digest: sessionDigest });
  assert.equal(out.plan, null);
});

check('parseResponse plan: an empty plan throws', () => {
  const payload = { weeks: 4, rationale: 'x', sessions: [] };
  assert.throws(
    () => parseResponse('plan', messageResponse(payload), { digest: planDigest }),
    (err) => err instanceof CoachApiError && err.code === 'parse' && /empty plan/i.test(err.message),
  );
});

check('parseResponse: never trusts a model-supplied session id', () => {
  const payload = {
    weeks: 4,
    rationale: 'x',
    sessions: [{ id: 'evil-id', order: 99, name: 'A', focus: null, exercises: [{ exerciseId: 'ex-bench', targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 50, targetRpe: 7, note: null }] }],
  };
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

check('parseResponse: body, notes and names get their own budgets', () => {
  const long = 'word '.repeat(400);
  const payload = {
    ...goodSession,
    summary: long,
    better: [{ exerciseId: 'ex-bench', name: long, note: long }],
    flags: [{ code: 'rpe-creep', message: long }],
  };
  const out = parseResponse('session', messageResponse(payload), { digest: sessionDigest });
  assert.ok(out.summary.length <= 600);
  assert.ok(out.better[0].name.length <= 40);
  assert.ok(out.better[0].note.length <= 300);
  assert.ok(out.flags[0].message.length <= 300);
});

check('parseResponse: missing arrays coerce to []', () => {
  const out = parseResponse('session', messageResponse({ overallTone: 'great', summary: 'ok' }), { digest: sessionDigest });
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

await checkAsync('callCoach: 429, 429, 200 resolves after two backoffs', async () => {
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
  assert.ok(call.init.signal, 'a 60 s abort signal must be attached');
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

await checkAsync('callCoach: 500 three times throws server after three calls', async () => {
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
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).max_tokens, 8000);
  assert.equal(JSON.parse(fetchImpl.calls[1].init.body).max_tokens, 12000);
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
// 11b / 12. Copy and cost
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

console.log(`\nAll ${passed} assertions passed.`);
process.exit(0);
