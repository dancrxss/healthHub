// E2E: drive the reworked RepCount-style gym-tracker PWA headlessly over CDP.
// One fresh Chrome profile (from tests/e2e.sh) drives a single continuous walk —
// state (IndexedDB, localStorage, service worker) persists across every step.
//
// Selectors are mined from the real code (ui.js, screens/workout.js,
// screens/picker.js, db.js, seed.js, timer.js) and the pinned DOM-hook contract
// in PLAN.md §"Phase 1.5". The four tab screens (log/routines/stats/profile) are
// asserted only structurally against their pinned hooks.
//
// Robustness rules followed throughout: never fixed-sleep for a state change —
// always poll(); every interaction uses element.click()/dispatchEvent directly
// (bypasses hit-testing so overlays/sheets never block a click); every add-set is
// confirmed persisted before the next one (avoids the pre-re-render duplicate-tap
// race); failures carry a detail string.

const DEBUG_PORT = 9223;
const APP_URL = 'http://127.0.0.1:8741/index.html';
const J = (v) => JSON.stringify(v);

const BBP = 'seed-barbell-bench-press';
const ASSAULT = 'seed-assault-bike';
const CABLE_FLY = 'seed-cable-fly';
const TRI_PUSHDOWN = 'seed-triceps-pushdown';

let passCount = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`PASS — ${name}`); }
  else { failures.push(name); console.log(`FAIL — ${name}${detail ? ` :: ${detail}` : ''}`); }
}

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?url=about:blank`, { method: 'PUT' });
      if (res.ok) return res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome debug port never came up');
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
// Collected across the whole walk (step 16): uncaught exceptions + console errors.
const jsErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    const e = msg.params?.exceptionDetails;
    jsErrors.push('exception: ' + (e?.exception?.description || e?.text || 'unknown'));
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const t = msg.params?.type;
    if (t === 'error' || t === 'assert') {
      const txt = (msg.params.args || []).map((a) => a.description || a.value || '').join(' ');
      jsErrors.push('console.' + t + ': ' + txt);
    }
  }
};
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}
async function evalJS(expression) {
  const msg = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (msg.result?.exceptionDetails) {
    throw new Error('page threw: ' + JSON.stringify(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text));
  }
  return msg.result?.result?.value;
}
async function poll(name, expression, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    let v;
    try { v = await evalJS(expression); } catch (e) { last = e.message; v = undefined; }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`poll timed out: ${name}${last ? ` (last error: ${last})` : ''}`);
}

// ---- interaction helpers ---------------------------------------------------
async function clickSel(name, sel, timeoutMs = 8000) {
  await poll(`${name} present`, `document.querySelector(${J(sel)}) != null`, timeoutMs);
  const ok = await evalJS(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`click failed (element vanished): ${sel}`);
}
// Click the first element matching `sel` whose trimmed textContent includes `txt`.
async function clickText(name, sel, txt, timeoutMs = 8000) {
  await poll(`${name} present`, `[...document.querySelectorAll(${J(sel)})].some(e => e.textContent.trim().includes(${J(txt)}))`, timeoutMs);
  const ok = await evalJS(`(() => { const el = [...document.querySelectorAll(${J(sel)})].find(e => e.textContent.trim().includes(${J(txt)})); if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`click-by-text failed: ${sel} ~ ${txt}`);
}
async function count(sel) { return evalJS(`document.querySelectorAll(${J(sel)}).length`); }
async function exists(sel) { return evalJS(`document.querySelector(${J(sel)}) != null`); }

// Open the exercise picker from the workout screen and WAIT for renderPick to
// swap in the fresh DOM. The picker screen keeps its previous visit's DOM mounted
// (hidden) between visits, and renderPick runs async off the hashchange — so we
// mark the current subtree stale, then poll until it detaches (replaced) rather
// than racing the swap. First-ever visit has no subtree, so fall back to .pick-head.
async function gotoPicker(name) {
  await evalJS(`(() => { window.__pickStale = document.querySelector('#s-pick > *') || null; return true; })()`);
  await clickSel(name, '#s-workout [data-action="add-exercise"]');
  await poll('picker route (#/pick)', `location.hash === '#/pick'`);
  await poll('picker rendered fresh', `(() => {
    const stale = window.__pickStale;
    return stale ? !document.contains(stale) : document.querySelector('#s-pick .pick-head') != null;
  })()`);
}

