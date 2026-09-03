// ============================================================================
// screens/coach-shared.js — shared Coach UI building blocks (Phase C2, PLAN.md
// §"Phase C2" C2.5), used by the Home tab, the Coach tab and the plan builder.
//
// Nothing here touches IndexedDB directly except reading chat history
// (js/db.js listChatMessages) and js/coach.js's read model / chat queue —
// exactly the same surface every other screen uses. Model-written text
// (bullets, chat replies) is untrusted content and only ever reaches the DOM
// through textContent / the h() `text` prop — never innerHTML.
// ============================================================================

import {
  h, Icon, openSheet, closeSheet, sheetHeader, sheetGroup, formatWeight,
} from '../ui.js';
import { listChatMessages } from '../db.js';
import {
  getCoachState, sendChat, chatBusy, onCoachUpdate,
} from '../coach.js';
import { playOnce, motionOK } from '../motion.js';

// ----------------------------------------------------------------------------
// Small formatting helpers
// ----------------------------------------------------------------------------
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const trimNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/** "16:39" today, "3 Aug, 16:39" otherwise — the chat time-divider label. */
function chatTimeLabel(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
}

/**
 * A model-written bullet list. `points` is normally a string[] (already
 * clipped/capped by coach-api.js's normaliseNarrative), but a bare string is
 * accepted too (one item) — null/empty renders nothing.
 * @param {string[]|string|null} points
 * @returns {HTMLElement|null}
 */
export function bullets(points, { cls = '' } = {}) {
  let items;
  if (Array.isArray(points)) items = points.filter((p) => typeof p === 'string' && p.trim());
  else if (typeof points === 'string' && points.trim()) items = [points.trim()];
  else items = [];
  if (!items.length) return null;
  return h('ul', { class: `coach-bullets${cls ? ` ${cls}` : ''}` },
    ...items.map((t) => h('li', { text: t })));
}

/**
 * "3 × 6–8 @ 62.5 kg" for a rep target, "10 min" / "3 × 45 s" for a duration
 * target (PLAN.md C2.2 isDurationType). withName + exMap prefixes the
 * exercise name: "Barbell Bench Press · 3 × 6–8 @ 62.5 kg".
 */
export function targetText(e, { exMap = null, withName = false } = {}) {
  if (!e || typeof e !== 'object') return '';
  const sets = numOrNull(e.targetSets);
  const dur = numOrNull(e.targetDurationSec);
  let base;
  if (dur != null && dur > 0) {
    const durTxt = dur >= 60 ? `${Math.round(dur / 60)} min` : `${Math.round(dur)} s`;
    base = sets != null && sets > 1 ? `${trimNum(sets)} × ${durTxt}` : durTxt;
  } else {
    const lo = numOrNull(e.targetRepsLow);
    const hi = numOrNull(e.targetRepsHigh);
    const reps = lo == null && hi == null ? '—'
      : lo != null && hi != null && lo !== hi ? `${trimNum(lo)}–${trimNum(hi)}`
        : trimNum(lo ?? hi);
    base = `${sets == null ? '—' : trimNum(sets)} × ${reps}`;
    const w = numOrNull(e.targetWeightKg);
    if (w != null && w > 0) base += ` @ ${formatWeight(w)}`;
  }
  if (withName) {
    const ex = exMap && e.exerciseId ? exMap.get(e.exerciseId) : null;
    const name = ex ? ex.name : 'Exercise';
    return `${name} · ${base}`;
  }
  return base;
}

/** Copied verbatim from screens/coach.js v1 — a small pill coloured by tone. */
export function tonePill(value, map) {
  const def = map[value];
  if (!def) return null;
  return h('span', { class: `coach-pill coach-pill-${def.tone}`, text: def.label });
}

// ----------------------------------------------------------------------------
// chatPanel — a live chat thread ('home' or 'plan'), rendered into `container`.
// ----------------------------------------------------------------------------
const EMPTY_TEXT = {
  home: 'Ask anything about your training, or tell the coach something it should know.',
  plan: 'Describe the change you want — e.g. "add a leg day on Fridays" or "swap bench for dumbbell press".',
};

