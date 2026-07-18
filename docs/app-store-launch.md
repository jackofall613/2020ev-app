# App Store Launch Runbook

> Goal: move 2020EV from TestFlight (build #19, internal testers) to a public
> App Store release, as a single multi-building app.
> Created 2026-07-11. Companion to [multi-tenancy-plan.md](multi-tenancy-plan.md).

## Why one app (not one per building)

Multi-tenancy shipped 2026-07-05: one shared API, `building_id` scoping on every
tenant query, and login resolves the user's building server-side (email is
globally unique → one login → one building; JWT carries `buildingId`;
`resolveBuilding` never trusts a client-supplied building). So a single App
Store binary serves every building with hard isolation — no building picker, no
per-building bundle IDs, no N× App Review. `EXPO_PUBLIC_API_URL` stays pointed
at the shared Railway API.

Product consequence to be aware of: one email = one building. A person cannot
belong to two buildings with the same email address.

## Already in place

- ASC app record exists: `ascAppId 6761398358`, team `PP8G4AYQ66`, bundle
  `com.2020ev.app` (apps/mobile/eas.json)
- `production` build profile + submit config in eas.json
- `ITSAppUsesNonExemptEncryption: false` + photo-library usage string (app.json)
- Hosted Privacy Policy — https://2020ev-admin.vercel.app/privacy
- Hosted Terms of Service — https://2020ev-admin.vercel.app/terms
- Hosted Support page — https://2020ev-admin.vercel.app/support
- Store listing as code — apps/mobile/store.config.json (EAS Metadata).
  **Pushed to ASC 2026-07-12**: title, subtitle (≤30 chars), description,
  keywords, categories, URLs, localized info — all live in the draft. The
  `advisory` age-rating block was **removed** after `metadata:push` failed on it:
  the cached eas-cli sends Apple the deprecated `gamblingAndContests` attribute,
  which ASC's API rejects (`unknown attribute 'gamblingAndContests'`). Age rating
  is therefore set **manually in ASC** (all None → 4+) — see checklist. (Alt fix
  if you want it automated later: upgrade eas-cli to a build that sends the split
  gambling/contests attributes.) App Review Information (contact phone, demo
  login, reviewer notes) is also **excluded** from this file — credential +
  personal phone — entered directly in ASC (paste-ready notes below).
- Demo building for App Review seeded in prod (2026-07-12): building
  "The Palm Residences (Demo)", reviewer login `<demo-login-redacted>`
  (password shared with Jordan in-session, NOT stored in git). Seeded with
  wallet balance + charging history + feed posts.
- App Store screenshots prepped: `~/Downloads/2020ev-appstore-screenshots/`
  (`01-home`…`04-feed`, 1290×2796 / 6.9"). Upload manually in ASC.
- Production build #20 kicked off on EAS 2026-07-12 (buildNumber auto-bumped
  19→20; reused stored distribution cert, no Apple login needed for the build).
  **Superseded 2026-07-13 by build #21** (adds the Wallet "⬆ Export" report
  download + "Forgot password?" on the login screen) — attach **#21** in ASC,
  not #20.
- Account deletion in-app (App Store guideline 5.1.1(v)) — `DELETE /users/me`
- Invite-only registration, 12-char password minimum, rate-limited auth,
  refresh-token rotation/revocation
- No third-party/social login → "Sign in with Apple" is NOT required (4.8
  applies only when third-party login is offered)
- No in-app payments and none needed: the wallet is a bookkeeping ledger for a
  physical service (electricity); top-ups happen offline (guideline 3.1.5(a))

## ⚠️ Apple authentication (the one thing that can't be automated headless)

`eas metadata:push` and `eas submit` both require interactive **Apple Developer
login (Apple ID + 2FA)** — they cannot run in a non-interactive/agent session.
`eas build` is the exception: it reuses the distribution cert already stored on
EAS, so it runs headless. Two ways to get the Apple-authenticated steps done:

1. **Interactive (simplest):** Jordan runs the commands in his own terminal and
   completes the Apple login + 2FA prompt when asked (see commands below).
2. **ASC API key (unattended):** create a key in App Store Connect → Users and
   Access → Integrations → App Store Connect API, then export
   `EXPO_ASC_API_KEY_PATH` / `EXPO_ASC_KEY_ID` / `EXPO_ASC_ISSUER_ID` before
   running eas. Enables fully non-interactive metadata:push + submit. The key is
   a secret — keep it out of git.

## Pre-submission checklist

- [x] **App Review demo account** — DONE 2026-07-12. Building "The Palm
  Residences (Demo)"; reviewer login `<demo-login-redacted>`
  (password with Jordan, not in git). Seeded with balance/history/feed. The demo
  building has no ChargePoint config, so its Live Charger shows unavailable —
  the reviewer notes explain this.
