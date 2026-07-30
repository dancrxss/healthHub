// ============================================================================
// charts.js — the SVG chart engine. No libraries, no canvas: everything is
// SVG built with createElementNS, styled from the CSS custom properties
// (--accent, --muted, --faint, --line, --card-2) so themes stay in CSS.
//
// Design rules (pinned by the orchestrator — do not change the signature):
//
// - Line charts are the DEFAULT presentation (reference screenshot: RepCount's
//   per-exercise chart — smooth teal line, faint horizontal gridlines, y-axis
//   labels on the RIGHT, sparse x-axis time labels along the bottom).
// - Types: 'line' (time series), 'bar' (time series or categories; horizontal
//   flips the axes), 'pie' (composition, with a legend).
// - INTERACTIVE (line + bar, when spec.interactive): pinch-to-zoom on the
//   x-domain (two pointers), one-finger horizontal pan while zoomed,
//   double-tap resets to the full domain. Pointer events only (works for
//   touch AND mouse-drag; wheel zoom is a free extra, not required). While a
//   gesture is active the chart must never scroll the page vertically —
//   touch-action manipulation on the SVG. Zoom re-renders axes/points from
//   the visible domain; keep it cheap (no full DOM rebuild per frame if
//   avoidable, but correctness beats cleverness at this data size).
// - Trend line (line charts, spec.trend): least-squares linear regression
//   over the VISIBLE points, drawn as a thinner dashed line in --muted.
// - Tap/press-and-hold on a point/bar shows a value readout (small floating
//   label inside the SVG; disappears on release/next gesture). Nice-to-have,
//   not load-bearing.
// - Responsive: fills its container's width; uses ResizeObserver to re-render
//   on container resize. Height comes from the container (the CSS sets it).
// - Empty/degenerate data (0 or 1 point, all-equal values) must render
//   something sane, never NaN coordinates or exceptions.
// ============================================================================
//
// Implementation notes (how the rules above are met):
//
// - DOM layout, built once per mount and reused:
//     <svg touch-action:none>
//       <defs>            gradient + plot clip-path (ids unique per instance)
//       <rect .hit>       transparent, pointer-events:all — the gesture target
//       <g .plot>         REBUILT on every draw (grid, axes, series, trend)
//       <g .readout>      value readout overlay, cleared on release
//   .plot and .readout are pointer-events:none, so every pointer event lands
//   on the one hit rect — no per-element listeners, nothing to leak.
// - Zoom/pan state is a single {f0, f1} pair of FRACTIONS (0..1) of the full
//   x-domain, or null for "full domain". Fractions survive resizes and
//   re-renders and work identically for the line's time domain and the bar's
//   band-index domain. Gestures mutate the fractions and request a rAF; the
//   rAF calls draw(), which rebuilds only the .plot group.
// - Axis tick labels use a bare compact number (matching the reference shot);
//   the readout and pie legend use the full "value + unit" format. A caller
//   supplied yFormat overrides both.
// ============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const THIN_SPACE = ' ';

/** Instance counter, so gradient/clip ids never collide between charts. */
let instanceSeq = 0;

// ---------------------------------------------------------------------------
// Small DOM helpers (createElementNS only — never innerHTML)
// ---------------------------------------------------------------------------

/**
 * Create an SVG element with attributes, optionally appending it to a parent.
 * @param {string} name
 * @param {Record<string, string|number>} [attrs]
 * @param {Element} [parent]
 */
function el(name, attrs, parent) {
  const node = document.createElementNS(SVG_NS, name);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null) continue;
      node.setAttribute(k, String(v));
    }
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Create a <text> node with content (textContent, not innerHTML). */
function text(str, attrs, parent) {
  const node = el('text', attrs, parent);
  node.textContent = str;
  return node;
}

/** Remove every child of a node. */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------------------------------------------------------------------------
// Pure maths / formatting helpers (unit-testable, no DOM)
// ---------------------------------------------------------------------------

/** Clamp n into [lo, hi]; NaN-safe (returns lo). */
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/** True for a real, plottable number. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * "Nice" number at or around `range` (Heckbert). round=true snaps to the
 * nearest nice number, round=false to the next nice number up.
 */
function niceNum(range, round) {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const exp = Math.floor(Math.log10(range));
  const f = range / Math.pow(10, exp);
  let nf;
  if (round) {
    if (f < 1.5) nf = 1;
    else if (f < 3) nf = 2;
    else if (f < 7) nf = 5;
    else nf = 10;
  } else if (f <= 1) nf = 1;
  else if (f <= 2) nf = 2;
  else if (f <= 5) nf = 5;
  else nf = 10;
  return nf * Math.pow(10, exp);
}

/** Strip binary float fuzz relative to a step size (0.30000000000000004 → 0.3). */
function snap(v, step) {
  if (!Number.isFinite(v)) return 0;
  const dp = clamp(Math.ceil(-Math.log10(Math.abs(step || 1))) + 2, 0, 12);
  return Number(v.toFixed(dp));
}

/**
 * Nice y-scale over [min, max] with 3–6 ticks.
 * Degenerate input (equal values, non-finite, empty) is padded so the series
 * lands mid-chart rather than on an edge — and never produces NaN.
 *
 * @returns {{min: number, max: number, step: number, ticks: number[]}}
 */
