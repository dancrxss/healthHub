// Shared helpers. No dependencies, no DOM.

/** Random UUID (crypto-backed where available). */
export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Current instant as ISO datetime string. */
export function nowISO() {
  return new Date().toISOString();
}

/** Today as ISO date (YYYY-MM-DD), local time. */
export function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A date in UK numeric form, DD/MM/YYYY — the app's single display format.
 * Accepts an ISO date ('2026-10-13', read as LOCAL midnight so it never slips
 * a day), an ISO datetime, epoch ms or a Date. Returns '' when unparseable.
 */
export function formatDMY(value) {
  if (value == null || value === '') return '';
  let d;
  if (value instanceof Date) d = value;
  else if (typeof value === 'number') d = new Date(value);
  else {
    const str = String(value);
    d = new Date(str.length <= 10 ? `${str}T00:00:00` : str);
  }
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** 'HH:MM' (24-hour, local) for an ISO datetime, epoch ms or Date; '' when unparseable. */
export function formatHM(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (value == null || Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Alphabetical order for anything the user picks from a list — exercises,
 * categories, equipment. Case- and accent-insensitive, ignores stray leading
 * or trailing spaces (imported names have them), and sorts "Set 2" before
 * "Set 10".
 */
export function compareText(a, b) {
  return String(a == null ? '' : a).trim()
    .localeCompare(String(b == null ? '' : b).trim(), 'en-GB', { sensitivity: 'base', numeric: true });
}
/** Sort items by a text key, alphabetically (see compareText). Returns a new array. */
export function sortByText(items, key = (x) => x) {
  return [...items].sort((a, b) => compareText(key(a), key(b)));
}
