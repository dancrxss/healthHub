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
  throw new Error('charts: not implemented');
}