- [x] **Screenshots** — DONE 2026-07-12, from Jordan's real device (live
  charger + real history — better than the demo building). Staged at
  `~/Downloads/2020ev-appstore-screenshots/` (`01-home`…`04-feed`, 6.9").
- [ ] **Age rating** — set manually in ASC (App → Age Rating → Edit): answer
  every category **None / No** → **4+**. (Could not be pushed via metadata — see
  the store.config.json note above re: the eas-cli `gamblingAndContests` bug.)
- [ ] **Verify `support@2020ev.app` receives mail** — Jordan bought 2020ev.app
  (Squarespace) 2026-07-12; set up forwarding support@ → Gmail and send a test.
- [ ] **App Privacy "nutrition labels"** in ASC (source: the privacy policy) —
  must be entered in ASC by hand (not covered by EAS Metadata):
  | ASC category | What we collect | Linked to identity | Tracking |
  |---|---|---|---|
  | Contact Info → Name, Email | account details | Yes | No |
  | User Content → Photos; Other | profile photo; feed posts | Yes | No |
  | Identifiers → User ID, Device ID | account id; Expo push token | Yes | No |
  | Financial Info → Other | wallet balance + charging cost history | Yes | No |
  - No analytics/ads SDKs; answer "No" to tracking.
- [ ] **App Review Information** in ASC: tick "Sign-in required", enter the demo
  login above + a contact phone, and paste the reviewer notes (below).

### Paste-ready App Review notes (ASC → App Review Information → Notes)

> 2020EV is a private, invite-only app for residents of buildings that share an
> EV charger. There is no public signup by design — residents join via an
> invitation from their building administrator, which is why a demo account is
> provided. The in-app "wallet" is a bookkeeping ledger of each resident's share
> of the building's electricity cost; the app contains no payment functionality,
> holds no funds, and sells no digital content (top-ups are handled offline by
> the building administrator), so no in-app purchases are used. The demo
> building has no physical charger connected, so the "Live Charger" screen shows
> as unavailable — this is expected for the demo only.

## Build + submit

Build #20 was started headless on EAS 2026-07-12. The remaining two commands
need interactive Apple login (see the Apple-authentication section above) — run
them in a normal terminal:

```bash
cd /Users/jordanneustadter/2020ev/apps/mobile
npx eas-cli metadata:push                               # pushes the listing (Apple login)
# build #20 already running; if you need a fresh one:
# npx eas-cli build --platform ios --profile production  # bumps buildNumber (headless, cached cert)
npx eas-cli submit --platform ios --latest              # uploads to Apple (Apple login)
```

Then in App Store Connect: version 1.0.0 → attach the build → confirm review
notes + demo account → **Submit for Review**. Release is set to manual
(`automaticRelease: false` in store.config.json) — release the build yourself
after approval.

## Likely review questions (and our answers)

- **"App is for a limited audience" (4.2 / business-app pushback):** 2020EV is
  a multi-building platform any building can join — not an internal tool for
  one company. If Apple still balks at public listing, the fallback is
  **Unlisted App Distribution** (public App Store infrastructure, link-only
  discovery, no TestFlight expiry) — request via Apple's unlisted-app form.
- **"Wallet" scrutiny:** review notes in store.config.json already explain it's
  a ledger, no funds held, no payment functionality, no IAP required.
- **Login wall (2.1):** demo account provided; invite-only is by design
  (private residential communities).

## After approval

- Residents install from the App Store; same bundle ID, so the store build
  supersedes TestFlight — no data migration (tokens live server-side).
- TestFlight + the quarterly rebuild workflow
  (.github/workflows/testflight-rebuild.yml) can stay as the beta channel, or
  be retired once the store build is the norm. TestFlight's 90-day expiry no
  longer matters for residents.
- Bump `version` in app.json for each subsequent release (buildNumber
  auto-increments).

## Deferred hardening (post-launch, tracked in next-session-brief.md)

- Per-account login lockout (current rate limit is per-IP, in-memory).
- RLS backstop: switch the API off the `postgres` superuser role, then enable
  `apps/api/src/db/rls.sql` (see [rls-backstop.md](rls-backstop.md)).
- LLC + Apple Developer **organization** account: the listing currently shows
  the individual developer name. For selling to buildings, migrate the Apple
  account to the LLC (needs D-U-N-S) — decide before marketing widely.

## Open decisions

- **Auth provider:** stays on the in-house JWT system (just hardened, tightly
  coupled to placeholder users / invites / impersonation). A managed provider
  (e.g. Clerk) was considered 2026-07-11 and deliberately not adopted — see
  CLAUDE.md session log. Revisit only if SSO/MFA demands appear.
- **Branding:** app name "2020EV" is derived from the first building's address.
  Fine for launch; consider a neutral product name before pitching widely
  (renaming later is allowed but changes the App Store listing).
