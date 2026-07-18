import { Router, Response, Request } from 'express';
import { authenticate, requireAdmin, resolveBuilding, requireBuilding, AuthRequest } from '../middleware/auth';
import { getStationStatus, getChargingSessions, getCurrentLoad, getBuildingCpConfig } from '../services/chargepoint';
import { computeEtaHours } from '../utils/eta';
import { ingestYesterdaysSessions } from '../services/ingest';
import { query } from '../db';
import { safeEqual } from '../utils/secure';
import { encryptSecret, credEncryptionAvailable } from '../utils/crypto';

const router = Router();

// In-memory status cache (per building) so we don't hammer ChargePoint on every poll
const statusCache = new Map<string, { data: any; fetchedAt: number }>();
const STATUS_CACHE_MS = 60_000; // 1 minute

/**
 * GET /chargepoint/status
 * Real-time charger status for the caller's building — cached for 60s
 */
router.get('/status', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  const key = req.buildingId || 'none';
  try {
    const cfg = await getBuildingCpConfig(req.buildingId ?? null);
    if (!cfg) return res.status(503).json({ success: false, error: 'Charger not configured for this building' });

    const now = Date.now();
    const cached = statusCache.get(key);
    if (cached && now - cached.fetchedAt < STATUS_CACHE_MS) {
      return res.json({ success: true, data: cached.data, cached: true });
    }

    const status = await getStationStatus(cfg);
    statusCache.set(key, { data: status, fetchedAt: now });
    res.json({ success: true, data: status, cached: false });
  } catch (err: any) {
    console.error('ChargePoint status error:', err.message);
    // Return cached data if available, even if stale
    const cached = statusCache.get(key);
    if (cached) {
      return res.json({ success: true, data: cached.data, cached: true, stale: true });
    }
    res.status(503).json({ success: false, error: 'Charger status unavailable' });
  }
});

/**
 * GET /chargepoint/sessions?days=7
 * Recent sessions from ChargePoint for the caller's building
 */
router.get('/sessions', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const cfg = await getBuildingCpConfig(req.buildingId ?? null);
    if (!cfg) return res.status(503).json({ success: false, error: 'Charger not configured for this building' });
    const rawDays = parseInt(req.query.days as string || '7');
    const days = isNaN(rawDays) ? 7 : Math.max(1, Math.min(rawDays, 30));
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const to = new Date();
    const sessions = await getChargingSessions(cfg, from, to);
    res.json({ success: true, data: sessions });
  } catch (err: any) {
    console.error('ChargePoint sessions error:', err.message);
    res.status(503).json({ success: false, error: 'Session data unavailable' });
  }
});

/**
 * GET /chargepoint/load
 * Current power draw in kW for the caller's building
 */
router.get('/load', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const cfg = await getBuildingCpConfig(req.buildingId ?? null);
    if (!cfg) return res.status(503).json({ success: false, error: 'Charger not configured for this building' });
    const load = await getCurrentLoad(cfg);

    // v1.1 Feature 3: enrich with the active session's car-profile ETA, and
    // Feature 2's idle surfacing. Best-effort — the raw load always returns.
    let eta: {
      car_label: string | null;
      estimated_free_at: string | null;
      idle_minutes: number | null;
    } | null = null;
    try {
      const s = await query(
        `SELECT s.idle_reminder_at, u.name, u.car_model, u.battery_kwh, u.target_percent
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.building_id = $1 AND s.status = 'active'`,
        [req.buildingId]
      );
      const row = s.rows[0];
      if (row) {
        const firstName = String(row.name || '').split(' ')[0];
        const etaHours = row.battery_kwh && row.target_percent
          ? computeEtaHours(parseFloat(row.battery_kwh), row.target_percent, load.loadKw)
          : null;
        eta = {
          car_label: row.car_model ? `${firstName}’s ${row.car_model}` : null,
          estimated_free_at: etaHours != null
            ? new Date(Date.now() + etaHours * 60 * 60 * 1000).toISOString()
            : null,
          idle_minutes: row.idle_reminder_at && load.loadKw < 0.5
            ? Math.max(0, Math.round((Date.now() - new Date(row.idle_reminder_at).getTime()) / 60000))
            : null,
        };
      }
    } catch { /* enrichment is best-effort */ }

    res.json({ success: true, data: { ...load, eta } });
  } catch (err: any) {
    console.error('ChargePoint load error:', err.message);
    res.status(503).json({ success: false, error: 'Load data unavailable' });
  }
});

