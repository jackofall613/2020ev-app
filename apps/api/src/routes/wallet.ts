import { Router, Response, Request } from 'express';
import { authenticate, requireAdmin, resolveBuilding, requireBuilding, AuthRequest } from '../middleware/auth';
import { query, pool } from '../db';
import { notifyUser, notifyAdmins } from '../services/notifications';
import { isConfigured as aiConfigured, askBillingAssistant, summarizeMonth } from '../services/assistant';
import crypto from 'crypto';

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

async function getRateCents(buildingId: string | null): Promise<number> {
  try {
    const r = await query(`SELECT value FROM settings WHERE key = 'electricity_rate_cents_per_kwh' AND building_id = $1`, [buildingId]);
    if (r.rows[0]) {
      const rate = Math.round(parseFloat(r.rows[0].value));
      console.log(`[billing] Electricity rate loaded from DB: ${rate}¢/kWh ($${(rate / 100).toFixed(4)}/kWh)`);
      return rate;
    }
  } catch (err) {
    console.error('[billing] Failed to fetch electricity rate from settings — using default 18¢/kWh:', err);
  }
  console.log('[billing] Electricity rate not set in DB — using default 18¢/kWh');
  return 18; // $0.18/kWh default
}

/** Resolve a resident user_id by ChargePoint numeric user ID.
 *  SOAP ingest uses synthetic CP_USER_<id> account numbers while CSV uses real
 *  DNACLB... numbers — both carry the same chargepoint_user_id. So a resident
 *  mapped under one identity should bill under the other too. Prefers a real
 *  (non-phantom) account when several share the same numeric ID. Returns the
 *  mapped user_id, or null. */
async function resolveByCpUserId(buildingId: string | null, cpUserId: string | null | undefined): Promise<string | null> {
  if (!cpUserId) return null;
  const r = await query(
    `SELECT user_id FROM chargepoint_drivers
     WHERE chargepoint_user_id = $1 AND status = 'mapped' AND user_id IS NOT NULL AND building_id = $2
     ORDER BY (driver_account_number NOT LIKE 'CP_USER_%') DESC
     LIMIT 1`,
    [cpUserId, buildingId]
  );
  return r.rows[0]?.user_id ?? null;
}

/** Ensure a wallet row exists for a user (stamped with the user's building).
 *  No-op when buildingId is null (e.g. a super-admin, who has no wallet) — this
 *  also keeps wallets.building_id NOT NULL safe. */
async function ensureWallet(userId: string, buildingId: string | null) {
  if (!buildingId) return;
  await query(
    `INSERT INTO wallets (user_id, balance_cents, building_id) VALUES ($1, 0, $2) ON CONFLICT (user_id) DO NOTHING`,
    [userId, buildingId]
  );
}

/** Run fn inside a BEGIN/COMMIT block; rolls back and rethrows on any error. */
async function withTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Match a ChargePoint session to an app session by plug-connect time overlap.
 *  Excludes sessions that have already been charged (prevents double-billing). */
async function matchSession(buildingId: string | null, plugConnectTime: Date): Promise<{ sessionId: string; userId: string } | null> {
  const r = await query(
    `SELECT s.id as session_id, s.user_id
     FROM sessions s
     WHERE s.status = 'completed'
       AND s.building_id = $2
       AND s.started_at BETWEEN ($1::timestamptz - interval '45 min') AND ($1::timestamptz + interval '45 min')
       AND NOT EXISTS (
         SELECT 1 FROM wallet_transactions wt
         WHERE wt.session_id = s.id AND wt.type = 'charge' AND wt.kwh IS NOT NULL
       )
     ORDER BY ABS(EXTRACT(EPOCH FROM (s.started_at - $1::timestamptz)))
     LIMIT 1`,
    [plugConnectTime, buildingId]
  );
  return r.rows[0] ? { sessionId: r.rows[0].session_id, userId: r.rows[0].user_id } : null;
}

/** Core debit logic — reused by manual charge + import.
 *  chargepointSessionId is used for deduplication (ON CONFLICT DO NOTHING). */
