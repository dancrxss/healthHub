// screens/profile.js — Profile tab (stub). A follow-up agent builds units,
// default rest, sync status and about. Keep this tiny.
import { h } from '../ui.js';

export function renderProfile() {
  document.getElementById('s-profile').replaceChildren(
    h('div', { class: 'tab-screen' },
      h('h1', { class: 'tab-title', text: 'Profile' }),
      h('p', { class: 'tab-placeholder muted', text: 'Coming in the next commit' }),
    ),
  );
}
