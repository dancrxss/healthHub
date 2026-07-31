// Assemble www/ for the Capacitor iOS shell. The PWA is served straight from
// the repo root on GitHub Pages; the native shell needs the same files in a
// clean directory (Capacitor copies webDir wholesale into the app bundle).
// Node built-ins only — no dependencies (CLAUDE.md §10 stack rule).
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'www');

// Everything the app shell needs, mirroring sw.js SHELL plus the SW itself
// (unregistered inside the native shell, harmless to bundle).
const ENTRIES = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const entry of ENTRIES) {
  await cp(path.join(root, entry), path.join(out, entry), { recursive: true });
}
console.log(`www/ assembled (${ENTRIES.join(', ')})`);