async function chargeUser(
  buildingId: string | null,
  userId: string,
  kwh: number,
  rateCents: number,
  sessionId: string | null,
  plugConnectTime: Date,
  plugDisconnectTime: Date,
  chargepointSessionId?: string
): Promise<{ amountCents: number; alreadyBilled?: boolean }> {
  await ensureWallet(userId, buildingId);
  const amountCents = Math.round(kwh * rateCents);
  const durationMins = Math.round((plugDisconnectTime.getTime() - plugConnectTime.getTime()) / 60000);
  const dateStr = plugConnectTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const desc = `${dateStr} · ${kwh.toFixed(2)} kWh · ${durationMins}m`;

  console.log(`[billing] chargeUser — userId=${userId} kwh=${kwh.toFixed(3)} rate=${rateCents}¢ amount=$${(amountCents/100).toFixed(2)} cpSessionId=${chargepointSessionId ?? 'none'} date=${dateStr} duration=${durationMins}m`);

  // Atomic: INSERT transaction record first, then deduct balance.
  // This prevents a half-billed state if the server crashes between the two writes.
  // For CP sessions the ON CONFLICT guard also eliminates the pre-check SELECT race condition.
  const billed = await withTransaction(async (client) => {
    if (chargepointSessionId) {
      const txResult = await client.query(
        `INSERT INTO wallet_transactions (user_id, amount_cents, type, description, session_id, kwh, chargepoint_session_id, rate_cents_per_kwh, building_id)
         VALUES ($1, $2, 'charge', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (building_id, chargepoint_session_id) WHERE chargepoint_session_id IS NOT NULL DO NOTHING`,
        [userId, -amountCents, desc, sessionId, kwh, chargepointSessionId, rateCents, buildingId]
      );
      if ((txResult.rowCount ?? 0) === 0) {
        console.log(`[billing] chargeUser — SKIPPED (already billed) cpSessionId=${chargepointSessionId}`);
        return false; // already billed — skip balance update
      }
    } else {
      await client.query(
        `INSERT INTO wallet_transactions (user_id, amount_cents, type, description, session_id, kwh, rate_cents_per_kwh, building_id)
         VALUES ($1, $2, 'charge', $3, $4, $5, $6, $7)`,
        [userId, -amountCents, desc, sessionId, kwh, rateCents, buildingId]
      );
    }
    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE user_id = $2`,
      [amountCents, userId]
    );
    return true;
  });

  if (!billed) return { amountCents: 0, alreadyBilled: true };

  console.log(`[billing] chargeUser — BILLED userId=${userId} $${(amountCents/100).toFixed(2)}`);

  // Fire-and-forget push notification
  notifyUser(userId, 'Charging session billed', `${kwh.toFixed(2)} kWh · $${(amountCents / 100).toFixed(2)} deducted`).catch(() => {});

  return { amountCents };
}

// ── parse ChargePoint CSV ─────────────────────────────────────────────────────

export interface CPRow {
  plugInEventId: string;       // "Plug In Event ID" column
  driverAccountNumber: string; // "Driver Account Number" column
  driverName: string;          // "Driver Name" column
  chargepointUserId: string;   // "User ID" column
  email?: string;              // resolved via getUsers (SOAP ingest only) — most reliable match key
  plugConnectTime: Date;
  plugDisconnectTime: Date;
  kwh: number;
}

/** Find an app user in this building by email (most reliable) then exact name.
 *  Returns user_id or null. Scoped so a driver only maps to a resident of the
 *  same building. */
async function matchAppUser(buildingId: string | null, email: string | undefined, name: string): Promise<string | null> {
  if (email) {
    const r = await query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND building_id = $2 LIMIT 1`, [email, buildingId]);
    if (r.rows[0]) return r.rows[0].id;
  }
  const r = await query(`SELECT id FROM users WHERE LOWER(name) = LOWER($1) AND building_id = $2 LIMIT 1`, [name, buildingId]);
  return r.rows[0]?.id ?? null;
}

export function parseChargePointCSV(csv: string): CPRow[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  // Find header row — ChargePoint CSV sometimes has a title row first
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    if (lines[i].toLowerCase().includes('plug connect')) { headerIdx = i; break; }
  }

  const rawHeaders = lines[headerIdx].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());

  const findCol = (needle: string) => rawHeaders.findIndex(h => h === needle);

  const eventIdIdx      = findCol('plug in event id');
  const acctNumIdx      = findCol('driver account number');
  const driverNameIdx   = findCol('driver name');
  const cpUserIdIdx     = findCol('user id');
  const connectIdx      = rawHeaders.findIndex(h => h.includes('plug connect time') && !h.includes('zone'));
  const disconnectIdx   = rawHeaders.findIndex(h => h.includes('plug disconnect time') && !h.includes('zone'));
  // Prefer exact 'energy kwh' over 'energy consumed ac kwh' which is empty on session summary rows
  const energyIdx = (() => {
    const exact = rawHeaders.findIndex(h => h === 'energy kwh');
    if (exact >= 0) return exact;
    return rawHeaders.findIndex(h => h.includes('kwh') && !h.includes('zone') && !h.includes('consumed'));
  })();

  if (connectIdx === -1 || disconnectIdx === -1 || energyIdx === -1) {
    const missing = [
      connectIdx === -1    ? 'Plug Connect Time'    : null,
      disconnectIdx === -1 ? 'Plug Disconnect Time' : null,
      energyIdx === -1     ? 'Energy kWh'           : null,
    ].filter(Boolean).join(', ');
    throw new Error(`CSV is missing required columns: ${missing}. Make sure you downloaded the correct ChargePoint session report.`);
  }

  const rows: CPRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Respect quoted fields that may contain commas
    const cols = splitCSVLine(line);

    const driverAccountNumber = acctNumIdx >= 0 ? (cols[acctNumIdx] ?? '').trim() : '';

    // Skip 15-min meter interval rows (no driver account number)
    if (!driverAccountNumber) continue;

    const kwhStr = energyIdx >= 0 ? cols[energyIdx] : '';
    const kwh = parseFloat(kwhStr);
    if (isNaN(kwh) || kwh <= 0) continue;

    const connectStr    = cols[connectIdx] ?? '';
    const disconnectStr = cols[disconnectIdx] ?? '';
    const plugConnectTime    = new Date(connectStr);
    const plugDisconnectTime = new Date(disconnectStr);
    if (isNaN(plugConnectTime.getTime())) continue;

    rows.push({
      plugInEventId:        eventIdIdx >= 0    ? (cols[eventIdIdx] ?? '').trim()    : '',
      driverAccountNumber,
      driverName:           driverNameIdx >= 0 ? (cols[driverNameIdx] ?? '').trim() : '',
      chargepointUserId:    cpUserIdIdx >= 0   ? (cols[cpUserIdIdx] ?? '').trim()   : '',
      plugConnectTime,
      plugDisconnectTime,
      kwh,
    });
  }
  return rows;
}

/** RFC 4180-compliant CSV line splitter (handles quoted fields). */
function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ── core process function ─────────────────────────────────────────────────────

