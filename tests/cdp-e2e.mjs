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
// Headless Chrome treats the page as unfocused, so element.focus() never
// dispatches a focus event — which would silently no-op every focus-driven
// assertion (caret placement, first-keystroke-replaces). Emulate focus so the
// text-entry behaviour in js/inputs.js is genuinely exercised.
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
// Touch emulation: without it Input.dispatchTouchEvent is silently dropped,
// so the drag-and-drop step would no-op. Needed for real pointer sequences.
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
// window.confirm is no longer used (sheets replaced it) — keep a harmless shim anyway.
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm = () => true;' });
await send('Page.navigate', { url: APP_URL });

let w1id = null;

try {
  // --- 1. Fresh app: seed ran, #/log renders, 2 tabs, empty log ---
  await poll('app boots to #/home', `location.hash === '#/home' && !document.getElementById('s-home').hidden`, 12000);
  check('home: default tab renders', (await count('#s-home .tab-screen')) === 1, `got ${await count('#s-home .tab-screen')}`);
  await clickSel('tab log (first visit)', '#tabbar button[data-tab="log"]');
  await poll('log screen visible', `location.hash === '#/log' && !document.getElementById('s-log').hidden`);
  const seedCount = await poll('seed exercises loaded', `import('./js/db.js').then(m => m.listExercises()).then(l => l.length)`);
  check('seed: 61 exercises seeded on fresh install (55 strength + 6 cardio)', seedCount === 61, `got ${seedCount}`);
  check('shell: tab bar has 4 tab buttons (Home, Log, Statistics, Coach)', (await count('#tabbar button')) === 4, `got ${await count('#tabbar button')}`);
  check('shell: Coach tab is hidden until an API key exists', await evalJS(`document.querySelector('#tabbar button[data-tab="coach"]').hidden === true`));
  check('log: empty state has no month groups yet', (await count('#s-log .month-group')) === 0, `got ${await count('#s-log .month-group')}`);

  // --- 2. Tab switching: each tab shows its screen, hides the rest ---
  const TABS = ['home', 'log', 'stats'];
  let tabsOk = true; let tabDetail = '';
  for (const tab of TABS) {
    await clickSel(`tab ${tab}`, `#tabbar button[data-tab="${tab}"]`);
    await poll(`${tab} screen visible`, `!document.getElementById('s-${tab}').hidden`);
    const othersHidden = await evalJS(`['home','log','stats','coach','settings'].filter(t => t !== ${J(tab)}).every(t => document.getElementById('s-'+t).hidden)`);
    if (!othersHidden) { tabsOk = false; tabDetail = `others not hidden on ${tab}`; }
  }
  check('tabs: switching shows one screen and hides the others', tabsOk, tabDetail);

  // --- 2b. Settings: gear on the Log head opens #/settings (fullscreen) ---
  await clickSel('log tab', '#tabbar button[data-tab="log"]');
  await clickSel('settings gear', '#s-log [data-action="open-settings"]');
  await poll('settings route', `location.hash === '#/settings' && !document.getElementById('s-settings').hidden`);
  check('settings: gear opens the fullscreen settings screen', await evalJS(`document.body.classList.contains('fullscreen')`));
  check('settings: legacy #/profile redirects', await evalJS(`(() => { location.hash = '#/profile'; return true; })()`) && await poll('redirected', `location.hash === '#/settings'`) && true);

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

  // --- 6b. Text-entry behaviour (js/inputs.js) -----------------------------
  // Numeric fields: focus puts the caret at the END (never at 0, never a
  // select-all — that is what raised iOS's drag handles), and the FIRST typed
  // character replaces the value so overwriting a duplicated set is one action.
  const caret = await evalJS(`(async () => {
    const row = document.querySelectorAll(${J(bbpCard + ' .set-row')})[1];
    const i = row.querySelector('input.set-input[data-field="weight"]');
    i.focus();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));
    return { start: i.selectionStart, end: i.selectionEnd, len: i.value.length, val: i.value };
  })()`);
  check('input: focus puts the caret at the end with nothing selected',
    caret.start === caret.len && caret.end === caret.len && caret.len > 0, JSON.stringify(caret));

  const replaced = await evalJS(`(() => {
    const row = document.querySelectorAll(${J(bbpCard + ' .set-row')})[1];
    const i = row.querySelector('input.set-input[data-field="weight"]');
    const before = i.value;
    i.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '7', bubbles: true, cancelable: true }));
    return { before, after: i.value };
  })()`);
  check('input: first keystroke replaces the value (no prepending)',
    replaced.before === '20' && replaced.after === '7', JSON.stringify(replaced));

  // A second keystroke appends normally — pristine mode is one-shot.
  const appended = await evalJS(`(() => {
    const row = document.querySelectorAll(${J(bbpCard + ' .set-row')})[1];
    const i = row.querySelector('input.set-input[data-field="weight"]');
    i.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '5', bubbles: true, cancelable: true }));
    i.value = '75'; // the (uncancelled) native insert the browser would have done
    i.blur();
    return i.value;
  })()`);
  check('input: later keystrokes append (pristine mode is one-shot)', appended === '75', appended);
  await poll('bench set 2 -> 75kg (db)', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(BBP)}).sort((a, b) => a.setNumber - b.setNumber);
    return !!(s[1] && s[1].weightKg === 75);
  })()`);
  // Restore 20 kg — the PR assertions in step 15 expect it as the working set.
  // Focus first: the blur handler skips the write when the value is unchanged
  // since focus, and this field's focus snapshot is currently '75'.
  await evalJS(`(() => {
    const row = document.querySelectorAll(${J(bbpCard + ' .set-row')})[1];
    const i = row.querySelector('input.set-input[data-field="weight"]');
    i.focus(); i.value = '20'; i.blur(); return true;
  })()`);
  await poll('bench set 2 back to 20kg (db)', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(BBP)}).sort((a, b) => a.setNumber - b.setNumber);
    return !!(s[1] && s[1].weightKg === 20);
  })()`);

  // Notes are a direct inline input too — no sheet.
  await setField('bench s2 note', bbpCard, 1, 'notes', 'felt easy');
  await poll('bench set 2 note (db)', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(BBP)}).sort((a, b) => a.setNumber - b.setNumber);
    return !!(s[1] && s[1].notes === 'felt easy');
  })()`);
  check('edit: inline notes input commits free text to the set', true);

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

  // --- 13. Routines: none are seeded, so create one from a logged session
  // via its ⋯ menu, then copy it into a fresh workout. ---
  check('routines: nothing is seeded — the library starts empty',
    (await evalJS(`import('./js/db.js').then((m) => m.listTemplates()).then((t) => t.length)`)) === 0);

  // Open the finished workout and save it as a routine.
  await clickSel('open logged workout', '#s-log .workout-card');
  await poll('past workout open', `location.hash.startsWith('#/workout/')`);
  await clickSel('workout menu', '#s-workout .w-head [aria-label="Workout menu"]');
  await clickSel('save as routine', '[data-action="save-as-routine"]');
  await poll('routine editor open', `location.hash.startsWith('#/routine/from/') && document.querySelector('#s-routine .routine-name-input') != null`);
  const prefilled = await count('#s-routine .tpl-entry-row');
  check('routines: Save as Routine prefills the session skeleton', prefilled >= 1, `entries=${prefilled}`);
  await evalJS(`(() => {
    const i = document.querySelector('#s-routine .routine-name-input');
    i.value = 'Test Routine'; i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await clickSel('save routine', '#s-routine [data-action="routine-save"]');
  const saved = await poll('routine persisted', `import('./js/db.js').then((m) => m.listTemplates()).then((t) => t.length === 1 ? t[0] : null)`);
  check('routines: saving stores the routine with its name and skeleton',
    saved && saved.name === 'Test Routine' && saved.entries.length === prefilled, JSON.stringify(saved && saved.name));

  // Copy it into a brand-new workout.
  await evalJS(`import('./js/ui.js').then((ui) => { ui.go('#/log'); return true; })`);
  await clickSel('start workout for copy', '#s-log [data-action="start-workout"]');
  await poll('empty workout up', `location.hash === '#/workout'`);
  check('workout: Copy Routine sits above Add Exercise',
    await poll('copy button', `document.querySelector('#s-workout [data-action="copy-routine"]') != null`));
  await clickSel('open copy picker', '#s-workout [data-action="copy-routine"]');
  await poll('copy categories', `location.hash === '#/copy' && document.querySelector('#s-copy [data-copy-cat="routines"]') != null`);
  check('copy: both categories offered',
    await exists('#s-copy [data-copy-cat="routines"]') && await exists('#s-copy [data-copy-cat="previous"]'));
  await clickSel('open routines list', '#s-copy [data-copy-cat="routines"]');
  await poll('routine row listed', `document.querySelector('#s-copy .pick-row[data-template-id]') != null`);
  await clickSel('copy the routine', '#s-copy .pick-row[data-template-id]');
  await poll('back on the workout', `location.hash === '#/workout'`);
  const copied = await poll('skeleton copied', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const sets = await db.listSetsForWorkout(wid);
    const w = await db.getWorkout(wid);
    return sets.length > 0 ? { entries: (w.entries || []).length, sets: sets.length, blank: sets.every((s) => s.weightKg === 0 && s.reps === 0) } : null;
  })()`);
  check('copy: the routine skeleton lands as exercises + blank sets',
    copied.entries === prefilled && copied.sets > 0 && copied.blank === true, JSON.stringify(copied));

  // Previous Sessions is the other half of the same picker.
  await clickSel('copy routine again', '#s-workout [data-action="copy-routine"]');
  await poll('copy categories again', `location.hash === '#/copy'`);
  await clickSel('open sessions list', '#s-copy [data-copy-cat="previous"]');
  check('copy: previous sessions are listed',
    await poll('session row', `document.querySelectorAll('#s-copy .pick-row[data-workout-id]').length >= 1`));
  await evalJS(`import('./js/ui.js').then((ui) => { ui.go('#/workout'); return true; })`);
  await poll('back on workout again', `location.hash === '#/workout'`);
  await finishActiveWorkout();
  // Two logged workouts by now: the original walk's, plus this copied one.
  check('routines: the copied workout can be finished', await poll('two workout cards', `document.querySelectorAll('#s-log .workout-card').length === 2`));

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

  // --- 15b. CSV import (Profile tab): preview -> confirm -> done -------------
  // The walk has two real workouts dated TODAY, so the fixture's "today" row is
  // guaranteed to collide and must be skipped by default. The 2024 rows are far
  // enough in the past that nothing else in the suite can be disturbed by them.
  await evalJS(`(() => { location.hash = '#/settings'; return true; })()`);
  await poll('import row rendered', `document.querySelector('#s-settings [data-action="import-csv"]') != null`);
  check('settings: the Data card exposes an import row', await exists('#s-settings [data-action="import-csv"]'));

  // Fixture: one OLD workout (2 exercises — a seeded name + a novel one) and one
  // workout dated TODAY (the deliberate collision). Injected through a real
  // DataTransfer so the change handler runs exactly as it would from a tap.
  const injectCSV = `(() => {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const csv = [
      'Workout Start,Workout End,Exercise,Weight,Reps,Notes,Category',
      '2024-01-05 10:00,2024-01-05 11:00,Barbell Bench Press,60,8,,Chest',
      '2024-01-05 10:00,2024-01-05 11:00,Barbell Bench Press,65,6,,Chest',
      '2024-01-05 10:00,2024-01-05 11:00,Zercher Carry Test,40,5,,Legs',
      today + ' 09:00,' + today + ' 09:30,Barbell Bench Press,50,10,,Chest',
    ].join('\\n');
    const dt = new DataTransfer();
    dt.items.add(new File([csv], 'test.csv', { type: 'text/csv' }));
    const inp = document.querySelector('#import-file');
    if (!inp) return false;
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
  // Reads the preview sheet's stat rows + the collision toggle's current value.
  const previewExpr = `(() => {
    const root = document.querySelector('[data-action="import-preview"]');
    if (!root) return null;
    const rows = {};
    for (const r of root.querySelectorAll('.sheet-row.readonly')) {
      rows[r.querySelector('.sheet-row-label').textContent.trim()] = r.querySelector('.sheet-row-value').textContent.trim();
    }
    const skip = root.querySelector('[data-action="import-skip-collisions"]');
    return { rows, skip: skip ? skip.querySelector('.sheet-row-value').textContent.trim() : null };
  })()`;
  // Whole-DB snapshot: imported records, the old workout's sets, and totals.
  const importStateExpr = `(async () => {
    const db = await import('./js/db.js');
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const ws = await db.listWorkouts('0000');
    const imported = ws.filter((w) => w.id.startsWith('import-'));
    const old = ws.find((w) => w.id.indexOf('import-w-20240105-1000') === 0);
    const oldSets = old ? await db.listSetsForWorkout(old.id) : [];
    const exs = await db.listExercises();
    const all = await Promise.all(ws.map((w) => db.listSetsForWorkout(w.id)));
    return {
      importedWorkouts: imported.length,
      oldId: old ? old.id : null,
      oldDate: old ? old.date : null,
      oldSetCount: oldSets.length,
      oldWeights: oldSets.map((s) => s.weightKg).sort((a, b) => a - b),
      zercher: exs.some((e) => e.id === 'import-zercher-carry-test'),
      importedToday: imported.filter((w) => w.date === today).length,
      totalWorkouts: ws.length,
      totalSets: all.reduce((n, s) => n + s.length, 0),
      totalExercises: exs.length,
    };
  })()`;

  await evalJS(injectCSV);
  await poll('import preview sheet open', `document.querySelector('[data-action="import-preview"]') != null`, 12000);
  const preview = await evalJS(previewExpr);
  check('import: preview counts 2 workouts from the fixture', preview?.rows?.Workouts === '2', JSON.stringify(preview?.rows));
  check('import: preview counts 4 sets and 1 new exercise',
    preview?.rows?.Sets === '4' && preview?.rows?.['New exercises'] === '1', JSON.stringify(preview?.rows));
  check('import: collision toggle is offered and defaults to skipping', preview?.skip === 'Yes', JSON.stringify(preview));

  await clickSel('confirm import', '[data-action="import-confirm"]');
  await poll('import done sheet', `document.querySelector('[data-action="import-done"]') != null`, 20000);
  const after1 = await evalJS(importStateExpr);
  check('import: the 2024-01-05 workout lands with a deterministic id',
    after1.oldId?.startsWith('import-w-20240105-1000') && after1.oldDate === '2024-01-05', JSON.stringify({ id: after1.oldId, date: after1.oldDate }));
  check('import: its three sets persist with the CSV weights (40/60/65 kg)',
    after1.oldSetCount === 3 && JSON.stringify(after1.oldWeights) === JSON.stringify([40, 60, 65]), JSON.stringify(after1.oldWeights));
  check('import: the novel exercise is created as import-zercher-carry-test', after1.zercher === true);
  check('import: the colliding TODAY workout was skipped', after1.importedToday === 0 && after1.importedWorkouts === 1,
    `importedToday=${after1.importedToday} importedWorkouts=${after1.importedWorkouts}`);

  await clickSel('close import result', '[data-action="import-done-close"]');
  await poll('import sheet dismissed', `document.querySelector('[data-action="import-done"]') == null`);
  await clickSel('log tab', '#tabbar button[data-tab="log"]');
  check('import: the imported session shows as a January 2024 month group',
    await poll('January 2024 month group', `[...document.querySelectorAll('#s-log .month-group-name')].some(e => e.textContent.trim() === 'January 2024')`));

  // Idempotency: the identical file a second time must upsert in place, never duplicate.
  await evalJS(`(() => { location.hash = '#/settings'; return true; })()`);
  await poll('import row rendered again', `document.querySelector('#s-settings [data-action="import-csv"]') != null`);
  await evalJS(injectCSV);
  await poll('import preview sheet open (2nd)', `document.querySelector('[data-action="import-preview"]') != null`, 12000);
  await clickSel('confirm import (2nd)', '[data-action="import-confirm"]');
  await poll('import done sheet (2nd)', `document.querySelector('[data-action="import-done"]') != null`, 20000);
  const after2 = await evalJS(importStateExpr);
  check('import: re-importing the same file changes no counts (idempotent)',
    after2.totalWorkouts === after1.totalWorkouts && after2.totalSets === after1.totalSets && after2.totalExercises === after1.totalExercises,
    `first=${JSON.stringify([after1.totalWorkouts, after1.totalSets, after1.totalExercises])} second=${JSON.stringify([after2.totalWorkouts, after2.totalSets, after2.totalExercises])}`);
  await clickSel('close import result (2nd)', '[data-action="import-done-close"]');
  await poll('import sheet dismissed (2nd)', `document.querySelector('[data-action="import-done"]') == null`);

  // --- 15c. Statistics rework: module grid, drill-ins, chart screens --------
  await evalJS(`(() => { location.hash = '#/stats'; return true; })()`);
  await poll('stats grid rendered', `document.querySelector('#s-stats .stats-grid') != null`);
  check('stats: default layout renders 3 module cards',
    (await poll('module cards', `document.querySelectorAll('#s-stats .stat-card[data-module-id]').length`)) === 3,
    `got ${await count('#s-stats .stat-card[data-module-id]')}`);
  check('stats: Exercises + Categories navigation rows present',
    await exists('#s-stats [data-stat-nav="exercises"]') && await exists('#s-stats [data-stat-nav="categories"]'));
  const overallRows = await evalJS(`(async () => {
    const sd = await import('./js/stats-data.js');
    return { dom: document.querySelectorAll('#s-stats [data-metric]').length, catalogue: sd.OVERALL_METRICS.length };
  })()`);
  check('stats: one Overall Statistics row per catalogue metric', overallRows.dom === overallRows.catalogue, JSON.stringify(overallRows));

  // Card interaction: the chart area reads values and lets the page scroll;
  // only the card's chrome opens the full screen.
  await poll('module chart mounted', `document.querySelector('#s-stats .stat-card[data-module-id] .stats-chart svg') != null`, 12000);
  check('stats: a card chart does not block vertical scrolling (touch-action)',
    await evalJS(`(() => {
      const svg = document.querySelector('#s-stats .stat-card[data-module-id] .stats-chart svg');
      return svg && getComputedStyle(svg).touchAction === 'pan-y';
    })()`));
  await evalJS(`(() => { window.__hashBefore = location.hash; return true; })()`);
  // SVGElement has no .click() — dispatch a real bubbling click so the card's
  // listener genuinely gets the chance to (not) fire.
  await evalJS(`(() => {
    const svg = document.querySelector('#s-stats .stat-card[data-module-id] .stats-chart svg');
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300)); // deliberate: absence needs a beat
  check('stats: tapping the chart shows values without leaving the grid',
    await evalJS(`location.hash === window.__hashBefore && location.hash === '#/stats'`),
    await evalJS(`location.hash`));
  await clickSel('tap the card chrome', '#s-stats .stat-card[data-module-id] .stats-module-head .stats-module-title');
  await poll('card chrome opened the chart screen', `location.hash.startsWith('#/stats/') && document.querySelector('#s-stats .chart-screen') != null`, 8000);
  check('stats: tapping the card chrome opens the full chart screen', true);
  await evalJS(`import('./js/ui.js').then((ui) => { ui.go('#/stats'); return true; })`);
  await poll('back on the grid', `document.querySelector('#s-stats .stats-grid') != null`);

  // Chart detail: overall volume — svg renders, range pill re-renders it.
  await evalJS(`(() => { location.hash = '#/stats/overall/volume'; return true; })()`);
  await poll('overall volume chart screen', `document.querySelector('#s-stats .chart-screen svg') != null`, 12000);
  check('stats: overall volume chart renders an SVG with plotted content',
    await evalJS(`document.querySelectorAll('#s-stats .chart-screen svg *').length > 10`));
  check('stats: range pills present (3M/6M/1Y/All)', (await count('#s-stats [data-range]')) >= 4, `got ${await count('#s-stats [data-range]')}`);
  await clickSel('range pill All', '#s-stats [data-range="all"]');
  // Settle on either a live chart or an empty state, and report which.
  const rangeState = await poll('chart settled after range change', `(() => {
    const scr = document.querySelector('#s-stats .chart-screen');
    if (!scr) return { ok: false, why: 'no chart screen' };
    const svgN = scr.querySelectorAll('svg *').length;
    if (svgN > 10) return { ok: true, svgN };
    const empty = scr.querySelector('.stats-empty, .muted');
    if (empty) return { ok: false, why: 'empty state: ' + empty.textContent.trim() };
    return null; // still loading — keep polling
  })()`, 8000).catch((e) => ({ ok: false, why: e.message }));
  check('stats: switching range keeps a live chart on screen', rangeState.ok === true, JSON.stringify(rangeState));

  // Per-exercise drill-in: metric list from the catalogue, then its chart.
  await evalJS(`(() => { location.hash = '#/stats/exercise/${BBP}'; return true; })()`);
  const exRows = await poll('exercise metric rows', `(async () => {
    const sd = await import('./js/stats-data.js');
    const dom = document.querySelectorAll('#s-stats [data-metric]').length;
    return dom >= sd.EXERCISE_METRICS.length ? { dom, catalogue: sd.EXERCISE_METRICS.length } : null;
  })()`);
  check('stats: per-exercise metric list matches the catalogue', exRows.dom >= exRows.catalogue, JSON.stringify(exRows));
  await evalJS(`(() => { location.hash = '#/stats/exercise/${BBP}/chart/e1rm'; return true; })()`);
  await poll('exercise e1rm chart', `document.querySelector('#s-stats .chart-screen svg') != null`, 12000);
  check('stats: per-exercise e1RM chart renders', await evalJS(`document.querySelectorAll('#s-stats .chart-screen svg *').length > 10`));

  // Edit mode: remove a module through the UI, then reset the layout back.
  await evalJS(`(() => { location.hash = '#/stats'; return true; })()`);
  await clickSel('edit layout', '#s-stats [data-action="stats-edit"]');
  await poll('edit mode on', `document.querySelector('#s-stats .stats-editing') != null || document.querySelector('#s-stats [data-action="module-remove"]') != null`);
  await clickSel('remove second module', '#s-stats .stat-card[data-module-id="default-volume"] [data-action="module-remove"]');
  await clickText('confirm module removal', '#sheet-root [data-action="confirm"]', 'Remove').catch(async () => {
    await clickSel('confirm module removal (generic)', '#sheet-root [data-action="confirm"]');
  });
  await poll('module removed from grid', `document.querySelectorAll('#s-stats .stat-card[data-module-id]').length === 2`);
  // The confirm sheet's backdrop removal runs on a ~260ms transition fallback —
  // wait it out, or the touch sequence below lands on the backdrop instead.
  await poll('sheets fully closed', `document.querySelectorAll('#sheet-root .sheet-backdrop').length === 0`);
  const storedLayout = await evalJS(`import('./js/settings.js').then((s) => s.getStatsLayout().map((m) => m.id))`);
  check('stats: removing a module persists the layout', Array.isArray(storedLayout) && storedLayout.length === 2 && !storedLayout.includes('default-volume'), JSON.stringify(storedLayout));

  // Drag-and-drop reorder via REAL touch input (CDP Input domain): grab the
  // first module's handle and drag it below the second; layout order flips.
  const beforeDrag = await evalJS(`import('./js/settings.js').then((s) => s.getStatsLayout().map((m) => m.id))`);
  const dragRects = await evalJS(`(() => {
    window.scrollTo(0, 0); // the drag coords must be inside the viewport
    window.__dragEvts = [];
    const cards = [...document.querySelectorAll('#s-stats .stat-card[data-module-id]')];
    const handle = cards[0].querySelector('[data-action="module-drag"]');
    if (!handle) return null;
    handle.addEventListener('pointerdown', () => window.__dragEvts.push('down'), { once: true });
    const hr = handle.getBoundingClientRect();
    const second = cards[1].getBoundingClientRect();
    return {
      x: hr.left + hr.width / 2, y: hr.top + hr.height / 2,
      targetY: second.top + second.height * 0.8,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  })()`);
  check('stats: drag handle exposed in edit mode', dragRects != null);
  if (dragRects) {
    // What is actually under the touch point right now?
    const under = await evalJS(`(() => {
      const el = document.elementFromPoint(${Math.round(dragRects.x)}, ${Math.round(dragRects.y)});
      const handle = document.querySelector('#s-stats .stat-card[data-module-id] [data-action="module-drag"]');
      return {
        under: el ? el.tagName + '.' + (el.className.baseVal ?? el.className) : 'none',
        handleConnected: handle ? handle.isConnected : false,
        underIsHandle: !!(el && el.closest && el.closest('[data-action="module-drag"]')),
        backdrops: document.querySelectorAll('#sheet-root .sheet-backdrop').length,
      };
    })()`);
    console.log(`      drag point diag: ${JSON.stringify(under)}`);
    // touchEnd must carry the released point — an empty touchPoints list never
    // maps to a pointerup, and the drag would hang uncommitted.
    const touch = (type, x, y) => send('Input.dispatchTouchEvent', {
      type, touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1 }],
    });
    await touch('touchStart', dragRects.x, dragRects.y);
    const steps = 12;
    let lastY = dragRects.y;
    for (let i = 1; i <= steps; i++) {
      lastY = dragRects.y + ((dragRects.targetY - dragRects.y) * i) / steps;
      await touch('touchMove', dragRects.x, lastY);
      await new Promise((r) => setTimeout(r, 30));
    }
    await touch('touchEnd', dragRects.x, lastY);
    const afterDrag = await poll('layout reordered after drag', `import('./js/settings.js').then((s) => {
      const ids = s.getStatsLayout().map((m) => m.id);
      return ids[0] !== ${J(beforeDrag[0])} ? ids : null;
    })`, 6000).catch(() => null);
    const dragDiag = await evalJS(`({ evts: window.__dragEvts, scrollY: window.scrollY })`);
    check('stats: touch drag reorders the layout and persists it',
      Array.isArray(afterDrag) && afterDrag[0] === beforeDrag[1] && afterDrag.includes(beforeDrag[0]),
      `before=${JSON.stringify(beforeDrag)} after=${JSON.stringify(afterDrag)} rects=${JSON.stringify(dragRects)} diag=${JSON.stringify(dragDiag)}`);
  }

  // Reset the layout so later runs start clean; leaves edit mode too. go()
  // re-routes even on the same hash (location.hash alone would not re-render).
  await evalJS(`Promise.all([import('./js/settings.js'), import('./js/ui.js')]).then(([s, ui]) => { s.resetStatsLayout(); ui.go('#/stats'); return true; })`);
  await poll('layout back to defaults', `document.querySelectorAll('#s-stats .stat-card[data-module-id]').length === 3`);

  // --- 15d. Settings toggles + wired behaviour ------------------------------
  await evalJS(`(() => { location.hash = '#/settings'; return true; })()`);
  await poll('settings toggles rendered', `document.querySelectorAll('#s-settings [data-setting]').length >= 7`);
  check('settings: all seven toggles present', (await count('#s-settings [data-setting]')) === 7, `got ${await count('#s-settings [data-setting]')}`);
  await clickSel('flip auto-start timer OFF', '#s-settings [data-setting="autoStartTimer"]');
  check('settings: toggle flips aria-checked and persists',
    await poll('setting persisted', `localStorage.getItem('settings.autoStartTimer') === 'false'
      && document.querySelector('#s-settings [data-setting="autoStartTimer"]').getAttribute('aria-checked') === 'false'`) && true);

  // Behaviour: with auto-start OFF, adding a set must NOT start the rest timer;
  // autofill (default ON) pulls last session's weight when only reps are typed.
  await evalJS(`import('./js/ui.js').then(() => { location.hash = '#/log'; return true; })`);
  await clickSel('start behaviour-check workout', '#s-log [data-action="start-workout"]');
  await poll('workout screen up', `location.hash === '#/workout' && !document.getElementById('s-workout').hidden`);
  // The autofill subject must have a REAL last-session weight. Bench's latest
  // session is the routine workout (all 0 kg blanks), so use the imported
  // Zercher Carry Test: one clean session, 40 kg × 5, untouched since.
  const ZERCHER = 'import-zercher-carry-test';
  const zercherCard = `.ex-card[data-exercise-id="${ZERCHER}"]`;
  await gotoPicker('add-exercise (behaviour check)');
  await pickSearch('Zercher');
  await clickSel('pick zercher (behaviour check)', `#s-pick .pick-row[data-exercise-id="${ZERCHER}"]`);
  await poll('zercher card up', `location.hash === '#/workout' && document.querySelector(${J(zercherCard)}) != null`);
  await clickSel('add set (timer check)', `${zercherCard} .add-set`);
  await poll('second set row present', `document.querySelectorAll(${J(zercherCard + ' .set-row')}).length === 2`);
  await new Promise((r) => setTimeout(r, 400)); // deliberate: absence needs a beat
  check('settings: auto-start OFF leaves the rest bar hidden', await evalJS(`document.getElementById('rest-bar').hidden`));

  await setField('reps only (autofill check)', zercherCard, 0, 'reps', 6);
  const autofilled = await poll('autofill persisted', `(async () => {
    const db = await import('./js/db.js');
    const wid = localStorage.getItem('currentWorkoutId');
    const s = (await db.listSetsForWorkout(wid)).filter((x) => x.exerciseId === ${J(ZERCHER)}).sort((a, b) => a.setNumber - b.setNumber);
    return s[0] && s[0].reps === 6 && s[0].weightKg > 0 ? s[0].weightKg : null;
  })()`);
  check('settings: autofill weight copies last session on a reps-only entry', autofilled === 40, `weightKg=${autofilled}`);

  // Restore the toggle and clear the behaviour-check workout via its menu.
  await evalJS(`import('./js/settings.js').then((s) => { s.setSetting('autoStartTimer', true); return true; })`);
  await clickSel('workout menu (cleanup)', '#s-workout .w-head [aria-label="Workout menu"]');
  await clickText('delete workout row', '#sheet-root .sheet-row', 'Delete Workout');
  // Sheets stack, and a closing sheet lingers through its exit transition —
  // always press the TOPMOST sheet's confirm, never the first text match.
  const confirmTopSheet = () => evalJS(`(() => {
    const tops = [...document.querySelectorAll('#sheet-root .sheet-backdrop')];
    const btn = tops.length && tops[tops.length - 1].querySelector('[data-action="confirm"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await poll('first confirm sheet up', `document.querySelector('#sheet-root [data-action="confirm"]') != null`);
  await confirmTopSheet();
  await poll('second confirm sheet', `[...document.querySelectorAll('#sheet-root .sheet-title')].some((e) => e.textContent.includes('permanently'))`);
  await confirmTopSheet();
  await poll('back on log after cleanup', `location.hash === '#/log'`);

  // --- 15e. Long-press to reorder, and swipe-to-delete ---------------------
  await evalJS(`import('./js/ui.js').then((ui) => { ui.go('#/log'); return true; })`);
  await clickSel('start gesture-check workout', '#s-log [data-action="start-workout"]');
  await poll('gesture workout up', `location.hash === '#/workout'`);
  for (const ex of [BBP, 'seed-lat-pulldown']) {
    await gotoPicker(`add ${ex}`);
    await pickSearch(ex === BBP ? 'Barbell Bench' : 'Lat Pulldown');
    await clickSel(`pick ${ex}`, `#s-pick .pick-row[data-exercise-id="${ex}"]`);
    await poll(`${ex} card`, `document.querySelector('.ex-card[data-exercise-id="${ex}"]') != null`);
  }
  const orderNow = () => evalJS(`[...document.querySelectorAll('#s-workout .ex-card')].map((c) => c.dataset.exerciseId)`);
  const before = await orderNow();
  check('reorder: two exercises in the order they were added', before.length === 2 && before[0] === BBP, JSON.stringify(before));
  check('reorder: Move Up/Down are gone from the ⋯ menu', await evalJS(`(async () => {
    document.querySelector('.ex-card[data-exercise-id="${BBP}"] .ex-menu').click();
    await new Promise((r) => setTimeout(r, 300));
    const labels = [...document.querySelectorAll('#sheet-root .sheet-row')].map((r) => r.textContent);
    const has = labels.some((l) => l.includes('Move Up') || l.includes('Move Down'));
    const backdrop = document.querySelector('#sheet-root .sheet-backdrop');
    if (backdrop) backdrop.click();
    return !has;
  })()`));
  await poll('menu closed', `document.querySelectorAll('#sheet-root .sheet-backdrop').length === 0`);

  // Long press the SECOND card, then move it up.
  await evalJS(`(() => {
    const card = document.querySelectorAll('#s-workout .ex-card')[1];
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: r.left + 40, clientY: r.top + 10, bubbles: true }));
    return true;
  })()`);
  await poll('card selected by long press', `document.querySelector('#s-workout .ex-card.ex-selected') != null`, 4000);
  // Lift the finger, as a real long press does once the selection appears.
  await evalJS(`(() => {
    const card = document.querySelector('#s-workout .ex-card.ex-selected');
    card.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    return true;
  })()`);
  check('reorder: a long press selects the card and reveals its toolbar',
    await exists('#s-workout .ex-selected [data-action="entry-up"]'));
  await clickSel('move it up', '#s-workout .ex-selected [data-action="entry-up"]');
  const after = await poll('order changed', `(() => {
    const ids = [...document.querySelectorAll('#s-workout .ex-card')].map((c) => c.dataset.exerciseId);
    return ids[0] !== ${J(before[0])} ? ids : null;
  })()`);
  check('reorder: moving up reorders the workout and persists', after[0] === before[1], JSON.stringify(after));
  const persisted = await evalJS(`(async () => {
    const db = await import('./js/db.js');
    const w = await db.getWorkout(localStorage.getItem('currentWorkoutId'));
    return (w.entries || []).map((e) => e.exerciseId);
  })()`);
  check('reorder: the new order is written to the workout record', persisted[0] === before[1], JSON.stringify(persisted));

  // Swipe a set row left far enough to reveal Delete, then use it.
  await clickSel('add a set to swipe', `.ex-card[data-exercise-id="${before[1]}"] .add-set`);
  await poll('two set rows', `document.querySelectorAll('.ex-card[data-exercise-id="${before[1]}"] .set-row').length === 2`);
  const swiped = await evalJS(`(async () => {
    const row = document.querySelectorAll('.ex-card[data-exercise-id="${before[1]}"] .swipe-surface')[1];
    const r = row.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const send = (type, x) => row.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: y, bubbles: true }));
    send('pointerdown', r.right - 20);
    for (let i = 1; i <= 8; i++) { send('pointermove', r.right - 20 - i * 12); await new Promise((res) => setTimeout(res, 16)); }
    send('pointerup', r.right - 116);
    await new Promise((res) => setTimeout(res, 450));
    return !!row.closest('.swipe-host').classList.contains('swipe-open');
  })()`);
  check('swipe: dragging a set row left reveals its Delete button', swiped);
  await clickSel('tap the revealed Delete', `.ex-card[data-exercise-id="${before[1]}"] [data-action="swipe-delete"]`);
  check('swipe: tapping Delete removes the set',
    await poll('back to one set row', `document.querySelectorAll('.ex-card[data-exercise-id="${before[1]}"] .set-row').length === 1`));
  await finishActiveWorkout();

  // --- 15f. Coach (Phase C): plan-driven ghost sets, start choice, finish hook
  // No network: fetch is stubbed to fail like a dead connection, so the only
  // observable side effect of the finish hook is the queued retry slot.
  await evalJS(`(async () => {
    window.__realFetch = window.fetch;
    window.fetch = async () => { throw new TypeError('offline (e2e stub)'); };
    localStorage.setItem('coach.apiKey', 'sk-ant-e2e-not-a-real-key');
    const db = await import('./js/db.js');
    const ui = await import('./js/ui.js');
    await db.setMeta('coach.profile', { version: 1, updatedAt: new Date().toISOString(), injuryNotes: 'e2e', goal: 'return-from-injury', daysPerWeek: 3, sessionMinutes: 60, equipmentNotes: null, returnDate: null, avoidExerciseIds: [] });
    // A v2 plan that started 15 days ago (⇒ programme week 3): bench 60 kg base + 2.5 kg/week.
    const lineageStart = new Date(Date.now() - 15 * 86400000); const pad = (n) => String(n).padStart(2, '0');
    const lineageISO = lineageStart.getFullYear() + '-' + pad(lineageStart.getMonth() + 1) + '-' + pad(lineageStart.getDate());
    const prog = (w) => ({ weightStepKg: w, repStep: null, durationStepSec: null, everyWeeks: 1 });
    await db.putCoachPlan({ id: 'plan-e2e', version: 1, createdAt: new Date().toISOString(), source: 'manual', basedOnWorkoutId: null, rationale: null,
      planVersion: 2, lineageStart: lineageISO, baseWeek: 1, weeks: 8,
      overview: { points: ['Rebuild pressing strength over eight weeks.', 'Add legs back gently.'], muscleFocus: [{ group: 'chest', why: 'Main pressing pattern.' }, { group: 'legs', why: 'Requested despite no history.' }], progression: ['Bench climbs 2.5 kg a week.'], deloadWeek: 6 },
      weekNotes: [{ week: 6, focus: 'Deload', points: ['Drop loads 10 percent.'] }],
      sessions: [
        { id: 'ps-1', order: 1, name: 'Upper A', focus: 'push', brief: ['Pressing volume first.'], exercises: [
          { exerciseId: ${J(BBP)}, targetSets: 3, targetRepsLow: 6, targetRepsHigh: 8, targetWeightKg: 60, targetDurationSec: null, targetRpe: 7, purpose: 'Main press', goal: '3 × 8 at 77.5 kg by week 8', note: null, progression: prog(2.5) },
          { exerciseId: ${J(TRI_PUSHDOWN)}, targetSets: 2, targetRepsLow: 10, targetRepsHigh: 12, targetWeightKg: 25, targetDurationSec: null, targetRpe: 8, purpose: 'Triceps volume', goal: 'Clean 12s', note: 'slow eccentric', progression: prog(0) } ] },
        { id: 'ps-2', order: 2, name: 'Lower A', focus: null, brief: ['Easy leg re-introduction.'], exercises: [
          { exerciseId: ${J(CABLE_FLY)}, targetSets: 3, targetRepsLow: 10, targetRepsHigh: 12, targetWeightKg: 15, targetDurationSec: null, targetRpe: null, purpose: 'Chest isolation', goal: 'Steady 12s', note: null, progression: prog(0) } ] },
      ] });
    await db.setMeta('coach.currentPlanId', 'plan-e2e');
    ui.refreshCoachTab();
    return true;
  })()`);
  check('coach: tab button appears once a key exists', await poll('coach tab visible', `document.querySelector('#tabbar button[data-tab="coach"]').hidden === false`));
  await clickSel('open coach tab', '#tabbar button[data-tab="coach"]');
  await poll('coach route', `location.hash === '#/coach' && !document.getElementById('s-coach').hidden`);
  check('coach: next-session card renders the seeded plan with a Start button',
    await poll('coach start button', `document.querySelector('#s-coach [data-action="coach-start-session"]') != null`));
  check('coach: next session names Upper A', await evalJS(`document.getElementById('s-coach').textContent.includes('Upper A')`));
  check('coach: next-session card shows the programme week (Week 3)', await evalJS(`/Week 3/.test(document.getElementById('s-coach').textContent)`));
  await clickSel('start planned session', '#s-coach [data-action="coach-start-session"]');
  await poll('planned workout up', `location.hash === '#/workout' && document.querySelector('.ex-card[data-exercise-id=${J(BBP)}]') != null`);
  check('coach: planned session pre-creates targetSets blank rows (3 for bench)',
    await poll('three bench rows', `document.querySelectorAll(${J(bbpCard + ' .set-row')}).length === 3`));
  check('coach: 2 rows for the second exercise', (await count(`.ex-card[data-exercise-id="${TRI_PUSHDOWN}"] .set-row`)) === 2);
  check('coach: plan chip marks the swapped placeholders', await exists(`${bbpCard} .ex-plan-chip`));
  const ghost = await evalJS(`(() => {
    const row = document.querySelectorAll(${J(bbpCard + ' .set-row')})[0];
    return { w: row.querySelector('input[data-field="weight"]').placeholder, r: row.querySelector('input[data-field="reps"]').placeholder,
             v: row.querySelector('input[data-field="weight"]').value };
  })()`);
  check('coach: ghost placeholders are this WEEK\'s projected targets (65 kg × 8), inputs still empty',
    ghost && ghost.w === '65' && ghost.r === '8' && ghost.v === '', JSON.stringify(ghost));
  check('coach: workout record is tagged with the plan session', await evalJS(`(async () => {
    const db = await import('./js/db.js');
    const w = await db.getWorkout(localStorage.getItem('currentWorkoutId'));
    return w.planId === 'plan-e2e' && w.planSessionId === 'ps-1' && w.name === 'Upper A';
  })()`));
  await setField('reps only (plan autofill)', bbpCard, 0, 'reps', 8);
  const planFilled = await poll('plan weight autofilled', `(async () => {
    const db = await import('./js/db.js');
    const s = (await db.listSetsForWorkout(localStorage.getItem('currentWorkoutId'))).filter((x) => x.exerciseId === ${J(BBP)}).sort((a, b) => a.setNumber - b.setNumber);
    return s[0] && s[0].reps === 8 && s[0].weightKg === 65;
  })()`);
  check('coach: typing reps autofills the projected plan weight (65 kg) with no extra tap', planFilled);
  // Copy Routine now offers the plan too.
  await clickSel('copy routine (plan check)', '#s-workout [data-action="copy-routine"]');
  await poll('copy picker', `location.hash === '#/copy'`);
  check('coach: Copy Routine lists From Plan when a plan exists', await poll('from-plan row', `document.querySelector('#s-copy [data-copy-cat="from"]') != null`));
  await evalJS(`(() => { location.hash = '#/workout'; return true; })()`);
  await poll('back on workout', `location.hash === '#/workout'`);
  const plannedId = await evalJS(`localStorage.getItem('currentWorkoutId')`);
  await finishActiveWorkout();
  check('coach: finishing a planned workout queues session feedback while offline',
    await poll('pending session slot', `(async () => {
      const db = await import('./js/db.js');
      const p = await db.getMeta('coach.pending');
      return !!p && p.kind === 'session' && p.workoutId === ${J(plannedId)};
    })()`, 10000));
  check('coach: no insight was stored from the failed call', await evalJS(`(async () => (await (await import('./js/db.js')).getCoachInsight('session-' + ${J(plannedId)})) === undefined)()`));
  // The Log + now asks: planned session or empty workout. Next planned session should be Lower A.
  await clickSel('log +, with a plan', '#s-log [data-action="start-workout"]');
  check('coach: start choice sheet offers planned + empty', await poll('start choice sheet', `document.querySelector('#sheet-root [data-action="start-planned"]') != null && document.querySelector('#sheet-root [data-action="start-empty"]') != null`));
  check('coach: next planned session rotates to Lower A', await evalJS(`document.querySelector('#sheet-root [data-action="start-planned"]').textContent.includes('Lower A')`));
  await clickSel('choose empty workout', '#sheet-root [data-action="start-empty"]');
  await poll('empty workout up', `location.hash === '#/workout' && !document.getElementById('s-workout').hidden`);
  check('coach: empty choice starts an untagged workout with no cards', await evalJS(`(async () => {
    const db = await import('./js/db.js');
    const w = await db.getWorkout(localStorage.getItem('currentWorkoutId'));
    return !w.planSessionId && document.querySelectorAll('#s-workout .ex-card').length === 0;
  })()`));
  // --- Coach v2: plan weeks, builder, chat + memory -------------------------
  await evalJS(`(() => { location.hash = '#/coach/plan'; return true; })()`);
  check('coach v2: plan screen shows overview bullets', await poll('overview bullets', `document.querySelector('#s-coach .coach-bullets') != null && document.getElementById('s-coach').textContent.includes('Rebuild pressing strength')`));
  check('coach v2: week selector has 8 chips with W3 current', (await count('#s-coach [data-action="coach-week"]')) === 8 && await exists('#s-coach [data-action="coach-week"][data-week="3"].is-current'));
  await clickSel('pick week 5', '#s-coach [data-action="coach-week"][data-week="5"]');
  check('coach v2: week 5 projects bench to 70 kg', await poll('week 5 targets', `/70\\s?kg/.test(document.getElementById('s-coach').textContent)`));
  await clickSel('pick week 6 (deload)', '#s-coach [data-action="coach-week"][data-week="6"]');
  check('coach v2: deload week is labelled and drops the load', await poll('deload week', `/[Dd]eload/.test(document.getElementById('s-coach').textContent) && /65\\s?kg/.test(document.getElementById('s-coach').textContent)`));
  await clickSel('expand an exercise row', '#s-coach [data-action="coach-ex-toggle"]');
  check('coach v2: exercise row expands to purpose/goal', await poll('purpose shown', `document.getElementById('s-coach').textContent.includes('Main press')`));

  await evalJS(`(() => { location.hash = '#/coach/builder'; return true; })()`);
  check('coach v2: builder renders save + build actions', await poll('builder', `document.querySelector('#s-coach [data-action="coach-builder-save"]') != null && document.querySelector('#s-coach [data-action="coach-builder-build"]') != null`));
  await clickSel('builder save', '#s-coach [data-action="coach-builder-save"]');
  check('coach v2: builder save writes a v2 profile', await poll('profile v2', `(async () => { const p = await (await import('./js/db.js')).getMeta('coach.profile'); return !!p && p.version === 2 && typeof p.cardio === 'object'; })()`));

  // Chat: stub fetch with a canned successful chat reply.
  await evalJS(`(() => {
    window.fetch = async (url, init) => {
      const body = JSON.stringify({ reply: ['Noted.', 'I will keep spinal loading light.'], memoryUpdates: { add: ['Sciatica — no heavy spinal loading yet'], removeIds: [] }, profilePatch: null, planChanges: [], plan: null });
      return new Response(JSON.stringify({ id: 'msg_e2e', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: body }], usage: { input_tokens: 100, output_tokens: 40 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    location.hash = '#/home';
    return true;
  })()`);
  await poll('home chat input', `document.querySelector('#s-home .coach-chat-input') != null && document.querySelector('#s-home [data-action="coach-chat-send"]') != null`);
  await evalJS(`(() => { const ta = document.querySelector('#s-home .coach-chat-input'); ta.value = 'I have sciatica, go easy on my back'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await clickSel('send chat', '#s-home [data-action="coach-chat-send"]');
  check('coach v2: chat shows the coach reply as bullets', await poll('coach reply', `[...document.querySelectorAll('#s-home .coach-chat-coach')].some((el) => el.textContent.includes('Noted.'))`, 10000));
  check('coach v2: chat reply added a memory item', await poll('memory item', `(async () => { const m = await (await import('./js/db.js')).getMeta('coach.memory'); return Array.isArray(m) && m.length === 1 && m[0].text.includes('Sciatica'); })()`));
  check('coach v2: chat stored both turns', await evalJS(`(async () => (await (await import('./js/db.js')).listChatMessages({ thread: 'home' })).length === 2)()`));
  await evalJS(`(() => { location.hash = '#/coach/builder'; return true; })()`);
  check('coach v2: builder lists the memory item', await poll('memory listed', `document.querySelector('#s-coach [data-action="coach-memory-remove"]') != null`));
  await clickSel('remove memory item', '#s-coach [data-action="coach-memory-remove"]');
  check('coach v2: removing a memory item empties the list', await poll('memory empty', `(async () => { const m = await (await import('./js/db.js')).getMeta('coach.memory'); return Array.isArray(m) && m.length === 0; })()`));
  await evalJS(`(() => { location.hash = '#/log'; return true; })()`);
  await poll('back on log', `location.hash === '#/log'`);

  // Cleanup: remove the empty workout, clear coach data + key, restore fetch.
  await evalJS(`(async () => {
    const db = await import('./js/db.js');
    const ui = await import('./js/ui.js');
    await db.deleteWorkout(localStorage.getItem('currentWorkoutId'));
    ui.setCurrent(null);
    await db.clearCoachData();
    localStorage.removeItem('coach.apiKey');
    ui.refreshCoachTab();
    window.fetch = window.__realFetch;
    location.hash = '#/log';
    return true;
  })()`);
  await poll('back on log after coach walk', `location.hash === '#/log'`);
  check('coach: tab hides again once the key is removed', await poll('coach tab hidden', `document.querySelector('#tabbar button[data-tab="coach"]').hidden === true`));

  // --- 16. No uncaught exceptions / console errors across the whole walk ---
  check('pwa: no uncaught exceptions or console errors during the walk', jsErrors.length === 0, jsErrors.join(' | '));
} catch (err) {
  failures.push('SUITE ABORTED');
  console.log('FAIL — suite aborted :: ' + err.message);
  if (jsErrors.length) console.log('      page errors at abort: ' + jsErrors.slice(0, 5).join(' | '));
}

console.log(failures.length === 0
  ? `E2E SUMMARY: ${passCount} passed, 0 failed — ALL GREEN`
  : `E2E SUMMARY: ${passCount} passed, ${failures.length} FAILED: ${failures.join('; ')}`);
ws.close();
process.exit(failures.length ? 1 : 0);
