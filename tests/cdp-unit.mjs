// Drive headless Chrome over CDP: open the test page, poll the summary line,
// print results, exit. Node 22+ (global WebSocket, fetch).
const DEBUG_PORT = 9223;
const PAGE_URL = 'http://127.0.0.1:8741/tests/test.html';

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
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}

await send('Page.enable');
await send('Page.navigate', { url: PAGE_URL });

let summary = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const { result } = await send('Runtime.evaluate', {
    expression: `document.getElementById('summary')?.textContent || ''`,
    returnByValue: true,
  });
  const text = result?.result?.value || '';
  if (text && !text.includes('Running')) { summary = text; break; }
}

if (summary === null) {
  console.log('TIMEOUT: summary never resolved');
  process.exit(2);
}
console.log(summary);

const { result } = await send('Runtime.evaluate', {
  expression: `[...document.querySelectorAll('#results > div')].map(d => d.textContent).join('\\n')`,
  returnByValue: true,
});
console.log(result?.result?.value || '(no detail lines)');
ws.close();
process.exit(summary.includes('FAIL') ? 1 : 0);