export async function processRows(
  buildingId: string | null,
  rows: CPRow[],
  source: string,
  filename?: string,
  csvHash?: string
): Promise<{
  rows_total: number;
  rows_matched: number;
  rows_unmatched: number;
  rows_already_billed: number;
  total_deducted_cents: number;
  unknown_drivers: string[];
}> {
  const rateCents = await getRateCents(buildingId);
  let matched = 0;
  let unmatched = 0;
  let alreadyBilled = 0;
  let totalDeductedCents = 0;
  const unknownDriverNames: string[] = [];

  console.log(`[billing] processRows START — source=${source} rows=${rows.length} rate=${rateCents}¢/kWh filename=${filename ?? 'none'}`);

  for (const row of rows) {
    console.log(`[billing] row — cpSessionId=${row.plugInEventId} driver=${row.driverName} acct=${row.driverAccountNumber} kwh=${row.kwh.toFixed(3)} connect=${row.plugConnectTime.toISOString()}`);

    // 1. Look up driver record (scoped to this building)
    const driverRes = await query(
      `SELECT id, user_id, status, is_ignored FROM chargepoint_drivers WHERE driver_account_number = $1 AND building_id = $2`,
      [row.driverAccountNumber, buildingId]
    );

    let userId: string | null = null;

    if (driverRes.rows.length > 0) {
      const driver = driverRes.rows[0];
      if (driver.is_ignored) {
        console.log(`[billing] row SKIPPED — driver ${row.driverName} (${row.driverAccountNumber}) is ignored`);
        continue; // admin dismissed this account — skip silently
      }
      // Always refresh metadata from CSV: real driver_name (if present) + chargepoint_user_id (if missing).
      // This ensures names are kept up-to-date even when the driver record already exists.
      const csvName = row.driverName?.trim();
      const hasRealName = Boolean(csvName && !csvName.startsWith('ChargePoint User #'));
      await query(
        `UPDATE chargepoint_drivers
         SET last_seen_at = NOW(),
             driver_name = CASE WHEN $2::text IS NOT NULL THEN $2::text ELSE driver_name END,
             chargepoint_user_id = COALESCE(chargepoint_user_id, $3)
         WHERE id = $1`,
        [driver.id, hasRealName ? csvName : null, row.chargepointUserId || null]
      );

      if (driver.status === 'mapped' && driver.user_id) {
        userId = driver.user_id;
        console.log(`[billing] driver matched — ${hasRealName ? csvName : driver.driver_name} → userId=${userId}`);
      } else if (driver.status === 'pending' && !driver.user_id) {
        // Previously-pending driver — retry auto-match by email/name, then numeric-ID cross-link
        let resolvedId: string | null = await matchAppUser(buildingId, row.email, row.driverName);
        if (!resolvedId) resolvedId = await resolveByCpUserId(buildingId, row.chargepointUserId);
        if (resolvedId) {
          await query(
            `UPDATE chargepoint_drivers SET user_id = $1, status = 'mapped' WHERE id = $2`,
            [resolvedId, driver.id]
          );
          userId = resolvedId;
          console.log(`[billing] driver resolved (name or CP user ID) — ${row.driverName} → userId=${userId}`);
        } else {
          console.log(`[billing] row UNMATCHED — driver ${row.driverName} is pending and no name/ID match found`);
          unmatched++;
          continue;
        }
      } else {
        console.log(`[billing] row UNMATCHED — driver ${row.driverName} status=${driver.status} userId=${driver.user_id ?? 'null'}`);
        unmatched++;
        continue;
      }
    } else {
      // Driver not found by account number — insert it as a new record.
      // Resolve a resident by email/name, or by shared ChargePoint numeric ID, which links
      // a SOAP CP_USER_<id> phantom to a resident's real CSV account (or vice-versa).
      // SOAP and CSV identities are kept as separate rows that share chargepoint_user_id;
      // the chargepoint_session_id unique index still prevents any double-billing.
      let autoUserId: string | null = await matchAppUser(buildingId, row.email, row.driverName);
      if (!autoUserId) autoUserId = await resolveByCpUserId(buildingId, row.chargepointUserId);
      const status = autoUserId ? 'mapped' : 'pending';

      await query(
        `INSERT INTO chargepoint_drivers
           (driver_account_number, chargepoint_user_id, driver_name, user_id, status, building_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (building_id, driver_account_number) DO NOTHING`,
        [row.driverAccountNumber, row.chargepointUserId || null, row.driverName, autoUserId, status, buildingId]
      );

      if (autoUserId) {
        userId = autoUserId;
        console.log(`[billing] NEW driver inserted + auto-matched (name or CP user ID) — ${row.driverName} → userId=${userId}`);
      } else {
        console.log(`[billing] NEW driver inserted as PENDING — ${row.driverName} (${row.driverAccountNumber}) — no user match`);
        notifyAdmins(
          buildingId,
          'New driver detected',
          `${row.driverName} appeared in a ChargePoint report. Open the app to map them to a resident.`
        ).catch(() => {});
        unknownDriverNames.push(row.driverName);
        unmatched++;
        continue;
      }
    }

    // 3. Charge the user — deduplication is handled atomically inside chargeUser
    const appSession = await matchSession(buildingId, row.plugConnectTime);
    if (appSession) {
      console.log(`[billing] matched app session — sessionId=${appSession.sessionId}`);
    }
    const { amountCents, alreadyBilled: wasAlreadyBilled } = await chargeUser(
      buildingId,
      userId!,
      row.kwh,
      rateCents,
      appSession?.sessionId ?? null,
      row.plugConnectTime,
      row.plugDisconnectTime,
      row.plugInEventId || undefined
    );
    if (wasAlreadyBilled) { alreadyBilled++; continue; }
    matched++;
    totalDeductedCents += amountCents;
  }

  console.log(`[billing] processRows DONE — matched=${matched} unmatched=${unmatched} alreadyBilled=${alreadyBilled} totalDeducted=$${(totalDeductedCents/100).toFixed(2)}`);

  await query(
    `INSERT INTO report_imports
       (source, filename, rows_total, rows_matched, rows_unmatched, total_deducted_cents, unknown_drivers, csv_hash, building_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [source, filename ?? null, rows.length, matched, unmatched, totalDeductedCents, unknownDriverNames, csvHash ?? null, buildingId]
  );

  return {
    rows_total: rows.length,
    rows_matched: matched,
    rows_unmatched: unmatched,
    rows_already_billed: alreadyBilled,
    total_deducted_cents: totalDeductedCents,
    unknown_drivers: unknownDriverNames,
  };
}

// ── routes ────────────────────────────────────────────────────────────────────

/** GET /wallet/me — resident's own balance + transactions */
router.get('/me', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    await ensureWallet(req.user!.userId, req.buildingId ?? null);
    const [walletRes, txRes] = await Promise.all([
      query(`SELECT balance_cents FROM wallets WHERE user_id = $1`, [req.user!.userId]),
      query(
        `SELECT id, amount_cents, type, description, kwh, created_at, session_id
         FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.user!.userId]
      ),
    ]);
    res.json({
      success: true,
      data: {
        balance_cents: walletRes.rows[0]?.balance_cents ?? 0,
        transactions: txRes.rows,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to fetch wallet' });
  }
});

