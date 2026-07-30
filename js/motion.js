// ============================================================================
// motion.js — the JS half of the motion system (css/motion.css is the other).
// Tiny, dependency-free helpers for the animations CSS can't express on its
// own: one-shot classes that clean themselves up, FLIP, and stagger.
//
// Rules every helper here obeys:
//  - transform/opacity only — never a layout property.
//  - prefers-reduced-motion short-circuits to the end state immediately. The
//    global rule in app.css already collapses durations, but these helpers
//    also skip the work entirely rather than racing a 0.01ms animation.
//  - nothing is load-bearing: if an animation is skipped or interrupted, the
//    DOM must already be in its final state. Motion decorates, never gates.
// ============================================================================

/** Does the user want motion? Checked live — the setting can change mid-session. */
export function motionOK() {
  return !window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Play a one-shot animation class and remove it when it finishes, so the
 * element keeps no animation state (or will-change layer) afterwards.
 * @param {HTMLElement} el
 * @param {string} cls a class from css/motion.css, e.g. 'anim-set-row-in'
 * @returns {HTMLElement} el, for chaining
 */
export function playOnce(el, cls) {
  if (!el || !motionOK()) return el;
  el.classList.add(cls);
  const done = () => {
    el.classList.remove(cls);
    el.style.willChange = '';
    el.removeEventListener('animationend', done);
    el.removeEventListener('animationcancel', done);
  };
  el.addEventListener('animationend', done);
  el.addEventListener('animationcancel', done);
  // Belt and braces: an element animated while its tab is hidden may never
  // fire animationend, and we would leak the class onto a re-rendered node.
  setTimeout(done, 1200);
  return el;
}

/**
 * Play an EXIT animation and resolve when it has finished, so the caller can
 * remove the element (or re-render over it) afterwards. Always resolves —
 * never rejects and never hangs — because the DOM change it gates must happen
 * whether or not the animation ran.
 *
 * The class is deliberately left on: the element is about to be removed, and
 * stripping it first would flash the element back to full opacity.
 *
 * @param {HTMLElement} el
 * @param {string} cls an exit class from css/motion.css, e.g. 'anim-card-out'
 * @returns {Promise<void>}
 */
export function playOut(el, cls) {
  if (!el || !motionOK()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('animationend', done);
      resolve();
    };
    el.addEventListener('animationend', done);
    el.classList.add(cls);
    setTimeout(done, 600); // hidden tab, or no animation applied at all
  });
}

/**
 * Stagger a list of elements into view. Sets --stagger-i (read by
 * .anim-card-in) and caps the index so a long list never waits ages.
 * @param {Iterable<HTMLElement>} els
 * @param {string} [cls]
 * @param {number} [maxIndex] beyond this everything shares the last delay
 */
export function stagger(els, cls = 'anim-card-in', maxIndex = 6) {
  if (!motionOK()) return;
  let i = 0;
  for (const el of els) {
    el.style.setProperty('--stagger-i', String(Math.min(i, maxIndex)));
    playOnce(el, cls);
    i += 1;
  }
}

/**
 * FLIP: run `mutate`, then animate the elements from where they were to
 * where they now are. Used for list reordering, where the DOM has to move
 * instantly but the eye should see travel.
 *
 * @param {HTMLElement[]} els elements to track across the mutation
 * @param {() => void} mutate the DOM change
 * @param {{duration?: number, easing?: string}} [opts]
 */
export function flip(els, mutate, opts = {}) {
  if (!motionOK()) { mutate(); return; }
  const first = els.map((el) => el.getBoundingClientRect());
  mutate();
  const duration = opts.duration || 320;
  const easing = opts.easing || 'cubic-bezier(0.22, 1, 0.36, 1)';
  els.forEach((el, i) => {
    const last = el.getBoundingClientRect();
    const dx = first[i].left - last.left;
    const dy = first[i].top - last.top;
    if (!dx && !dy) return;
    if (typeof el.animate !== 'function') return; // no WAAPI: land instantly
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration, easing, composite: 'replace' },
    );
  });
}

/**
 * Spring a value home with the Web Animations API — for gestures, where the
 * start offset is only known at release time (a dragged card settling, a
 * dismissed sheet snapping back).
 *
 * @param {HTMLElement} el
 * @param {string} fromTransform the transform it is at right now
 * @param {{duration?: number}} [opts]
 * @returns {Animation|null}
 */
export function springHome(el, fromTransform, opts = {}) {
  if (!el || !motionOK() || typeof el.animate !== 'function') {
    if (el) el.style.transform = '';
    return null;
  }
  const spring = getComputedStyle(document.documentElement)
    .getPropertyValue('--ease-spring').trim() || 'cubic-bezier(0.22, 1, 0.36, 1)';
  const anim = el.animate(
    [{ transform: fromTransform }, { transform: 'none' }],
    { duration: opts.duration || 420, easing: spring },
  );
  el.style.transform = '';
  return anim;
}
