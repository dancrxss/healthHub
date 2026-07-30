# Claude Instructions — Working Practices

This file is the source of truth for *how we work*. A separate living document
(e.g. `infrastructure-diagrams.md`) is the authoritative source for *what exists*.

## 0. Project initialisation — read this first on a new project

This repo starts from a template. The workflow is: the plan is drafted in Claude
chat, chat produces an **initial brief**, and that brief is handed to Claude Code
in this repo. When Claude receives the initial brief (or notices §10 below is still
the unfilled template), Claude must, as its first task:

1. **Read the brief and this whole file.**
2. **Fill in §10 (Project addendum)** with the project's specifics: what the product
   is, the stack, the source-of-truth documents, the deploy path, hosting, and any
   domain rules from the brief.
3. **Resolve conflicts explicitly in §10.** Where the brief's stack or constraints
   differ from the general conventions below (e.g. a static site with no backend,
   a different frontend framework, no hosted environment yet), the addendum states
   which general sections are overridden or dormant and why. The addendum is the
   only place overrides live — **never edit §§1–9 to fit a project.**
4. **Save the brief** into the repo (e.g. `BRIEF.md` or `PLAN.md`) and reference it
   from §10 as the authoritative build spec.
5. **Commit and push** the updated `CLAUDE.md` + brief before starting any build work.

As the project evolves (new stack decisions, first deploy, hosting chosen), keep
§10 current in the same session as the change — same rule as §2.3.

§§1–9 are Dan's general ways of working. They apply to every project and survive
every brief. If a brief appears to demand breaking one of the hard rules in §2,
ask before proceeding.

## 1. Source of truth

- Keep one authoritative document describing the running infrastructure (resources,
  jobs, data pipeline, external services, network, database schema, frontend
  architecture).
- Before starting any infrastructure, deployment, backend, or cross-cutting change,
  **read that document first** so the change lands consistent with the deployed topology.

## 2. Hard rules — every change must follow these

### 2.1 Do not break the live product

1. **Don't touch live data.** No destructive SQL, no schema drops, no deletes.
   Migrations are additive (add column/table, backfill, then later remove — never
   remove in the same migration that adds).
2. **Don't remove or rename public API routes** without a deprecation path. Clients
   depend on exact paths.
3. **Verify the product still works after the change.** At minimum: health endpoint
   returns 200, a core data endpoint returns real data, and the site loads with no
   console errors.
4. **Keep migrations safe.** Test migrations locally against a copy of the live
   schema before pushing — a broken migration on boot takes down the backend.
5. **Preserve usability.** Don't change a user-facing flow without confirming the
   replacement works end-to-end. When in doubt, ship behind a flag or ask.

### 2.2 Commit and push every logical change

After any change:

```bash
git add -A                 # or specific files — never commit .env, state files, or secrets
git status                 # sanity-check what's staged
git commit -m "<clear, imperative message>"
git push
```

Rules:

- **Never skip the push.** A local-only commit doesn't count as "done".
- **Never use `--force` / `--force-with-lease`** on `main` without an explicit ask.
- **Never commit secrets.** `.env`, IaC state/vars files, service accounts, API keys.
  If `git status` shows one staged, stop.
- **Never use `--no-verify`.** If a hook fails, fix the underlying issue.
- Short-lived feature branches merged into `main` via PR are fine; direct commits to
  `main` are acceptable for small, safe changes but still must be pushed.

### 2.3 Infrastructure changes always update the infrastructure doc — immediately, not later

The infrastructure doc must reflect what is **actually deployed right now**. It is
wrong if it doesn't match reality — if it describes something that doesn't exist, or
omits something that does.

Process — every step is mandatory:

1. Make the code/IaC change.
2. **Immediately after** (not in a follow-up, not "later"), update the relevant
   diagram(s) to match the new reality.
3. If the change affects cost, update the cost table.
4. Commit the doc in the same session that made the change.

If an infra change lands without the doc update, the task is not complete.

### 2.4 Post-deploy smoke check

After any deploy, before marking the task done: confirm the new revision/deployment
is active and healthy, hit the health endpoint, load the site. Report the results
back. If any step fails, **roll back and surface the failure** — do not leave prod
broken.