/** GET /wallet/me/export?months=12 — resident: download their own charging
 *  history as CSV (opens in the iOS share sheet from the app; also imports
 *  cleanly into Numbers/Excel). Newest first. */
router.get('/me/export', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const months = Math.min(Math.max(parseInt(String(req.query.months)) || 12, 1), 36);
    const txRes = await query(
      `SELECT created_at, type, description, kwh, rate_cents_per_kwh, amount_cents
       FROM wallet_transactions
       WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' months')::interval
       ORDER BY created_at DESC`,
      [req.user!.userId, months]
    );

    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'Date,Type,Description,kWh,Rate ($/kWh),Amount ($)';
    const lines = txRes.rows.map((t: any) =>
      [
        new Date(t.created_at).toISOString().slice(0, 10),
        t.type,
        esc(t.description),
        t.kwh != null ? Number(t.kwh).toFixed(2) : '',
        t.rate_cents_per_kwh != null ? (t.rate_cents_per_kwh / 100).toFixed(2) : '',
        (t.amount_cents / 100).toFixed(2),
      ].join(',')
    );
    const csv = [header, ...lines].join('\n') + '\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="2020ev-charging-history.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[wallet] export failed:', err);
    res.status(500).json({ success: false, error: 'Failed to export history' });
  }
});

/** GET /wallet/users — admin: all users with balances */
router.get('/users', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    // Auto-create wallets table if it doesn't exist yet
    await query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        balance_cents INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id)
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL,
        type VARCHAR(20) NOT NULL CHECK (type IN ('credit', 'charge')),
        description TEXT NOT NULL,
        session_id UUID REFERENCES sessions(id),
        kwh NUMERIC(8,3),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS report_imports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source VARCHAR(50) NOT NULL DEFAULT 'email',
        filename TEXT,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rows_total INTEGER NOT NULL DEFAULT 0,
        rows_matched INTEGER NOT NULL DEFAULT 0,
        total_deducted_cents INTEGER NOT NULL DEFAULT 0,
        raw_csv TEXT,
        csv_hash TEXT,
        notes TEXT
      )
    `);
    // Add columns from migration 004 to tables created before it ran
    await query(`ALTER TABLE report_imports ADD COLUMN IF NOT EXISTS csv_hash TEXT`);
    await query(`ALTER TABLE report_imports ADD COLUMN IF NOT EXISTS rows_unmatched INTEGER NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE report_imports ADD COLUMN IF NOT EXISTS unknown_drivers TEXT[]`);
    // Seed wallets for any users in this building that don't have one
    await query(`
      INSERT INTO wallets (user_id, balance_cents, building_id)
      SELECT id, 0, building_id FROM users WHERE building_id = $1
      ON CONFLICT (user_id) DO NOTHING
    `, [req.buildingId]);
    const r = await query(
      `SELECT u.id, u.name, u.email, u.unit_number, COALESCE(w.balance_cents, 0) as balance_cents
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.building_id = $1
       ORDER BY u.name`,
      [req.buildingId]
    );
    res.json({ success: true, data: r.rows });
  } catch (err: any) {
    console.error('wallet/users error:', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to fetch wallets' });
  }
});

/** POST /wallet/credit — admin: add (or deduct if negative) funds from a resident's wallet */
router.post('/credit', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { user_id, amount_dollars, note } = req.body;
  if (!user_id || amount_dollars === undefined || amount_dollars === '' || isNaN(parseFloat(amount_dollars))) {
    return res.status(400).json({ success: false, error: 'user_id and amount_dollars required' });
  }
  try {
    // Guard: the target resident must belong to the admin's building.
    const target = await query(`SELECT id FROM users WHERE id = $1 AND building_id = $2`, [user_id, req.buildingId]);
    if (target.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found in this building' });
    }
    await ensureWallet(user_id, req.buildingId ?? null);
    const parsed = parseFloat(amount_dollars);
    const amountCents = Math.round(parsed * 100);
    const isCredit = amountCents >= 0;
    const absStr = Math.abs(parsed).toFixed(2);
    const type = isCredit ? 'credit' : 'charge';
    const desc = note || (isCredit
      ? `Admin credit: $${absStr}`
      : `Admin deduction: -$${absStr}`);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE wallets SET balance_cents = balance_cents + $1, updated_at = NOW() WHERE user_id = $2`,
        [amountCents, user_id]
      );
      await client.query(
        `INSERT INTO wallet_transactions (user_id, amount_cents, type, description, building_id) VALUES ($1, $2, $3, $4, $5)`,
        [user_id, amountCents, type, desc, req.buildingId]
      );
    });
    const updated = await query(`SELECT balance_cents FROM wallets WHERE user_id = $1`, [user_id]);
    const balance = updated.rows[0]?.balance_cents ?? 0;
    res.json({ success: true, data: { balance_cents: balance } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to update wallet' });
  }
});

