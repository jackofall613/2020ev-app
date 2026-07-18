import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { verifyAccessToken } from './utils/jwt';
import { activeProvider } from './services/assistant';
import authRoutes from './routes/auth';
import sessionRoutes from './routes/sessions';
import feedRoutes from './routes/feed';
import userRoutes from './routes/users';
import scheduleRoutes from './routes/schedule';
import settingsRoutes from './routes/settings';
import chargepointRoutes from './routes/chargepoint';
import walletRoutes from './routes/wallet';
import adminRoutes from './routes/admin';
import buildingRoutes from './routes/building';
import queueRoutes from './routes/queue';
import { setIo, buildingRoom } from './services/realtime';
import { pool } from './db';

const app = express();
app.set('trust proxy', 1); // Railway sits behind a reverse proxy
const httpServer = createServer(app);

const ALLOWED_ORIGINS = [
  'https://admin.2020ev.app',
  'https://2020ev-admin.vercel.app',
];

const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? ALLOWED_ORIGINS
      : ['http://localhost:3001'],
    credentials: true,
  },
});

// Middleware
app.use(helmet());
app.use(compression()); // gzip JSON — the admin dashboard pulls ~13 payloads per load
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ALLOWED_ORIGINS
    : true,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
// Separate bucket for password recovery: a flood of failed logins must never
// lock someone out of the recovery flow (and vice versa).
const recoveryLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use(limiter);
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);
app.use('/auth/forgot-password', recoveryLimiter);
app.use('/auth/reset-password', recoveryLimiter);

// Routes
app.use('/auth', authRoutes);
app.use('/sessions', sessionRoutes);
app.use('/feed', feedRoutes);
app.use('/users', userRoutes);
app.use('/schedule', scheduleRoutes);
app.use('/settings', settingsRoutes);
app.use('/chargepoint', chargepointRoutes);
app.use('/wallet', walletRoutes);
app.use('/admin', adminRoutes);
app.use('/building', buildingRoutes);
app.use('/queue', queueRoutes);

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), build: '2026-07-14-v19-v1.1', ai: activeProvider() ?? 'disabled' }));

