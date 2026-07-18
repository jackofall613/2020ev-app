/**
 * Super-admin (platform operator) routes — building fleet management.
 * Every route here requires role 'super_admin'. Building admins never reach these.
 */
import { Router, Response } from 'express';
import { authenticate, requireSuperAdmin, AuthRequest } from '../middleware/auth';
import { query, pool } from '../db';
import { generateInviteToken } from '../utils/invite';
import { signImpersonationToken } from '../utils/jwt';
import { config } from '../config';

const router = Router();
router.use(authenticate, requireSuperAdmin);

const BILLING_STATUSES = ['trial', 'active', 'past_due', 'canceled'];

/** GET /admin/buildings — every building + resident count + MRR. */
router.get('/buildings', async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(`
      SELECT b.id, b.slug, b.name, b.timezone, b.plan, b.price_cents, b.billing_status, b.created_at,
             b.cp_station_id,
             (b.cp_api_key_enc IS NOT NULL AND b.cp_api_password_enc IS NOT NULL) AS has_cp_creds,
             COALESCE(m.cnt, 0)::int AS resident_count,
             COALESCE(a.cnt, 0)::int AS admin_count
      FROM buildings b
      LEFT JOIN (SELECT building_id, COUNT(*) cnt FROM users WHERE role = 'member'  GROUP BY building_id) m ON m.building_id = b.id
      LEFT JOIN (SELECT building_id, COUNT(*) cnt FROM users WHERE role = 'admin'   GROUP BY building_id) a ON a.building_id = b.id
      ORDER BY b.created_at
    `);
    const mrrCents = r.rows
      .filter((b: any) => b.billing_status === 'active')
      .reduce((s: number, b: any) => s + (b.price_cents || 0), 0);
    res.json({ success: true, data: { buildings: r.rows, mrr_cents: mrrCents } });
  } catch (err: any) {
    console.error('[admin] list buildings failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to list buildings' });
  }
});

/** POST /admin/buildings — provision a building + generate its first admin invite. */
router.post('/buildings', async (req: AuthRequest, res: Response) => {
  const { name, slug, plan, price_cents, timezone, admin_email } = req.body ?? {};
  const cleanSlug = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!name || typeof name !== 'string' || !cleanSlug) {
    return res.status(400).json({ success: false, error: 'name and a valid slug are required' });
  }
  const priceCents = Number.isInteger(price_cents) ? price_cents : 19900;
  try {
    const b = await query(
      `INSERT INTO buildings (slug, name, timezone, plan, price_cents, billing_status)
       VALUES ($1, $2, COALESCE($3,'America/New_York'), COALESCE($4,'standard'), $5, 'trial')
       RETURNING id, slug, name, plan, price_cents, billing_status, timezone`,
      [cleanSlug, name.trim(), timezone || null, plan || null, priceCents]
    );
    const building = b.rows[0];

    // One-time invite for the building's first admin.
    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + config.invite.expiryHours * 60 * 60 * 1000);
    await query(
      `INSERT INTO invite_codes (token, email, created_by, expires_at, building_id, role)
       VALUES ($1, $2, $3, $4, $5, 'admin')`,
      [token, admin_email ? String(admin_email).trim().toLowerCase() : null, req.user!.userId, expiresAt, building.id]
    );

    res.status(201).json({
      success: true,
      data: { building, invite_token: token, invite_url: `ev2020://invite?token=${token}`, invite_expires_at: expiresAt },
    });
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'A building with that slug already exists' });
    }
    console.error('[admin] create building failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to create building' });
  }
});

/** PATCH /admin/buildings/:id — update subscription + metadata. */
router.patch('/buildings/:id', async (req: AuthRequest, res: Response) => {
  const { name, plan, price_cents, billing_status, timezone } = req.body ?? {};
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (typeof name === 'string' && name.trim()) { sets.push(`name = $${i++}`); vals.push(name.trim()); }
  if (typeof plan === 'string') { sets.push(`plan = $${i++}`); vals.push(plan); }
  if (Number.isInteger(price_cents)) { sets.push(`price_cents = $${i++}`); vals.push(price_cents); }
  if (typeof timezone === 'string' && timezone.trim()) { sets.push(`timezone = $${i++}`); vals.push(timezone.trim()); }
  if (typeof billing_status === 'string') {
    if (!BILLING_STATUSES.includes(billing_status)) {
      return res.status(400).json({ success: false, error: `billing_status must be one of ${BILLING_STATUSES.join(', ')}` });
    }
    sets.push(`billing_status = $${i++}`); vals.push(billing_status);
  }
  if (sets.length === 0) return res.status(400).json({ success: false, error: 'Nothing to update' });
  vals.push(req.params.id);
  try {
    const r = await query(
      `UPDATE buildings SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, slug, name, plan, price_cents, billing_status, timezone`,
      vals
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Building not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err: any) {
    console.error('[admin] update building failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update building' });
  }
});