/** POST /wallet/charge — admin: manually charge one session */
router.post('/charge', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { user_id, kwh, plug_connect_time, plug_disconnect_time } = req.body;
  if (!user_id || !kwh) return res.status(400).json({ success: false, error: 'user_id and kwh required' });
  try {
    const target = await query(`SELECT id FROM users WHERE id = $1 AND building_id = $2`, [user_id, req.buildingId]);
    if (target.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found in this building' });
    }
    const rateCents = await getRateCents(req.buildingId ?? null);
    const connectTime = new Date(plug_connect_time || Date.now());
    const disconnectTime = new Date(plug_disconnect_time || Date.now());
    // Try to find matching app session
    const match = await matchSession(req.buildingId ?? null, connectTime);
    const { amountCents } = await chargeUser(
      req.buildingId ?? null, user_id, parseFloat(kwh), rateCents, match?.sessionId ?? null, connectTime, disconnectTime
    );
    res.json({ success: true, data: { amount_cents: amountCents, matched_session: match?.sessionId ?? null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to charge wallet' });
  }
});

/** POST /wallet/import — admin: bulk import parsed CP sessions via ChargePoint CSV */
router.post('/import', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { csv } = req.body;
  try {
    if (!csv) {
      return res.status(400).json({ success: false, error: 'csv field is required' });
    }

    // Idempotency check — prevent double-importing the same CSV (per building)
    const csvHash = crypto.createHash('sha256').update(csv).digest('hex');
    const existing = await query(`SELECT id FROM report_imports WHERE csv_hash = $1 AND building_id = $2`, [csvHash, req.buildingId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'This CSV has already been imported. Duplicate imports are blocked to prevent double-charging.',
      });
    }

    const rows = parseChargePointCSV(csv); // throws if required columns missing
    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid sessions found in CSV' });
    }

    const result = await processRows(req.buildingId ?? null, rows, 'manual', undefined, csvHash);
    res.json({ success: true, data: result });
  } catch (err: any) {
    console.error(err);
    // CSV format errors (missing columns) are client errors — return 400 with the message
    const isCsvError = err?.message?.includes('CSV');
    res.status(isCsvError ? 400 : 500).json({ success: false, error: err?.message || 'Import failed' });
  }
});

/** GET /wallet/reports — admin: history of all imports */
router.get('/reports', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT id, source, filename, processed_at, rows_total, rows_matched, rows_unmatched, unknown_drivers, total_deducted_cents, notes
       FROM report_imports WHERE building_id = $1 ORDER BY processed_at DESC LIMIT 50`,
      [req.buildingId]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to fetch reports' });
  }
});

/** DELETE /wallet/reports/:id — admin: clear a bad import so the same CSV can be re-uploaded */
router.delete('/reports/:id', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const r = await query(`DELETE FROM report_imports WHERE id = $1 AND building_id = $2 RETURNING id`, [id, req.buildingId]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Report not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to delete report' });
  }
});

/** GET /wallet/drivers — admin: list all ChargePoint drivers with mapping status */
router.get('/drivers', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT cd.*, u.name as mapped_user_name, u.email as mapped_user_email
       FROM chargepoint_drivers cd
       LEFT JOIN users u ON u.id = cd.user_id
       WHERE cd.building_id = $1
       ORDER BY cd.status ASC, cd.last_seen_at DESC`,
      [req.buildingId]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to fetch drivers' });
  }
});

/** POST /wallet/drivers/:id/map — admin: map a driver to an app user */
router.post('/drivers/:id/map', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });
  try {
    // Both the driver and the target resident must belong to this building.
    const target = await query(`SELECT id FROM users WHERE id = $1 AND building_id = $2`, [user_id, req.buildingId]);
    if (target.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found in this building' });
    }
    const r = await query(
      `UPDATE chargepoint_drivers SET user_id = $1, status = 'mapped' WHERE id = $2 AND building_id = $3 RETURNING *`,
      [user_id, req.params.id, req.buildingId]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Driver not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to map driver' });
  }
});

/** POST /wallet/drivers/:id/unmap — admin: revert a mapped driver back to pending */
router.post('/drivers/:id/unmap', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE chargepoint_drivers SET user_id = NULL, status = 'pending' WHERE id = $1 AND building_id = $2 RETURNING id, driver_name`,
      [req.params.id, req.buildingId]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Driver not found' });
    console.log(`[billing] Driver unmapped: ${r.rows[0].driver_name} (${req.params.id})`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to unmap driver' });
  }
});

/** POST /wallet/drivers/:id/ignore — admin: dismiss a driver so future ingests skip them silently */
router.post('/drivers/:id/ignore', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE chargepoint_drivers SET is_ignored = true WHERE id = $1 AND building_id = $2 RETURNING id`,
      [req.params.id, req.buildingId]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Driver not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to ignore driver' });
  }
});

