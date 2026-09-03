# App Store submission checklist — Gym Tracker

Reference: `PLAN.md` § "Phase N — Native iOS shell + Apple Health" (the pinned
build contract) and `CLAUDE.md` §10. This file tracks what's already done in
the repo versus what only Dan can do (Apple accounts, signing, hardware,
human decisions on App Store Connect).

## Done in-repo

- Capacitor shell: `package.json`, `capacitor.config.json`,
  `scripts/build-www.mjs`, generated `ios/` project (appId
  `com.dancross.gymtracker`, appName "Gym Tracker").
- `js/health.js` bridge + Swift `HealthKit` CAPPlugin wired into the Xcode
  project, including background delivery.
- Purpose strings (`NSHealthShareUsageDescription`,
  `NSHealthUpdateUsageDescription`) and HealthKit entitlements set in the
  Xcode project.
- Settings → Apple Health section (connect/status/sync/write-toggle/
  disconnect) and Stats → Health section, both hidden entirely when not
  running natively — the GitHub Pages PWA is unchanged.
- `privacy.html` — the App Store privacy policy page, live at
  `https://dancrxss.github.io/healthHub/privacy.html`.
- **Native build verified (31 Jul 2026, Xcode 26.6 / iOS 26.5 SDK):**
  `node scripts/build-www.mjs && npx cap sync ios` then a simulator
  `xcodebuild` compiles with zero warnings or errors. Smoke-tested in the
  iPhone 17 Pro simulator: app launches, Log/Statistics UI renders, and the
  webview registers the HealthKit plugin (`To Native -> HealthKit
  addListener`) with no JS errors. SPM pin committed
  (`Package.resolved`, capacitor-swift-pm 7.6.8).

## Steps only Dan can do

These need Apple credentials, a Mac with Xcode, and human sign-off — none of
it can be scripted from here.

1. ~~**Install Xcode**~~ — done 31 Jul 2026 (Xcode 26.6, iOS platform
   component installed; simulator build + smoke test pass, see above).
2. **Enrol in the Apple Developer Programme** — £79/year, at
   https://developer.apple.com/programs/enroll/. Required before a device
   build can be signed or before App Store Connect will accept an app.
3. **Open the generated Xcode project** (the `www/` build + sync already
   run and verified; re-run if the web code has changed since):
   ```
   node scripts/build-www.mjs && npx cap sync ios
   open ios/App/App.xcodeproj
   ```
4. **In Xcode**, select the `App` target → Signing & Capabilities:
   - Set the Team to your enrolled Apple Developer account.
   - Confirm "Automatically manage signing" resolves without errors.
   - Verify the **HealthKit** capability is present, and that **Background
     Modes → Background fetch / Background processing** (whichever
     `startSync`'s background delivery relies on) is checked.
5. **Build to your iPhone** (plug it in, select it as the run destination,
   hit Run) and smoke-test the flow: Settings → Connect Apple Health → grant
   the HealthKit sheet → Sync now → Stats screen shows real data → finish a
   workout and confirm it appears in the Health app.
6. **App Store Connect** (https://appstoreconnect.apple.com):
   - Create the app record: bundle ID `com.dancross.gymtracker`, name "Gym
     Tracker".
   - **App Privacy** questionnaire (revised 3 Sep 2026 for the Coach): the
     developer collects **nothing** — there is no server. But the optional
     AI Coach, once the user enters their own Anthropic API key, sends a
     derived summary of the user's gym data (and, only behind a second
     explicit opt-in, four derived Apple Health values) straight from the
     device to Anthropic under the user's own account. Apple's form has no
     clean box for "user-supplied third-party key", so the honest mapping
     is: declare **Fitness** (and **Health & Fitness → Health** if the
     recovery toggle ships) as *Data Not Linked to You*, *Not Used for
     Tracking*, purpose *App Functionality*; keep everything else as "not
     collected"; and explain the architecture in the review notes. Re-confirm
     these answers with the Coach enabled before each submission.
     (`privacy.html` §"AI Coach (optional)" is the wording to lean on.)
   - **Privacy Policy URL**: `https://dancrxss.github.io/healthHub/privacy.html`.
   - Add screenshots (required sizes per device class Apple lists in the
     listing form).
   - Upload a build via Xcode (Product → Archive → Distribute App → App Store
     Connect) or `xcodebuild`/Transporter if you prefer the command line.
   - Add the build to **TestFlight** first and test on-device before
     submitting for review.
   - **Submit for review** with a reviewer note along the lines of: "HealthKit
     is used read/write, entirely on-device — no server, no account, no data
     collection by the developer. Read data (workouts, heart rate, HRV,
     weight, sleep, VO₂max, active energy) populates the in-app Statistics
     screen; write access saves the user's own finished gym sessions back to
     Health when they opt in via a Settings toggle. The optional AI Coach is
     off until the user enters their own Anthropic API key; it then sends a
     derived summary of the user's gym data directly to Anthropic's API under
     the user's own account. Health data is never included unless the user
     separately enables 'Share recovery data with coach' (default off), and
     even then only four derived values (sleep hours, HRV, resting HR,
     weight trend) — never raw samples. The developer operates no server and
     receives nothing (guideline 5.1.3 / 5.1.1(iii))."

## Notes

- No CI gate for this native path (per `CLAUDE.md` §10 override) — run
  `node tests/calc.test.mjs` and `./tests/e2e.sh` before any submission,
  same as for a normal Pages deploy.
- The web PWA at https://dancrxss.github.io/healthHub/ is unaffected by any
  of the above; it keeps deploying from `main` as before.
