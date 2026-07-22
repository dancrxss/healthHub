// screens/routines.js — Routines tab (stub). A follow-up agent builds the
// templates list and start/create/edit flows. Keep this tiny.
import { h } from '../ui.js';

export function renderRoutines() {
  document.getElementById('s-routines').replaceChildren(
    h('div', { class: 'tab-screen' },
      h('h1', { class: 'tab-title', text: 'Routines' }),
      h('p', { class: 'tab-placeholder muted', text: 'Coming in the next commit' }),
    ),
  );
}