## 3. Standard workflows

- **CI is the deploy path.** Local tests must pass before pushing; pushing to `main`
  builds, deploys, and health-checks. Watch the run go green. Keep a manual deploy
  path for emergencies only — never run it alongside a green CI (two deployers racing
  is a known failure mode).
- **IaC changes:** format → validate → plan (read it carefully) → apply → update the
  infrastructure doc → commit. Never stage state or vars files.
- **After applying infra that was created to fix something, run it immediately.**
  Don't present it as a "next step" for the user. The rule: **if Claude can do it,
  Claude does it.** "Here's what you need to do next" is only acceptable when the
  step genuinely requires the user (credentials, a business decision, hardware/access
  Claude doesn't have).
- **Cache/service-worker versions:** if a frontend change alters an API
  request/response shape, a route path, or a cached asset pattern, bump the cache/SW
  version in the same commit. Pure UI/CSS changes don't need a bump.

## 4. Coding conventions

Defaults — a project's brief may override these in §10, never by editing this section:

- **Backend:** Python 3.12, FastAPI, SQLAlchemy 2.0 style, `async/await`, type hints
  everywhere, PEP 8. All DB access goes through a service layer — routers must not
  import SQLAlchemy directly. Error responses follow `{"detail": "message"}`.
- **Frontend:** React functional components only, named exports except for
  page-level defaults, Tailwind for styling, Zustand for global state, a single
  Axios client that attaches the auth token.
- **Shared UI components — keep a catalog (`COMPONENTS.md`).** Before building any UI
  pattern, read it. If the pattern exists, use it with its exact API. If it's flagged
  "not yet extracted", extract it into `shared/` in the same PR. If it's new, build it
  in `shared/` from day one and add a catalog entry in the same commit. Never inline
  a slightly-different copy of an existing pattern.
- **Tests:** at minimum one test per new service function and one per new router
  endpoint. E2E flows live in a dedicated repo/folder (Playwright).
- **Data ingestion:** respect rate limits, exponential backoff on 429/5xx. Upserts
  only — never delete.
- **Copy:** UK English, plain.

## 5. Secrets & environment

- All secrets live in platform-managed environment variables. Never hard-code them.
- Local `.env` files are gitignored and must stay that way.
- Legacy/unused keys: leave them be, don't add new uses.

## 6. Operational hygiene

### 6.1 Record every deploy in `DEPLOY_LOG.md`

One line per production-affecting deploy at the repo root:

```
2026-04-23 14:07 UTC · backend · <revision/sha> · "fix daily generator nil-check" · <who>
```

When prod misbehaves at 11pm, the fastest recovery path is "what changed and when".
CI history expires; this file doesn't. Append *after* the smoke check passes. If you
roll back, append a second entry noting the rollback and why.

### 6.2 Nothing runs locally unless there is no better option

**Default: everything runs in the hosted environment** (new, not-yet-hosted projects
excepted — note that in §10). Decision tree, in order:

1. Does a hosted job already exist for this? → trigger it.
2. Should this be repeatable? → add it to IaC, apply, then run it.
3. Is it a one-off that only calls the HTTP API (not the DB directly)? → a
   documented script in a dedicated `local/` repo, run from a laptop.
4. Can Claude do it directly via CLI or API? → Claude does it — no script needed.

Scripts that hit the database or scrape external sites must never run from a laptop:
laptops disconnect mid-job and leave data half-updated, and residential IPs get
banned. Local runs are acceptable only against a **local** database for debugging.

Claude recommends local-instead-of-executing only when the step needs interactive
input (passwords, 2FA, browser OAuth) — and then explains why, provides the exact
command, and saves the script to `local/` if it will be reused.

### 6.3 Database query hygiene

- **No `SELECT *`** in application code paths. Name columns explicitly.
- **Add an index before shipping a new "find by X" query** on any table > 10k rows.
  Check `EXPLAIN` against a realistic dataset.
- **No N+1 from routers.** Eager-load in the service layer; batch anything that
  loops over DB calls.
- **Always `LIMIT`** read queries backing list endpoints, even when the result
  "should" be small — defensive limits keep bad data states from taking the site down.

## 7. Delegating to subagents

**The orchestrating session runs on Fable.** Fable does the thinking — it pins the
contracts, makes the design decisions, reviews the diffs, verifies, commits and
pushes. **Default to delegating the typing — especially coding — to `opus` and
`sonnet` subagents** (the Agent tool, `subagent_type: general-purpose`, with
`model: opus` or `model: sonnet`). This parallelises the work and keeps the
orchestrator's context for judgement.

### 7.1 Which model

- **`opus`** — anything needing real reasoning inside the implementation: engines,
  maths, algorithms, migrations, test suites, tricky edge cases, or work where a
  design decision sits *inside* the code.
- **`sonnet`** — well-specified, simpler work: UI screens, styling, data files,
  scaffolding, mechanical refactors and extractions, applying a pattern that
  already exists.
- **Neither** — one-line edits, quick greps, or anything Fable would finish faster
  than the brief takes to write. Just do it directly.

### 7.2 How to brief an agent

1. **Pin the contract first.** Fable writes the shared types, interfaces and data
   files itself, and commits them, *before* spawning. Agents code against
   signatures; they never invent them.
2. **Give an exact file scope** — "create X and Y, edit Z, touch nothing else".
   Parallel agents must have disjoint file sets. Never let two agents edit one file.
3. **Say what a parallel agent owns**, so an error in someone else's file doesn't
   send yours off-scope chasing it.
4. **State the acceptance criteria** and require typecheck + tests to pass before
   reporting back.
5. **No git, no installs, no dev servers inside agents.** The orchestrator owns the
   repository: it reads the diff, runs the full suite, commits and pushes.

### 7.3 Verify, don't trust

An agent reporting "all green" is a claim, not evidence. Re-run typecheck, lint,
tests and build in the orchestrator, and read the diff of anything load-bearing
before committing.

### 7.4 When an agent dies

Agents fail — session limits, stalls, watchdogs. **Check what landed on disk before
retrying**: a killed agent has often already written complete, working files, and a
blind retry duplicates or clobbers them. Re-brief only the gap. If the work is
blocking and retries are exhausted, finish it inline and note that in the progress
doc.

## 8. When unsure

If a request could plausibly touch production data, change a public API route, alter
auth flow, remove a job, modify a migration's downgrade path, or increase hosting
cost by more than a few pence a day — **ask the user before doing it**. It's always
cheaper to clarify than to recover.

## 9. Keeping this file honest

- §§1–9 change only when Dan explicitly changes his ways of working — never to
  accommodate a single project.
- §10 changes freely and often: initial brief, stack decisions, first deploy, new
  domain rules. Update it in the same session as the change it describes.
- If §10 and a brief/plan document disagree, flag it and ask — don't silently pick one.

## 10. Project addendum — Gym Tracker (healthHub)

*Filled in 21 July 2026 from the initial brief.*

- **Product:** A personal gym workout tracker for a single user (Dan) — an
  offline-first PWA replacing RepCount, prioritising a ≤2-tap repeat-set logging
  flow with an auto rest timer. Dan owns all the data (local-first, later
  Azure-synced), and the derived query layer is designed as a frozen contract for
  a future MCP server so Claude can read training data directly. It is **not** a
  multi-user product, a social/coaching app, a wearable integration (P2 wishlist
  only), or a native App Store app.
- **Authoritative build spec:** `gym-tracker-spec.md` (the spec), with
  `gym-tracker-claude-code-handoff.md` defining Phase 1 session scope. **Where
  they conflict, the spec wins** (per the handoff itself). `PLAN.md` is the
  Phase 1 implementation plan derived from both. **UI structure exception
  (22 Jul 2026):** Dan supplied RepCount reference screenshots
  (`sample_screenshots/`) and asked for the UI to be reworked to that
  structure — per-exercise set-grid cards, category-based picker, supersets,
  and Strength+Cardio exercise types.
  For screen flow/layout the screenshots + `PLAN.md` §“Phase 1.5” now win over
  the spec; all domain rules below still stand (cardio sets are additionally
  excluded from PR/volume calcs, alongside warmups).
  **Navigation since:** the tab bar went from 4 tabs to **Log + Statistics**
  with a settings gear on every header (29 Jul 2026), then lost Routines
  (30 Jul 2026) — routines are created from a workout's ⋯ menu (“Save as
  Routine”) and re-used via **Copy Routine** on the workout screen, which also
  copies the skeleton of any previous session. Nothing is seeded: the routine
  library starts empty and is Dan's to fill.
