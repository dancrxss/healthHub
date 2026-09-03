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

## Phase 1.9 — Routines reworked, gesture editing (30 July 2026)

### Routines tab removed

The tab bar is now **Log + Statistics**. Routines were a destination you rarely
needed; what you actually want is to reuse a session while starting one.

- **Copy Routine** sits above Add Exercise on an active workout → `#/copy`,
  a picker in the exercise-picker language with two categories: **Routines**
  (user-created; nothing is seeded any more) and **Previous Sessions**.
  Choosing either copies its *skeleton* — exercises + number of sets, never the
  loads — as blank sets, so each row shows its own last-session placeholder.
  Exercises already in the workout are skipped rather than duplicated.
- **Save as Routine** on a workout's ⋯ menu → `#/routine/from/:id`, the editor
  prefilled with that session's skeleton, needing only a name.
- Routine editing is a fullscreen screen (`#/routine/new|:id`), not a sheet.
  `#/routines` redirects to `#/copy/routines`.
- `seedIfEmpty` no longer seeds "Push Day A". Existing installs keep theirs —
  deleting it would be a destructive migration (§2.1). `SEED_TEMPLATE` stays
  exported as a test fixture.

### Gesture editing

- **Long press an exercise card** to pick it up: it lifts into a selected state
  with a toolbar for move up / move down / delete. Replaces Move Up/Move Down
  in the ⋯ menu — the controls now sit next to the thing being moved. 450ms,
  cancelled by 8px of movement so a press that becomes a scroll never selects.
- **Swipe left to delete** (`js/swipe.js`), shared by sets, exercise cards,
  sessions and routines. Deleting a whole session still confirms; a set does
  not (swipe + tap is already two deliberate steps).

Two real bugs found while verifying the gesture, both invisible to the eye:
swipe rows NEST (a set row inside a swipeable card), so both tracked one drag
and the outer closed the inner — swiping a set actually swiped its card. And
the gesture claim was permanent, so a pointerdown that never got its pointerup
wedged swiping shut for the session. The claim is now keyed by pointerId, only
blocks the same gesture, and is released document-wide on any pointerup.

## Phase N — Native iOS shell + Apple Health (31 July 2026)

Direction change (CLAUDE.md §10): healthHub becomes an end-user App Store app.
Azure sync and the cloud MCP server are cancelled; Apple Health integration is
on-device only, health data never leaves the phone. The web app stays a
no-build vanilla-JS PWA and must keep working unchanged on GitHub Pages —
everything below is progressive enhancement behind feature detection.

### N1 — Capacitor shell (done)

`package.json` + `capacitor.config.json` + `scripts/build-www.mjs` assemble
`www/` and generate `ios/` (Capacitor 7, SPM, no CocoaPods). SW registration
is skipped when `window.Capacitor.isNativePlatform()`. appId
`com.dancross.gymtracker`, appName "Gym Tracker".

### N2 — Pinned contracts

**DB (js/db.js, DB_VERSION 2, additive):** new `health` store, keyPath `id`,
index `by-type-start` on `['type','startedAt']`. `HEALTH_TYPES` and
`HealthSampleRecord` are documented in db.js. Repository API:
`putHealthSamples(samples)`, `listHealthSamples(type, {since, limit})`,
`getLatestHealthSample(type)`, `clearHealthSamples()` (user-initiated only).

