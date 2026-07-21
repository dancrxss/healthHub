# Gym Tracker — Specification v0.1

**Owner:** Dan
**Status:** Draft for Claude Code handoff
**Date:** 20 July 2026

---

## Problem statement

Dan currently tracks gym workouts in RepCount, which is excellent for logging but locks data export/integration behind a monthly subscription. He wants his training data available to Claude directly (for morning briefs and analysis), with full ownership of the data and the ability to extend functionality beyond what RepCount offers.

## Goals

1. Log a set in ≤2 taps mid-workout, matching or beating RepCount's logging speed.
2. Own all workout data in a queryable store Dan controls (local-first, Azure-synced).
3. Design the data and query layer so a future MCP server can expose it to Claude with zero schema changes.
4. Import full RepCount history via one-off CSV migration so no training history is lost.

## Non-goals (v1)

- **MCP server implementation.** The Azure MCP platform is still being built. This spec defines the query layer the MCP server will later sit on, but no MCP code is in scope. *(Deferred — Dan will signal when the platform is ready.)*
- **Multi-user support.** Single user, no auth flows beyond a SAS token / function key. Keeps the build to a weekend, not a month.
- **Social features, coaching content, exercise video libraries.** Not the point of the app.
- **Wearable integration.** On the wishlist (ties into Dan's broader connector plans) but a separate initiative — noted as P2 so the schema doesn't preclude it.
- **Native app / App Store distribution.** PWA installed to home screen, same as Odds IQ.

---

## Architecture summary

- **Client:** Offline-first PWA. Vanilla JS, single-file or near-single-file HTML, IndexedDB as the local source of truth. Same pattern as Odds IQ.
- **Sync:** Background sync to Azure Table Storage via a thin adapter. Last-write-wins is acceptable (single user, single primary device). The sync adapter is an interface from day one so local-only mode works before any Azure resources exist.
- **Azure:** Table Storage (pennies/month for one user), in Dan's separate subscription alongside the MCP platform. Optionally fronted by a small Function App; direct writes with a scoped SAS token are acceptable for v1.
- **Units:** All weights stored in **kg** (numeric). Display-unit preference is a client concern, not a storage concern.

---

## Data model

Three core entities plus templates. Everything else (PRs, volume, trends) is **derived, never stored**.

### Exercise

| Field | Type | Notes |
|---|---|---|
| `id` | string (uuid) | |
| `name` | string | e.g. "Barbell Bench Press" |
| `muscleGroup` | enum | chest, back, legs, shoulders, arms, core, other |
| `equipment` | enum | barbell, dumbbell, machine, cable, bodyweight, other |
| `isCustom` | boolean | seed library vs user-created |
| `createdAt` | ISO datetime | |

### Workout

| Field | Type | Notes |
|---|---|---|
| `id` | string (uuid) | |
| `date` | ISO date | the training day |
| `startedAt` / `finishedAt` | ISO datetime | `finishedAt` null while in progress |
| `templateId` | string, nullable | if started from a template |
| `notes` | string, nullable | |

### Set

| Field | Type | Notes |
|---|---|---|
| `id` | string (uuid) | |
| `workoutId` | string | FK |
| `exerciseId` | string | FK |
| `setNumber` | int | order within exercise within workout |
| `weightKg` | number | 0 for pure bodyweight; added load for weighted bodyweight |
| `reps` | int | |
| `rpe` | number 6–10, nullable | optional per set |
| `isWarmup` | boolean | excluded from PR/volume calcs |
| `completedAt` | ISO datetime | drives auto rest timer |

### Template

| Field | Type | Notes |
|---|---|---|
| `id` | string (uuid) | |
| `name` | string | e.g. "Push Day A" |
| `entries` | ordered array | `{ exerciseId, targetSets, targetRepsLow, targetRepsHigh }` |

### Azure Table Storage mapping

| Table | PartitionKey | RowKey | Rationale |
|---|---|---|---|
| `exercises` | `"exercise"` | `id` | tiny table, single partition fine |
| `workouts` | `yyyy-MM` of `date` | `id` | month-range queries are the common read |
| `sets` | `workoutId` | `setNumber` zero-padded + `id` suffix | fetch all sets for a workout in one partition query |
| `templates` | `"template"` | `id` | |

Client entities serialise 1:1 into table entities; `entries` on templates is JSON-stringified. A `syncedAt` timestamp on each local record drives delta sync.

---

## Derived query layer

This is the contract the future MCP tools will call. Implement as pure functions over the data (client-side for the app; the MCP server later reimplements or shares them server-side).

| Query | Signature | Definition |
|---|---|---|
| Last session for exercise | `getLastSession(exerciseId)` | most recent workout containing that exercise, with its sets — shown inline while logging ("what to beat") |
| Recent workouts | `getRecentWorkouts(sinceDate)` | workouts + sets, newest first |
| PRs | `getPRs(exerciseId)` | best weight at each rep count 1–10, plus best estimated 1RM (Epley: `w × (1 + reps/30)`), warmups excluded |
| Weekly volume | `getWeeklyVolume(weeks)` | Σ(weight × reps) per muscle group per ISO week, warmups excluded |
| Frequency | `getTrainingFrequency(weeks)` | sessions per week, per muscle group |

## Requirements

### P0 — cannot ship without

- [ ] Seed exercise library (~50 common lifts) + create custom exercise
- [ ] Start empty workout or start from template
- [ ] Log a set: previous session's weight/reps pre-filled, adjust with steppers, one tap to confirm — **≤2 taps for a repeat set**
- [ ] Rest timer auto-starts on set completion; configurable default; visible countdown
- [ ] Last session's numbers for the current exercise visible while logging
- [ ] Edit/delete sets and workouts
- [ ] Fully functional offline; installable PWA
- [ ] Sync adapter interface with (a) no-op local mode and (b) Azure Table Storage mode
- [ ] RepCount CSV import script (one-off, run locally; map columns → this schema; idempotent)

### P1 — fast follows

- [ ] Templates CRUD (P0 only needs consuming a hand-seeded template)
- [ ] PR detection with in-workout "new PR" flag
- [ ] Volume/frequency charts (simple, no charting library if avoidable)
- [ ] Plate calculator (kg plates, configurable bar weight)
- [ ] JSON/CSV export of everything (data ownership is the point)

### P2 — architectural insurance

- [ ] MCP server exposing the derived query layer (`get_recent_workouts`, `get_prs`, `get_weekly_volume`, `get_last_session`) — pending Azure MCP platform
- [ ] Wearable/health data ingestion alongside workout data
- [ ] Multi-device conflict handling beyond last-write-wins

## Acceptance criteria — logging flow (the make-or-break)

- Given an exercise with a previous session, when Dan opens it in today's workout, then the previous session's sets are displayed and the input is pre-filled with the last top set.
- Given pre-filled values match what Dan lifted, when he taps confirm, then the set is saved and the rest timer starts — one tap total.
- Given no connectivity, when a set is logged, then it persists locally and syncs when connectivity returns, with no user-visible error.
- Given a warmup toggle is on, when the set is saved, then it is excluded from PR and volume calculations.

## Open questions (Dan to answer — none block starting)

1. **RPE:** track it, or is weight × reps enough? (Field is nullable either way; affects whether the logging UI shows it.)
2. **RepCount export format:** exact CSV columns unknown until the export is pulled — import script should be written against a sample file. Worth grabbing the export early (may need one month's subscription).
3. **Direct SAS-token writes vs a Function App in front of Table Storage:** SAS is simpler; Function App gives a cleaner seam for the MCP server to share later. Lean Function App if the MCP platform will want server-side query functions anyway.
4. **Bodyweight movements:** is `weightKg = added load` (0 for strict bodyweight) acceptable for pull-ups/dips, or should estimated bodyweight be factored into volume?

## Timeline considerations

- Odds IQ PL conversion has a hard 21 August 2026 deadline — this project must not compete with it. Phase 1 (data layer + logging PWA core) is scoped as roughly a weekend of Claude Code work.
- MCP phase is gated on Dan's Azure MCP platform build; no date. Schema and query layer above are frozen as its contract.