// Socket.io auth
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try {
    const payload = verifyAccessToken(token);
    (socket as any).user = payload;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const user = (socket as any).user;
  console.log(`Socket connected: ${user.userId}`);
  socket.join('charger_room'); // legacy global room — nothing tenant-scoped is emitted here

  // Tenant-scoped room for queue/charger events. The building comes from the
  // server-verified JWT (legacy tokens lack it — resolve from the user's row),
  // never from anything the client sends.
  if (user.buildingId) {
    socket.join(buildingRoom(user.buildingId));
  } else {
    pool.query('SELECT building_id FROM users WHERE id = $1', [user.userId])
      .then((r) => { if (r.rows[0]?.building_id) socket.join(buildingRoom(r.rows[0].building_id)); })
      .catch(() => {});
  }

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${user.userId}`);
  });
});

// Expose io for use in routes + the realtime service (queue broadcasts)
app.set('io', io);
setIo(io);

async function runMigrations() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chargepoint_drivers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_account_number TEXT UNIQUE NOT NULL,
        chargepoint_user_id TEXT,
        driver_name TEXT NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'mapped')),
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS chargepoint_session_id TEXT`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_cp_session_unique
        ON wallet_transactions(chargepoint_session_id)
        WHERE chargepoint_session_id IS NOT NULL
    `);
    await pool.query(`ALTER TABLE report_imports ADD COLUMN IF NOT EXISTS csv_hash TEXT`);
    await pool.query(`ALTER TABLE report_imports ADD COLUMN IF NOT EXISTS rows_unmatched INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE report_imports ADD COLUMN IF NOT EXISTS unknown_drivers TEXT[]`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS report_imports_csv_hash_unique
        ON report_imports(csv_hash)
        WHERE csv_hash IS NOT NULL
    `);
    console.log('[migrations] Migration 004 applied');
    // Migration 005 — ignored drivers
    await pool.query(`ALTER TABLE chargepoint_drivers ADD COLUMN IF NOT EXISTS is_ignored BOOLEAN NOT NULL DEFAULT false`);
    console.log('[migrations] Migration 005 applied');
    // Migration 006 — store rate used on each transaction for full billing auditability
    await pool.query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS rate_cents_per_kwh INTEGER`);
    console.log('[migrations] Migration 006 applied');
    // Migration 008 — backfill chargepoint_user_id on SOAP phantom records from their
    // CP_USER_<id> account-number suffix. This is the numeric key that links a SOAP
    // phantom to a resident's real CSV account so daily auto-ingest can bill them.
    // (Supersedes the old Migration 007 auto-ignore strategy: phantoms are now the
    // stable SOAP billing identity and are mapped/cross-linked, not hidden.)
    await pool.query(`
      UPDATE chargepoint_drivers
      SET chargepoint_user_id = substring(driver_account_number from 'CP_USER_(.*)')
      WHERE driver_account_number LIKE 'CP_USER_%'
        AND (chargepoint_user_id IS NULL OR chargepoint_user_id = '')
    `);
    console.log('[migrations] Migration 008 applied');
    // Migration 009 — at most one active charger session at a time (closes the
    // race where two concurrent /sessions/start requests both pass the pre-check)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_single_active
        ON sessions(status)
        WHERE status = 'active'
    `);
    console.log('[migrations] Migration 009 applied');
    // Migration 010 — "move your car" reminder flags (one push per trigger per session)
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS estimated_reminder_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS idle_reminder_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cap_reminder_at TIMESTAMPTZ`);
    console.log('[migrations] Migration 010 applied');

    // ── Migration 011 — Multi-tenancy schema (Phase 1: additive only) ──────────
    // Introduces the `buildings` table and a nullable `building_id` on every
    // tenant-scoped table, backfilled to the default "2020" building. Composite
    // uniqueness indexes are created ALONGSIDE the existing global ones (safe while
    // only one building exists). Nothing here changes app behavior — later phases
    // add NOT NULL, drop the old global indexes, and enforce per-building scoping.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS buildings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'America/New_York',
        cp_station_id TEXT,
        cp_api_key_enc TEXT,
        cp_api_password_enc TEXT,
        plan TEXT NOT NULL DEFAULT 'standard',
        price_cents INTEGER NOT NULL DEFAULT 19900,
        billing_status TEXT NOT NULL DEFAULT 'trial'
          CHECK (billing_status IN ('trial','active','past_due','canceled')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Seed the default building for the original deployment. Active subscription so
    // the existing building keeps ingesting/billing without interruption.
    await pool.query(`
      INSERT INTO buildings (slug, name, timezone, billing_status)
      VALUES ('2020', '2020', 'America/New_York', 'active')
      ON CONFLICT (slug) DO NOTHING
    `);

    // Add nullable building_id to every tenant table (FK → buildings).
    const tenantTables = [
      'users', 'sessions', 'feed_messages', 'settings', 'chargepoint_drivers',
      'wallets', 'wallet_transactions', 'report_imports', 'invite_codes',
    ];
    for (const t of tenantTables) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES buildings(id)`);
    }

    // Backfill every existing row to the default "2020" building.
    for (const t of tenantTables) {
      await pool.query(
        `UPDATE ${t} SET building_id = (SELECT id FROM buildings WHERE slug = '2020')
         WHERE building_id IS NULL`
      );
    }

    // Composite uniqueness scoped per building — created alongside the existing
    // global unique indexes. Once app code writes building_id everywhere (P2) and
    // scoping is enforced (P3), the old global indexes get dropped.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_building_cp_session_unique
        ON wallet_transactions(building_id, chargepoint_session_id)
        WHERE chargepoint_session_id IS NOT NULL
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS report_imports_building_csv_hash_unique
        ON report_imports(building_id, csv_hash)
        WHERE csv_hash IS NOT NULL
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_building_single_active
        ON sessions(building_id)
        WHERE status = 'active'
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS chargepoint_drivers_building_account_unique
        ON chargepoint_drivers(building_id, driver_account_number)
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS settings_building_key_unique
        ON settings(building_id, key)
    `);

    // Helpful non-unique indexes for the per-building scans coming in P3.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_building ON users(building_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_building ON sessions(building_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_feed_messages_building ON feed_messages(building_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_building ON wallet_transactions(building_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cp_drivers_building ON chargepoint_drivers(building_id)`);
    console.log('[migrations] Migration 011 applied (multi-tenancy schema, phase 1)');

    // ── Migration 012 — Roles + invite scoping (Phase 2) ───────────────────────
    // Allow the new 'super_admin' role (keep 'admin' = building admin). Drop-then-add
    // keeps this idempotent across reboots. Existing rows ('admin'/'member') pass.
    await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','member'))`);
    // Invites carry the role the invitee becomes; building_id was added in P1.
    await pool.query(`ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'`);
    await pool.query(`ALTER TABLE invite_codes DROP CONSTRAINT IF EXISTS invite_codes_role_check`);
    await pool.query(`ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_role_check CHECK (role IN ('admin','member'))`);
    console.log('[migrations] Migration 012 applied (roles + invite scoping, phase 2)');

    // ── Migration 013 — Enforce per-building scoping (Phase 3) ─────────────────
    // All reads/writes are now building-scoped and every INSERT sets building_id,
    // so: enforce NOT NULL on tenant tables (users stays nullable — super_admin has
    // no building), drop the old global unique indexes (superseded by the P1
    // composite ones), and move the settings PK to (building_id, key).
    for (const t of ['sessions', 'feed_messages', 'settings', 'chargepoint_drivers',
                     'wallets', 'wallet_transactions', 'report_imports', 'invite_codes']) {
      await pool.query(`ALTER TABLE ${t} ALTER COLUMN building_id SET NOT NULL`);
    }
    await pool.query(`DROP INDEX IF EXISTS wallet_transactions_cp_session_unique`);
    await pool.query(`DROP INDEX IF EXISTS report_imports_csv_hash_unique`);
    await pool.query(`DROP INDEX IF EXISTS sessions_single_active`);
    await pool.query(`ALTER TABLE chargepoint_drivers DROP CONSTRAINT IF EXISTS chargepoint_drivers_driver_account_number_key`);
    // settings PK: (key) -> (building_id, key). Drop-then-add keeps it idempotent.
    // The P1 composite unique index is redundant with the new PK, so drop it.
    await pool.query(`DROP INDEX IF EXISTS settings_building_key_unique`);
    await pool.query(`ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey`);
    await pool.query(`ALTER TABLE settings ADD PRIMARY KEY (building_id, key)`);
    console.log('[migrations] Migration 013 applied (enforce per-building scoping, phase 3)');

    // ── Migration 014 — Portal access log (Phase 6: ghost login audit) ─────────
    // Records super-admin impersonation sessions + the mutating actions taken under
    // them. Readable by the building's own admin (transparency).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_access_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        building_id UUID NOT NULL REFERENCES buildings(id),
        super_admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_portal_access_building ON portal_access_log(building_id, created_at DESC)`);
    console.log('[migrations] Migration 014 applied (portal access log, phase 6)');
  } catch (err: any) {
    console.error('[migrations] Migration 004 failed:', err.message);
  }

  // ── Migration 015 — Forgot-password reset tokens + hot-path indexes ────────
  // Own try/catch: an earlier migration failing (e.g. wallet tables not created
  // yet on a fresh dev DB — they're made lazily by the wallet routes) must not
  // prevent this one from running. Reset tokens are stored as SHA-256 (same
  // rationale as refresh tokens — Gotcha #14). Single-use + 30-min expiry.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pw_reset_token_hash ON password_reset_tokens(token_hash)`);
    // Composite indexes for the two hottest reads: a resident's history/export
    // and the building feed. Guarded — the tables may not exist yet locally.
    await pool.query(`DO $$ BEGIN
      CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_created ON wallet_transactions(user_id, created_at DESC);
      EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
    END $$`);
    await pool.query(`DO $$ BEGIN
      CREATE INDEX IF NOT EXISTS idx_feed_building_created ON feed_messages(building_id, created_at DESC);
      EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
    END $$`);
    console.log('[migrations] Migration 015 applied (password reset tokens + hot-path indexes)');
  } catch (err: any) {
    console.error('[migrations] Migration 015 failed:', err.message);
  }

  // ── Migration 016 — "Next Up" charger queue (v1.1 Feature 1) ────────────────
  // Live queue per building: waiting → offered (15-min hold) → claimed/passed/
  // expired, or cancelled on leave. Engine lives in services/chargerWatch.ts.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS charger_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        building_id UUID NOT NULL REFERENCES buildings(id),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'waiting'
          CHECK (status IN ('waiting','offered','claimed','passed','expired','cancelled')),
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        offered_at TIMESTAMPTZ,
        offer_expires_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ
      )
    `);
    // claimed_at marks "On my way" — the entry STAYS offered (still holding
    // the charger) until the resident plugs in; session start resolves it.
    await pool.query(`ALTER TABLE charger_queue ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
    // One live queue entry per user per building.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS charger_queue_active_unique
        ON charger_queue(building_id, user_id) WHERE status IN ('waiting','offered')
    `);
    // One charger per building → never more than one outstanding offer.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS charger_queue_single_offer
        ON charger_queue(building_id) WHERE status = 'offered'
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS charger_queue_building_status
        ON charger_queue(building_id, status, joined_at)
    `);
    console.log('[migrations] Migration 016 applied (charger queue)');
  } catch (err: any) {
    console.error('[migrations] Migration 016 failed:', err.message);
  }

  // ── Migration 017 — Queue-aware anti-camping (v1.1 Feature 2) ───────────────
  // idle_escalated_at: the one-shot second nudge sent while neighbors are queued.
  // idle_fee_blocks_billed: how many 15-min idle blocks have been billed for this
  // session (opt-in idle fee, off by default — see settings idle_fee_cents_per_15min).
  try {
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS idle_escalated_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS idle_fee_blocks_billed INTEGER NOT NULL DEFAULT 0`);
    // The fee meter's anchor: set on the first ELIGIBLE tick and re-set after
    // any gap, so idle fees are strictly prospective (never retro-billed).
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS idle_fee_billed_through TIMESTAMPTZ`);
    console.log('[migrations] Migration 017 applied (anti-camping escalation + idle fee flags)');
  } catch (err: any) {
    console.error('[migrations] Migration 017 failed:', err.message);
  }

  // ── Migration 018 — Car profiles (v1.1 Feature 3) ───────────────────────────
  // All optional; the finish-ETA feature degrades gracefully when unset.
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS car_make VARCHAR(60)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS car_model VARCHAR(60)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS battery_kwh NUMERIC(5,1)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS target_percent INTEGER`);
    console.log('[migrations] Migration 018 applied (car profiles)');
  } catch (err: any) {
    console.error('[migrations] Migration 018 failed:', err.message);
  }
}

// Error handler
app.use(errorHandler);

// Start — skipped under NODE_ENV=test so the test harness can import { app,
// runMigrations } without binding a port or starting the cron jobs.
if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(config.port, async () => {
    try {
      await pool.query('SELECT 1');
      console.log('Database connected');
      await runMigrations();
    } catch (err) {
      console.error('Database connection failed:', err);
    }
    console.log(`2020EV API running on port ${config.port}`);

    // Daily auto-ingest at 9:00 AM, in-process. This always runs so billing can never
    // silently stop: the chargepoint_session_id unique index makes repeat ingests
    // harmless (no double-billing), so there's no need to gate it on an env var even if
    // an external cron also hits POST /chargepoint/ingest.
    scheduleDailyIngest();

    // "Move your car" reminders — checks the active session every 5 min.
    const { scheduleChargerWatch } = require('./services/chargerWatch');
    scheduleChargerWatch();
  });
}

function scheduleDailyIngest() {
  const { ingestYesterdaysSessions } = require('./services/ingest');
  const msUntil9AM = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  };
  const schedule = () => {
    setTimeout(async () => {
      try {
        console.log('[ingest] Running daily auto-ingest...');
        const result = await ingestYesterdaysSessions();
        console.log(`[ingest] Done — processed: ${result.processed}, charged: ${result.charged}, unknown: ${result.unknown}`);
      } catch (err: any) {
        console.error('[ingest] Failed:', err.message);
      }
      schedule(); // reschedule for next day
    }, msUntil9AM());
  };
  schedule();
}

export { io, app, runMigrations };
