// ============================================================================
// screens/profile.js — Profile tab (#/profile). Display-unit toggle, default
// rest timer, sync status and an about card.
//
// User text only ever via textContent / h() — never innerHTML.
// ============================================================================

import * as timer from '../timer.js';
import { getActiveAdapter } from '../sync.js';
import { h, Icon, getUnits, mmss } from '../ui.js';

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ============================================================================
// Render
// ============================================================================
export async function renderProfile() {
  const screen = document.getElementById('s-profile');
  const adapter = getActiveAdapter();
  const status = await adapter.status();

  screen.replaceChildren(h('div', { class: 'tab-screen' },
    h('h1', { class: 'tab-title', text: 'Profile' }),
    settingsCard(),
    syncCard(status),
    aboutCard(),
  ));
}

// ---- settings card ----------------------------------------------------
function settingsCard() {
  const units = getUnits();

  return h('div', { class: 'tab-card settings-card' },
    h('div', { class: 'settings-row' },
      h('span', { class: 'settings-label', text: 'Display units' }),
      h('div', { class: 'seg-toggle' },
        h('button', {
          class: 'seg-btn' + (units === 'kg' ? ' on' : ''), type: 'button',
          onclick: () => setUnits('kg'),
        }, 'kg'),
        h('button', {
          class: 'seg-btn' + (units === 'lb' ? ' on' : ''), type: 'button',
          onclick: () => setUnits('lb'),
        }, 'lb'),
      ),
    ),
    h('p', { class: 'settings-note muted', text: 'Weights are always stored in kg; this only changes how they show.' }),
    restRow(),
  );
}

function restRow() {
  const val = h('span', { class: 'timer-val small', text: mmss(timer.getDefaultRestSeconds()) });
  const adjust = (delta) => {
    const next = Math.max(5, timer.getDefaultRestSeconds() + delta);
    timer.setDefaultRestSeconds(next);
    val.textContent = mmss(next);
  };
  return h('div', { class: 'settings-row' },
    h('span', { class: 'settings-label', text: 'Default rest timer' }),
    h('div', { class: 'rest-stepper' },
      h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Decrease default rest', onclick: () => adjust(-5) }, Icon('minus')),
      val,
      h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Increase default rest', onclick: () => adjust(5) }, Icon('plus')),
    ),
  );
}

function setUnits(v) {
  localStorage.setItem('settings.units', v);
  renderProfile(); // re-render so the segmented control and any live weights reflect the change
}

// ---- sync card -------------------------------------------------------------
function syncCard(status) {
  const modeLabel = status.mode === 'local' ? 'Local only' : titleCase(status.mode);
  const note = status.mode === 'local'
    ? 'Local only — Azure sync arrives in Phase 2.'
    : (status.lastError || (status.configured ? 'Connected.' : 'Not configured.'));

  return h('div', { class: 'tab-card sync-card' },
    h('div', { class: 'settings-row' },
      h('span', { class: 'settings-label', text: 'Sync' }),
      h('span', { class: 'settings-value', text: modeLabel }),
    ),
    h('div', { class: 'settings-row' },
      h('span', { class: 'settings-label', text: 'Status' }),
      h('span', { class: 'settings-value', text: status.configured ? 'Configured' : 'Not configured' }),
    ),
    h('p', { class: 'settings-note muted', text: note }),
  );
}

// ---- about card --------------------------------------------------------
function aboutCard() {
  return h('div', { class: 'tab-card about-card' },
    h('div', { class: 'about-name', text: 'Gym Tracker' }),
    h('p', { class: 'about-line muted', text: 'Built for Dan — data lives on this device.' }),
  );
}
