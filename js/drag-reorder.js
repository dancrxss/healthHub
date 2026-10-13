// ============================================================================
// drag-reorder.js — pick an item up and drag it to a new place in its list.
//
// One implementation for every reorderable list in the app (the Statistics
// module grid's drag handles, and press-and-hold on a workout's exercise
// cards). The item follows the finger; its siblings slide out of the way as
// its midpoint crosses theirs (FLIP); nothing is committed until the finger
// lifts — onDrop then receives the final order. A cancelled gesture (the OS
// taking the touch away) puts the item back where it started.
//
// Vertical lists only. Pure DOM, no dependencies beyond motion.js.
// ============================================================================

import { motionOK, springHome } from './motion.js';

/** True while any drag is in flight — the touch guard keys off this. */
let dragging = false;
export function isDragging() { return dragging; }

/**
 * Stop the page scrolling under a drag that began WITHOUT `touch-action:none`
 * (a press-and-hold on ordinary scrollable content). The browser decides
 * whether a touch may scroll when it starts, so the only way to take a touch
 * over part-way through is to cancel its touchmove events — and that only
 * works from a NON-PASSIVE listener that was already registered ON THE
 * DOCUMENT when the touch began (measured 13 Oct 2026: the same listener on a
 * screen element leaves every touchmove uncancelable, and the browser fires
 * pointercancel on the first move). Installed once, at import; it does nothing
 * unless a drag is in flight, so ordinary scrolling is untouched.
 *
 * A context menu arriving mid-carry would cancel the touch too.
 */
if (typeof document !== 'undefined') {
  document.addEventListener('touchmove', (e) => {
    if (dragging && e.cancelable) e.preventDefault();
  }, { passive: false, capture: true });
  document.addEventListener('contextmenu', (e) => { if (dragging) e.preventDefault(); }, true);
}

function clampTilt(deg, max) {
  if (!Number.isFinite(deg)) return 0;
  return deg < -max ? -max : deg > max ? max : deg;
}

/**
 * Begin dragging `item` within `container`. Call from a pointerdown handler
 * (a drag handle) or once a press-and-hold has been recognised — the pointer
 * must still be down.
 *
 * @param {{
 *   pointerId: number,            // the pointer doing the dragging
 *   clientY: number,              // its current Y
 *   item: HTMLElement,            // a direct child of container
 *   container: HTMLElement,
 *   isItem?: (el: Element) => boolean,  // which children take part (default: all)
 *   itemClass?: string,           // put on the item while it is held
 *   containerClass?: string,      // put on the container while dragging
 *   bodyClass?: string,           // put on <body> while dragging
 *   scale?: number,               // lift scale (default 1.03)
 *   onDrop?: (order: HTMLElement[], moved: boolean) => void,
 *   onCancel?: () => void,
 * }} opts
 * @returns {{ cancel(): void }}
 */