/**
 * GET /chargepoint/config
 * Building admin: current ChargePoint config status (never returns the secrets).
 */
router.get('/config', authenticate, resolveBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT cp_station_id, cp_api_key_enc, cp_api_password_enc FROM buildings WHERE id = $1`,
      [req.buildingId]
    );
    const b = r.rows[0] || {};
    res.json({
      success: true,
      data: {
        station_id: b.cp_station_id ?? null,
        has_api_key: Boolean(b.cp_api_key_enc),
        has_api_password: Boolean(b.cp_api_password_enc),
        encryption_available: credEncryptionAvailable(),
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to load config' });
  }
});

/**
 * PATCH /chargepoint/config
 * Building admin: set this building's charger station id + API credentials.
 * Credentials are encrypted at rest (AES-256-GCM). Requires CP_CRED_KEY.
 */
router.patch('/config', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { station_id, api_key, api_password } = req.body ?? {};
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  try {
    if (typeof station_id === 'string') {
      sets.push(`cp_station_id = $${i++}`);
      vals.push(station_id.trim());
    }
    if (typeof api_key === 'string' && api_key) {
      if (!credEncryptionAvailable()) {
        return res.status(503).json({ success: false, error: 'Credential encryption is not configured on the server (set CP_CRED_KEY).' });
      }
      sets.push(`cp_api_key_enc = $${i++}`);
      vals.push(encryptSecret(api_key));
    }
    if (typeof api_password === 'string' && api_password) {
      if (!credEncryptionAvailable()) {
        return res.status(503).json({ success: false, error: 'Credential encryption is not configured on the server (set CP_CRED_KEY).' });
      }
      sets.push(`cp_api_password_enc = $${i++}`);
      vals.push(encryptSecret(api_password));
    }
    if (sets.length === 0) {
      return res.status(400).json({ success: false, error: 'Provide station_id, api_key, and/or api_password' });
    }
    vals.push(req.buildingId);
    await query(`UPDATE buildings SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[chargepoint] Failed to save config:', err.message);
    res.status(500).json({ success: false, error: 'Failed to save config' });
  }
});

/**
 * POST /chargepoint/ingest
 * Manually trigger yesterday's auto-ingest (admin only).
 * Railway cron calls this daily at 9 AM: POST /chargepoint/ingest
 * with header X-Ingest-Secret matching INGEST_SECRET env var.
 */
router.post('/ingest', async (req: Request, res: Response) => {
  // Accept either admin JWT or the ingest secret header (for Railway cron)
  const secret = process.env.INGEST_SECRET;
  const headerSecret = req.headers['x-ingest-secret'];
  if (!secret || !safeEqual(headerSecret, secret)) {
    // Fall back to requiring admin JWT
    return authenticate(req as AuthRequest, res, async () => {
      return requireAdmin(req as AuthRequest, res, async () => {
        await runIngest(res);
      });
    });
  }
  await runIngest(res);
});