function niceScale(min, max, maxTicks = 5) {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 1;
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  if (lo === hi) {
    const pad = Math.abs(lo) > 1e-9 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad;
    hi += pad;
  }
  const wanted = clamp(Math.round(maxTicks), 3, 6);
  const span = niceNum(hi - lo, false);
  const step = niceNum(span / (wanted - 1), true) || 1;
  const nmin = Math.floor(lo / step) * step;
  const nmax = Math.ceil(hi / step) * step;
  const ticks = [];
  // Guard against a pathological step producing a runaway loop.
  const count = Math.min(64, Math.floor((nmax - nmin) / step + 1e-6) + 1);
  for (let i = 0; i < count; i++) ticks.push(snap(nmin + i * step, step));
  if (ticks.length < 2) ticks.push(snap(nmin + step, step));
  return { min: snap(nmin, step), max: snap(nmax, step), step, ticks };
}

/**
 * Least-squares linear regression over [{x, y}]. x should be normalised
 * (0..1) for numeric stability. Fewer than 2 points, or a degenerate x
 * spread, returns null (caller skips the trend line).
 */
function regress(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const { x, y } = pts[i];
    if (!num(x) || !num(y)) return null;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return null;
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  if (!Number.isFinite(m) || !Number.isFinite(b)) return null;
  return { m, b };
}

/**
 * Compact UK number: 1,240 — 1.2k above 10k — 2 dp under 1.
 */
function compact(v) {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 10000) {
    const k = v / 1000;
    const dp = Math.abs(k) >= 100 ? 0 : 1;
    return `${Number(k.toFixed(dp)).toLocaleString('en-GB', { maximumFractionDigits: dp })}k`;
  }
  const dp = a >= 100 ? 0 : a >= 1 ? 1 : 2;
  return Number(v.toFixed(dp)).toLocaleString('en-GB', { maximumFractionDigits: dp });
}

/** Default value formatter: compact number + unit, joined by a thin space. */
function withUnit(unit) {
  const u = unit ? String(unit) : '';
  return (v) => (u ? `${compact(v)}${THIN_SPACE}${u}` : compact(v));
}

/** Rough text width — good enough for label collision + readout boxes. */
function textWidth(str, fontSize) {
  return String(str == null ? '' : str).length * fontSize * 0.56;
}

/** Truncate to fit a pixel width, adding an ellipsis. */
function ellipsise(str, fontSize, maxW) {
  const s = String(str == null ? '' : str);
  if (textWidth(s, fontSize) <= maxW) return s;
  const per = fontSize * 0.56;
  const keep = Math.max(1, Math.floor(maxW / per) - 1);
  return `${s.slice(0, keep)}…`;
}

/** Rounded-rect path with independently rounded corners (top-only for bars). */
function roundedRectPath(x, y, w, h, rTop, rBottom) {
  const rw = Math.max(0, w);
  const rh = Math.max(0, h);
  const rt = clamp(rTop, 0, Math.min(rw / 2, rh));
  const rb = clamp(rBottom, 0, Math.min(rw / 2, rh - rt));
  return [
    `M${x} ${y + rh - rb}`,
    `L${x} ${y + rt}`,
    rt ? `Q${x} ${y} ${x + rt} ${y}` : `L${x} ${y}`,
    `L${x + rw - rt} ${y}`,
    rt ? `Q${x + rw} ${y} ${x + rw} ${y + rt}` : `L${x + rw} ${y}`,
    `L${x + rw} ${y + rh - rb}`,
    rb ? `Q${x + rw} ${y + rh} ${x + rw - rb} ${y + rh}` : `L${x + rw} ${y + rh}`,
    `L${x + rb} ${y + rh}`,
    rb ? `Q${x} ${y + rh} ${x} ${y + rh - rb}` : `L${x} ${y + rh}`,
    'Z',
  ].join(' ');
}

/** Point on a circle at `deg` degrees clockwise from 12 o'clock. */
function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** Donut segment path between two angles. */
function donutSlicePath(cx, cy, rOuter, rInner, a0, a1) {
  const sweep = a1 - a0;
  // A full circle can't be drawn as one arc — split it.
  if (sweep >= 359.999) {
    const half = a0 + 180;
    return `${donutSlicePath(cx, cy, rOuter, rInner, a0, half)} ${donutSlicePath(cx, cy, rOuter, rInner, half, a0 + 360)}`;
  }
  const large = sweep > 180 ? 1 : 0;
  const o0 = polar(cx, cy, rOuter, a0);
  const o1 = polar(cx, cy, rOuter, a1);
  const i1 = polar(cx, cy, rInner, a1);
  const i0 = polar(cx, cy, rInner, a0);
  return [
    `M${o0.x} ${o0.y}`,
    `A${rOuter} ${rOuter} 0 ${large} 1 ${o1.x} ${o1.y}`,
    `L${i1.x} ${i1.y}`,
    `A${rInner} ${rInner} 0 ${large} 0 ${i0.x} ${i0.y}`,
    'Z',
  ].join(' ');
}

/**
 * Pick 4–6 non-overlapping x labels from the visible data.
 * @param {Array<{x: number, label: string}>} vis
 */
