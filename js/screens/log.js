// screens/log.js — Log tab (stub). A follow-up agent builds month groups and
// workout cards. Keep this tiny.
import { h } from '../ui.js';

export function renderLogTab() {
  document.getElementById('s-log').replaceChildren(
    h('div', { class: 'tab-screen' },
      h('h1', { class: 'tab-title', text: 'Log' }),
      h('p', { class: 'tab-placeholder muted', text: 'Coming in the next commit' }),
    ),
  );
}
