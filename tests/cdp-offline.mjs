// Hard offline check: load once (SW precaches), KILL the web server for real,
// reload — the app must come entirely from the service worker cache.
import { execSync } from 'node:child_process';

const DEBUG_PORT = 9223;
const APP_URL = 'http://127.0.0.1:8741/index.html';

const target = await (async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?url=about:blank`, { method: 'PUT' });
      if (res.ok) return res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('no debug port');
})();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
const evalJS = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return m.result?.result?.value;
};
const poll = async (expr, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evalJS(expr)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

await send('Page.enable');
await send('Page.navigate', { url: APP_URL });
// Reworked shell: the app boots to #/log with the bottom tab bar (no more #s-home).
if (!(await poll(`location.hash === '#/home' && !document.getElementById('s-home').hidden && document.getElementById('s-home').childElementCount > 0`))) {
  console.log('FAIL — initial load never rendered'); process.exit(1);
}
await poll(`caches.keys().then((k) => k.some((n) => n.startsWith('healthhub-')))`); // the SW shell cache exists (any CACHE_VERSION)
await new Promise((r) => setTimeout(r, 500));

// Kill the server — genuinely no network origin any more.
try { execSync('pkill -f "http.server 8741"'); } catch {}
await new Promise((r) => setTimeout(r, 500));
try {
  await fetch(APP_URL);
  console.log('FAIL — server still reachable; offline test invalid');
  process.exit(1);
} catch { /* good: origin is dead */ }

await send('Page.reload');
// Served entirely from the SW cache: the Log tab must render with the tab bar.
const home = await poll(`location.hash === '#/home' && !document.getElementById('s-home').hidden && document.getElementById('s-home').childElementCount > 0 && document.querySelector('#tabbar button[data-tab="home"]') !== null`);
if (home) await evalJS(`location.hash = '#/log'`);
const ok = home && await poll(`location.hash === '#/log' && !document.getElementById('s-log').hidden && document.getElementById('s-log').childElementCount > 0`);
// Prove interactivity offline too: start a workout (writes to IndexedDB).
let flow = false;
if (ok) {
  await evalJS(`window.confirm = () => true; document.querySelector('#s-log [data-action="start-workout"]').click()`);
  flow = await poll(`location.hash === '#/workout' && !document.getElementById('s-workout').hidden`);
}
// Coach (Phase C) is in the shell cache too: its route renders offline
// (the no-key state) without any network.
let coach = false;
if (ok && flow) {
  await evalJS(`location.hash = '#/coach'`);
  coach = await poll(`location.hash === '#/coach' && !document.getElementById('s-coach').hidden && document.getElementById('s-coach').childElementCount > 0`);
}
console.log(ok && flow && coach
  ? 'PASS — server killed: app loads from SW cache, a workout can be started offline, and #/coach renders'
  : `FAIL — server killed: rendered=${ok} startFlow=${flow} coach=${coach}`);
ws.close();
process.exit(ok && flow && coach ? 0 : 1);