/** POST /wallet/drivers/:id/unignore — admin: restore a previously ignored driver */
router.post('/drivers/:id/unignore', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE chargepoint_drivers SET is_ignored = false WHERE id = $1 AND building_id = $2 RETURNING id`,
      [req.params.id, req.buildingId]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Driver not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to unignore driver' });
  }
});

/** DELETE /wallet/drivers/:id/transactions — admin: remove all CP-sourced transactions for this driver so sessions can be re-imported */
router.delete('/drivers/:id/transactions', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const driverRes = await query(
      `SELECT user_id, driver_name FROM chargepoint_drivers WHERE id = $1 AND building_id = $2`,
      [req.params.id, req.buildingId]
    );
    if (driverRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Driver not found' });
    const driver = driverRes.rows[0];
    if (!driver.user_id) return res.status(400).json({ success: false, error: 'Driver has no mapped user' });

    // Atomically delete transactions and refund the balance in one transaction
    const { deleted, refunded_cents } = await withTransaction(async (client) => {
      const txRes = await client.query(
        `DELETE FROM wallet_transactions
         WHERE user_id = $1 AND building_id = $2 AND chargepoint_session_id IS NOT NULL AND type = 'charge'
         RETURNING amount_cents`,
        [driver.user_id, req.buildingId]
      );
      const totalRefundCents = txRes.rows.reduce((sum: number, t: any) => sum + Math.abs(t.amount_cents), 0);
      if ((txRes.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE wallets SET balance_cents = balance_cents + $1, updated_at = NOW() WHERE user_id = $2`,
          [totalRefundCents, driver.user_id]
        );
      }
      return { deleted: txRes.rowCount ?? 0, refunded_cents: totalRefundCents };
    });

    res.json({ success: true, data: { deleted, refunded_cents } });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message || 'Failed to clear transactions' });
  }
});

/** POST /wallet/drivers/:id/create-placeholder — admin: create a placeholder user for an unmapped driver */
router.post('/drivers/:id/create-placeholder', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const driverRes = await query(
      `SELECT id, driver_name, user_id FROM chargepoint_drivers WHERE id = $1 AND building_id = $2`,
      [req.params.id, req.buildingId]
    );
    if (driverRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Driver not found' });
    const driver = driverRes.rows[0];
    if (driver.user_id) return res.status(409).json({ success: false, error: 'Driver already mapped' });

    // Placeholder email derived from driver name, made globally unique per building
    // (email stays globally unique across tenants, so scope the synthetic address).
    const slug = driver.driver_name.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.]/g, '');
    const bldgSuffix = String(req.buildingId).slice(0, 8);
    const placeholderEmail = `${slug}.placeholder.${bldgSuffix}@2020ev.internal`;

    // Create placeholder user (no real password — bcrypt of a random UUID they can never log in with)
    const bcrypt = await import('bcryptjs');
    const fakeHash = await bcrypt.hash(crypto.randomUUID(), 8);

    const userRes = await query(
      `INSERT INTO users (name, email, password_hash, role, is_placeholder, building_id)
       VALUES ($1, $2, $3, 'member', true, $4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, email`,
      [driver.driver_name, placeholderEmail, fakeHash, req.buildingId]
    );
    const newUser = userRes.rows[0];

    await ensureWallet(newUser.id, req.buildingId ?? null);

    await query(
      `UPDATE chargepoint_drivers SET user_id = $1, status = 'mapped' WHERE id = $2 AND building_id = $3`,
      [newUser.id, req.params.id, req.buildingId]
    );

    res.json({ success: true, data: { user: newUser } });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message || 'Failed to create placeholder' });
  }
});

/** POST /wallet/drivers/:id/reprocess — admin: retroactively charge pending sessions after mapping */
router.post('/drivers/:id/reprocess', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { sessions } = req.body as {
    sessions?: Array<{
      plug_in_event_id: string;
      kwh: number;
      plug_connect_time: string;
      plug_disconnect_time: string;
    }>;
  };

  if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
    return res.status(400).json({ success: false, error: 'sessions array required' });
  }

  try {
    // Fetch the driver to get the mapped user_id
    const driverRes = await query(
      `SELECT user_id, status, driver_name FROM chargepoint_drivers WHERE id = $1 AND building_id = $2`,
      [req.params.id, req.buildingId]
    );
    if (driverRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Driver not found' });
    }
    const driver = driverRes.rows[0];
    if (driver.status !== 'mapped' || !driver.user_id) {
      return res.status(400).json({ success: false, error: 'Driver is not mapped to a user yet' });
    }

    const rateCents = await getRateCents(req.buildingId ?? null);
    let charged = 0;
    let skipped = 0;
    const results: any[] = [];

    for (const s of sessions) {
      const connectTime    = new Date(s.plug_connect_time);
      const disconnectTime = new Date(s.plug_disconnect_time);
      const kwh = parseFloat(String(s.kwh));

      if (isNaN(kwh) || kwh <= 0) { skipped++; continue; }

      const match = await matchSession(req.buildingId ?? null, connectTime);
      const { amountCents, alreadyBilled: wasAlreadyBilled } = await chargeUser(
        req.buildingId ?? null,
        driver.user_id,
        kwh,
        rateCents,
        match?.sessionId ?? null,
        connectTime,
        disconnectTime,
        s.plug_in_event_id || undefined
      );
      if (wasAlreadyBilled) { skipped++; continue; }
      charged++;
      results.push({ plug_in_event_id: s.plug_in_event_id, kwh, amountCents });
    }

    res.json({ success: true, data: { charged, skipped, results } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Reprocess failed' });
  }
});

