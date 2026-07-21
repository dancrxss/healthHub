# Phase 1 Implementation Plan — Gym Tracker

*Derived from `gym-tracker-spec.md` (authoritative) and
`gym-tracker-claude-code-handoff.md`. Written 21 July 2026, paused here for
review before implementation per the handoff's working method.*

## File layout

"Near-single-file": one HTML entry point, with JS split into a handful of plain
ES modules loaded natively (no build step, no bundler, no external runtime
dependencies).

```
healthHub/
├── index.html              # app shell: all screens as sections, toggled by a tiny router
├── manifest.webmanifest    # PWA manifest (installable, standalone display)
├── sw.js                   # service worker: precache app shell, cache-first
├── css/
│   └── app.css             # mobile-first, big touch targets, high contrast
├── js/
│   ├── db.js               # IndexedDB open/upgrade + repository functions (CRUD per entity)
│   ├── queries.js          # frozen derived-query contract (pure functions)
│   ├── sync.js             # sync adapter interface + no-op local adapter + Azure stub
│   ├── seed.js             # ~50-exercise seed library + one hand-seeded template
│   ├── ui.js               # screens, rendering, event wiring, router
│   └── timer.js            # rest timer (auto-start on set completion, configurable default)
├── tests/
│   ├── test.html           # runs assertions against real IndexedDB in-browser
│   └── assertions.js       # data-layer + query-layer assertions over seeded sample data
├── import-repcount.js      # standalone Node CSV import scaffold (column mapping isolated)
├── sample-repcount.csv     # plausible sample export the scaffold runs against
└── README.md               # local dev, sync adapter seam, what Phase 2 plugs into
```

## Module boundaries

- **`db.js`** — owns IndexedDB. Schema v1: object stores `exercises`,
  `workouts`, `sets`, `templates`, keyed by `id`, matching the spec's entities
  field-for-field. Indexes: `sets` by `workoutId` and by `exerciseId`;
  `workouts` by `date`. Exposes plain async repository functions
  (`putExercise`, `getWorkout`, `listSetsForWorkout`, …). Every record carries
  `syncedAt` (null until synced) for future delta sync. Upserts only; deletes
  exist only for user-initiated edit/delete of sets/workouts (a P0 requirement).
- **`queries.js`** — the **frozen MCP contract**. Exactly:
  `getLastSession(exerciseId)`, `getRecentWorkouts(sinceDate)`,
  `getPRs(exerciseId)`, `getWeeklyVolume(weeks)`, `getTrainingFrequency(weeks)`.
  Pure functions per the spec's definitions table: they take data via the
  repository, exclude warmups from PRs/volume, Epley 1RM, ISO-week bucketing.
  No UI concerns in this module.
- **`sync.js`** — `SyncAdapter` interface: `push(records)`, `pull(since)`,
  `status()`. Implemented: `LocalNoopAdapter` (default). Stubbed:
  `AzureTableAdapter` with the spec's partition/row key mapping encoded but no
  network calls and no Azure resources — throws "not configured" if selected.
- **`seed.js`** — ~50 exercises across all muscle-group and equipment enums,
  `isCustom: false`; seeded once on first run. One hand-seeded template
  (e.g. "Push Day A") so start-from-template is exercisable without a CRUD UI.
- **`ui.js` + `timer.js`** — everything user-facing. No data logic; calls
  `db.js`/`queries.js` only.
- **`import-repcount.js`** — reads a CSV path from argv; `mapRow(row)` is the
  single clearly-marked mapping function to correct once the real RepCount
  format is known. Emits a JSON file importable by the app (paste/upload seam),
  keeping the script decoupled from IndexedDB. Idempotent via deterministic IDs
  hashed from (date, exercise, setNumber).

## UI screens (build order)

1. **Home / workout start** — "Start empty workout", "Start from template",
   recent workouts list (via `getRecentWorkouts`).
2. **Workout in progress** — exercises added so far with their sets; add
   exercise; finish workout.
3. **Exercise logging** (the make-or-break) — previous session's sets shown
   ("what to beat"), weight/reps steppers pre-filled from last top set, warmup
   toggle, RPE (optional, collapsed by default pending open question 1),
   one-tap confirm → set saved + rest timer auto-starts with visible countdown.
   **Repeat set = 1 tap; adjusted set ≤2 taps + stepper presses.**
4. **Exercise picker** — searchable seed library grouped by muscle group;
   create custom exercise inline.
5. **History** — workout list → workout detail; edit/delete sets and workouts.
6. **Settings (minimal)** — default rest duration, display units (kg/lb display
   only; storage stays kg).

## Build order & milestones

1. **M1 — data + query layers**: `db.js`, `queries.js`, `seed.js`, `sync.js`
   interfaces, `tests/` assertions green against seeded sample data.
2. **M2 — logging core**: screens 1–4, timer, offline persistence — meets the
   spec's logging-flow acceptance criteria.
3. **M3 — PWA + history**: manifest, service worker, installable, screens 5–6.
4. **M4 — import scaffold + README**: `import-repcount.js` runs against
   `sample-repcount.csv`.

After each milestone: state what was built, what's untested, next steps
(per handoff). Delegation per CLAUDE.md §7: M1 to an `opus` agent (calc
correctness matters), UI screens to `sonnet` agents with pinned contracts,
orchestrator verifies and commits.

## Open questions (from the spec — none block starting)

- RPE in the logging UI: planned as optional and collapsed by default; cheap to
  remove or promote.
- Real RepCount CSV columns: scaffold written against a plausible sample;
  mapping isolated in `mapRow`.
- Bodyweight volume: `weightKg = added load` (0 for strict bodyweight) as
  specced; noted in README as a known simplification.