**Meta keys:** `healthConnected` (bool), `healthLastSyncAt` (ISO string),
`healthWriteWorkouts` (bool, default true — "save gym sessions to Apple
Health").

**Swift plugin (`HealthKit`, in-app CAPPlugin, registered via a
CAPBridgeViewController subclass):** methods, all resolving plain objects:
- `requestAuthorization()` → `{requested: true}` — presents the HealthKit
  sheet for the §10 read set + workout write. Read denials are invisible by
  design; never claim to know grant state.
- `startSync({backfillDays})` → `{started: true}` — runs anchored queries per
  type (anchors persisted in UserDefaults, so the first call is the backfill
  and later calls are deltas), enables background delivery + observer queries,
  and emits `samples` events as batches: `{type, samples: [HealthSampleRecord],
  done: boolean}`. Per-type backfill caps: heartRate 30 days, sleepAnalysis 90,
  everything else 365. activeEnergy arrives as daily totals
  (HKStatisticsCollectionQuery) with deterministic ids `activeEnergy-YYYY-MM-DD`.
- `stopSync()` → disables background delivery, clears anchors.
- `saveWorkout({name, startedAt, endedAt, kcal})` → `{saved: boolean}` —
  writes an HKWorkout (traditionalStrengthTraining) with optional total energy.
- `getStatus()` → `{available: boolean, authorizationRequested: boolean}`.

Workout samples carry `meta.avgHeartRate` (statistics query over the workout
window) and `meta.kcal`, `meta.activityType`, `meta.distanceM`.

**JS bridge (`js/health.js`):** the only file that touches
`window.Capacitor.Plugins.HealthKit`. Public API:
`healthAvailable()`, `getHealthState()` → `{available, connected, lastSyncAt}`,
`connectHealth()`, `disconnectHealth({purge})`, `syncNow()`,
`onHealthUpdate(cb)` (fires after each stored batch), `initHealth()` (called
once from ui.js init; wires plugin event listeners → putHealthSamples → meta
updates), `saveWorkoutToHealth(workout, sets)` (no-op unless native +
connected + healthWriteWorkouts; computes kcal `null`, duration from
startedAt/finishedAt).

**UI:** Settings gains an "Apple Health" section (hidden in the PWA;
Connect state → status/Sync now/write-toggle/Disconnect states when native).
Stats gains a "Health" section (latest weight + 30-day trend, resting HR, HRV,
last night's sleep, VO₂max) rendered only when connected and data exists.
Workout finish calls `saveWorkoutToHealth`. Copy rule: absence of data is
always "No data found — check Settings → Health → Data Access", never "you
blocked this".

### N3 — Store prep

`privacy.html` (served on Pages — the App Store privacy policy URL),
`APP_STORE.md` (submission checklist + Dan-only steps: Apple Developer
account, Xcode install, signing, TestFlight, App Privacy labels). Purpose
strings + HealthKit entitlements (incl. background delivery) wired into the
Xcode project.

## Phase C — Coach: AI training coach (3 September 2026)

Dan is returning after an injury. The Coach builds a return-to-training plan
from his history, revises it after every session, and writes a daily summary
(muscle-group balance, session feedback, overreach warnings). Powered by the
user's **own** Claude API key; the app has no backend and gains none.
Approved plan of record: `~/.claude/plans/so-i-am-getting-peaceful-riddle.md`
(this section is the pinned contract extracted from it).

### C0 — Constraints inherited

- Vanilla JS, no build, **no Anthropic SDK** — `POST https://api.anthropic.com/v1/messages`
  via raw `fetch`. CORS preflight verified 3 Sep 2026 from the Pages origin with
  header `anthropic-dangerous-direct-browser-access: true`.
- Model pinned: `claude-sonnet-5`. No picker.
- No key ⇒ Coach tab hidden, zero network. App stays a fully working PWA.
- Apple Health values leave the device **only** when meta `coach.shareRecovery === true`
  (default off by absence; Settings → Coach → "Share recovery data with coach").
  Signed off by Dan 3 Sep 2026. Exactly four derived values may leave when on:
  sleep hours last night, HRV (ms) + 30-day baseline, resting HR + baseline,
  body weight + 30-day trend %. Raw HealthKit samples never.
- "Daily" = first open each day (date gate). No background jobs in v1.
- No prompt caching (5-minute TTL, calls hours apart).

### C1 — Data contract (DB v3, additive)

Stores added in `onupgradeneeded` with `contains()` guards:

```
coachPlans     keyPath id, index 'by-created' on createdAt
  CoachPlanRecord { id, version (1-based, monotonic), createdAt, source:'created'|'revised'|'manual',
                    basedOnWorkoutId|null, rationale|null, weeks, sessions: PlanSession[] }
  PlanSession     { id:'ps-1'.. (assigned locally, never model-supplied), order, name, focus|null,
                    exercises: PlanExercise[] }
  PlanExercise    { exerciseId, targetSets, targetRepsLow, targetRepsHigh, targetWeightKg|null,
                    targetRpe|null, note|null }

coachInsights  keyPath id, index 'by-kind-created' on ['kind','createdAt'], 'by-workout' on workoutId
  CoachInsightRecord { id:'daily-YYYY-MM-DD'|'session-<workoutId>', kind:'daily'|'session', createdAt,
                       date, workoutId|null, model, engineVersion, metrics, narrative, planId|null,
                       usage:{inputTokens, outputTokens} }
```

Plan revisions are new records (never mutated). Dedicated `putCoachPlan` /
`putCoachInsight` (no `syncedAt`). `WorkoutRecord` gains optional
`planId|null`, `planSessionId|null`.

Meta keys: `coach.profile` `{version:1, updatedAt, injuryNotes, goal:
'return-from-injury'|'build-muscle'|'get-stronger'|'general-fitness', daysPerWeek,
sessionMinutes, equipmentNotes, returnDate|null, avoidExerciseIds:[]}`,
`coach.shareRecovery`, `coach.currentPlanId`, `coach.lastDailyDate`,
`coach.pending` `{kind, workoutId?, queuedAt}|null`, `coach.lastError`,
`coach.usageTotals` `{calls, inputTokens, outputTokens, estimatedCostUsd}`,
`coach.unreadAt`.

API key: localStorage `coach.apiKey` through `STRING_SETTING_DEFS` /
`getStringSetting` / `setStringSetting` in `js/settings.js` (the boolean
`SETTING_DEFS` table cannot hold a string). Synchronous so `route()` can hide
the tab. Never logged, never sent anywhere except as `x-api-key`.

### C2 — Engine contract (`js/coach-engine.js`, pure, Node-testable)

`today` is always injected (like `weeklyVolumeFrom`). Dataset = `{workouts, sets, exercises}`.

```
COACH_ENGINE_VERSION = 'coach-engine-1'
SET_TARGETS  chest 10–20 · back 10–20 · legs 12–22 · shoulders 8–16 · biceps 6–16 · triceps 6–16
             abs 4–12 · accessory 0–12 (advisory) · rehab never flagged · cardio/other unscored
             (max ×0.85 when daysPerWeek ≤ 3)
RAMP_FACTORS [0.4, 0.5, 0.65, 0.8, 0.9, 1.0]   by week since return (index min(w-1,5))
START_FACTORS weeksOff ≤2→0.95 · 3–4→0.85 · 5–8→0.75 · 9–16→0.65 · >16→0.60
FLAG_CODES   volume-spike, group-volume-spike, rpe-creep, e1rm-regression, no-rest-day,
             frequency-drop, return-ramp, low-hrv, elevated-rhr, short-sleep, weight-drop

setTargetsFor(profile, weeksTrained)
hardSetsByGroup(dataset, weeks, today)             hard set = !isWarmup && setType!=='cardio' && reps>=1
muscleBalance(dataset, {weeks=4, today, profile})  → [{group, sets, min, max, status, trend}]
                                                   status: untrained | under (<0.75·min) | on | over (>max)
                                                   trend: last ISO week vs mean of prior 3, ±15% → up/down/flat
trainingGap(dataset, today)                        → {daysSinceLastSession, weeksOff, status:'active'|'layoff'|'long-layoff',
                                                      detrainingPct = min(0.35, 0.02·max(0, weeksOff-2))}
                                                   active <10d · layoff 10–20 · long-layoff >20
sessionDiff(dataset, workoutId)                    → per-exercise {verdict:'better'|'worse'|'same'|'new', volumeKg,
                                                      volumePrevKg, e1rm, e1rmPrev, repsAtSameWeight, avgRpe, ...}
loadFlags(dataset, {today, health})                → [{code, severity:'info'|'watch'|'warn', detail}]
progressionFor(dataset, exerciseId, {today, profile, gap})
                                                   → {weightKg, repsLow, repsHigh, sets, rule}
                                                   layoff: START_FACTOR × median working weight of the highest-e1RM
                                                   session in the 12 weeks before the gap, rounded down to 2.5
                                                   (floors 20 barbell / 2.5 other / 0 bodyweight)
                                                   active: double progression — top of range every set @RPE≤8|null
                                                   → ×1.025 (min one 2.5 step), reps→low; in range → hold, low=achieved+1;
                                                   below twice or RPE≥9.5 → hold; below ×3 → deload 10%.
                                                   caps +5% weight/ex/week, +10% group sets/week
nextPlanSession(plan, recentWorkouts)              walks plan.sessions after the last finished workout's planSessionId, wraps
planRefSets(planExercise)                          → targetSets × {weightKg, reps, durationSeconds:null, distanceM:null, kcal:null}
buildDigest({dataset, profile, today, health, workoutId, plan, kind})
```

Digest (< 4 kB; `recovery` only when consent; `session` only for kind 'session'):

```
{ schemaVersion:1, kind, today, profile:{goal, daysPerWeek, sessionMinutes, injuryNotes, equipmentNotes, avoid},
  gap, week:{isoWeek, sessions, hardSets, volumeKg, avgRpe},
  balance:[{g, sets, min, max, status, trend}], flags:[{code, severity, detail}],
  exercises:[{id, name, group, type, lastDate, workWeightKg, topReps, e1rm, e1rmPrev, bestE1rm, weeksSince,
              proposal:{weightKg, repsLow, repsHigh, sets, rule}}],
  recovery?:{sleepH, hrvMs, hrvBaselineMs, restingHr, restingHrBaseline, weightKg, weightTrend30dPct},
  session?:{workoutId, date, name, durationMin, hardSets, volumeKg, avgRpe,
            exercises:[{id, name, verdict, volumeKg, volumePrevKg, e1rm, e1rmPrev, sets:[{w,r,rpe}], prevTop:{w,r,rpe}}]},
  plan?:{version, sessions:[...]} }
```

Exercise window is anchored to the **last training session**, not today:
daily/session ≤12 most-trained in the 8 weeks ending there; plan ≤20 in 16 weeks.

### C3 — API contract (`js/coach-api.js`)

```
POST https://api.anthropic.com/v1/messages
content-type: application/json · x-api-key · anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
{ model:'claude-sonnet-5', max_tokens: daily 4000 | session 8000 | plan 8000,
  system: SYSTEM_PROMPT (frozen constant),
  output_config: { effort: daily 'low' | others 'medium', format:{type:'json_schema', schema} },
  messages:[{role:'user', content: JSON.stringify(digest)}] }
```
Never send `thinking`, `temperature/top_p/top_k`, prefill, `tools`, beta headers,
`cache_control`. Schema subset: `additionalProperties:false` + full `required` on
every object; nullable via `anyOf`; no min/max/length/items/pattern keywords.

Kinds: `daily` → `{headline, body, balanceNotes[{group, status, note}], recoveryNote|null,
todayAdvice, tone}`; `session` → `{overallTone, summary, better[], worse[], flags[],
planChanges[], plan: PLAN|null}` (one call = feedback + revision); `plan` → PLAN.
PLAN = `{weeks, rationale, sessions[{name, focus, exercises[{exerciseId, targetSets,
targetRepsLow, targetRepsHigh, targetWeightKg|null, targetRpe|null, note}]}]}`.

`parseResponse` clamps: unknown exerciseId dropped; empty session dropped; empty
plan rejected; sets 1–8; reps 1–30, high ≥ low; weight 0–500 to 0.5; sessions ≤
daysPerWeek; ≤10 exercises/session; headline 80 / body 600 / notes 200 chars;
`ps-N` ids assigned locally.

Errors (`CoachApiError.code`): offline (queue) · auth 401/403 · request 400 ·
model 404 · rate-limit 429 (retry, Retry-After) · server 5xx/529 (retry) ·
refusal · truncated (retry once at ×1.5 max_tokens) · parse. Max 2 retries,
1 s then 4 s + jitter. 60 s abort. `testApiKey` uses `/v1/messages/count_tokens`.

### C4 — Triggers (`js/coach.js`)

`initCoach()` from `ui.js init()` (fire-and-forget): flush `coach.pending`, then
`runDaily()` if `coach.lastDailyDate !== todayISO()`; `visibilitychange` re-checks.
`onWorkoutFinished(workoutId)` from `finishFlow`, never awaited. Single-flight lock
across all kinds; idempotency checks inside the lock. Results set `coach.unreadAt`
(dot on the tab, cleared on `#/coach`).

### C5 — Routes and DOM hooks

Routes: `#/coach`, `#/coach/balance`, `#/coach/session/:workoutId`, `#/coach/plan`,
`#/coach/history`, `#/coach/setup` (= `#/coach` + setup sheet), `#/copy/plan`.
Tab: `nav#tabbar button[data-tab="coach"]` (last; `hidden` until a key exists).
Screen: `section#s-coach`.
data-action: `coach-setup`, `coach-open-settings`, `coach-start-session`,
`coach-regenerate`, `coach-clear`, `coach-key-input`, `coach-key-show`,
`coach-key-save`, `coach-test-key`, `start-planned`, `start-empty`.
`data-copy-cat="plan"`; `data-setting="coach.shareRecovery"`.

Ghost sets: `startPlannedWorkout(plan, planSession)` in `ui.js` tags the workout
with `planId`/`planSessionId`; `workout.js` swaps `lastByEx` for `planRefSets`
on planned workouts (no change to `buildSetRow`/`autofillWeight`); a `plan` chip
on each `.ex-card` header makes the swap visible. Log `+` unchanged when no plan.

### C6 — Out of scope (v1) — amended 3 Sep 2026 by Phase C2

Streaming, model picker, inventing exercises not in the library, web search,
native background refresh / notifications, any server. **Chatting with the
coach was out of scope in v1 and is IN scope from Phase C2** (Dan's request
after using v1); see C2 below.

## Phase C2 — Coach v2: Home tab, plan builder, projection, explanations, chat (3 September 2026)

Dan's feedback on v1: add muscle groups/cardio/core his history lacks, move plan
configuration into the Coach tab, present all AI output as bullets, plan 6–8
weeks ahead with the current week shown and the rest browsable, explain the
programme and each session, add a chat, and make a Home tab the default. Plan of
record: `~/.claude/plans/so-i-am-getting-peaceful-riddle.md` (v2 section).
Decisions: two chat threads (`home`, `plan`) sharing one on-device **coach
memory**; week 1 + progression rules with the app projecting later weeks; Home
key stats mirror the Statistics modules; cardio/core live inside sessions with a
duration target. Everything pinned in C1–C5 stays unless amended here.

### C2.1 — Data contract deltas (DB v4, additive)

Profile v2 (meta `coach.profile`, all optional with defaults):
```
version: 2 · split: 'auto'|'full-body'|'upper-lower'|'ppl' (auto)
groupPrefs: {[muscleGroup]: 'auto'|'include'|'emphasise'|'avoid'} ({})
cardio: {include:false, minutesPerSession: 5–30 (10), standaloneDay:false, exerciseIds:[]}
core: {include:false} · favouriteExerciseIds: [] · notes: string|null (≤600)
```
Coach memory (meta `coach.memory`): `[{id:'m-<uid>', text ≤160, addedAt,
source:'chat-home'|'chat-plan'|'user'}]`, max 20; sent to every request as
`digest.memory: [{id, text}]`; user-editable in the plan builder.

PLAN v2 (`CoachPlanRecord`, additive):
```
planVersion: 2 · lineageStart: 'YYYY-MM-DD' (programme day 1; copied on revision)
baseWeek: int (programme week the stored targets describe: 1 created, currentWeek revised)
weeks: 6–8 · overview: {points[], muscleFocus:[{group, why}], progression[], deloadWeek|null}
weekNotes: [{week, focus, points[]}]
sessions: [{id 'ps-N', order, name, focus|null, brief[],
  exercises: [{exerciseId, targetSets, targetRepsLow|null, targetRepsHigh|null, targetWeightKg|null,
    targetDurationSec|null, targetRpe|null, purpose, goal, note|null,
    progression: {weightStepKg|null, repStep|null, durationStepSec|null, everyWeeks: 1–4}}]}]
```
`rationale` (v1) is no longer written; renderers show it as one bullet.

Store `coachChat` keyPath `id`, index `by-thread-created` on `['thread','createdAt']`:
`{id, thread:'home'|'plan', role:'user'|'coach', createdAt, text|null (user), points[]|null (coach),
planId|null, changed:{plan,profile,memory}|null, error|null, pending:boolean}`.
Repo: `putChatMessage`, `listChatMessages({thread, limit=60})`, `clearChat(thread|null)`;
`clearCoachData` clears it too.

Insight narrative v2: daily `{headline, points[], balanceNotes[], recoveryNote|null,
advice[], tone}`; session `{overallTone, points[], better[], worse[], flags[],
planChanges[], plan|null}`. Renderers accept v1 strings as one bullet.

### C2.2 — Engine deltas (`js/coach-engine.js`)

```
currentPlanWeek(plan, today)  clamp(floor(days(lineageStart→today)/7)+1, 1, weeks); old plans use createdAt
projectPlanWeek(plan, week)   → {week, isCurrent?, isPast, isDeload, sessions[]}
   steps = max(0, floor((week−baseWeek)/everyWeeks)); weight = base + steps·weightStepKg (0.5 rounding; bodyweight stays 0)
   reps ± steps·repStep (cap 30); duration + steps·durationStepSec
   week === overview.deloadWeek → weight ×0.9 rounded down to 2.5, sets−1 (min 1), isDeload
   week < baseWeek → base targets, isPast:true · no progression → flat
projectedSessions(plan, today) → projectPlanWeek(plan, currentPlanWeek(plan, today)).sessions
planRefSets(pe)               ALWAYS an array (length targetSets, min 1); duration exercises →
                              {weightKg:0, reps:0, durationSeconds:targetDurationSec, distanceM:null, kcal:null}
recentPRs(dataset, {today, days=7}) → [{exerciseId, name, kind:'e1rm', value, date}]
isDurationType(type)          cardio | time | weight_time
```
`buildDigest` kind 'plan': `profile` carries v2 fields; `exercises` = trained
ranked (≤20) + up to 4 library exercises per `include`/`emphasise` group (and
`abs` when core, `cardio` when cardio) not already present — favourites first,
seed before custom, then name; favourites always present; `avoid` groups
dropped; duration types allowed (entries `{…, type, lastDurationSec, proposal:{durationSec}}`).
`rankedExercises`/`libraryTopUp`/`trainedEntry` gain the duration-type path.
Budget: `DIGEST_MAX_BYTES` per kind — 4000 daily/session, 6000 plan/chat; shrink
levers add `chat.recent → 3`, then `memory → 10`. `plan` echo (daily/session/chat)
= `{version, weeks, baseWeek, currentWeek, deloadWeek, sessions: projected current week (slim)}`.
kind 'chat' adds `chat: {thread, recent:[{role,text}] ≤6 × ≤400 chars, message ≤1200}`.
Every kind carries `memory`.

### C2.3 — API deltas (`js/coach-api.js`)

`MAX_TOKENS` daily 4000 · session 10000 · plan 16000 · chat 6000.
`TIMEOUT_MS` daily 60s · session 90s · plan 180s · chat 60s (default when caller passes none).
`MAX_ATTEMPTS` plan 2, others 3. Effort: daily/chat `low`, session/plan `medium`.
Schemas v2: PLAN_V2 as C2.1; daily/session as C2.1; chat →
`{reply[], memoryUpdates:{add[], removeIds[]}, profilePatch:{daysPerWeek|null, sessionMinutes|null,
injuryNotes|null, equipmentNotes|null, notes|null, split|null, cardioInclude|null, coreInclude|null}|null,
planChanges[], plan: PLAN_V2|null}`.
Clamps: bullet lists ≤8 × 200 chars (`brief`/`advice` ≤5, `reply` ≤10 × 300); `purpose`/`goal` ≤160;
`weeks` 6–8 (default 6); `deloadWeek` null or 2..weeks; `weekNotes` ≤ weeks, unique weeks;
`muscleFocus` ≤8; progression weightStepKg 0–10, repStep 0–3, durationStepSec 0–600, everyWeeks 1–4;
`targetDurationSec` null or 30–3600; **id→type map from the digest**: duration types require
duration + null reps, rep types require reps + null duration; chat `add` ≤5 × 160, `removeIds` ⊆ digest
memory ids, `profilePatch` range-checked. Single user message for every kind (chat transcript rides
inside the digest — no multi-turn messages).

### C2.4 — Orchestrator deltas (`js/coach.js`)

`sanitiseProfile` v2 (deep-merge `cardio`/`core`/`groupPrefs`); memory API
`getMemory/addMemory/removeMemory/applyMemoryUpdates` (cap 20, dedupe);
`storePlan` sets `lineageStart`/`baseWeek`/`planVersion`; `sendChat(thread, text)`
(queued kind 'chat'; user message stored immediately with `pending:true`; home
thread applies a returned `plan` only when `planChanges.length > 0`, plan thread
always; single in-flight guard); `getCoachState` adds `currentWeek`, `projected`,
projected `nextSession`, `memoryCount`, `recentPRs`.

### C2.5 — Routes, tabs, hooks

Tabs `home · log · stats · coach(hidden without key)`; default route `#/home`
(both `ui.js` fallbacks); `#/coach/setup` → redirects to `#/coach/builder`.
New routes: `#/home`, `#/coach/builder`, `#/coach/chat`. New files:
`js/screens/home.js`, `js/screens/coach-shared.js`, `css/home.css`; SW v16.
data-action: `home-last-session`, `home-stat`, `home-analyse`, `coach-chat-send`,
`coach-chat-retry`, `coach-builder-save`, `coach-builder-build`, `coach-week` (chips,
`data-week="N"`), `coach-ex-toggle` (expand purpose/goal), `coach-memory-remove`,
`coach-memory-add`, `coach-open-chat`, `coach-open-builder`. Retired: `coach-regenerate`,
`coach-edit-profile`, `coach-setup-save` (`coach-setup` now navigates to the builder).
Every `plan.sessions` read (Coach root, plan screen, Log start choice, `#/copy/plan`,
workout ghost override) goes through `projectedSessions`.

### C2.3 amendment (3 Sep 2026) — wire schema simplified: the API rejected the v2 schemas with 'compiled grammar is too large'. The wire schema now has no enums, one anyOf (nullable plan), `0`/`""` sentinels instead of nullable fields, flattened progression step fields (`stepWeightKg`, `stepReps`, `stepDurationSec`, `everyWeeks`) and `profilePatch` as `[{field, value}]` pairs. `parseResponse` maps the wire shape back to the C2.1 record shapes, so nothing downstream changes.

### C2.2/C2.3 amendment 2 (3 Sep 2026) — the coach denied it could program legs/back/biceps in chat despite months of history: `buildDigest` only ever ranked the ≤12 most-trained rep-type exercises from the 8 weeks before the last session, and never sent the exercise library, so anything outside that narrow window looked to the model like it had never existed — compounded by `SYSTEM_PROMPT` literally telling it "Only exercises listed in exercises[] exist." Fix, in both files: `buildDigest` now adds `historyByGroup` on every kind — `{[group]: {sessions, last, top}}`, the WHOLE log, all time, unwindowed, keyed by muscle group (`historyByGroupOf`) — and `library` on kinds `plan`/`chat` only — the whole exercise library grouped by muscle group as compact `id|Name`/`id|Name|type` strings (`buildLibrary`, notes-type excluded). Kind `chat` now ranks `exercises[]` over 52 weeks (was 8) capped at 20 (was 12) — `DIGEST_WINDOW_WEEKS`/`DIGEST_EXERCISE_CAP` gain a `chat` entry — since a chat digest has no group top-up to fall back on. `DIGEST_MAX_BYTES` grows to `{daily: 4500, session: 4500, plan: 9000, chat: 9000}`; the shrink loop gains two levers after the existing ones (`chat.recent`→3, `memory`→10): drop every `historyByGroup[*].top` array, then — plan/chat only — drop `library` groups the profile has no `groupPrefs` interest in, largest first (`groupIsOfInterest`, shared with `extendPlanExercises`'s top-up); a `plan` digest never loses `library` entirely, `chat` may. `js/coach-api.js`: `exerciseTypes()` (the id→type map `parseResponse`/`cleanPlanExercise` use to validate a plan's `exerciseId`s) now also parses every `digest.library` entry, so a plan may target any library exercise, not just a recently-trained one. `SYSTEM_PROMPT`'s ROLE is rewritten from "reads this person's data" to a genuine multi-domain expert coach (hypertrophy, strength/powerlifting, conditioning, mobility, recovery, nutrition basics, physio-informed return-to-training) who answers from that expertise first and is not a clinician; the DATA CONVENTIONS section explains `historyByGroup`/`library`; "Only exercises listed in exercises[] exist" is replaced with "use `library` (or `exercises[]` when `library` is absent) for plan `exerciseId`s, but prose may name and recommend any exercise"; CHAT gains "never claim no history without checking `historyByGroup`, never skip a muscle group for lack of recent data." The prompt stays a frozen, digest-independent constant under 9000 chars throughout.
