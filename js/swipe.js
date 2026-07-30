// ============================================================================
// swipe.js — swipe-a-row-left-to-delete, shared by sets, exercise cards,
// sessions and routines. One implementation so the gesture feels identical
// everywhere.
//
// Structure: the caller hands us its content node and gets back a wrapper.
// We never restructure the content itself, and the delete button is a SIBLING
// of it rather than a child — several call sites (the Log tab's workout rows)
// are themselves <button>s, and a button inside a button is invalid HTML that
// iOS handles unpredictably.
//
//   <div class="swipe-host">
//     <button class="swipe-delete">        ← revealed underneath
//     <div class="swipe-surface">          ← translates under the finger
//       …the caller's content…
//
// Scrolling always wins ties. The surface carries touch-action: pan-y, so the
// browser keeps vertical panning for itself and only sends us the horizontal
// component; on top of that a directional lock means a gesture that starts
// even slightly vertical is abandoned to the page. A list you cannot scroll
// is a far worse bug than a delete you have to swipe twice for.
// ============================================================================

import { motionOK } from './motion.js';

/** The currently open row, so opening one closes the last. */
let openHost = null;

/**
 * The row that owns the gesture in progress.
 *
 * Swipe rows NEST: a set row lives inside a swipeable exercise card, so a
 * single drag bubbles through both. Without this, both tracked it and the
 * outer one — running second — closed the inner one it had just opened, so
 * swiping a set silently swiped its whole card instead. Bubble order reaches
 * the innermost row first, so the first to claim wins and ancestors stand
 * down for the rest of the gesture.
 *
 * The claim is keyed by pointerId and only ever blocks the SAME gesture: a
 * pointerdown carrying a new id takes over regardless. A pointer that goes
 * away without an up (swallowed by another handler, lost off-screen) can
 * therefore never wedge swiping shut for the rest of the session.
 * @type {{host: HTMLElement, pointerId: number}|null}
 */
let claimedBy = null;

if (typeof document !== 'undefined') {
  // Belt and braces: the gesture is over, whoever thinks they own it.
  const release = () => { claimedBy = null; };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
}

/** Close whatever row is open (used on route changes and outside taps). */
export function closeOpenSwipe() {
  if (!openHost) return;
  const host = openHost;
  openHost = null;
  host.classList.remove('swipe-open');
  const surface = host.querySelector('.swipe-surface');
  if (surface) surface.style.transform = '';
}

// One global listener rather than one per row: a tap anywhere that is not the
// open row closes it, which is what every native list does.
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    if (!openHost) return;
    if (e.target instanceof Node && openHost.contains(e.target)) return;
    closeOpenSwipe();
  }, true);
}

/**
 * Wrap `content` in a swipe-to-delete row.
 *
 * @param {HTMLElement} content the node to make swipeable
 * @param {{
 *   onDelete: () => void,   invoked when the revealed button is tapped
 *   label?: string,         button text (default 'Delete')
 *   width?: number,         reveal width in px (default 92)
 * }} opts
 * @returns {HTMLElement} the wrapper to insert in place of `content`
 */
export function swipeRow(content, opts) {
  const width = opts.width || 92;
  const host = document.createElement('div');
  host.className = 'swipe-host';

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'swipe-delete';
  del.textContent = opts.label || 'Delete';
  del.setAttribute('data-action', 'swipe-delete');
  del.style.setProperty('--swipe-w', `${width}px`);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    closeOpenSwipe();
    opts.onDelete();
  });

  const surface = document.createElement('div');
  surface.className = 'swipe-surface';
  surface.appendChild(content);

  host.append(del, surface);

  // ---- gesture ------------------------------------------------------------
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let mode = 'none'; // none | testing | swiping
  let pointerId = null;

  const setX = (x) => {
    surface.style.transform = x ? `translateX(${x}px)` : '';
  };

  const finish = (open) => {
    surface.style.transition = motionOK()
      ? 'transform var(--dur-base) var(--ease-spring)'
      : '';
    if (open) {
      host.classList.add('swipe-open');
      setX(-width);
      if (openHost && openHost !== host) closeOpenSwipe();
      openHost = host;
    } else {
      host.classList.remove('swipe-open');
      setX(0);
      if (openHost === host) openHost = null;
    }
    setTimeout(() => { surface.style.transition = ''; }, 340);
  };

  surface.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (mode !== 'none') return;
    // Stand down only for the gesture already in flight; a new pointer id is
    // a new gesture and is ours to take.
    if (claimedBy && claimedBy.pointerId === e.pointerId) return;
    claimedBy = { host, pointerId: e.pointerId };
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    mode = 'testing';
    surface.style.transition = '';
  });

  surface.addEventListener('pointermove', (e) => {
    if (mode === 'none' || e.pointerId !== pointerId) return;
    const totalX = e.clientX - startX;
    const totalY = e.clientY - startY;

    if (mode === 'testing') {
      // Directional lock. A mostly-vertical intent hands the gesture back to
      // the page for good; only a decisive horizontal drag becomes a swipe.
      if (Math.abs(totalY) > 10 && Math.abs(totalY) >= Math.abs(totalX)) {
        mode = 'none';
        pointerId = null;
        if (claimedBy && claimedBy.host === host) claimedBy = null;
        return;
      }
      if (Math.abs(totalX) < 10) return;
      mode = 'swiping';
      try { surface.setPointerCapture(pointerId); } catch { /* not captureable */ }
    }

    const base = host.classList.contains('swipe-open') ? -width : 0;
    dx = base + totalX;
    // Rubber-band past the stops so the row never feels stuck or detached.
    if (dx > 0) dx *= 0.25;
    if (dx < -width) dx = -width + (dx + width) * 0.25;
    setX(dx);
  });

  const end = (e) => {
    if (mode === 'none' || (pointerId !== null && e.pointerId !== pointerId)) {
      mode = 'none';
      pointerId = null;
      if (claimedBy && claimedBy.host === host) claimedBy = null;
      return;
    }
    const wasSwiping = mode === 'swiping';
    mode = 'none';
    pointerId = null;
    if (claimedBy && claimedBy.host === host) claimedBy = null;
    if (!wasSwiping) return;
    // Past the halfway point it opens; otherwise it springs shut.
    finish(dx < -width / 2);
  };
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);

  // A tap on an OPEN row closes it rather than activating whatever is under
  // the finger — otherwise dismissing a revealed Delete would open the row's
  // own screen.
  surface.addEventListener('click', (e) => {
    if (!host.classList.contains('swipe-open')) return;
    e.preventDefault();
    e.stopPropagation();
    closeOpenSwipe();
  }, true);

  return host;
}