function pickXLabels(vis, left, right) {
  const out = [];
  if (!vis.length) return out;
  const target = clamp(Math.min(vis.length, 5), 1, 6);
  const step = Math.max(1, Math.round(vis.length / target));
  // Centre the sampling so the chosen labels sit evenly, not bunched left.
  const offset = Math.floor(((vis.length - 1) % step) / 2);
  let lastRight = -Infinity;
  for (let i = offset; i < vis.length; i += step) {
    const d = vis[i];
    const label = d.label == null ? '' : String(d.label);
    if (!label) continue;
    const half = textWidth(label, 11) / 2;
    if (!num(d.x)) continue;
    if (d.x - half < left - 2) continue;
    if (d.x + half > right + 34) continue;
    if (d.x - half < lastRight + 10) continue;
    lastRight = d.x + half;
    out.push({ x: d.x, label });
  }
  if (!out.length && vis.length) {
    const d = vis[0];
    if (num(d.x) && d.label) out.push({ x: clamp(d.x, left + 12, right - 12), label: String(d.label) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Theme: read colours from the CSS custom properties at render time
// ---------------------------------------------------------------------------

function readTheme(container) {
  const fallback = {
    accent: '#4ecdd6',
    muted: '#8a9096',
    faint: '#5a6066',
    line: 'rgba(255,255,255,0.08)',
    card2: '#23272b',
    text: '#f2f4f5',
    bg: '#0b0d0f',
  };
  let cs = null;
  try {
    cs = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
  } catch { cs = null; }
  if (!cs) return fallback;
  const pick = (prop, def) => {
    const v = cs.getPropertyValue(prop);
    const s = v ? v.trim() : '';
    return s || def;
  };
  return {
    accent: pick('--accent', fallback.accent),
    muted: pick('--muted', fallback.muted),
    faint: pick('--faint', fallback.faint),
    line: pick('--line', fallback.line),
    card2: pick('--card-2', fallback.card2),
    text: pick('--text', fallback.text),
    bg: pick('--bg', fallback.bg),
  };
}

// ---------------------------------------------------------------------------
// Spec normalisation
// ---------------------------------------------------------------------------

function normalise(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const raw = Array.isArray(s.points) ? s.points : [];
  const points = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (!p || typeof p !== 'object') continue;
    if (!num(p.value)) continue;
    points.push({
      t: num(p.t) ? p.t : null,
      label: p.label == null ? '' : String(p.label),
      value: p.value,
    });
  }
  const type = s.type === 'bar' || s.type === 'pie' ? s.type : 'line';
  return {
    type,
    points,
    rawPoints: s.points,
    unit: s.unit == null ? '' : String(s.unit),
    yFormat: typeof s.yFormat === 'function' ? s.yFormat : null,
    trend: !!s.trend,
    horizontal: !!s.horizontal,
    interactive: !!s.interactive,
  };
}

// ---------------------------------------------------------------------------
// renderChart
// ---------------------------------------------------------------------------

/**
 * Render (or re-render) a chart into a container element.
 *
 * @param {HTMLElement} container  emptied and repopulated; the returned handle
 *   re-uses it. The caller owns sizing via CSS.
 * @param {{
 *   type: 'line'|'bar'|'pie',
 *   points: Array<{t: number|null, label: string, value: number}>,
 *     // time series: t = bucket epoch ms (ascending), label = short axis text
 *     // pie: t null, label = slice name, value = slice size
 *   unit: string,                    // 'kg' | 'reps' | 'min' | '' …
 *   yFormat?: (v: number) => string, // default: compact number + unit
 *   trend?: boolean,                 // line only — dashed regression overlay
 *   horizontal?: boolean,            // bar only — horizontal bars, swapped axes
 *   interactive?: boolean,           // pinch zoom / pan / double-tap reset
 * }} spec
 * @returns {{ update(spec: object): void, destroy(): void }}
 *   update re-renders with new spec (same container); destroy disconnects
 *   observers/listeners and empties the container.
 */
export function renderChart(container, spec) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('renderChart: a container element is required');
  }

  const uid = `ch${++instanceSeq}`;
  const gradId = `${uid}-fill`;
  const clipId = `${uid}-clip`;

  let cfg = normalise(spec);
  let destroyed = false;

  /** Visible x-window as fractions of the full domain; null = full. */
  let zoom = null;
  /** Geometry + hit-testing published by the last draw(). */
  let geom = null;
  let rafId = 0;

  // --- gesture state -------------------------------------------------------
  const pointers = new Map(); // pointerId -> {x, y}
  let mode = 'none';          // 'none' | 'idle1' | 'pan' | 'pinch'
  let down = null;            // {x, y, time} of the first pointer
  let panRef = null;          // {x, f0}
  let pinchRef = null;        // {dist, cx, f0, span}
  let lastTap = null;         // {time, x, y}

  // --- static DOM ----------------------------------------------------------
  while (container.firstChild) container.removeChild(container.firstChild);

  const svg = el('svg', {
    xmlns: SVG_NS,
    width: '100%',
    height: '100%',
    role: 'img',
    'aria-label': 'chart',
  });
  svg.style.display = 'block';
  svg.style.overflow = 'visible';

  /**
   * Touch-action follows the chart's job.
   *  - interactive (the detail screen): 'none' — we own every gesture, so
   *    pinch-zoom and pan never scroll the page underneath.
   *  - static (the cards on the statistics grid): 'pan-y' — a vertical drag
   *    scrolls the page as normal, because a card in a list must never be a
   *    scroll trap. A tap still reaches us and shows the value readout.
   */
  function applyTouchAction() {
    svg.style.touchAction = cfg.interactive ? 'none' : 'pan-y';
  }
  applyTouchAction();

  const defs = el('defs', null, svg);
  const grad = el('linearGradient', {
    id: gradId, x1: '0', y1: '0', x2: '0', y2: '1',
  }, defs);
  const gradTop = el('stop', { offset: '0', 'stop-opacity': '0.18' }, grad);
  const gradBottom = el('stop', { offset: '1', 'stop-opacity': '0' }, grad);
  const clipPath = el('clipPath', { id: clipId }, defs);
  const clipRect = el('rect', { x: 0, y: 0, width: 1, height: 1 }, clipPath);

  const hit = el('rect', {
    x: 0, y: 0, width: 1, height: 1,
    fill: 'transparent',
    'pointer-events': 'all',
  }, svg);

  const gPlot = el('g', { 'pointer-events': 'none' }, svg);
  const gOver = el('g', { 'pointer-events': 'none' }, svg);

  container.appendChild(svg);

  // --- zoom helpers --------------------------------------------------------

  function fullSpanOnly() {
    return zoom == null;
  }

  function currentSpan() {
    return zoom ? zoom.f1 - zoom.f0 : 1;
  }

  function minSpan() {
    const n = cfg.points.length;
    if (n <= 5) return 1;
    return clamp(5 / n, 0.01, 1);
  }

  function setWindow(f0, span) {
    const s = clamp(span, minSpan(), 1);
    const start = clamp(f0, 0, 1 - s);
    zoom = s >= 0.9995 ? null : { f0: start, f1: start + s };
  }

  function resetZoom() {
    zoom = null;
  }

  function schedule() {
    if (destroyed || rafId) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    rafId = raf(() => {
      rafId = 0;
      if (!destroyed) draw();
    }) || 1;
  }

  // --- drawing -------------------------------------------------------------

  function size() {
    const w = Math.max(0, Math.round(container.clientWidth || 0));
    const h = Math.max(0, Math.round(container.clientHeight || 0));
    return { W: w > 0 ? w : 300, H: h > 0 ? h : 260 };
  }

  function draw() {
    if (destroyed) return;
    const { W, H } = size();
    const theme = readTheme(container);

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    hit.setAttribute('width', W);
    hit.setAttribute('height', H);
    gradTop.setAttribute('stop-color', theme.accent);
    gradBottom.setAttribute('stop-color', theme.accent);

    clear(gPlot);
    clear(gOver);
    geom = null;

    if (!cfg.points.length) {
      drawEmpty(W, H, theme);
      return;
    }
    if (cfg.type === 'pie') {
      drawPie(W, H, theme);
      return;
    }
    if (cfg.type === 'bar' && cfg.horizontal) {
      drawHorizontalBars(W, H, theme);
      return;
    }
    drawTimeSeries(W, H, theme);
  }

  function drawEmpty(W, H, theme) {
    text('No data yet', {
      x: W / 2,
      y: H / 2 + 4,
      fill: theme.faint,
      'font-size': 13,
      'text-anchor': 'middle',
    }, gPlot);
  }

  // ---- line + vertical bar (shared axes) ---------------------------------

  function drawTimeSeries(W, H, theme) {
    const pts = cfg.points;
    const n = pts.length;
    const isBar = cfg.type === 'bar';
    const M = { top: 14, right: 48, bottom: 26, left: 12 };
    const plotL = M.left;
    const plotT = M.top;
    const plotW = Math.max(10, W - M.left - M.right);
    const plotH = Math.max(10, H - M.top - M.bottom);
    const plotR = plotL + plotW;
    const plotB = plotT + plotH;

    clipRect.setAttribute('x', plotL - 2);
    clipRect.setAttribute('y', plotT - 6);
    clipRect.setAttribute('width', plotW + 4);
    clipRect.setAttribute('height', plotH + 12);

    // --- x domain --------------------------------------------------------
    // Bars need equal bands, so they always use an index domain. Lines use
    // real time (uneven gaps are honest) and fall back to indices when the
    // timestamps are missing or all identical.
    let xs;
    let domLo;
    let domHi;
    if (isBar) {
      xs = pts.map((_, i) => i);
      domLo = -0.5;
      domHi = n - 0.5;
    } else {
      const haveT = pts.every((p) => num(p.t));
      const tLo = haveT ? pts[0].t : 0;
      const tHi = haveT ? pts[n - 1].t : n - 1;
      if (haveT && tHi > tLo) {
        xs = pts.map((p) => p.t);
        domLo = tLo;
        domHi = tHi;
      } else {
        xs = pts.map((_, i) => i);
        domLo = 0;
        domHi = Math.max(1e-6, n - 1);
      }
    }
    const domSpan = domHi - domLo;
    const f0 = zoom ? zoom.f0 : 0;
    const f1 = zoom ? zoom.f1 : 1;
    const visLo = domLo + f0 * domSpan;
    const visHi = domLo + f1 * domSpan;
    const visSpan = visHi - visLo;
    const xOf = (x) => (visSpan > 0 ? plotL + ((x - visLo) / visSpan) * plotW : plotL + plotW / 2);

    // Visible = strictly inside the window (a hair of tolerance for the ends).
    const eps = domSpan * 1e-9;
    const visible = [];
    let firstVis = -1;
    let lastVis = -1;
    for (let i = 0; i < n; i++) {
      if (xs[i] >= visLo - eps && xs[i] <= visHi + eps) {
        if (firstVis < 0) firstVis = i;
        lastVis = i;
        visible.push(i);
      }
    }
    let idx = visible;
    if (!idx.length) {
      // Degenerate window (shouldn't happen, but never render nothing).
      idx = pts.map((_, i) => i);
      firstVis = 0;
      lastVis = n - 1;
    }

    // --- y domain (from the visible points) ------------------------------
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const i of idx) {
      const v = pts[i].value;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) { vMin = 0; vMax = 1; }
    if (isBar) {
      // Bars are read against a baseline — always include zero.
      vMin = Math.min(vMin, 0);
      vMax = Math.max(vMax, 0);
    }
    const scale = niceScale(vMin, vMax, 5);
    const ySpan = scale.max - scale.min || 1;
    const yOf = (v) => plotB - ((v - scale.min) / ySpan) * plotH;

    // --- gridlines + right-hand y labels ---------------------------------
    const tickFmt = cfg.yFormat || compact;
    for (const tv of scale.ticks) {
      const y = yOf(tv);
      if (!num(y)) continue;
      el('line', {
        x1: plotL, y1: y, x2: plotR, y2: y,
        stroke: theme.line, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }, gPlot);
      text(tickFmt(tv), {
        x: plotR + 8,
        y: y + 4,
        fill: theme.faint,
        'font-size': 11,
        'text-anchor': 'start',
      }, gPlot);
    }

    // --- x labels + subtle vertical gridlines ----------------------------
    const labelSource = idx.map((i) => ({ x: xOf(xs[i]), label: pts[i].label }));
    const xLabels = pickXLabels(labelSource, plotL, plotR);
    for (const lab of xLabels) {
      el('line', {
        x1: lab.x, y1: plotT, x2: lab.x, y2: plotB,
        stroke: theme.line, 'stroke-width': 1, opacity: 0.55,
        'shape-rendering': 'crispEdges',
      }, gPlot);
      text(lab.label, {
        x: lab.x,
        y: plotB + 16,
        fill: theme.muted,
        'font-size': 11,
        'text-anchor': 'middle',
      }, gPlot);
    }

    const gSeries = el('g', { 'clip-path': `url(#${clipId})` }, gPlot);
    /** Hit-test data: one entry per visible point. */
    const hits = [];

    if (isBar) {
      const band = plotW / Math.max(1, visSpan);
      const barW = clamp(band * 0.62, 2, 44);
      const zeroY = clamp(yOf(0), plotT, plotB);
      for (const i of idx) {
        const cx = xOf(i);
        const v = pts[i].value;
        const vy = yOf(v);
        if (!num(cx) || !num(vy)) continue;
        const top = Math.min(vy, zeroY);
        const h = Math.max(1, Math.abs(vy - zeroY));
        el('path', {
          d: roundedRectPath(cx - barW / 2, top, barW, h, 2, 0),
          fill: theme.accent,
          opacity: 0.85,
        }, gSeries);
        hits.push({ i, x: cx, y: vy, label: pts[i].label, value: v });
      }
    } else {
      // Draw one neighbour beyond each edge so the line reaches the border;
      // the clip path trims the overhang.
      const drawFrom = firstVis > 0 ? firstVis - 1 : Math.max(0, firstVis < 0 ? 0 : firstVis);
      const drawTo = lastVis >= 0 && lastVis < n - 1 ? lastVis + 1 : (lastVis < 0 ? n - 1 : lastVis);
      const coords = [];
      for (let i = drawFrom; i <= drawTo; i++) {
        const px = xOf(xs[i]);
        const py = yOf(pts[i].value);
        if (num(px) && num(py)) coords.push({ i, x: px, y: py });
      }
      if (coords.length === 1) {
        el('circle', {
          cx: coords[0].x, cy: coords[0].y, r: 4, fill: theme.accent,
        }, gSeries);
      } else if (coords.length > 1) {
        let d = '';
        for (let k = 0; k < coords.length; k++) {
          d += `${k === 0 ? 'M' : 'L'}${coords[k].x.toFixed(2)} ${coords[k].y.toFixed(2)}`;
          if (k < coords.length - 1) d += ' ';
        }
        // Faint area under the line, then the line itself.
        const areaD = `${d} L${coords[coords.length - 1].x.toFixed(2)} ${plotB} L${coords[0].x.toFixed(2)} ${plotB} Z`;
        el('path', { d: areaD, fill: `url(#${gradId})`, stroke: 'none' }, gSeries);
        el('path', {
          d,
          fill: 'none',
          stroke: theme.accent,
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        }, gSeries);
      }
      for (const c of coords) {
        if (c.i >= firstVis && c.i <= lastVis) {
          hits.push({ i: c.i, x: c.x, y: c.y, label: pts[c.i].label, value: pts[c.i].value });
        }
      }

      // --- trend: least squares over the VISIBLE points -------------------
      if (cfg.trend && idx.length >= 2) {
        const nx = (x) => (visSpan > 0 ? (x - visLo) / visSpan : 0);
        const fit = regress(idx.map((i) => ({ x: nx(xs[i]), y: pts[i].value })));
        if (fit) {
          const y0 = yOf(fit.b);
          const y1 = yOf(fit.m + fit.b);
          if (num(y0) && num(y1)) {
            el('line', {
              x1: plotL, y1: y0, x2: plotR, y2: y1,
              stroke: theme.muted,
              'stroke-width': 1.25,
              'stroke-dasharray': '4 4',
              'stroke-linecap': 'round',
              opacity: 0.85,
            }, gSeries);
          }
        }
      }
    }

    geom = {
      kind: isBar ? 'bar' : 'line',
      plotL, plotR, plotT, plotB, plotW, plotH,
      theme, hits,
      interactive: !!cfg.interactive,
    };
  }

  // ---- horizontal bars (category breakdown) ------------------------------

  function drawHorizontalBars(W, H, theme) {
    const pts = cfg.points;
    const n = pts.length;
    const labelW = clamp(Math.round(W * 0.32), 64, 120);
    const M = { top: 24, right: 14, bottom: 8, left: labelW + 10 };
    const plotL = M.left;
    const plotT = M.top;
    const plotW = Math.max(10, W - M.left - M.right);
    const plotH = Math.max(10, H - M.top - M.bottom);
    const plotR = plotL + plotW;

    let vMax = -Infinity;
    let vMin = Infinity;
    for (const p of pts) {
      if (p.value > vMax) vMax = p.value;
      if (p.value < vMin) vMin = p.value;
    }
    const scale = niceScale(Math.min(0, vMin), Math.max(0, vMax), 4);
    const xSpan = scale.max - scale.min || 1;
    const xOf = (v) => plotL + ((v - scale.min) / xSpan) * plotW;
    const zeroX = clamp(xOf(0), plotL, plotR);

    const tickFmt = cfg.yFormat || compact;
    for (const tv of scale.ticks) {
      const x = xOf(tv);
      if (!num(x)) continue;
      el('line', {
        x1: x, y1: plotT, x2: x, y2: plotT + plotH,
        stroke: theme.line, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }, gPlot);
      text(tickFmt(tv), {
        x, y: plotT - 8, fill: theme.faint, 'font-size': 11, 'text-anchor': 'middle',
      }, gPlot);
    }

    const band = plotH / Math.max(1, n);
    const barH = clamp(band * 0.6, 4, 26);
    const hits = [];
    for (let i = 0; i < n; i++) {
      const cy = plotT + band * (i + 0.5);
      const vx = xOf(pts[i].value);
      if (!num(cy) || !num(vx)) continue;
      const left = Math.min(vx, zeroX);
      const w = Math.max(1, Math.abs(vx - zeroX));
      el('rect', {
        x: left, y: cy - barH / 2, width: w, height: barH,
        rx: 2, ry: 2,
        fill: theme.accent, opacity: 0.85,
      }, gPlot);
      text(ellipsise(pts[i].label, 12, labelW), {
        x: labelW, y: cy + 4, fill: theme.muted, 'font-size': 12, 'text-anchor': 'end',
      }, gPlot);
      hits.push({ i, x: vx, y: cy, label: pts[i].label, value: pts[i].value });
    }

    geom = {
      kind: 'hbar',
      plotL, plotR, plotT, plotB: plotT + plotH, plotW, plotH,
      theme, hits, interactive: false,
    };
  }

  // ---- pie (donut + legend) ----------------------------------------------

  function drawPie(W, H, theme) {
    // ≤8 slices: sort descending and fold the tail into "Other".
    const sorted = cfg.points.slice().sort((a, b) => b.value - a.value).filter((p) => p.value > 0);
    let slices = sorted;
    if (sorted.length > 8) {
      const head = sorted.slice(0, 7);
      const tail = sorted.slice(7).reduce((s, p) => s + p.value, 0);
      slices = head.concat([{ t: null, label: 'Other', value: tail }]);
    }
    if (!slices.length) {
      drawEmpty(W, H, theme);
      return;
    }
    const total = slices.reduce((s, p) => s + p.value, 0);
    if (!(total > 0)) {
      drawEmpty(W, H, theme);
      return;
    }

    const fmt = cfg.yFormat || withUnit(cfg.unit);
    const rowH = 20;
    const legendH = slices.length * rowH;
    const sideLegendW = clamp(Math.round(W * 0.46), 120, 210);
    const sideBySide = W - sideLegendW >= 120 && H >= legendH + 8;

    let cx;
    let cy;
    let rOuter;
    let legendX;
    let legendY;
    let legendW;

    if (sideBySide) {
      const chartW = W - sideLegendW - 12;
      rOuter = Math.max(20, Math.min(chartW, H) / 2 - 8);
      cx = 8 + chartW / 2;
      cy = H / 2;
      legendX = W - sideLegendW;
      legendY = Math.max(4, (H - legendH) / 2);
      legendW = sideLegendW - 4;
    } else {
      const chartH = Math.max(60, H - legendH - 12);
      rOuter = Math.max(20, Math.min(W, chartH) / 2 - 8);
      cx = W / 2;
      cy = 6 + chartH / 2;
      legendX = 6;
      legendY = chartH + 12;
      legendW = W - 12;
    }
    const rInner = rOuter * 0.55;

    // Dimmer steps of the SAME accent — no new hues.
    const opacityFor = (i) => clamp(1 - i * (0.72 / Math.max(1, slices.length - 1)), 0.26, 1);

    let angle = 0;
    for (let i = 0; i < slices.length; i++) {
      const share = slices[i].value / total;
      const sweep = share * 360;
      const a0 = angle;
      const a1 = angle + sweep;
      angle = a1;
      if (!(sweep > 0)) continue;
      el('path', {
        d: donutSlicePath(cx, cy, rOuter, rInner, a0, Math.min(a1, 360)),
        fill: theme.accent,
        opacity: opacityFor(i),
        stroke: theme.bg,
        'stroke-width': 1.5,
      }, gPlot);
    }

    // Legend: swatch, label, value + share.
    for (let i = 0; i < slices.length; i++) {
      const y = legendY + i * rowH;
      if (y + rowH > H + 2) break;
      el('rect', {
        x: legendX, y: y + 4, width: 10, height: 10, rx: 3, ry: 3,
        fill: theme.accent, opacity: opacityFor(i),
      }, gPlot);
      const pct = (slices[i].value / total) * 100;
      const pctStr = `${pct >= 10 ? Math.round(pct) : Number(pct.toFixed(1))}%`;
      const valStr = `${fmt(slices[i].value)}  ${pctStr}`;
      const valW = textWidth(valStr, 11);
      const labelMax = Math.max(24, legendW - 18 - valW - 8);
      text(ellipsise(slices[i].label, 12, labelMax), {
        x: legendX + 18, y: y + 13, fill: theme.text, 'font-size': 12, 'text-anchor': 'start',
      }, gPlot);
      text(valStr, {
        x: legendX + legendW, y: y + 13, fill: theme.muted, 'font-size': 11, 'text-anchor': 'end',
      }, gPlot);
    }

    geom = { kind: 'pie', theme, hits: [], interactive: false };
  }

  // --- value readout -------------------------------------------------------

  function hideReadout() {
    clear(gOver);
  }

  function showReadout(px, py) {
    if (!geom || !geom.hits || !geom.hits.length) return;
    clear(gOver);
    const theme = geom.theme;
    // Vertical charts are picked along x; horizontal bars along y.
    const along = geom.kind === 'hbar' ? 'y' : 'x';
    const at = along === 'y' ? py : px;
    let best = null;
    let bestD = Infinity;
    for (const h of geom.hits) {
      const d = Math.abs(h[along] - at);
      if (d < bestD) { bestD = d; best = h; }
    }
    if (!best) return;

    const fmt = cfg.yFormat || withUnit(cfg.unit);
    const line1 = best.label ? String(best.label) : '';
    const line2 = fmt(best.value);

    // Guide + highlighted point.
    if (geom.kind !== 'hbar') {
      el('line', {
        x1: best.x, y1: geom.plotT, x2: best.x, y2: geom.plotB,
        stroke: theme.accent, 'stroke-width': 1, opacity: 0.35,
      }, gOver);
    }
    el('circle', {
      cx: best.x, cy: best.y, r: 4.5,
      fill: theme.accent, stroke: theme.bg, 'stroke-width': 2,
    }, gOver);

    const padX = 8;
    const w = Math.max(52, Math.max(textWidth(line1, 11), textWidth(line2, 13)) + padX * 2);
    const h = line1 ? 38 : 24;
    let bx = best.x - w / 2;
    const left = geom.plotL != null ? geom.plotL - 6 : 0;
    const right = geom.plotR != null ? geom.plotR + 34 : w;
    bx = clamp(bx, left, Math.max(left, right - w));
    let by = best.y - h - 12;
    if (by < (geom.plotT || 0)) by = Math.min(best.y + 12, (geom.plotB || h) - h);
    if (!num(bx) || !num(by)) return;

    el('rect', {
      x: bx, y: by, width: w, height: h, rx: 8, ry: 8,
      fill: theme.card2, stroke: theme.line, 'stroke-width': 1, opacity: 0.97,
    }, gOver);
    if (line1) {
      text(line1, {
        x: bx + w / 2, y: by + 15, fill: theme.muted, 'font-size': 11, 'text-anchor': 'middle',
      }, gOver);
    }
    text(line2, {
      x: bx + w / 2, y: by + (line1 ? 31 : 16),
      fill: theme.text, 'font-size': 13, 'font-weight': '600', 'text-anchor': 'middle',
    }, gOver);
  }

  // --- pointer gestures ----------------------------------------------------

  function localX(ev) {
    const r = svg.getBoundingClientRect();
    return ev.clientX - r.left;
  }
  function localY(ev) {
    const r = svg.getBoundingClientRect();
    return ev.clientY - r.top;
  }

  function twoPointers() {
    const it = pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? [a, b] : null;
  }

  function plotWidth() {
    return geom && geom.plotW ? geom.plotW : Math.max(10, size().W - 60);
  }
  function plotLeft() {
    return geom && geom.plotL != null ? geom.plotL : 12;
  }

  /** Zoom about a screen x, keeping the data under it fixed. */
  function zoomAbout(screenX, newSpan, refF0, refSpan, refScreenX) {
    const pw = plotWidth();
    const pl = plotLeft();
    const at = clamp((refScreenX - pl) / pw, 0, 1);
    const dataFrac = refF0 + at * refSpan;
    const now = clamp((screenX - pl) / pw, 0, 1);
    setWindow(dataFrac - now * newSpan, newSpan);
  }

  function onPointerDown(ev) {
    if (!geom || geom.kind === 'pie') return;
    try { svg.setPointerCapture(ev.pointerId); } catch { /* not captureable */ }
    pointers.set(ev.pointerId, { x: localX(ev), y: localY(ev) });

    if (pointers.size === 1) {
      const p = pointers.get(ev.pointerId);
      mode = 'idle1';
      down = { x: p.x, y: p.y, time: Date.now() };
      showReadout(p.x, p.y);
    } else if (pointers.size === 2 && cfg.interactive && geom.interactive) {
      const pair = twoPointers();
      if (pair) {
        hideReadout();
        mode = 'pinch';
        pinchRef = {
          dist: Math.max(1, Math.abs(pair[0].x - pair[1].x)),
          cx: (pair[0].x + pair[1].x) / 2,
          f0: zoom ? zoom.f0 : 0,
          span: currentSpan(),
        };
      }
    }
  }

  function onPointerMove(ev) {
    if (!pointers.has(ev.pointerId)) return;
    const p = pointers.get(ev.pointerId);
    p.x = localX(ev);
    p.y = localY(ev);

    if (mode === 'pinch' && pointers.size >= 2 && pinchRef) {
      const pair = twoPointers();
      if (!pair) return;
      const dist = Math.max(1, Math.abs(pair[0].x - pair[1].x));
      const cx = (pair[0].x + pair[1].x) / 2;
      const factor = pinchRef.dist / dist; // fingers apart → smaller span
      zoomAbout(cx, pinchRef.span * factor, pinchRef.f0, pinchRef.span, pinchRef.cx);
      schedule();
      return;
    }

    if (mode === 'idle1' && down) {
      const dx = p.x - down.x;
      const dy = p.y - down.y;
      const canPan = cfg.interactive && geom && geom.interactive && !fullSpanOnly();
      if (canPan && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        mode = 'pan';
        panRef = { x: p.x, f0: zoom ? zoom.f0 : 0 };
        hideReadout();
      } else {
        // Not zoomed (or a vertical drag): scrub the readout instead.
        showReadout(p.x, p.y);
      }
      return;
    }

    if (mode === 'pan' && panRef) {
      const span = currentSpan();
      const delta = ((p.x - panRef.x) / plotWidth()) * span;
      setWindow(panRef.f0 - delta, span);
      schedule();
    }
  }

  function endPointer(ev) {
    if (!pointers.has(ev.pointerId)) return;
    const released = pointers.get(ev.pointerId);
    pointers.delete(ev.pointerId);
    try { svg.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }

    if (pointers.size >= 2 && mode === 'pinch') {
      // A third finger left: re-baseline against whichever two remain, so the
      // next move doesn't reinterpret the old distance.
      const pair = twoPointers();
      if (pair) {
        pinchRef = {
          dist: Math.max(1, Math.abs(pair[0].x - pair[1].x)),
          cx: (pair[0].x + pair[1].x) / 2,
          f0: zoom ? zoom.f0 : 0,
          span: currentSpan(),
        };
      }
      return;
    }

    if (pointers.size === 1 && (mode === 'pinch' || mode === 'pan')) {
      // Dropping from two fingers to one: re-baseline the pan so the
      // remaining finger doesn't teleport the chart.
      const rest = pointers.values().next().value;
      mode = 'pan';
      panRef = { x: rest.x, f0: zoom ? zoom.f0 : 0 };
      pinchRef = null;
      return;
    }

    if (pointers.size === 0) {
      const wasTap = mode === 'idle1'
        && down
        && ev.type !== 'pointercancel'
        && Math.abs(released.x - down.x) < 10
        && Math.abs(released.y - down.y) < 10
        && Date.now() - down.time < 400;

      if (wasTap && cfg.interactive && geom && geom.interactive) {
        const now = Date.now();
        if (lastTap
          && now - lastTap.time < 300
          && Math.abs(released.x - lastTap.x) < 24
          && Math.abs(released.y - lastTap.y) < 24) {
          lastTap = null;
          resetZoom();
          schedule();
        } else {
          lastTap = { time: now, x: released.x, y: released.y };
        }
      }
      mode = 'none';
      down = null;
      panRef = null;
      pinchRef = null;
      hideReadout();
    }
  }

  function onWheel(ev) {
    if (!cfg.interactive || !geom || !geom.interactive) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    const span = currentSpan();
    const factor = Math.exp((ev.deltaY || 0) * (ev.ctrlKey ? 0.01 : 0.0015));
    const x = localX(ev);
    zoomAbout(x, span * factor, zoom ? zoom.f0 : 0, span, x);
    schedule();
  }

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('lostpointercapture', endPointer);
  svg.addEventListener('wheel', onWheel, { passive: false });

  // --- resize --------------------------------------------------------------

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => schedule());
    try { ro.observe(container); } catch { ro = null; }
  }

  draw();

  return {
    /**
     * Re-render with a new spec. Zoom is preserved only when the caller hands
     * back the SAME points array reference (i.e. "same data, new options");
     * any other change resets to the full domain.
     */
    update(next) {
      if (destroyed) return;
      const prevPoints = cfg.rawPoints;
      cfg = normalise(next);
      applyTouchAction(); // interactive may have flipped with the new spec
      if (cfg.rawPoints !== prevPoints) resetZoom();
      pointers.clear();
      mode = 'none';
      down = null;
      panRef = null;
      pinchRef = null;
      draw();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = 0;
      if (ro) { try { ro.disconnect(); } catch { /* ignore */ } ro = null; }
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', onPointerMove);
      svg.removeEventListener('pointerup', endPointer);
      svg.removeEventListener('pointercancel', endPointer);
      svg.removeEventListener('lostpointercapture', endPointer);
      svg.removeEventListener('wheel', onWheel);
      pointers.clear();
      geom = null;
      while (container.firstChild) container.removeChild(container.firstChild);
    },
  };
}
