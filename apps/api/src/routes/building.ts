/**
 * GET /building — the caller's building (public-ish info for the admin dashboard
 * header + subscription banner). Scoped: a building admin gets their own building;
 * a super-admin gets whichever building they've selected via X-Building-Id.
 */
import { Router, Response } from 'express';
import { authenticate, resolveBuilding, requireBuilding, requireAdmin, AuthRequest } from '../middleware/auth';
import { query } from '../db';

const router = Router();

router.get('/', authenticate, resolveBuilding, requireBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT id, slug, name, timezone, plan, price_cents, billing_status FROM buildings WHERE id = $1`,
      [req.buildingId]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Building not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to load building' });
  }
});

/**
 * GET /building/access-log — the building admin's view of operator (super-admin)
 * access to their portal. Transparency: the customer can see every impersonation
 * session and action taken on their behalf.
 */
router.get('/access-log', authenticate, resolveBuilding, requireBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `SELECT pal.id, pal.action, pal.created_at, pal.expires_at, u.name AS operator_name
       FROM portal_access_log pal
       LEFT JOIN users u ON u.id = pal.super_admin_user_id
       WHERE pal.building_id = $1
       ORDER BY pal.created_at DESC
       LIMIT 100`,
      [req.buildingId]
    );
    res.json({ success: true, data: r.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to load access log' });
  }
});

export default router;
