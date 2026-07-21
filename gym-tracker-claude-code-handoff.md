# Claude Code Handoff — Gym Tracker Phase 1

Drop this file and `gym-tracker-spec.md` into a fresh repo, then point Claude Code at this prompt.

---

## Prompt

You are building **Phase 1 of a personal gym workout tracker** for a single user (Dan). The full specification is in `gym-tracker-spec.md` in this repo — read it in full before writing any code. It is the source of truth; where this prompt and the spec conflict, the spec wins.

### Scope for this session

Build, in order:

1. **Data layer** — IndexedDB schema for Exercise, Workout, Set, Template exactly as specified. Wrap in a small repository module (plain functions, no framework).
2. **Derived query layer** — implement `getLastSession`, `getRecentWorkouts`, `getPRs`, `getWeeklyVolume`, `getTrainingFrequency` as pure functions per the spec's definitions table. These are a frozen contract for a future MCP server: name them exactly as specified and do not change their signatures without flagging it.
3. **Sync adapter interface** — define the interface and implement the **no-op local adapter only**. Stub the Azure Table Storage adapter behind the same interface with the partition/row key scheme from the spec, but do not wire any Azure resources (that infra doesn't exist yet).
4. **Logging UI** — the P0 checklist in the spec, prioritising the ≤2-tap repeat-set flow and the auto rest timer. Offline-first PWA: manifest, service worker, installable.
5. **Seed data** — ~50 common exercises covering all muscle groups and equipment types.
6. **Import script scaffold** — a standalone Node script `import-repcount.js` that takes a CSV path, with the column mapping isolated in one clearly-marked function (the real RepCount export format is unknown; write it against a plausible sample and make the mapping trivial to correct).

### Explicitly out of scope

- Any MCP server code (Phase 2, gated on separate Azure MCP platform work)
- Azure resource provisioning or deployment
- Auth, multi-user, wearable data
- Templates CRUD UI (consuming a hand-seeded template is enough)

### Technical constraints

- Vanilla JS, no framework, no build step. Single-file or near-single-file HTML, matching the owner's existing Odds IQ PWA pattern.
- No external runtime dependencies in the PWA. The import script may use Node built-ins plus a CSV parser if needed.
- All weights in kg internally. British English in all UI copy.
- Mobile-first: this is used one-handed, mid-set, with sweaty thumbs. Big touch targets, high contrast, minimal chrome.

### Working method

1. Start by producing a short written plan (file layout, module boundaries, UI screen list) and pause for review before implementing.
2. Implement the data + query layers first with a handful of unit-style assertions (a plain test HTML page or Node script is fine — no test framework).
3. Then the UI, screen by screen: Workout in progress → Exercise logging → History → Exercise picker.
4. After each milestone, state what was built, what's untested, and what you'd do next.

### Definition of done for this session

- Installable PWA that works fully offline
- A complete workout can be logged start to finish, meeting the acceptance criteria in the spec's logging-flow section
- Query layer passes assertions against seeded sample data
- Import script scaffold runs against a sample CSV
- README covering: local dev, where the sync adapter seam is, and what Phase 2 (Azure sync, MCP) will plug into