/** GET /wallet/activity — admin: recent charge transactions across all users */
router.get('/activity', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT wt.id, wt.user_id, u.name as user_name, wt.amount_cents, wt.kwh,
              wt.rate_cents_per_kwh, wt.description, wt.chargepoint_session_id, wt.created_at
       FROM wallet_transactions wt
       JOIN users u ON u.id = wt.user_id
       WHERE wt.type = 'charge' AND (wt.kwh IS NOT NULL OR wt.description LIKE 'Idle fee%') AND wt.building_id = $1
       ORDER BY wt.created_at DESC
       LIMIT 100`,
      [req.buildingId]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[wallet] Failed to fetch billing activity:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch billing activity' });
  }
});

/** POST /wallet/assistant — resident: ask a plain-English question about their own
 *  charging/wallet. Answered by Claude, grounded in the resident's own data.
 *  Dormant (503) until ANTHROPIC_API_KEY is configured. */
router.post('/assistant', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  if (!aiConfigured()) {
    return res.status(503).json({ success: false, error: 'AI assistant is not enabled yet.' });
  }
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question || question.length > 500) {
    return res.status(400).json({ success: false, error: 'question is required (max 500 chars)' });
  }
  try {
    await ensureWallet(req.user!.userId, req.buildingId ?? null);
    const rateCents = await getRateCents(req.buildingId ?? null);
    const [walletRes, txRes] = await Promise.all([
      query(`SELECT balance_cents FROM wallets WHERE user_id = $1`, [req.user!.userId]),
      query(
        `SELECT amount_cents, type, description, kwh, created_at
         FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [req.user!.userId]
      ),
    ]);
    const answer = await askBillingAssistant(
      {
        balanceDollars: (walletRes.rows[0]?.balance_cents ?? 0) / 100,
        rateCentsPerKwh: rateCents,
        transactions: txRes.rows.map((t: any) => ({
          date: new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          type: t.type,
          description: t.description,
          kwh: t.kwh != null ? parseFloat(String(t.kwh)) : null,
          amountDollars: t.amount_cents / 100,
        })),
      },
      question
    );
    res.json({ success: true, data: { answer } });
  } catch (err: any) {
    console.error('[assistant] Failed:', err?.message);
    res.status(500).json({ success: false, error: 'Assistant is unavailable right now.' });
  }
});

/** GET /wallet/statement?month=YYYY-MM — admin: monthly building billing statement.
 *  Aggregates charge transactions in the month by resident, plus building totals.
 *  This is the report a manager reconciles with the association's books. */
router.get('/statement', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    // Default to the current month (server time) if none supplied
    const now = new Date();
    const monthStr = /^\d{4}-\d{2}$/.test(String(req.query.month))
      ? String(req.query.month)
      : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const [yr, mo] = monthStr.split('-').map(Number);
    const start = new Date(Date.UTC(yr, mo - 1, 1));
    const end = new Date(Date.UTC(yr, mo, 1)); // exclusive — first of next month

    const rowsRes = await query(
      `SELECT u.id, u.name, u.unit_number,
              COUNT(wt.id)                       AS sessions,
              COALESCE(SUM(wt.kwh), 0)           AS total_kwh,
              COALESCE(SUM(-wt.amount_cents), 0) AS billed_cents,
              COALESCE(w.balance_cents, 0)       AS balance_cents
       FROM users u
       LEFT JOIN wallet_transactions wt
         ON wt.user_id = u.id
        AND wt.type = 'charge' AND wt.kwh IS NOT NULL
        AND wt.created_at >= $1 AND wt.created_at < $2
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.building_id = $3
       GROUP BY u.id, u.name, u.unit_number, w.balance_cents
       HAVING COUNT(wt.id) > 0 OR COALESCE(w.balance_cents, 0) <> 0
       ORDER BY billed_cents DESC, u.name ASC`,
      [start, end, req.buildingId]
    );

    const rows = rowsRes.rows.map((r: any) => ({
      user_id: r.id,
      name: r.name,
      unit_number: r.unit_number,
      sessions: Number(r.sessions),
      total_kwh: Number(r.total_kwh),
      billed_cents: Number(r.billed_cents),
      balance_cents: Number(r.balance_cents),
    }));

    const totals = rows.reduce(
      (acc, r) => ({
        residents: acc.residents + (r.sessions > 0 ? 1 : 0),
        sessions: acc.sessions + r.sessions,
        total_kwh: acc.total_kwh + r.total_kwh,
        recovered_cents: acc.recovered_cents + r.billed_cents,
      }),
      { residents: 0, sessions: 0, total_kwh: 0, recovered_cents: 0 }
    );

    const rateCents = await getRateCents(req.buildingId ?? null);

    res.json({
      success: true,
      data: {
        month: monthStr,
        generated_at: new Date().toISOString(),
        rate_cents_per_kwh: rateCents,
        totals,
        rows,
      },
    });
  } catch (err) {
    console.error('[wallet] Failed to build statement:', err);
    res.status(500).json({ success: false, error: 'Failed to build statement' });
  }
});

/** POST /wallet/statement/summary — admin: AI-written plain-English summary of a
 *  month's statement, for the board. Body: { month, rate_cents, totals, rows }.
 *  Dormant (503) until ANTHROPIC_API_KEY is configured. */
router.post('/statement/summary', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  if (!aiConfigured()) {
    return res.status(503).json({ success: false, error: 'AI summary is not enabled yet.' });
  }
  const { month, rate_cents, totals, rows } = req.body ?? {};
  if (!month || !totals || !Array.isArray(rows)) {
    return res.status(400).json({ success: false, error: 'month, totals, and rows are required' });
  }
  try {
    const monthLabel = (() => {
      const [y, mo] = String(month).split('-').map(Number);
      return new Date(y, (mo || 1) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    })();
    const summary = await summarizeMonth({
      monthLabel,
      rateCentsPerKwh: Number(rate_cents) || 18,
      totals: {
        residents: Number(totals.residents) || 0,
        sessions: Number(totals.sessions) || 0,
        total_kwh: Number(totals.total_kwh) || 0,
        recovered_cents: Number(totals.recovered_cents) || 0,
      },
      rows: rows.slice(0, 40).map((r: any) => ({
        name: String(r.name ?? 'Resident'),
        sessions: Number(r.sessions) || 0,
        total_kwh: Number(r.total_kwh) || 0,
        billed_cents: Number(r.billed_cents) || 0,
      })),
    });
    res.json({ success: true, data: { summary } });
  } catch (err: any) {
    console.error('[assistant] Summary failed:', err?.message);
    res.status(500).json({ success: false, error: 'Summary is unavailable right now.' });
  }
});

