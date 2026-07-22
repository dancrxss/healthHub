// screens/stats.js — Statistics tab (stub). A follow-up agent builds the
// CSS-bar charts from the frozen queries. Keep this tiny.
import { h } from '../ui.js';

export function renderStats() {
  document.getElementById('s-stats').replaceChildren(
    h('div', { class: 'tab-screen' },
      h('h1', { class: 'tab-title', text: 'Statistics' }),
      h('p', { class: 'tab-placeholder muted', text: 'Coming in the next commit' }),
    ),
  );
}
