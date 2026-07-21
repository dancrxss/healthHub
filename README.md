# Gym Tracker (healthHub)

Personal gym workout tracker for a single user. Offline-first PWA, all data
owned locally (IndexedDB), designed so a future MCP server can expose the
training data to Claude with zero schema changes. Replaces RepCount.

Spec: [`gym-tracker-spec.md`](gym-tracker-spec.md) ·
Phase 1 scope: [`gym-tracker-claude-code-handoff.md`](gym-tracker-claude-code-handoff.md) ·
Plan: [`PLAN.md`](PLAN.md)

## Local dev

No build step, no dependencies. ES modules + IndexedDB need a real origin, so
serve the repo root over HTTP:

```bash
python3 -m http.server 8000
# app:   http://localhost:8000/
# tests: http://localhost:8000/tests/test.html  (browser suite, real IndexedDB)
```

Pure-logic tests run in Node with zero dependencies:

```bash
node tests/calc.test.mjs
```

Install to a phone home screen from the browser share menu — the service
worker (`sw.js`) precaches the shell, so the app is fully functional offline.
Bump `CACHE_VERSION` in `sw.js` in the same commit as any change to cached
asset patterns.

## Layout

| Path | What |
|---|---|
| `index.html`, `css/app.css`, `js/ui.js` | App shell, screens, router |
| `js/db.js` | IndexedDB schema + repository (the only file that touches IndexedDB) |
| `js/calc.js` | Pure derived-metric functions (no DOM, no DB — run in Node and browser) |
| `js/queries.js` | **Frozen query contract** — thin wrappers: repo → calc |
| `js/sync.js` | Sync adapter seam (see below) |
| `js/seed.js` | 55-exercise seed library + "Push Day A" template |
| `js/timer.js` | Auto rest timer (persists across reloads) |
| `import-repcount.js` | One-off RepCount CSV → JSON import scaffold |

## The sync adapter seam

`js/sync.js` defines the adapter interface (`push(changes)`, `pull(since)`,
`status()`). Phase 1 ships `LocalNoopAdapter` — the app is fully functional
local-only. Every record carries `syncedAt` (nulled on local write), so delta
sync is a matter of pushing records where `syncedAt === null`.

`AzureTableAdapter` is a stub that already encodes the spec's partition/row
key scheme (workouts partitioned by `yyyy-MM`, sets by `workoutId` with
zero-padded `setNumber` row keys). Phase 2 wires it to real Azure Table
Storage — no schema changes, just implement `push`/`pull` and swap
`getActiveAdapter()`.

## What Phase 2 (Azure sync + MCP) plugs into

1. **Sync:** implement `AzureTableAdapter` against provisioned Table Storage
   (SAS token or a small Function App), call `push`/`pull` from the app on
   connectivity/startup. Last-write-wins is acceptable (single user).
2. **MCP server:** exposes the **frozen contract** in `js/queries.js` —
   `getLastSession`, `getRecentWorkouts`, `getPRs`, `getWeeklyVolume`,
   `getTrainingFrequency`. Server-side it reimplements them over Table Storage
   by reusing `js/calc.js` verbatim (pure functions, no browser APIs) over
   fetched partitions. Names, signatures and return shapes must not drift —
   that is the whole point of the seam.

## RepCount import

One-off, run locally:

```bash
node import-repcount.js path/to/export.csv --out repcount-import.json
```

The real RepCount export format is unknown until the export is pulled — all
column interpretation is isolated in `mapRow()` at the top of the script.
Deterministic ids make it idempotent (re-runs produce identical output).
The JSON output is the app-import seam; an in-app import consumes it (P1).

## Rules that must not drift

- Weights stored in **kg**, always. Display units are a UI concern.
- Warmup sets are excluded from PRs and volume; they still count for frequency.
- Everything beyond Exercise / Workout / Set / Template is derived, never stored.
- The query layer names/signatures are frozen (MCP contract).