export function dragReorder({
  pointerId, clientY, item, container, isItem = () => true,
  itemClass = 'dragging', containerClass = '', bodyClass = '',
  scale = 1.03, onDrop, onCancel,
}) {
  const items = () => [...container.children].filter((el) => isItem(el));
  const originalOrder = items();
  const originalNext = item.nextElementSibling;

  const startOffsetTop = item.offsetTop;
  const startPointerY = clientY;
  const startScrollY = window.scrollY;
  let pointerY = clientY;
  let translateY = 0;
  let active = true;
  let scrollRAF = null;

  dragging = true;
  item.classList.add(itemClass);
  if (containerClass) container.classList.add(containerClass);
  if (bodyClass) document.body.classList.add(bodyClass);
  // Capture on the CONTAINER, not the item: reordering runs insertBefore on
  // the item, and that momentary disconnect would strip capture from anything
  // inside it — the drag would freeze at the first swap. The container never
  // moves.
  try { container.setPointerCapture(pointerId); } catch (err) { /* mouse w/o capture */ }

  // Carry physics: the item leans into its own motion. Velocity is smoothed
  // from successive pointer deltas and the tilt is clamped hard — past ~2deg
  // it stops reading as weight and starts reading as a bug.
  let velocity = 0;
  let lastPointerY = clientY;
  const MAX_TILT = 2;

  const applyTransform = () => {
    const wanted = startOffsetTop + (pointerY - startPointerY) + (window.scrollY - startScrollY);
    translateY = Math.round(wanted - item.offsetTop);
    const tilt = motionOK() ? clampTilt(velocity * 0.06, MAX_TILT) : 0;
    item.style.transform = `translateY(${translateY}px) scale(${scale}) rotate(${tilt}deg)`;
  };

  /** Move the item in the DOM and slide the displaced siblings into place. */
  const flipSiblings = (mutate) => {
    const others = items().filter((el) => el !== item);
    const first = others.map((el) => [el, el.getBoundingClientRect().top]);
    mutate();
    const moved = [];
    for (const [el, top] of first) {
      const dy = top - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      moved.push(el);
    }
    if (!moved.length) return;
    void container.offsetHeight; // flush the inverted state before transitioning back
    requestAnimationFrame(() => {
      for (const el of moved) {
        el.style.transition = motionOK() ? 'transform 180ms ease' : 'none';
        el.style.transform = '';
      }
    });
  };

  const maybeReorder = () => {
    const list = items();
    if (list.length < 2) return;
    const midY = item.offsetTop + translateY + item.offsetHeight / 2;
    const siblings = list.filter((el) => el !== item);
    const target = siblings.find((el) => midY < el.offsetTop + el.offsetHeight / 2) || null;
    const currentNext = list[list.indexOf(item) + 1] || null;
    if (target === currentNext) return;
    flipSiblings(() => {
      if (target) container.insertBefore(item, target);
      else siblings[siblings.length - 1].after(item);
    });
    applyTransform();
  };

  const update = () => { applyTransform(); maybeReorder(); };

  // Near the top or bottom of the screen the page scrolls under the finger.
  const EDGE = 92;
  const autoScroll = () => {
    if (!active) return;
    const vh = window.innerHeight;
    let speed = 0;
    if (pointerY < EDGE) speed = -Math.min(18, Math.ceil((EDGE - pointerY) / 5));
    else if (pointerY > vh - EDGE) speed = Math.min(18, Math.ceil((pointerY - (vh - EDGE)) / 5));
    if (speed) {
      const before = window.scrollY;
      window.scrollBy(0, speed);
      if (window.scrollY !== before) update();
    }
    scrollRAF = requestAnimationFrame(autoScroll);
  };

  const onMove = (ev) => {
    if (!active || ev.pointerId !== pointerId) return;
    pointerY = ev.clientY;
    velocity = velocity * 0.7 + (pointerY - lastPointerY) * 0.3; // mostly history
    lastPointerY = pointerY;
    update();
  };

  const end = (cancelled) => {
    if (!active) return;
    active = false;
    dragging = false;
    if (scrollRAF) cancelAnimationFrame(scrollRAF);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancelEvent);
    try { container.releasePointerCapture(pointerId); } catch (err) { /* already gone */ }

    const from = item.style.transform || `translateY(${translateY}px) scale(${scale})`;
    if (cancelled) {
      // Not released by the user — nothing was agreed, so put it back.
      if (originalNext && originalNext.parentElement === container) container.insertBefore(item, originalNext);
      else container.appendChild(item);
      for (const el of items()) { el.style.transition = ''; el.style.transform = ''; }
    }

    // Drop: the item springs into its slot. springHome sets the final (empty)
    // transform immediately and animates FROM the lifted one, so the DOM is
    // correct even if the animation is skipped or cut short.
    let cleared = false;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      item.style.transition = '';
      item.style.transform = '';
      item.classList.remove(itemClass);
      if (containerClass) container.classList.remove(containerClass);
      if (bodyClass) document.body.classList.remove(bodyClass);
    };
    const anim = cancelled ? null : springHome(item, from, { duration: 420 });
    if (anim && anim.finished) anim.finished.then(clear).catch(clear);
    if (cancelled || !anim) clear(); else setTimeout(clear, 460); // fallback: WAAPI unsupported, or the tab is hidden

    if (cancelled) {
      if (onCancel) onCancel();
      return;
    }
    const order = items();
    const moved = order.length !== originalOrder.length || order.some((el, i) => el !== originalOrder[i]);
    if (onDrop) onDrop(order, moved);
  };

  const onUp = (ev) => { if (ev.pointerId === pointerId) end(false); };
  const onCancelEvent = (ev) => { if (ev.pointerId === pointerId) end(true); };

  // Window-level listeners: they hear the pointer wherever capture routes it —
  // including after a reorder — and are removed in end().
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancelEvent);
  applyTransform();
  scrollRAF = requestAnimationFrame(autoScroll);

  return { cancel: () => end(true) };
}