- **Stack:** Vanilla JS, no framework, no build step; single-file or
  near-single-file HTML PWA with IndexedDB as the local source of truth (same
  pattern as Odds IQ). No external runtime dependencies in the PWA. A standalone
  Node script (`import-repcount.js`) for the one-off RepCount CSV import may use
  Node built-ins plus a CSV parser. Future sync target: Azure Table Storage
  (Phase 2 — interface stubbed now, no Azure resources provisioned).
- **Source-of-truth docs:** No infrastructure doc yet — nothing is deployed and
  no cloud resources exist. When Azure sync lands (Phase 2), create the infra doc
  in that same session. No component catalog — vanilla JS single-file app, no
  shared component library (§4's `COMPONENTS.md` rule dormant).
- **Deploy path:** **GitHub Pages** serves the repo root of `main` at
  https://dancrxss.github.io/healthHub/ — every push to `main` auto-deploys
  (the repo was made **public** on 21 July 2026 to enable this on the free
  plan). No CI gate: run `node tests/calc.test.mjs` and `./tests/e2e.sh`
  locally before pushing, and smoke-check the live URL after (§2.4).
  `DEPLOY_LOG.md` records production-affecting deploys.
- **Hosted vs local:** The PWA is hosted on GitHub Pages but inherently
  local-first — all data lives in on-device IndexedDB; there is no backend.
  The import script is explicitly a one-off local run (no live DB, no
  scraping). §6.2's "everything hosted" rule is satisfied by the static host.
- **Domain rules (must not change silently):**
  - All weights stored in **kg** (numeric). Display units are a client concern.
  - Derived query layer is a **frozen contract** for the future MCP server:
    `getLastSession`, `getRecentWorkouts`, `getPRs`, `getWeeklyVolume`,
    `getTrainingFrequency` — exact names and signatures per the spec; never
    change without flagging it first.
  - Warmup sets (`isWarmup`) are **excluded** from PR and volume calculations.
  - 1RM estimate uses Epley: `w × (1 + reps/30)`.
  - Everything beyond Exercise / Workout / Set / Template is **derived, never
    stored**.
  - Azure Table Storage partition/row key scheme is fixed per the spec's mapping
    table.
  - Logging flow acceptance criteria (spec §"Acceptance criteria") are the
    make-or-break; ≤2 taps for a repeat set.
  - UK English, plain copy. Mobile-first, one-handed use, big touch targets.
  - Import is idempotent; upserts only, never delete (per §4 data rules).
- **Overrides & dormant sections:**
  - **§4 backend conventions (Python/FastAPI/SQLAlchemy) — dormant.** No backend
    in Phase 1. The import script follows the spirit (typed, small, tested).
  - **§4 frontend conventions (React/Tailwind/Zustand/Axios) — overridden** by
    the brief's vanilla-JS/no-build constraint.
  - **§4 shared-components catalog — dormant** (no component framework).
  - **§4 test rule — adapted:** no test framework per the handoff; plain
    assertion scripts for the data + query layers instead.
  - **§3 CI-is-the-deploy-path — dormant** until there is a deploy target.
  - **§6.1 DEPLOY_LOG.md — dormant** until the first production-affecting deploy.
  - **§6.3 database query hygiene — dormant** (IndexedDB, no SQL); its intent
    (bounded reads, no accidental full scans in hot paths) still applies.
  - **§2.1 "live product" rules** apply from the moment real workout data exists
    on Dan's phone: IndexedDB migrations must be additive and never destructive.
  - **Out of scope this phase** (per handoff): MCP server code, Azure
    provisioning/deploy, auth, multi-user, wearables, templates CRUD UI.
