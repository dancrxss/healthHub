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

---

## Phase 1.5 — RepCount-style UI rework (22 July 2026)

Dan supplied reference screenshots (`sample_screenshots/`) of the RepCount UI and
asked for the app to be reworked to that structure. Decisions taken with Dan:

- **Exercise types:** Strength (kg × reps) **and Cardio** (minutes/seconds,
  distance, kcal). Cardio sets are excluded from PR and volume calculations.
- **Tabs:** all four — Log, Routines, Statistics, Profile — basic versions.
- **Supersets:** supported.
- **RPE + warm-up:** kept, exposed via the per-set “…” menu (not the main grid).

The frozen query contract (`getLastSession`, `getRecentWorkouts`, `getPRs`,
`getWeeklyVolume`, `getTrainingFrequency`) is **unchanged** in names, signatures
and return shapes.

### Schema v2 (all additive; DB_VERSION stays 1 — no store/index changes)

`ExerciseRecord` additions:
- `exerciseType`: `'strength' | 'cardio'` — absent ⇒ `'strength'`.
- `isUnilateral`: boolean — absent ⇒ false (“Single Leg / Single Arm”).
- `MUSCLE_GROUPS` v2 (display categories, this order):
  `['chest','back','legs','shoulders','biceps','triceps','abs','cardio','accessory','rehab','other']`.
  Seed v2 (meta flag `seeded-v2`, idempotent, upsert-only) remaps existing seed
  exercises (`arms` → `biceps`/`triceps` per exercise, `core` → `abs`) and adds
  cardio seeds (Assault Bike, Rowing Machine, Treadmill Run, Incline Walk,
  Stationary Bike, Stair Climber). Custom/user records are never touched.

`WorkoutRecord` additions:
- `name`: string|null — null ⇒ display name derived from `startedAt` hour
  (<12 “Morning Workout”, <17 “Afternoon Workout”, else “Evening Workout”).
- `bodyweightKg`: number|null.
- `entries`: `Array<{exerciseId: string, supersetGroup: number|null, note: string|null}> | null`
  — the ordered exercise list of the workout (exists even before any set is
  logged). null/absent ⇒ legacy workout: derive order from sets’ `completedAt`.
  Consecutive entries sharing a `supersetGroup` integer render as one superset.

`SetRecord` additions (all optional):
- `setType`: `'strength' | 'cardio'` — absent ⇒ `'strength'`.
- `notes`: string|null.
- `durationSeconds`, `distanceM`, `kcal`: number|null (cardio fields).
- Cardio sets store `weightKg: 0, reps: 0` so legacy code paths stay safe.

`calc.js` behaviour extension (signatures unchanged): `prsFrom` and
`weeklyVolumeFrom` **skip** sets with `setType === 'cardio'`;
`trainingFrequencyFrom` and the session listings still include them.

### Route map

- `#/` → redirects to `#/log`.
- Tabs (tab bar visible): `#/log`, `#/routines`, `#/stats`, `#/profile`.
- Fullscreen (tab bar hidden): `#/workout` (active), `#/workout/:id` (past,
  same screen in view/edit mode), `#/pick` (category list), `#/pick/:group`
  (exercise list within category).

### Module map

- `js/ui.js` — entry: `h()`, formatting, router, tab bar, bottom-sheet infra
  (`openSheet`/`closeSheet`), rest bar, `startWorkout(templateId?)` (seeds
  `entries` from the template), exported shared helpers.
- `js/screens/workout.js` — the workout screen (meta card, exercise cards with
  inline set grid, add-set duplication, per-set/per-exercise sheets, finish).
- `js/screens/picker.js` — category → exercise list → search; Regular/Superset
  toggle (superset = multi-select then confirm); custom exercise create/edit
  sheet (name, category, type, unilateral, delete-if-unused).
- `js/screens/log.js` — Log tab: month groups (“July 2026 · 2 Workouts”),
  workout cards (day badge, name, duration, “3× Face Pulls” lines).
- `js/screens/routines.js` — templates list, start routine, basic create/edit/delete.
- `js/screens/stats.js` — CSS-bar charts from the frozen queries: sessions/week,
  weekly volume per muscle group, per-exercise PRs.
- `js/screens/profile.js` — units, default rest, sync status, about.
- `css/app.css` (core + workout/picker) and `css/screens.css` (tab screens).

### Interaction contract (acceptance criteria unchanged)

- **Add Set** on an exercise card appends a set pre-filled from the previous set
  (or last session’s top set) — **repeat set = 1 tap**. Tapping a value opens an
  inline editor (numeric input + steppers) — adjusted set ≤2 taps + presses.
