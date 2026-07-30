// Rest timer. Auto-started by the logging flow on set completion.
// Survives reloads: the end timestamp is persisted to localStorage, so an
// installed PWA that gets backgrounded mid-rest resumes the countdown.
//
// No DOM imports here — settings.js is pure localStorage, so it is safe.

import { getSetting } from './settings.js';

const STORAGE_KEY = 'resttimer.endsAt';
const DEFAULT_REST_KEY = 'settings.restSeconds';
export const DEFAULT_REST_SECONDS = 90;

let intervalId = null;
let onTick = null; // (secondsRemaining) => void
let onDone = null; // () => void

/** Configured default rest duration (seconds). Stored client-side. */
export function getDefaultRestSeconds() {
  const v = Number(localStorage.getItem(DEFAULT_REST_KEY));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_REST_SECONDS;
}

export function setDefaultRestSeconds(seconds) {
  localStorage.setItem(DEFAULT_REST_KEY, String(seconds));
}

/** Seconds remaining on the running timer, or 0 if none. */
export function remaining() {
  const endsAt = Number(localStorage.getItem(STORAGE_KEY));
  if (!endsAt) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

/** Register UI callbacks. Call once at app start. */
export function bind({ tick, done }) {
  onTick = tick ?? null;
  onDone = done ?? null;
  if (remaining() > 0) startTicking(); // resume after reload
  else if (localStorage.getItem(STORAGE_KEY)) finish();
}

/** Start (or restart) the countdown. Defaults to the configured duration. */
export function start(seconds = getDefaultRestSeconds()) {
  localStorage.setItem(STORAGE_KEY, String(Date.now() + seconds * 1000));
  startTicking();
}

export function cancel() {
  localStorage.removeItem(STORAGE_KEY);
  stopTicking();
}

function startTicking() {
  stopTicking();
  onTick?.(remaining());
  intervalId = setInterval(() => {
    const left = remaining();
    onTick?.(left);
    if (left <= 0) finish();
  }, 250);
}

function finish() {
  localStorage.removeItem(STORAGE_KEY);
  stopTicking();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (getSetting('timerSound')) beep();
  onDone?.();
}

// ---- rest-finished beep ----------------------------------------------------
// A short two-note chime via the Web Audio API — no asset to cache, no <audio>
// element to keep alive. The context is created lazily on the first beep and
// reused: iOS suspends contexts created outside a user gesture, so we resume
// on each play and simply give up if the platform refuses. Never throws.

let audioCtx = null;

/** One sine note with a smooth in/out envelope (a hard start/stop clicks). */
function note(ctx, freq, at, dur) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function beep() {
  try {
    const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => { /* blocked until a gesture */ });
    const t0 = audioCtx.currentTime + 0.01;
    note(audioCtx, 880, t0, 0.15);
    note(audioCtx, 660, t0 + 0.18, 0.15);
  } catch { /* audio unavailable or blocked — the vibration is enough */ }
}

function stopTicking() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