/**
 * @param {{thread: 'home'|'plan', container: HTMLElement, compact?: boolean}} opts
 * @returns {{destroy: () => void}}
 */
export function chatPanel({ thread, container, compact = false }) {
  const list = h('div', { class: 'coach-chat-list' });
  const textarea = h('textarea', {
    class: 'coach-chat-input', rows: '1', enterkeyhint: 'send',
    placeholder: EMPTY_TEXT[thread] || EMPTY_TEXT.home,
  });
  const sendBtn = h('button', {
    class: 'coach-chat-send', type: 'button', 'aria-label': 'Send',
    'data-action': 'coach-chat-send', onclick: () => { send(); },
  }, Icon('up'));
  const sendError = h('p', { class: 'coach-chat-send-error' });
  const inputRow = h('div', { class: 'coach-chat-input-row' }, textarea, sendBtn);
  const wrap = h('div', { class: `coach-chat${compact ? ' coach-chat-compact' : ''}` },
    list, sendError, inputRow);
  container.append(wrap);

  let destroyed = false;
  let sending = false;
  let firstPaint = true;
  // Message ids already rendered once — anim-bubble-in only plays for a
  // message that just arrived, never replayed on every paint() re-render.
  const seenIds = new Set();

  const MAX_TEXTAREA_PX = 132; // ~5 lines at 16px/1.35 line-height + padding
  const autoGrow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(MAX_TEXTAREA_PX, textarea.scrollHeight)}px`;
  };
  textarea.addEventListener('input', autoGrow);
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });

  // ---- keyboard handling ---------------------------------------------------
  // While the panel is mounted, keep the composer visible as the on-screen
  // keyboard opens/closes/resizes the visual viewport (iOS never scrolls a
  // sticky/fixed element into view on its own). Listeners are on `window`,
  // so they must be torn down explicitly in destroy() — the element being
  // removed does not do that for us.
  const scrollInputIntoView = () => {
    try { inputRow.scrollIntoView({ block: 'end' }); } catch (e) { /* older engines */ }
  };
  textarea.addEventListener('focus', scrollInputIntoView);
  const vv = window.visualViewport || null;
  if (vv) {
    vv.addEventListener('resize', scrollInputIntoView);
    vv.addEventListener('scroll', scrollInputIntoView);
  }

  const nearBottom = () => (list.scrollHeight - list.scrollTop - list.clientHeight) < 60;

  function retryLine(text) {
    return h('button', {
      class: 'coach-text-btn', type: 'button', 'data-action': 'coach-chat-retry',
      onclick: () => send(text),
    }, 'Retry');
  }

  async function paint() {
    if (destroyed) return;
    const wasNearBottom = nearBottom();
    let rows = [];
    let state = null;
    try {
      [rows, state] = await Promise.all([
        listChatMessages({ thread, limit: 60 }),
        getCoachState().catch(() => null),
      ]);
    } catch (err) {
      console.error('coach-shared: chat load failed', err);
    }
    if (destroyed) return;

    const ordered = rows.slice().reverse(); // newest-first -> oldest-first
    const nodes = [];
    const newBubbles = []; // bubbles for messages not previously rendered by this panel
    if (!ordered.length) {
      nodes.push(h('p', { class: 'coach-chat-empty muted', text: EMPTY_TEXT[thread] || EMPTY_TEXT.home }));
    }
    let prevMsg = null;
    ordered.forEach((m, i) => {
      // A time divider when the gap since the previous message is > 10 min,
      // and a wider row gap whenever the speaker changes (both PLAN.md's
      // "iMessage-like" chat rhythm).
      if (prevMsg && (new Date(m.createdAt) - new Date(prevMsg.createdAt)) > 10 * 60 * 1000) {
        nodes.push(h('div', { class: 'coach-chat-ts muted', text: chatTimeLabel(m.createdAt) }));
      }
      const newSpeaker = !prevMsg || prevMsg.role !== m.role;
      const rowClass = (base) => `${base}${newSpeaker ? ' coach-chat-row-new-speaker' : ''}`;
      const isNew = !!m.id && !seenIds.has(m.id);
      if (m.id) seenIds.add(m.id);
      prevMsg = m;

      if (m.role === 'user') {
        const bubble = h('div', { class: 'coach-chat-user', text: m.text || '' });
        if (isNew) newBubbles.push(bubble);
        nodes.push(h('div', { class: rowClass('coach-chat-row coach-chat-row-user') },
          bubble,
          m.pending ? h('div', { class: 'coach-chat-wait muted', text: 'Waiting for the coach…' }) : null,
        ));
        return;
      }
      if (m.error) {
        const prevUser = i > 0 && ordered[i - 1].role === 'user' ? ordered[i - 1] : null;
        const bubble = h('div', { class: 'coach-chat-error' },
          h('span', { class: 'coach-chat-error-text', text: m.error }),
          prevUser && prevUser.text ? retryLine(prevUser.text) : null,
        );
        if (isNew) newBubbles.push(bubble);
        nodes.push(h('div', { class: rowClass('coach-chat-row coach-chat-row-coach') }, bubble));
        return;
      }
      const chips = [];
      if (m.changed) {
        if (m.changed.plan) chips.push('Plan updated');
        if (m.changed.profile) chips.push('Profile updated');
        if (m.changed.memory) chips.push('Noted');
      }
      const bubble = h('div', { class: 'coach-chat-coach' },
        bullets(m.points) || h('p', { class: 'coach-chat-coach-empty muted', text: '—' }));
      if (isNew) newBubbles.push(bubble);
      nodes.push(h('div', { class: rowClass('coach-chat-row coach-chat-row-coach') },
        bubble,
        chips.length ? h('div', { class: 'coach-chat-chips' },
          ...chips.map((c) => h('span', { class: 'coach-chat-chip', text: c }))) : null,
      ));
    });

    const running = !!(state && state.running === 'chat');
    if (running) {
      // Always the last node, so it reads as pinned to the bottom of the
      // thread — the same auto-scroll-when-near-bottom logic below keeps it
      // in view as it appears and disappears.
      nodes.push(h('div', { class: 'coach-chat-row coach-chat-row-coach' },
        h('div', { class: 'coach-chat-thinking' },
          h('span', { class: 'coach-status-dot' }),
          h('span', { class: 'coach-status-text', text: 'Coach is thinking…' }))));
    }

    list.replaceChildren(...nodes);
    if (motionOK()) { for (const el of newBubbles) playOnce(el, 'anim-bubble-in'); }
    if (wasNearBottom) list.scrollTop = list.scrollHeight;

    const busy = running || chatBusy();
    textarea.disabled = busy;
    sendBtn.disabled = busy;

    if (firstPaint) {
      firstPaint = false;
      // Open at the newest message. The compact Home list scrolls itself
      // (above); the full-screen route additionally asks ui.js's router to
      // land the page at the bottom (see requestBottomScroll in the coach
      // route), but the panel's own first paint happens after that scroll
      // has already run, so it re-asserts it once the messages are in.
      if (!compact) {
        requestAnimationFrame(() => {
          if (destroyed) return;
          list.scrollTop = list.scrollHeight;
          try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) { /* ignore */ }
        });
      }
    }
  }

  async function send(overrideText) {
    if (destroyed || sending) return;
    const text = (overrideText != null ? overrideText : textarea.value).trim();
    if (!text) return;
    // Drop the keyboard immediately on a touch device — waiting for the
    // reply to land first reads as unresponsive.
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) textarea.blur();
    sending = true;
    sendError.textContent = '';
    // Clear the box as soon as the message is on its way (the reply can take
    // a minute); put the text back if the send was refused outright.
    if (overrideText == null) { textarea.value = ''; autoGrow(); }
    try {
      await sendChat(thread, text);
    } catch (err) {
      if (overrideText == null) { textarea.value = text; autoGrow(); }
      if (err && err.code === 'busy') sendError.textContent = 'The coach is still replying.';
      else if (err && err.code === 'auth') sendError.textContent = 'Add your API key in Settings.';
      else sendError.textContent = (err && err.message) || 'Something went wrong.';
    } finally {
      sending = false;
    }
  }

  const unsub = onCoachUpdate(() => { paint().catch((err) => console.error('coach-shared: chat paint failed', err)); });
  paint().catch((err) => console.error('coach-shared: chat paint failed', err));

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsub();
      textarea.removeEventListener('focus', scrollInputIntoView);
      if (vv) {
        vv.removeEventListener('resize', scrollInputIntoView);
        vv.removeEventListener('scroll', scrollInputIntoView);
      }
      wrap.remove();
    },
  };
}

// ----------------------------------------------------------------------------
// multiSelectSheet — a searchable, grouped, multi-tick picker.
// ----------------------------------------------------------------------------
/**
 * @param {{title: string, groups: Array<{label: string, items: Array<{id:string,label:string,sub?:string}>}>,
 *   selected: Set<string>, onSave: (next: Set<string>) => void}} opts
 */
export function multiSelectSheet({ title, groups = [], selected = new Set(), onSave }) {
  const local = new Set(selected);
  const body = h('div', { class: 'coach-ms-body' });
  const footer = h('div', { class: 'coach-ms-footer muted' });

  const updateFooter = () => {
    footer.textContent = `${local.size} selected`;
  };

  const rowFor = (item) => {
    const tick = h('span', { class: 'sheet-row-tick' });
    const paintTick = () => tick.replaceChildren(...(local.has(item.id) ? [Icon('check')] : []));
    paintTick();
    const row = h('button', {
      class: `sheet-row coach-ms-row${local.has(item.id) ? ' is-selected' : ''}`, type: 'button',
      onclick: () => {
        if (local.has(item.id)) local.delete(item.id); else local.add(item.id);
        row.classList.toggle('is-selected', local.has(item.id));
        paintTick();
        updateFooter();
      },
    },
      h('span', { class: 'sheet-row-label' },
        h('span', { text: item.label }),
        item.sub ? h('span', { class: 'sheet-row-sub', text: item.sub }) : null,
      ),
      tick,
    );
    return row;
  };

  const paint = (query = '') => {
    const q = query.trim().toLowerCase();
    const sections = [];
    for (const group of groups) {
      const items = (group.items || []).filter((it) => !q || it.label.toLowerCase().includes(q));
      if (!items.length) continue;
      sections.push(h('div', { class: 'sheet-label', text: group.label }));
      sections.push(sheetGroup(...items.map(rowFor)));
    }
    body.replaceChildren(...(sections.length ? sections
      : [h('p', { class: 'sheet-message muted', text: 'No matches.' })]));
  };

  const search = h('input', {
    class: 'pick-search coach-ms-search', type: 'search', 'aria-label': 'Search', placeholder: 'Search',
  });
  search.addEventListener('input', () => paint(search.value));

  paint();
  updateFooter();

  openSheet(h('div', { class: 'coach-ms-sheet' },
    sheetHeader(title, {
      onSave: () => { onSave(new Set(local)); closeSheet(); },
      onClose: () => closeSheet(),
    }),
    h('div', { class: 'sheet-input-row coach-ms-search-row' }, search),
    body,
    footer,
  ));
}

// ----------------------------------------------------------------------------
// weekSelector — a horizontal row of week chips for the plan builder.
// ----------------------------------------------------------------------------
/**
 * @param {{weeks: number, current: number|null, selected: number|null,
 *   deloadWeek: number|null, onPick: (week: number) => void}} opts
 * @returns {HTMLElement}
 */
export function weekSelector({ weeks, current = null, selected = null, deloadWeek = null, onPick }) {
  const n = Math.max(1, Number(weeks) || 1);
  const chips = [];
  for (let w = 1; w <= n; w += 1) {
    const classes = ['coach-week-chip'];
    if (current != null && w === current) classes.push('is-current');
    if (selected != null && w === selected) classes.push('is-selected');
    if (deloadWeek != null && w === deloadWeek) classes.push('is-deload');
    if (current != null && w < current) classes.push('is-past');
    chips.push(h('button', {
      class: classes.join(' '), type: 'button',
      'data-action': 'coach-week', 'data-week': String(w),
      onclick: () => onPick(w),
    }, `W${w}`));
  }
  return h('div', { class: 'coach-week-row' }, ...chips);
}
