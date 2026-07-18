# Standing Up a New Building (Single-Tenant Clone)

Each customer building gets its own isolated stack: one Railway project (API +
Postgres), one Vercel project (admin portal), and a mobile build pointed at that
building's API. No code changes are needed — everything building-specific is an
environment variable. Budget ~2 hours the first time, ~45 minutes after that.

## 0. Prerequisites (gather from the building before starting)

| Item | Who provides it | Notes |
|------|-----------------|-------|
| ChargePoint Web Services API credentials | Building / ChargePoint | The building's ChargePoint account owner requests API access from ChargePoint support ("Web Services API v5.1 credentials"). This is the long pole — start it first; it can take days to weeks. |
| Charger EVSE/station ID | ChargePoint portal | Format `1:NNNNNNNN`, shown on the station page. Multi-charger buildings are NOT supported yet — one station per deployment. |
| Electricity rate ($/kWh) | Building manager | Set later in the admin Settings tab (default $0.18). |
| Building admin's email | Building manager | Gets the first invite; they run wallets day-to-day. |

## 1. Railway — API + Postgres

1. New Railway project named `<building>-ev` (e.g. `oceanview-ev`).
2. Add a **PostgreSQL** service.
3. Add a service deploying from the GitHub repo `jackofall613/2020ev`, root
   directory `apps/api` (same Dockerfile as production). Generate a public domain.
4. Set env vars on the API service:

   | Variable | Value |
   |----------|-------|
   | `DATABASE_URL` | reference the project's Postgres |
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | fresh random: `openssl rand -hex 32` |
   | `JWT_REFRESH_SECRET` | fresh random (different) |
   | `INGEST_SECRET` | fresh random — never reuse across buildings |
   | `CP_API_KEY` / `CP_API_PASSWORD` | that building's ChargePoint credentials |
   | `CP_STATION_ID` | that building's EVSE ID, e.g. `1:12345678` |

5. Verify: `curl https://<railway-domain>/health` returns `{"status":"ok",...}`.
   Migrations run automatically on boot; the daily 9 AM ingest cron is in-process
   and needs no extra setup.

## 2. Vercel — admin portal

1. New Vercel project from the same repo, root directory `apps/web`.
2. Env var: `NEXT_PUBLIC_API_URL` = the new Railway domain.
3. Deploy. Optionally attach a subdomain like `oceanview-admin.2020ev.app`.

## 3. Bootstrap the building admin

1. `curl -X POST https://<railway-domain>/auth/bootstrap` → returns an invite
   token (only works while the database has zero users — do this before sharing
   any URLs).
2. Send the building admin the invite; they register and become the admin
   automatically (first user = admin).
3. Admin sets the electricity rate in Settings and invites residents.

## 4. Mobile app

The app reads `EXPO_PUBLIC_API_URL` at build time
([api.ts](apps/mobile/src/constants/api.ts)); unset, it points at the original
2020 building.

Interim approach (fine for the first few buildings): one build per building —

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=https://<railway-domain> eas build --profile preview --platform ios
```

Distribute via TestFlight (internal testers) or Apple **Unlisted App
Distribution**. A single public App Store app serving all buildings needs a
building-picker at login (resolve building code → API URL) — that's part of the
multi-tenant milestone, not needed to onboard early customers.

## 5. Per-building checklist

- [ ] ChargePoint API credentials requested (do this first)
- [ ] Railway project up, `/health` green
- [ ] All env vars set, secrets freshly generated (never copied from another building)
- [ ] Vercel portal up, admin can log in
- [ ] Bootstrap done, building admin registered
- [ ] Electricity rate set
- [ ] Charge a test session and confirm it appears + bills after the next ingest
      (or trigger manually: `POST /chargepoint/ingest` with `X-Ingest-Secret`)
- [ ] Residents invited, wallets topped up
- [ ] Postgres backups enabled on the Railway project

## Costs per building

Railway API + Postgres ≈ $10–15/mo, Vercel free tier, TestFlight free.
Price accordingly (e.g. $75–150/mo per building covers infra + your time).
