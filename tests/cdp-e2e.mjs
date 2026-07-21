// E2E: drive the gym tracker PWA headlessly over CDP through a full workout.
const DEBUG_PORT = 9223;
const APP_URL = 'http://127.0.0.1:8741/index.html';

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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
  while (Date.now() - start < timeoutMs) {
    let v;
    try { v = await evalJS(expression); } catch { v = undefined; }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`poll timed out: ${name}`);
}
// Click the first element matching selector whose (optional) text matches exactly.
function clickExpr(selector, exactText = null) {
  return `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${exactText === null
      ? 'els[0]'
      : `els.find(e => (e.querySelector('.ex-name') || e).textContent.trim() === ${JSON.stringify(exactText)})`};
    if (!el) return false;
    el.click();
    return true;
  })()`;
}

await send('Page.enable');
// Auto-accept confirm() dialogs on every navigation.
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm = () => true;' });
await send('Page.navigate', { url: APP_URL });

try {
  // --- 1. Fresh app: seed runs, Home renders ---
  await poll('home rendered', `document.querySelector('#s-home .btn-primary')?.textContent === 'Start workout'`);
  check('home: Start workout shown on fresh install', true);
  const tplShown = await evalJS(`[...document.querySelectorAll('#s-home button')].some(b => b.textContent.trim() === 'Push Day A')`);
  check('home: seeded template “Push Day A” offered', tplShown);
  const seedCount = await evalJS(`import('./js/db.js').then(m => m.listExercises()).then(l => l.length)`);
  check('seed: 56 exercises after seedIfEmpty (55 seed; none custom yet)', seedCount === 55, `got ${seedCount}`);

  // --- 2. Start workout ---
  await evalJS(clickExpr('#s-home .btn-primary'));
  await poll('workout screen', `location.hash === '#/workout' && !document.getElementById('s-workout').hidden`);
  check('start: lands on empty workout screen', await evalJS(`document.getElementById('s-workout').textContent.includes('No exercises yet')`));

  // --- 3. Pick an exercise ---
  await evalJS(clickExpr('#s-workout .btn'));  // "+ Add exercise" is the first .btn
  await poll('picker', `location.hash === '#/pick' && document.querySelectorAll('#s-pick .pick-item').length > 0`);
  check('picker: grouped items rendered', true);
  await evalJS(clickExpr('#s-pick .pick-item', 'Barbell Bench Press'));
  await poll('log screen', `location.hash === '#/log/seed-barbell-bench-press' && !document.getElementById('s-log').hidden && document.getElementById('s-log').textContent.includes('Last session')`);
  check('log: first time shows no history', await evalJS(`document.getElementById('s-log').textContent.includes('First time — no history')`));
  const w0 = await evalJS(`document.querySelector('#s-log input[aria-label="Weight (kg)"]').value`);
  const r0 = await evalJS(`document.querySelector('#s-log input[aria-label="Reps"]').value`);
  check('log: default prefill 20 kg × 8', w0 === '20' && r0 === '8', `got ${w0} × ${r0}`);

  // --- 4. One-tap set + timer ---
  await evalJS(clickExpr('#s-log .confirm-btn'));
  await poll('set 1 saved', `document.querySelectorAll('#s-log .set-item').length === 1`);
  check('confirm: one tap saves set 1', true);
  const barShown = await poll('rest bar visible', `!document.getElementById('rest-bar').hidden`);
  check('timer: rest bar auto-starts on set completion', !!barShown);
  const t1 = await evalJS(`document.getElementById('rest-bar-time').textContent`);
  check('timer: countdown shows ~1:30 default', /^1:(2[0-9]|30)$/.test(t1), `got ${t1}`);
  await evalJS(clickExpr('#rest-bar'));
  await poll('rest bar dismissed', `document.getElementById('rest-bar').hidden`);
  check('timer: tap dismisses', true);

  // --- 5. One-tap repeat set ---
  await evalJS(clickExpr('#s-log .confirm-btn'));
  await poll('set 2 saved', `document.querySelectorAll('#s-log .set-item').length === 2`);
  const bothSame = await evalJS(`[...document.querySelectorAll('#s-log .set-item .vals')].every(v => v.textContent.includes('20 kg × 8'))`);
  check('repeat: second set identical, ONE tap total', bothSame);
  await evalJS(clickExpr('#rest-bar'));

  // --- 6. Adjust then confirm (≤2 taps + stepper) ---
  await evalJS(`[...document.querySelectorAll('#s-log .stepper')][0].querySelector('.step-btn[aria-label="increase"]').click()`);
  const w1 = await evalJS(`document.querySelector('#s-log input[aria-label="Weight (kg)"]').value`);
  check('stepper: +2.5 kg → 22.5', w1 === '22.5', `got ${w1}`);
  await evalJS(clickExpr('#s-log .confirm-btn'));
  await poll('set 3 saved', `document.querySelectorAll('#s-log .set-item').length === 3`);
  check('adjusted set saved at 22.5 kg', await evalJS(`[...document.querySelectorAll('#s-log .set-item .vals')].some(v => v.textContent.includes('22.5 kg × 8'))`));
  await evalJS(clickExpr('#rest-bar'));

  // --- 7. Warm-up set; toggle resets after save ---
  await evalJS(`[...document.querySelectorAll('#s-log .toggle')].find(b => b.textContent.trim() === 'Warm-up').click()`);
  await poll('warmup on', `[...document.querySelectorAll('#s-log .toggle')].find(b => b.textContent.trim() === 'Warm-up')?.getAttribute('aria-pressed') === 'true'`);
  await evalJS(clickExpr('#s-log .confirm-btn'));
  await poll('set 4 saved', `document.querySelectorAll('#s-log .set-item').length === 4`);
  check('warmup: set 4 marked W', await evalJS(`[...document.querySelectorAll('#s-log .set-item')].some(el => el.querySelector('.w'))`));
  check('warmup: toggle auto-resets after save', await evalJS(`[...document.querySelectorAll('#s-log .toggle')].find(b => b.textContent.trim() === 'Warm-up')?.getAttribute('aria-pressed') === 'false'`));
  await evalJS(clickExpr('#rest-bar'));

  // --- 8. Workout screen reflects sets; finish ---
  await evalJS(`location.hash = '#/workout'`);
  await poll('workout row', `[...document.querySelectorAll('#s-workout .ex-row')].some(r => r.textContent.includes('Barbell Bench Press') && r.textContent.includes('4 × done'))`);
  check('workout: exercise row shows 4 × done', true);
  await evalJS(`[...document.querySelectorAll('#s-workout .btn')].find(b => b.textContent.trim() === 'Finish workout').click()`);
  await poll('back home finished', `location.hash === '#/' && [...document.querySelectorAll('#s-home .card-sub')].some(c => c.textContent.includes('1 exercise') && c.textContent.includes('3 working sets'))`);
  check('finish: home card shows 1 exercise · 3 working sets (warmup excluded)', true);

  // --- 9. Frozen query layer over real logged data ---
  const prs = await evalJS(`import('./js/queries.js').then(m => m.getPRs('seed-barbell-bench-press'))`);
  check('queries: PR @8 reps = 22.5 kg', prs?.byReps?.find((r) => r.reps === 8)?.weightKg === 22.5, JSON.stringify(prs?.byReps));
  check('queries: bestE1RM from 22.5×8, warmup excluded', Math.abs((prs?.bestE1RM?.value ?? 0) - 22.5 * (1 + 8 / 30)) < 1e-6 && prs?.bestE1RM?.weightKg === 22.5);
  const vol = await evalJS(`import('./js/queries.js').then(m => m.getWeeklyVolume(1))`);
  check('queries: this week chest volume = 20×8×2 + 22.5×8 = 500', vol?.[0]?.perMuscleGroup?.chest === 500, JSON.stringify(vol?.[0]));

  // --- 10. Second workout: last-session panel + prefill from top working set ---
  await evalJS(clickExpr('#s-home .btn-primary'));   // Start workout
  await poll('workout 2', `location.hash === '#/workout'`);
  await evalJS(`location.hash = '#/log/seed-barbell-bench-press'`);
  await poll('log 2', `document.getElementById('s-log').textContent.includes('Last session') && !document.getElementById('s-log').textContent.includes('First time')`);
  check('last session: panel lists previous sets incl. warmup marker', await evalJS(`document.querySelectorAll('#s-log .panel .set-line').length === 4 && !!document.querySelector('#s-log .panel .w')`));
  const w2 = await evalJS(`document.querySelector('#s-log input[aria-label="Weight (kg)"]').value`);
  check('prefill: from last session top working set (22.5 × 8)', w2 === '22.5', `got ${w2}`);

  // --- 11. Reload: persistence + resume + service worker ---
  await send('Page.navigate', { url: APP_URL });
  await poll('reload home', `document.querySelector('#s-home .btn-primary')?.textContent === 'Resume workout'`);
  check('reload: in-progress workout survives, Resume offered', true);
  const swCount = await evalJS(`navigator.serviceWorker.getRegistrations().then(r => r.length)`);
  check('service worker registered', swCount >= 1, `got ${swCount}`);
  const cacheOk = await evalJS(`caches.has('healthhub-v1')`);
  check('app shell precached (healthhub-v1)', cacheOk === true);

  // --- 12. Settings: lb display-only ---
  await evalJS(`location.hash = '#/settings'`);
  await poll('settings', `!document.getElementById('s-settings').hidden && document.getElementById('s-settings').textContent.length > 0`);
  const sText = await evalJS(`document.getElementById('s-settings').textContent`);
  check('settings: sync status shows local mode', /local/i.test(sText), sText.slice(0, 120));
} catch (err) {
  failures.push('SUITE ABORTED');
  console.log('FAIL — suite aborted :: ' + err.message);
}

console.log(failures.length === 0
  ? `E2E SUMMARY: ${passCount} passed, 0 failed — ALL GREEN`
  : `E2E SUMMARY: ${passCount} passed, ${failures.length} FAILED: ${failures.join('; ')}`);
ws.close();
process.exit(failures.length ? 1 : 0);