async function runIngest(res: Response) {
  try {
    const result = await ingestYesterdaysSessions();
    res.json({ success: true, data: result });
  } catch (err: any) {
    console.error('[ingest] Failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /chargepoint/reconcile-drivers
 * Secret-protected maintenance (X-Ingest-Secret). Links SOAP CP_USER_<id> phantom
 * driver records to residents by ChargePoint numeric user ID so daily auto-ingest
 * bills them. Idempotent — safe to re-run.
 *   1. Backfills chargepoint_user_id on CP_USER_ records from the account-number suffix
 *   2. Optional body { links: [{ cp_user_id, user_email }] } explicitly maps a phantom
 *      to a resident and backfills that resident's real account with the numeric ID
 *   3. Auto-links any remaining pending phantom that shares a numeric ID with a
 *      resident already mapped under their real account
 */
router.post('/reconcile-drivers', async (req: Request, res: Response) => {
  const secret = process.env.INGEST_SECRET;
  if (!secret || !safeEqual(req.headers['x-ingest-secret'], secret)) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  try {
    const summary: any = { backfilled_ids: 0, explicit_links: [] as any[], auto_links: [] as string[] };

    // 1. Backfill numeric ID on phantoms from their CP_USER_<id> suffix
    const bf = await query(
      `UPDATE chargepoint_drivers
       SET chargepoint_user_id = substring(driver_account_number from 'CP_USER_(.*)')
       WHERE driver_account_number LIKE 'CP_USER_%'
         AND (chargepoint_user_id IS NULL OR chargepoint_user_id = '')
       RETURNING id`
    );
    summary.backfilled_ids = bf.rowCount ?? 0;

    // 2. Explicit links from request body
    const links = Array.isArray(req.body?.links) ? req.body.links : [];
    for (const link of links) {
      const cpUserId = String(link?.cp_user_id ?? '').trim();
      const email = String(link?.user_email ?? '').trim().toLowerCase();
      if (!cpUserId || !email) {
        summary.explicit_links.push({ cp_user_id: cpUserId, error: 'missing cp_user_id or user_email' });
        continue;
      }
      const userRes = await query(`SELECT id, name, building_id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
      if (!userRes.rows[0]) {
        summary.explicit_links.push({ cp_user_id: cpUserId, error: `no user with email ${email}` });
        continue;
      }
      const userId = userRes.rows[0].id;
      const userBuildingId = userRes.rows[0].building_id;
      // Only link phantom driver records within the resident's own building.
      const mapRes = await query(
        `UPDATE chargepoint_drivers
         SET user_id = $1, status = 'mapped', is_ignored = false
         WHERE driver_account_number LIKE 'CP_USER_%'
           AND building_id = $4
           AND (driver_account_number = $2 OR chargepoint_user_id = $3)
         RETURNING id`,
        [userId, `CP_USER_${cpUserId}`, cpUserId, userBuildingId]
      );
      // Backfill the resident's real account with the numeric ID so future SOAP
      // sessions auto-cross-link even if this phantom record is ever removed.
      await query(
        `UPDATE chargepoint_drivers
         SET chargepoint_user_id = $1
         WHERE user_id = $2 AND driver_account_number NOT LIKE 'CP_USER_%'
           AND (chargepoint_user_id IS NULL OR chargepoint_user_id = '')`,
        [cpUserId, userId]
      );
      summary.explicit_links.push({ cp_user_id: cpUserId, user: userRes.rows[0].name, mapped: mapRes.rowCount ?? 0 });
    }

    // 3. Auto-link remaining pending phantoms by shared numeric ID
    const auto = await query(
      `UPDATE chargepoint_drivers AS phantom
       SET user_id = real.user_id, status = 'mapped'
       FROM chargepoint_drivers AS real
       WHERE phantom.driver_account_number LIKE 'CP_USER_%'
         AND phantom.status = 'pending'
         AND phantom.user_id IS NULL
         AND phantom.chargepoint_user_id IS NOT NULL
         AND real.chargepoint_user_id = phantom.chargepoint_user_id
         AND real.building_id = phantom.building_id
         AND real.driver_account_number NOT LIKE 'CP_USER_%'
         AND real.status = 'mapped'
         AND real.user_id IS NOT NULL
       RETURNING phantom.driver_account_number AS acct`
    );
    summary.auto_links = auto.rows.map((r: any) => r.acct);

    res.json({ success: true, data: summary });
  } catch (err: any) {
    console.error('[reconcile] Failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