// Set the picker search box and fire its input handler.
async function pickSearch(value) {
  await poll('picker search box', `document.querySelector('#s-pick .pick-search') != null`);
  await evalJS(`(() => { const s = document.querySelector('#s-pick .pick-search'); s.value = ${J(value)}; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
}

// Type into the always-present set input (row `idx` within `cardSel`, by
// data-field) and commit via blur. The commit persists quietly (no re-render),
// so callers must poll the DB for the new value before moving on.
async function setField(name, cardSel, idx, field, value) {
  await poll(`${name} input present`, `(() => {
    const rows = document.querySelectorAll(${J(cardSel + ' .set-row')});
    return rows[${idx}] && rows[${idx}].querySelector('input.set-input[data-field=${J(field)}]') != null;
  })()`);
  const ok = await evalJS(`(() => {
    const row = document.querySelectorAll(${J(cardSel + ' .set-row')})[${idx}];
    const i = row && row.querySelector('input.set-input[data-field=${J(field)}]');
    if (!i) return false;
    i.value = ${J(String(value))};
    i.dispatchEvent(new Event('blur'));
    return true;
  })()`);
  if (!ok) throw new Error(`setField failed: ${name}`);
}

// Load the current in-progress workout's sets for one exercise (sorted by setNumber).
function setsExpr(exerciseId) {
  return `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    if (!wid) return [];
    const s = await db.listSetsForWorkout(wid);
    return s.filter((x) => x.exerciseId === ${J(exerciseId)}).sort((a, b) => a.setNumber - b.setNumber);
  })()`;
}
const bbpCard = `.ex-card[data-exercise-id="${BBP}"]`;
const assaultCard = `.ex-card[data-exercise-id="${ASSAULT}"]`;

// Finish the active workout: header tick -> confirm sheet -> Finish, lands on #/log.
async function finishActiveWorkout() {
  await clickSel('finish (header tick)', '#s-workout [data-action="finish"]');
  await clickSel('confirm-finish', '#sheet-root [data-action="confirm"]');
  await poll('finish lands on #/log', `location.hash === '#/log' && !document.getElementById('s-log').hidden`);
}

await send('Page.enable');
await send('Runtime.enable');
// window.confirm is no longer used (sheets replaced it) — keep a harmless shim anyway.
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm = () => true;' });
await send('Page.navigate', { url: APP_URL });

let w1id = null;

try {
  // --- 1. Fresh app: seed ran, #/log renders, 4 tabs, empty log ---
  await poll('app boots to #/log', `location.hash === '#/log' && !document.getElementById('s-log').hidden`, 12000);
  const seedCount = await poll('seed exercises loaded', `import('./js/db.js').then(m => m.listExercises()).then(l => l.length)`);
  check('seed: 61 exercises seeded on fresh install (55 strength + 6 cardio)', seedCount === 61, `got ${seedCount}`);
  check('shell: tab bar has 4 tabs', (await count('#tabbar button')) === 4, `got ${await count('#tabbar button')}`);
  check('log: empty state has no month groups yet', (await count('#s-log .month-group')) === 0, `got ${await count('#s-log .month-group')}`);

  // --- 2. Tab switching: each tab shows its screen, hides the rest ---
  const TABS = ['log', 'routines', 'stats', 'profile'];
  let tabsOk = true; let tabDetail = '';
  for (const tab of TABS) {
    await clickSel(`tab ${tab}`, `#tabbar button[data-tab="${tab}"]`);
    await poll(`${tab} screen visible`, `!document.getElementById('s-${tab}').hidden`);
    const othersHidden = await evalJS(`['log','routines','stats','profile'].filter(t => t !== ${J(tab)}).every(t => document.getElementById('s-'+t).hidden)`);
    if (!othersHidden) { tabsOk = false; tabDetail = `others not hidden on ${tab}`; }
  }
  check('tabs: switching shows one screen and hides the other three', tabsOk, tabDetail);

  // --- 3. Start a workout from the Log tab ---
  await clickSel('log tab', '#tabbar button[data-tab="log"]');
  await clickSel('start-workout (+)', '#s-log [data-action="start-workout"]');
  await poll('lands on #/workout', `location.hash === '#/workout' && !document.getElementById('s-workout').hidden`);
  await poll('workout meta card rendered', `document.querySelector('#s-workout .wmeta') != null`);
  check('start: workout screen has a meta card (.wmeta)', await exists('#s-workout .wmeta'));
  check('start: body is fullscreen (tab bar hidden)', await evalJS(`document.body.classList.contains('fullscreen')`));
  w1id = await poll('active workout id captured', `localStorage.getItem('currentWorkoutId')`);

  // --- 4. Add exercise via category -> Barbell Bench Press ---
  await gotoPicker('add-exercise');
  await clickText('category Chest', '#s-pick .pick-cat', 'Chest');
  await poll('category list (#/pick/chest)', `location.hash === '#/pick/chest'`);
  // Wait for the exercise list to render before asserting its shape (avoids racing
  // the async renderPick swap while the old category list is still on screen).
  await poll('chest exercise rows rendered', `document.querySelectorAll('#s-pick .pick-row').length > 0`);
  check('picker: within a category, rows are div.pick-row (no category buttons)', (await count('#s-pick .pick-cat')) === 0, `pick-cat=${await count('#s-pick .pick-cat')}`);
  await clickSel('pick Barbell Bench Press', `#s-pick .pick-row[data-exercise-id="${BBP}"]`);
  await poll('back on #/workout with bench card', `location.hash === '#/workout' && document.querySelector(${J(bbpCard)}) != null`);
  check('picker: tapping a .pick-row appends an exercise card', await exists(bbpCard));

  // --- 5. Auto set 1 + one-tap duplication via Add Set ---
  await poll('bench auto set 1 rendered', `document.querySelectorAll(${J(bbpCard + ' .set-row')}).length === 1`);
  const bbpAuto = await evalJS(setsExpr(BBP));
  check('log: adding an exercise auto-creates one blank set (0 kg × 0)',
    bbpAuto.length === 1 && bbpAuto[0]?.weightKg === 0 && bbpAuto[0]?.reps === 0, JSON.stringify(bbpAuto));
  check('log: blank set renders empty inputs with a grey placeholder',
    await evalJS(`(() => {
      const i = document.querySelector(${J(bbpCard + ' .set-row input.set-input[data-field="weight"]')});
      return i && i.value === '' && i.placeholder !== '';
    })()`));

  // Type set 1's values straight into the grid (60 kg × 8), then duplicate it.
  await setField('bench s1 weight', bbpCard, 0, 'weight', 60);
  await poll('bench set 1 -> 60kg (db)', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(BBP)}).sort((a, b) => a.setNumber - b.setNumber);
    return !!(s[0] && s[0].weightKg === 60);
  })()`);
  await setField('bench s1 reps', bbpCard, 0, 'reps', 8);
  await poll('bench set 1 -> 8 reps (db)', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(BBP)}).sort((a, b) => a.setNumber - b.setNumber);
    return !!(s[0] && s[0].reps === 8);
  })()`);
  await clickSel('add set 2', `${bbpCard} .add-set`);
  await poll('bench set 2 saved', `document.querySelectorAll(${J(bbpCard + ' .set-row')}).length === 2`);
  const bbp5 = await evalJS(setsExpr(BBP));
  check('log: Add Set duplicates the previous set (60 kg × 8)',
    bbp5.length === 2 && bbp5[1]?.weightKg === 60 && bbp5[1]?.reps === 8, JSON.stringify(bbp5[1]));

  // --- 6. Retype set 2's weight -> 20 kg (working set for the PR checks) ---
  await setField('bench s2 weight', bbpCard, 1, 'weight', 20);
  await poll('bench set 2 -> 20kg (db)', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(BBP)}).sort((a, b) => a.setNumber - b.setNumber);
    return !!(s[1] && s[1].weightKg === 20);
  })()`);
  const bbp6 = await evalJS(setsExpr(BBP));
  check('edit: set input commits 20 kg to set 2 without a re-render', bbp6[1]?.weightKg === 20 && bbp6[1]?.reps === 8, JSON.stringify(bbp6[1]));

  // --- 7. Per-set sheet: flag the (edited) first set as Warm-up ---
  await clickSel('set 1 menu (…)', `${bbpCard} .set-row .set-menu`);
  await clickText('Warm-up row', '#sheet-root .sheet-row', 'Warm-up');
  await poll('bench set 1 isWarmup true (db)', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(BBP)}).sort((a, b) => a.setNumber - b.setNumber);
    return !!(s[0] && s[0].isWarmup === true);
  })()`);
  check('warmup: set 1 flagged isWarmup in the DB', (await evalJS(setsExpr(BBP)))[0]?.isWarmup === true);
  check('warmup: set row shows the warm badge (.set-row.warm)',
    (await poll('warm badge rendered', `document.querySelectorAll(${J(bbpCard + ' .set-row.warm')}).length >= 1`)) && true,
    `got ${await count(`${bbpCard} .set-row.warm`)}`);

  // --- 8. Cardio: add Assault Bike via search, log a cardio set, edit fields ---
  await gotoPicker('add-exercise (cardio)');
  await pickSearch('Assault');
  await clickSel('pick Assault Bike', `#s-pick .pick-row[data-exercise-id="${ASSAULT}"]`);
  await poll('assault card on #/workout', `location.hash === '#/workout' && document.querySelector(${J(assaultCard)}) != null`);
  await poll('cardio auto set row present', `document.querySelectorAll(${J(assaultCard + ' .set-row')}).length === 1`);
  const cardioFields = await evalJS(`['minutes','seconds','distance','kcal'].every(f => document.querySelector(${J(assaultCard)} + ' input.set-input[data-field="' + f + '"]') != null)`);
  check('cardio: set exposes minutes/seconds/distance/kcal inputs', cardioFields);
  await setField('cardio minutes', assaultCard, 0, 'minutes', 4);
  await poll('cardio durationSeconds -> 240 (db)', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(ASSAULT)});
    return !!(s[0] && s[0].durationSeconds === 240);
  })()`);
  await setField('cardio kcal', assaultCard, 0, 'kcal', 20);
  await poll('cardio kcal -> 20 (db)', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(ASSAULT)});
    return !!(s[0] && s[0].kcal === 20);
  })()`);
  const cardioSet = (await evalJS(setsExpr(ASSAULT)))[0];
  check('cardio: set stored as setType cardio, 240s, 20 kcal, weightKg 0',
    cardioSet?.setType === 'cardio' && cardioSet?.durationSeconds === 240 && cardioSet?.kcal === 20 && cardioSet?.weightKg === 0,
    JSON.stringify(cardioSet));

  // --- 9. Superset: multi-select two exercises, confirm, both cards share a group ---
  await gotoPicker('add-exercise (superset)');
  await clickText('Superset mode', '#s-pick .seg-btn', 'Superset');
  await poll('superset mode active', `[...document.querySelectorAll('#s-pick .seg-btn')].some(b => b.textContent.trim() === 'Superset' && b.classList.contains('on'))`);
  await pickSearch('Cable Fly');
  await clickSel('select Cable Fly', `#s-pick .pick-row[data-exercise-id="${CABLE_FLY}"]`);
  // Row-click triggers an async re-render; wait for the selection to settle before
  // changing the search (otherwise we could target the about-to-be-replaced DOM).
  await poll('Cable Fly registered as selected', `document.querySelector('#s-pick .pick-row[data-exercise-id="${CABLE_FLY}"].selected') != null`);
  await pickSearch('Triceps Pushdown');
  await clickSel('select Triceps Pushdown', `#s-pick .pick-row[data-exercise-id="${TRI_PUSHDOWN}"]`);
  await poll('Triceps Pushdown registered as selected', `document.querySelector('#s-pick .pick-row[data-exercise-id="${TRI_PUSHDOWN}"].selected') != null`);
  await clickSel('confirm superset', '#s-pick .superset-confirm');
  await poll('back on #/workout with both superset cards', `location.hash === '#/workout'
    && document.querySelector('.ex-card[data-exercise-id="${CABLE_FLY}"]') != null
    && document.querySelector('.ex-card[data-exercise-id="${TRI_PUSHDOWN}"]') != null`);
  const supersetInfo = await evalJS(`(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const w = await db.getWorkout(wid);
    const es = w.entries || [];
    const cf = es.find((e) => e.exerciseId === ${J(CABLE_FLY)});
    const tp = es.find((e) => e.exerciseId === ${J(TRI_PUSHDOWN)});
    return { cf, tp };
  })()`);
  check('superset: both cards render on the workout screen', await exists(`.ex-card[data-exercise-id="${CABLE_FLY}"]`) && await exists(`.ex-card[data-exercise-id="${TRI_PUSHDOWN}"]`));
  check('superset: the two entries share a non-null supersetGroup',
    supersetInfo?.cf?.supersetGroup != null && supersetInfo.cf.supersetGroup === supersetInfo?.tp?.supersetGroup,
    JSON.stringify(supersetInfo));

  // --- 10. Rest timer: an Add Set on the active workout shows #rest-bar; tap dismisses ---
  await evalJS(`(() => { const rb = document.getElementById('rest-bar'); if (rb && !rb.hidden) rb.click(); return true; })()`);
  await poll('rest bar cleared before test', `document.getElementById('rest-bar').hidden`);
  await clickSel('add set (rest timer)', `.ex-card[data-exercise-id="${CABLE_FLY}"] .add-set`);
  check('timer: #rest-bar becomes visible after an Add Set', !!(await poll('rest bar visible', `!document.getElementById('rest-bar').hidden`)));
  await clickSel('dismiss rest bar', '#rest-bar');
  await poll('rest bar dismissed', `document.getElementById('rest-bar').hidden`);
  check('timer: tapping the rest bar dismisses it', true);

  // --- 10b. Minimise -> resume bar on the tabs -> tap to resume ---
  await clickSel('minimise workout', '#s-workout [data-action="minimise"]');
  await poll('minimise lands on #/log', `location.hash === '#/log' && !document.getElementById('s-log').hidden`);
  check('minimise: resume bar appears with elapsed time',
    await poll('resume bar visible', `!document.getElementById('resume-bar').hidden && /\\d/.test(document.getElementById('resume-bar-time').textContent)`) && true);
  await clickSel('resume via resume bar', '#resume-bar');
  await poll('resume returns to #/workout', `location.hash === '#/workout' && !document.getElementById('s-workout').hidden`);
  check('minimise: tapping the resume bar returns to the workout', true);
  await poll('resume bar hidden on workout screen', `document.getElementById('resume-bar').hidden`);
  check('minimise: resume bar hides on the workout screen', true);

  // --- 10c. Exercise menu -> Settings opens the shared Edit Exercise sheet ---
  await clickSel('bench exercise menu', `${bbpCard} .ex-menu`);
  await clickSel('settings row', '#sheet-root [data-action="exercise-settings"]');
  await poll('edit-exercise sheet open', `[...document.querySelectorAll('#sheet-root .sheet-title')].some(t => t.textContent === 'Edit Exercise')`);
  check('menu: Settings opens the same Edit Exercise sheet as the picker', true);
  await clickSel('close edit-exercise sheet', '#sheet-root .sheet-x');
  await poll('edit-exercise sheet closed', `![...document.querySelectorAll('#sheet-root .sheet-title')].some(t => t.textContent === 'Edit Exercise')`);

  // --- 11. Finish workout -> #/log shows a month group + a card for it ---
  await finishActiveWorkout();
  check('finish: workout finishedAt is set in the DB', await evalJS(`import('./js/db.js').then(m => m.getWorkout(${J(w1id)})).then(w => w && w.finishedAt != null)`));
  check('log: a month group appears after finishing', (await poll('month group present', `document.querySelectorAll('#s-log .month-group').length >= 1`)) && true);
  check('log: a workout card exists for the finished workout', await poll('workout card present', `document.querySelector('#s-log .workout-card[data-workout-id="${w1id}"]') != null`));
  check('log: the card lists the logged exercise (Barbell Bench Press)',
    await evalJS(`(document.querySelector('#s-log .workout-card[data-workout-id="${w1id}"]')?.textContent || '').includes('Barbell Bench Press')`),
    (await evalJS(`document.querySelector('#s-log .workout-card[data-workout-id="${w1id}"]')?.textContent || ''`)).slice(0, 160));

  // --- 12. Past workout: open the card, view its cards, go back ---
  await clickSel('open past workout card', `#s-log .workout-card[data-workout-id="${w1id}"]`);
  await poll('past workout screen (#/workout/:id)', `location.hash === '#/workout/${w1id}' && !document.getElementById('s-workout').hidden`);
  await poll('past workout cards rendered', `document.querySelector(${J(bbpCard)}) != null`);
  check('past: workout opens in the workout screen with its exercise cards',
    (await count('#s-workout .ex-card')) >= 1 && await exists(bbpCard), `ex-cards=${await count('#s-workout .ex-card')}`);
  await clickSel('done (back to log)', '#s-workout [data-action="finish"]');
  await poll('back on #/log from past workout', `location.hash === '#/log'`);

  // --- 13. Routines: start from the seeded template, then finish it ---
  await clickSel('routines tab', '#tabbar button[data-tab="routines"]');
  check('routines: seeded Push Day A template card present',
    await poll('template card', `document.querySelector('#s-routines [data-template-id="seed-template-push-day-a"]') != null`));
  await clickSel('open template detail', '#s-routines [data-template-id="seed-template-push-day-a"]');
  await clickSel('start routine', '[data-action="start-routine"]');
  await poll('routine started on #/workout', `location.hash === '#/workout' && !document.getElementById('s-workout').hidden`);
  check('routines: starting the template pre-seeds 5 exercise cards',
    (await poll('five ex-cards', `document.querySelectorAll('#s-workout .ex-card').length === 5`)) && true,
    `ex-cards=${await count('#s-workout .ex-card')}`);
  check('routines: each pre-seeded exercise auto-gets one blank set',
    (await poll('five auto set-rows', `document.querySelectorAll('#s-workout .set-row').length === 5`)) && true,
    `set-rows=${await count('#s-workout .set-row')}`);
  await finishActiveWorkout();
  check('routines: an untouched routine workout can be finished', await poll('two workout cards', `document.querySelectorAll('#s-log .workout-card').length === 2`));

  // --- 14. Stats: at least one stat card; frequency reflects 2 sessions this week ---
  await clickSel('stats tab', '#tabbar button[data-tab="stats"]');
  check('stats: at least one .stat-card renders', await poll('stat card', `document.querySelectorAll('#s-stats .stat-card').length >= 1`));
  const freq = await evalJS(`import('./js/queries.js').then(m => m.getTrainingFrequency(1))`);
  check('stats: training frequency = 2 sessions this week', Array.isArray(freq) && freq[freq.length - 1]?.sessionsTotal === 2, JSON.stringify(freq));

  // --- 15. Frozen query contract holds over the logged data ---
  const prs = await evalJS(`import('./js/queries.js').then(m => m.getPRs(${J(BBP)}))`);
  const expectedE1RM = 20 * (1 + 8 / 30); // working set 2 (20kg×8); 60kg set 1 is warm-up (excluded)
  check('queries: getPRs bestE1RM comes from the 20 kg × 8 working set (warm-up 60 kg excluded)',
    prs?.bestE1RM && Math.abs(prs.bestE1RM.value - expectedE1RM) < 1e-3 && prs.bestE1RM.weightKg === 20 && prs.bestE1RM.reps === 8,
    JSON.stringify(prs?.bestE1RM));
  check('queries: getPRs byReps @8 = 20 kg (only the working set counts)',
    prs?.byReps?.find((r) => r.reps === 8)?.weightKg === 20, JSON.stringify(prs?.byReps));

  // --- 16. No uncaught exceptions / console errors across the whole walk ---
  check('pwa: no uncaught exceptions or console errors during the walk', jsErrors.length === 0, jsErrors.join(' | '));
} catch (err) {
  failures.push('SUITE ABORTED');
  console.log('FAIL — suite aborted :: ' + err.message);
}

console.log(failures.length === 0
  ? `E2E SUMMARY: ${passCount} passed, 0 failed — ALL GREEN`
  : `E2E SUMMARY: ${passCount} passed, ${failures.length} FAILED: ${failures.join('; ')}`);
ws.close();
process.exit(failures.length ? 1 : 0);