/**
 * POST /admin/buildings/:id/impersonate — "view as" this building's admin.
 * Mints a 30-minute, non-refreshable token carrying an `act` (impersonation)
 * claim and records the session in portal_access_log. Every mutating action taken
 * under this token is additionally logged (see resolveBuilding).
 */
router.post('/buildings/:id/impersonate', async (req: AuthRequest, res: Response) => {
  try {
    const b = await query(`SELECT id, name, slug FROM buildings WHERE id = $1`, [req.params.id]);
    if (b.rows.length === 0) return res.status(404).json({ success: false, error: 'Building not found' });

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const token = signImpersonationToken({
      userId: req.user!.userId,
      role: 'admin',                       // acts as this building's admin
      buildingId: req.params.id,
      act: { sub: req.user!.userId, imp: true },
    });

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : null;
    await query(
      `INSERT INTO portal_access_log (building_id, super_admin_user_id, action, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.params.id,
        req.user!.userId,
        reason ? `impersonation_started: ${reason}` : 'impersonation_started',
        req.ip ?? null,
        String(req.headers['user-agent'] || '').slice(0, 300) || null,
        expiresAt,
      ]
    );

    res.json({ success: true, data: { token, expires_at: expiresAt, building: b.rows[0] } });
  } catch (err: any) {
    console.error('[admin] impersonate failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to start impersonation' });
  }
});

/**
 * DELETE /admin/buildings/:id — permanently delete a building and ALL of its
 * tenant data. Destructive + irreversible. Guarded three ways:
 *   1. super-admin only (router-level requireSuperAdmin),
 *   2. the caller must echo the building's slug in the body ({ confirm_slug }),
 *   3. the default "2020" building can never be deleted.
 * Runs as a single transaction, removing child rows in FK-dependency order.
 */
router.delete('/buildings/:id', async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const b = await client.query(`SELECT id, slug, name FROM buildings WHERE id = $1`, [req.params.id]);
    if (b.rows.length === 0) return res.status(404).json({ success: false, error: 'Building not found' });
    const building = b.rows[0];

    if (building.slug === '2020') {
      return res.status(403).json({ success: false, error: 'The primary building cannot be deleted' });
    }
    const confirm = typeof req.body?.confirm_slug === 'string' ? req.body.confirm_slug.trim() : '';
    if (confirm !== building.slug) {
      return res.status(400).json({
        success: false,
        error: `Confirmation failed — send { "confirm_slug": "${building.slug}" } to delete this building`,
      });
    }

    await client.query('BEGIN');
    const rows: Record<string, number> = {};
    // refresh_tokens has no building_id — delete by the building's users first.
    rows.refresh_tokens = (await client.query(
      `DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE building_id = $1)`,
      [building.id]
    )).rowCount ?? 0;
    // Tenant tables in child→parent order (tables that reference users/sessions first).
    for (const t of ['wallet_transactions', 'wallets', 'sessions', 'feed_messages',
                     'chargepoint_drivers', 'report_imports', 'settings', 'invite_codes',
                     'portal_access_log', 'charger_queue']) {
      rows[t] = (await client.query(`DELETE FROM ${t} WHERE building_id = $1`, [building.id])).rowCount ?? 0;
    }
    rows.users = (await client.query(`DELETE FROM users WHERE building_id = $1`, [building.id])).rowCount ?? 0;
    await client.query(`DELETE FROM buildings WHERE id = $1`, [building.id]);
    await client.query('COMMIT');

    console.log(`[admin] building deleted: ${building.slug} (${building.id}) by super-admin ${req.user!.userId}`);
    res.json({ success: true, data: { deleted: { id: building.id, slug: building.slug, name: building.name }, rows } });
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[admin] delete building failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete building' });
  } finally {
    client.release();
  }
});

export default router;