- Adding a set auto-starts the rest timer (unchanged `timer.js`); alarm icon in
  the workout header opens the timer sheet.
- Finishing = header tick → confirm sheet. Past workouts open in the same
  screen for viewing/editing.

### Stable DOM hooks (for the CDP e2e suite — implement exactly)

- Tab bar: `nav#tabbar button[data-tab="log"|"routines"|"stats"|"profile"]`.
- Screens: `#s-log`, `#s-routines`, `#s-stats`, `#s-profile`, `#s-workout`,
  `#s-pick`.
- Workout: finish `[data-action="finish"]`, meta card `.wmeta`, exercise card
  `.ex-card[data-exercise-id]`, add set `.add-set[data-exercise-id]`, set row
  `.set-row[data-set-id]`, field `.set-field[data-field]` (weight, reps,
  minutes, seconds, distance, kcal), add exercise `[data-action="add-exercise"]`.
- Log tab: `.month-group`, `.workout-card[data-workout-id]`, start
  `[data-action="start-workout"]`.
- Sheets: `#sheet-root .sheet`, actions via `[data-action]`.

### Out of scope for this rework

Charts per exercise beyond basic stats, Transfer Exercise Data, Replace
exercise, Log-tab bulk Edit mode, template supersets. The spec’s screen-flow
sections are superseded by the screenshots; every domain rule in CLAUDE.md §10
still stands.

## Phase 1.6 — On-device feel pass (29 July 2026)

From Dan's on-device testing round. Screen structure is unchanged; this pass is
about how the app *feels* under a thumb.

### Text entry (`js/inputs.js` — new, shared by every input)

The old behaviour selected-all on focus inside a rAF. On iOS that both lost the
race with the native caret placement (caret landed at 0, so typing prepended)
and raised the blue drag handles / magnifier. The rule now:

- **Numeric fields** (`enhanceInput(el, { replaceOnType: true })`) — caret to the
  END on focus, never a selection; the **first typed character replaces the whole
  value**, so overwriting a duplicated set is one action (25 → type 3 → `3`).
  Backspace and every later keystroke edit normally — pristine mode is one-shot.
  Falls back to select-all where `beforeinput` is unsupported.
- **Text fields** (`enhanceInput(el)`) — left alone, except that a caret parked at
  0 on a non-empty value (the iOS bug) is moved to the end. A deliberate
  mid-text tap is never overridden.
- Enter always blurs, and blur is the single commit point for every field.
- Template target inputs moved from `type=number` to `type=text` +
  `inputmode=numeric` so `setSelectionRange` works on them.

Last-session values stay as grey `placeholder`s on the set grid (Phase 1.5).

### Selection & smoothness

- `user-select: none` moved from `body` to the universal selector — iOS lets a
  long-press drag a selection out of a body-only rule. Inputs/textareas opt back in.
- Bottom sheets: forced layout pass before `.open` (a single rAF is too early on
  iOS — the sheet popped instead of sliding), and the page behind is scroll-locked
  (`body.scroll-locked`, position:fixed + restored offset).
- `100dvh` → `100svh` on body/screens: the static unit doesn't reflow the whole
  layout when the keyboard or URL bar changes height.
- Sticky workout header: solid fill + a 12px `::after` fade, instead of a
  full-height gradient repainting every scroll frame.
- `contain: layout style` on exercise cards; press feedback limited to
  opacity/transform; `prefers-reduced-motion` honoured.

### Not possible in a PWA

**Dynamic Island / lock-screen session timer.** These are iOS Live Activities
(ActivityKit) — native-only, with no web API. The in-app minimise → Resume
Workout pill is the closest equivalent and already ships. Revisit only if the
app is ever wrapped natively.

### Test harness note

`tests/cdp-e2e.mjs` now enables `Emulation.setFocusEmulationEnabled`. Headless
Chrome treats the page as unfocused, so `element.focus()` dispatches no focus
event — without this, every focus-driven assertion silently passes on a no-op.

## Phase 1.7 — In-app CSV import (29 July 2026)

Dan's full RepCount history (`sample/export_29 Jul 2026.csv`: 6,628 set rows,
350 workouts, Mar 2022 → Jul 2026) imports directly in the app — Profile tab →
"Import workout history". The importer is GENERIC: header-synonym column
detection over an RFC 4180 parser (delimiter sniffed), so other apps' exports
(Strong, Hevy…) map too; the RepCount file is the reference format.

### Module split