/** GET /wallet/insights — admin: board-facing dashboard data.
 *  6-month trend, all-time totals, and top residents — the ROI-at-a-glance view. */
router.get('/insights', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const [trendRes, topRes, totalsRes] = await Promise.all([
      query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                COUNT(*)                          AS sessions,
                COALESCE(SUM(kwh), 0)             AS kwh,
                COALESCE(SUM(-amount_cents), 0)   AS recovered_cents
         FROM wallet_transactions
         WHERE type = 'charge' AND kwh IS NOT NULL AND building_id = $1
           AND created_at >= date_trunc('month', NOW()) - interval '5 months'
         GROUP BY 1 ORDER BY 1`,
        [req.buildingId]
      ),
      query(
        `SELECT u.name,
                COUNT(wt.id)                        AS sessions,
                COALESCE(SUM(wt.kwh), 0)            AS kwh,
                COALESCE(SUM(-wt.amount_cents), 0)  AS recovered_cents
         FROM wallet_transactions wt
         JOIN users u ON u.id = wt.user_id
         WHERE wt.type = 'charge' AND wt.kwh IS NOT NULL AND wt.building_id = $1
         GROUP BY u.id, u.name
         ORDER BY recovered_cents DESC
         LIMIT 5`,
        [req.buildingId]
      ),
      query(
        `SELECT COUNT(*)                        AS sessions,
                COALESCE(SUM(kwh), 0)           AS kwh,
                COALESCE(SUM(-amount_cents), 0) AS recovered_cents,
                COUNT(DISTINCT user_id)         AS residents
         FROM wallet_transactions
         WHERE type = 'charge' AND kwh IS NOT NULL AND building_id = $1`,
        [req.buildingId]
      ),
    ]);

    const num = (v: any) => Number(v);
    res.json({
      success: true,
      data: {
        trend: trendRes.rows.map((r: any) => ({
          month: r.month, sessions: num(r.sessions),
          kwh: num(r.kwh), recovered_cents: num(r.recovered_cents),
        })),
        top_residents: topRes.rows.map((r: any) => ({
          name: r.name, sessions: num(r.sessions),
          kwh: num(r.kwh), recovered_cents: num(r.recovered_cents),
        })),
        totals: {
          sessions: num(totalsRes.rows[0]?.sessions ?? 0),
          kwh: num(totalsRes.rows[0]?.kwh ?? 0),
          recovered_cents: num(totalsRes.rows[0]?.recovered_cents ?? 0),
          residents: num(totalsRes.rows[0]?.residents ?? 0),
        },
      },
    });
  } catch (err) {
    console.error('[wallet] Failed to build insights:', err);
    res.status(500).json({ success: false, error: 'Failed to build insights' });
  }
});

/** POST /wallet/inbound-report — Mailgun webhook: auto-process emailed CSV */
router.post('/inbound-report', async (req: Request, res: Response) => {
  // Verify Mailgun signature — always required (fail-secure)
  const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!signingKey) {
    console.error('[wallet] MAILGUN_WEBHOOK_SIGNING_KEY is not set — rejecting inbound-report request');
    return res.status(503).json({ success: false, error: 'Webhook not configured on server' });
  }
  const { timestamp, token, signature } = req.body;
  if (!timestamp || !token || !signature) {
    return res.status(401).json({ success: false, error: 'Missing Mailgun signature fields' });
  }
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(timestamp + token)
    .digest('hex');
  const sigBuf = Buffer.from(String(signature));
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn('[wallet] Mailgun signature mismatch — possible spoofed request');
    return res.status(401).json({ success: false, error: 'Invalid Mailgun signature' });
  }

  try {
    // Legacy email ingestion serves the default building only (the Mailgun webhook
    // carries no building context). Per-building email ingestion is future work.
    const bRes = await query(`SELECT id FROM buildings WHERE slug = '2020'`);
    const buildingId: string | null = bRes.rows[0]?.id ?? null;

    const attachmentJson = req.body['attachments'];
    let csvContent: string | null = null;
    let filename = 'email-report.csv';

    if (attachmentJson) {
      try {
        const attachments = JSON.parse(attachmentJson);
        if (Array.isArray(attachments) && attachments[0]) {
          filename = attachments[0].name || filename;
          csvContent = attachments[0].data || null;
        }
      } catch {}
    }

    if (!csvContent && req.body['body-plain']) {
      csvContent = req.body['body-plain'];
    }

    if (!csvContent) {
      return res.status(400).json({ success: false, error: 'No CSV attachment found' });
    }

    const rows = parseChargePointCSV(csvContent);
    if (rows.length === 0) {
      await query(
        `INSERT INTO report_imports (source, filename, rows_total, rows_matched, rows_unmatched, notes, building_id)
         VALUES ('email', $1, 0, 0, 0, 'No valid rows found in CSV', $2)`,
        [filename, buildingId]
      );
      return res.json({ success: true, data: { rows_total: 0, rows_matched: 0 } });
    }

    const result = await processRows(buildingId, rows, 'email', filename);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Inbound report error:', err);
    res.status(500).json({ success: false, error: 'Failed to process report' });
  }
});

export default router;
