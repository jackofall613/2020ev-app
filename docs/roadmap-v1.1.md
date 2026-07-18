# 2020EV v1.1 — Feature Spec (the "killer" features)

> Status: **ALL THREE FEATURES SHIPPED 2026-07-14** (branch `feature/v1.1-queue`
> → PR #1; API tag `2026-07-14-v19-v1.1`; mobile ships in EAS build #22).
> Implementation notes/deviations are recorded in CLAUDE.md ("Shipped
> 2026-07-14" entries) and README §0. Notable deviations from this spec:
> socket broadcasts go to per-building rooms (`building:<id>`) instead of the
> global `charger_room` (cross-tenant leak); session-start is blocked for
> everyone but the hold-holder while an offer is live; `claim` does NOT resolve
> the entry (it sets `claimed_at` + extends the hold — resolving would let the
> engine re-offer the charger while the claimer walks down; plug-in resolves);
> the idle fee meters prospectively via `idle_fee_billed_through` rather than
> counting blocks since grace-end (the spec formula would retro-bill gated time).
>
> Original spec below, kept for reference. v1.0 was submitted to the App Store
> on 2026-07-15 (build #21).
>
> Source of the ideas: a competitor + user-pain research pass (2026-07-13)
> across ChargePoint Waitlist, AmpUp, EVmatch, and Reddit/HOA EV-charging
> threads. The through-line: for a building sharing **one** charger, the loudest
> real-world pain is **plug-hogging** and **"whose turn is it / who's next."**
> Priority days answer "whose day is it"; these features answer "who's next
> right now" and "your car is done, please move it."

---

## The three features, in recommended build order

1. **Next Up — a live charger queue** (biggest impact; the headline feature)
2. **Queue-aware anti-camping escalation** (small — mostly extends code that
   already exists in `chargerWatch.ts`)
3. **Car profiles + "free in ~1h 40m" finish-time ETA** (small; makes 1 & 2
   smarter and is a nice standalone)

Ship them in this order because 2 and 3 both reference the queue from 1.

---

## Where this plugs into existing code (READ FIRST)

The building already has most of the plumbing. Do **not** rebuild these:

- **`apps/api/src/services/chargerWatch.ts`** — a background job already runs
  every 5 minutes over each building's active session and fires at-most-once
  push nudges on three triggers: (1) estimated finish time passed, (2) charger
  `IN_USE` but drawing `< 0.5 kW` ("car looks done"), (3) over a 6-hour hard
  cap (also notifies admins). De-dupe flags live on the `sessions` row
  (`estimated_reminder_at`, `idle_reminder_at`, `cap_reminder_at`). **Feature 2
  is largely already here** — the work is making it queue-aware.
- **`chargerWatch.notifyNextResident(buildingId, endedByUserId)`** — already
  called from `POST /sessions` end-flow; today it pings the resident whose
  `priority_day` is today (weekdays only). This is the seed the real queue
  replaces/extends.
- **`apps/api/src/services/notifications.ts`** — `notifyUser`,
  `notifyBuildingMembers(buildingId, excludeUserId, …)`, `notifyAdmins`. All
  fire-and-forget Expo push; reuse them.
- **socket.io** — `io` is set up in `index.ts`; residents join `charger_room`.
  Currently almost no events are emitted. The queue is the first good use:
  broadcast queue changes so open apps update live.
- **`GET /chargepoint/load`** + `getCurrentLoad`, `getStationStatus`,
  `getBuildingCpConfig` (in `services/chargepoint.ts`) — live kW draw and
  charger status, per building. Feature 3's ETA and feature 2's "done" check
  read these.
- **Sessions**: `sessions` table — `id, user_id, building_id, type, status
  ('active'|'completed'|'cancelled'), started_at, estimated_end, actual_end,
  notes` + the reminder flags above. `HomeScreen.tsx` / `SessionScreen.tsx`
  render status; `SessionScreen` starts a session ("Plug In & Announce").
- **Migrations**: idempotent blocks in `runMigrations()` in `index.ts`; latest
  is **Migration 015**. Add new tables/columns as Migration 016+ following the
  same `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` pattern, each
  in its own try/catch.
- **Everything is building-scoped**: every tenant query filters by
  `req.buildingId` (set server-side by `resolveBuilding`). New tables get a
  `building_id UUID NOT NULL REFERENCES buildings(id)` column and every query
  filters by it. Add cross-building coverage to
  `apps/api/src/__tests__/isolation.test.ts`.
- **Mobile ships via EAS**: any mobile change needs a new build (`eas build
  --profile production`) → next buildNumber. These features are all mobile +
  API, so plan on build #22.

---

## Feature 1 — "Next Up": a live charger queue

### Pitch
When the charger is busy, a resident taps **Join queue**. The moment it frees,
the person at the front gets a push — "Charger's free, held for you 15 min" —
with **On my way** / **Pass** buttons. If they pass or time out, it advances to
the next person automatically. This is the single most impactful feature for a
one-charger building.

### Why (evidence)
ChargePoint's flagship busy-station feature is exactly this (Waitlist: notify →
accept → hold → snooze → auto-advance). AmpUp sells "reservations + waitlists"
as its core multifamily fairness tool. For one shared charger, the queue *is*
the product — priority days don't resolve real-time contention.

### Data model (Migration 016)
```
CREATE TABLE charger_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id   UUID NOT NULL REFERENCES buildings(id),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        VARCHAR(20) NOT NULL DEFAULT 'waiting',
                -- 'waiting' | 'offered' | 'claimed' | 'passed' | 'expired' | 'cancelled'
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  offered_at    TIMESTAMPTZ,          -- when the "it's free, it's yours" push went out
  offer_expires_at TIMESTAMPTZ,       -- offered_at + hold window (default 15 min)
  resolved_at   TIMESTAMPTZ
);
-- one active queue entry per user per building:
CREATE UNIQUE INDEX charger_queue_active_unique
  ON charger_queue(building_id, user_id) WHERE status IN ('waiting','offered');
CREATE INDEX charger_queue_building_status ON charger_queue(building_id, status, joined_at);
```
Position = order by `joined_at` among `status='waiting'`.

### API (`apps/api/src/routes/queue.ts`, mount at `/queue`)
All routes `authenticate, resolveBuilding, requireBuilding`; all scoped to
`req.buildingId`.
- `GET /queue` — the building's live queue (ordered), plus the caller's own
  position (or null) and whether an offer is currently held by anyone.
- `POST /queue/join` — add caller as `waiting` (ON CONFLICT: no-op if already
  in). Reject if the caller currently holds the active session. Broadcast.
- `POST /queue/leave` — set caller's active entry to `cancelled`. Broadcast.
- `POST /queue/claim` — caller (must be the `offered` head) starts their
  session; mark `claimed`, resolve entry, and hand off to the normal
  start-session flow. Broadcast.
- `POST /queue/pass` — caller declines their offer; mark `passed`, immediately
  advance (see engine). Broadcast.

### The engine (extend `chargerWatch.ts`)
Two hooks:
1. **On charger free** — replace/extend `notifyNextResident`: when a session
   ends (or the 5-min tick sees the charger go `AVAILABLE` with a non-empty
   queue), offer the front of the queue: set `status='offered'`,
   `offered_at=now`, `offer_expires_at=now+15min`, push
   *"⚡ Charger's free — held for you until {time}. On my way / Pass"*.
2. **On the tick** — if an `offered` entry is past `offer_expires_at`, mark it
   `expired` and offer the next `waiting` entry (repeat until someone's offered
   or the queue is empty). This is the auto-advance.

Emit a socket.io `queue:update` event to `charger_room` on every mutation so
open apps re-render without polling. Keep a REST `GET /queue` for cold loads.

### Mobile UX
- **HomeScreen**: when charger is busy, show a card — *"2 people waiting"* +
  **Join queue** (or **Leave queue** + "You're #2" if already in). When the
  caller is the one being offered, show a prominent **On my way** / **Pass**.
- **SessionScreen**: after a session ends, if a queue exists, confirm "The next
  resident has been notified."
- Deep-link the offer push to HomeScreen.

### Edge cases
- Person leaves the building / never responds → 15-min expiry auto-advances.
- Only one charger, so at most one `offered` at a time — never offer two people.
- If the offered person just starts charging without tapping claim, the normal
  session-start should resolve their queue entry (match by user + building).
- Weekend "first come, first served" still applies — the queue is orthogonal
  (it's about right-now contention, not priority days).

### Size: **M.**

---

## Feature 2 — Queue-aware anti-camping escalation

### Pitch
The app already tells you your car looks done. Make it escalate politely **when
people are actually waiting**: "2 neighbors are waiting — please unplug," and
surface idle time to the building. Optional: an admin-configurable idle fee
after a grace period, billed through the existing wallet.

### Why
Charger camping is the #1 complaint in every forum and etiquette guide; AmpUp
monetizes exactly this ("grace periods & idle fees"). This is your "reminders"
hunch aimed at the right moment.

### What already exists (do not rebuild)
`chargerWatch.ts` already sends the "estimated time passed," "car looks done"
(<0.5 kW while IN_USE), and "6-hour cap" nudges, de-duped via the
`*_reminder_at` flags on `sessions`. **Feature 2 is an extension of this**, not
new infrastructure.

### What to add
1. **Queue-aware wording + escalation.** In `checkOneSession`, when the "looks
   done" or "estimated passed" trigger fires, check `charger_queue` for
   `waiting` count in that building. If > 0, use stronger copy ("N neighbors are
   waiting for the charger") and allow a **second** escalation nudge after a
   further N minutes (add an `idle_escalated_at` flag — Migration 017) — but
   only while a queue exists.
2. **Idle time on everyone's HomeScreen** (optional): expose "charger has been
   idle-but-plugged for X min" via the charger status payload.
3. **Optional idle fee** (config-gated, off by default): a per-building setting
   `idle_fee_cents_per_15min` + `idle_grace_min`. After grace with the car
   drawing ~0 kW and a queue waiting, accrue a wallet `charge` transaction via
   the existing wallet mechanism. Ship this **behind a setting, defaulting to
   0/off** — several buildings will not want it, and it must be transparent
   (show it in Community Rules + the wallet line item).

### Size: **S–M** (mostly copy + one flag + optional fee setting).

---

## Feature 3 — Car profiles + finish-time ETA

### Pitch
Tell the app your car once (make/model, battery kWh, usual charge target). The
app then shows an honest **"Meghan's Ioniq 5 — free in ~1h 40m"** on HomeScreen
instead of a user-typed guess, and the queue offer can reference it.

### Why
Validates the "personalize your car" hunch by making it useful, not cosmetic.
"Estimated time of completion" is the most-used datapoint in OEM EV apps, and it
feeds features 1 & 2 (smarter offers, honest estimated_end).

### Data model (Migration 018)
Add nullable columns to `users` (all optional; feature degrades gracefully when
unset):
```
ALTER TABLE users ADD COLUMN IF NOT EXISTS car_make        VARCHAR(60);
ALTER TABLE users ADD COLUMN IF NOT EXISTS car_model       VARCHAR(60);
ALTER TABLE users ADD COLUMN IF NOT EXISTS battery_kwh     NUMERIC(5,1);
ALTER TABLE users ADD COLUMN IF NOT EXISTS target_percent  INTEGER;  -- e.g. 80
```
Add these to the `PATCH /users/me` whitelist (currently `name, push_token,
unit_number, avatar_url`).

### ETA computation (API)
Given the charger's live `loadKw` (from `getCurrentLoad`) and the session
owner's `battery_kwh` + `target_percent`, estimate remaining time. Keep it
simple and clearly labelled an estimate:
`remaining_hours ≈ (battery_kwh * (target_percent/100) * assumed_fraction_left) / max(loadKw, small_floor)`.
Expose on the charger status / active-session payload as `estimated_free_at`.
When no profile exists, fall back to the user-entered `estimated_end` (today's
behavior) — never show a fake number.

### Mobile UX
- **ProfileScreen**: a "Your car" section (make, model, battery kWh, target %).
- **HomeScreen**: when busy, "{Name}'s {model} — free in ~{eta}" instead of the
  raw estimated end when a profile + live load are available.

### Size: **S.**

---

## Backlog (honorable mentions — not scheduled)
- **Auto-complete zombie sessions** — a session never ended in-app blocks queue
  offers even when ChargePoint reports AVAILABLE (see CLAUDE.md Gotcha #16);
  auto-complete after CP reports AVAILABLE for several ticks past estimated_end.
- **Refresh `/users/me` on app open** — the app's user object is rebuilt only at
  login; server-side profile changes don't reach the app until re-login.
- **AI billing explainer** — "why was I charged $6.12?" (the wired OpenAI/
  Anthropic key already powers the admin summary; reuse it). "People accept fees
  when they see the math."
- **Monthly fairness snapshot** — each resident's kWh share vs. the building.
- **Low-balance push + "request top-up" button** (admin gets notified).
- **Guest sessions** billed to the host resident.
- **Admin-editable "house rules" card** on first login (instead of an
  onboarding tour — 10-person invite-only buildings are onboarded by a human).

## Cross-cutting checklist for the implementing session
- [x] Each new table/column as a new idempotent Migration (016+), own try/catch.
      (016 charger_queue, 017 escalation/idle-fee flags, 018 car profiles)
- [x] `building_id` on every new table; every query filtered by `req.buildingId`.
- [x] Extend `apps/api/src/__tests__/isolation.test.ts` — a B1 resident must
      never see/act on B2's queue. (suite now 36 tests, incl. idle-fee isolation)
- [x] `cd apps/api && npm run build` + `DATABASE_URL=<test-db> npm test` green;
      bump the `/health` build tag. (`2026-07-14-v19-v1.1`)
- [x] Verify against a local API on the isolation-test DB before pushing (done —
      second API on :3002; queue flow by curl + socket clients; portal Settings
      driven in-browser).
- [x] Mobile: `npx tsc --noEmit` green; then a new EAS build (#22) to ship.
- [x] Update README §0 + CLAUDE.md session log; open a PR into `main`. (PR #1)

## References
- ChargePoint Waitlist: https://www.chargepoint.com/drivers/waitlist-faq
- AmpUp multifamily: https://www.ampup.io/use-cases/ev-charging-management-for-residential
- EVmatch multifamily: https://evmatch.com/solutions/multi-family/