- `js/csv-import.js` — PURE (no DOM/IDB): `parseCSV`, `sniffDelimiter`,
  `detectColumns`, `buildImportPlan(text, existingExercises, existingWorkouts)`.
  The file's JSDoc is the pinned contract.
- `js/db.js` — additive `bulkImport({exercises, workouts, sets}, onProgress)`:
  chunked readwrite transactions (500/chunk), upsert-only, syncedAt nulled.
- `js/screens/profile.js` — Data card, file picker, preview sheet (stats,
  warnings, duplicate-day skip toggle), progress, result sheet.

### Import semantics (decisions of record)

- **Deterministic ids** from natural keys — workouts `import-w-<YYYYMMDD-HHMM>`,
  sets `import-s-<…>-<kebab-exercise>-<n>`, new exercises `import-<kebab-name>`
  — so re-importing the same file upserts in place: **idempotent, never deletes**.
- Exercise names match the existing library trim/case-insensitively; unmatched
  become custom exercises with muscleGroup from the Category column and
  exerciseType inferred from the data (cardio / bw_assisted_reps on negative
  weights / weight_reps / reps / time).
- Negative weights = assisted bodyweight (RepCount convention): stored abs.
- All weights kg (lb only if the header says so); durations seconds; naked
  local ISO timestamps; set completedAt spread across the start→end window.
- Row notes land on SETS (the app's inline set-notes field); Name → workout
  name; Bodyweight → workout.bodyweightKg.
- **Duplicate-day guard**: imported workouts landing on a date that already has
  an app-logged workout are flagged; the preview defaults to skipping them
  (Dan dual-logged in RepCount while testing this app, so the export overlaps
  21–28 Jul). Toggleable in the preview sheet.

## Phase 1.8 — Statistics rework + Settings (30 July 2026)

Second half of the stats/settings build (contracts in the 29 Jul session).
Reference: RepCount screenshots in `sample/` (now gitignored with the rest of
that folder).

### Settings (replaces the Profile tab)

- 3 tabs + a **settings gear** top-right of every tab header → fullscreen
  `#/settings` (legacy `#/profile` redirects). Everything from the Profile
  screen moved over unchanged (units, rest stepper, CSV import, sync, about).
- `js/settings.js` — central typed store. New settings, all **wired, not just
  stored**: Autofill weight (reps entered + weight empty → last session's
  weight commits in the same write), Auto-start rest timer (gates
  `timer.start()` in addSet), Timer sound (Web Audio double beep in
  timer.finish), Keep screen on (Screen Wake Lock, re-acquired on
  visibilitychange, released on screen teardown); Charts: Show trend line,
  Include warm-up sets (charts only — PRs never), Count single arm/leg twice.

### Statistics

- `js/charts.js` — dependency-free SVG engine: line (default, RepCount-style:
  teal line, faint grid, right-edge y labels), bar (+horizontal flip), donut
  pie + legend. Interactive: pinch-zoom on the x-domain, one-finger pan,
  double-tap reset, press readout; least-squares trend line; colours read from
  CSS custom properties; ResizeObserver-responsive.
- `js/stats-data.js` — the metric layer (separate from the FROZEN queries.js
  contract): Overall (duration, volume, sets, reps, reps/set, bodyweight,
  workouts, cardio time/distance, kcal), per-Exercise (e1RM, e1RM/BW, volume,
  max/avg weight, reps, sets, max reps, workouts), per-Category, plus
  `categoryBreakdown` for pies. Day/week/month/year bucketing, 3M/6M/1Y/All
  ranges, zero-fill only for count metrics, finished workouts only.
- `js/screens/stats.js` + `css/stats.css` — the **customisable module grid**
  (layout persisted via settings.js): Edit mode with pointer-events
  drag-and-drop (FLIP-animated, auto-scroll at viewport edges; capture held on
  the grid so mid-drag DOM reorders can't kill the gesture), per-card ⋯ config
  (metric/chart/group/range), add/remove/reset. Below: Exercises → per-exercise
  metric list → chart detail; Categories likewise; Overall Statistics rows.
  Chart detail = metric + Group By selectors, range pills, line/bar(/pie)
  toggle, axis flip; prefs persist per scope.
- Picker fix surfaced by the new e2e: confirming a superset now resets the
  picker to Regular mode (it used to stay armed forever).

### Verification

177 browser unit assertions (incl. 36 stats-data), 69 e2e steps (incl. a
CDP-touch drag-and-drop reorder, toggle wiring, autofill and rest-timer-gate
behaviour checks), offline check, and visual screenshot review of the grid,
chart detail, edit mode and settings screens. E2E harness now enables touch
emulation (Input.dispatchTouchEvent is silently dropped without it).
