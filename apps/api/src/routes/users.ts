import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { authenticate, requireAdmin, resolveBuilding, AuthRequest } from '../middleware/auth';
import { query, pool } from '../db';

const router = Router();

// GET /users — all users in the caller's building (members see list, no sensitive data)
router.get('/', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'SELECT id, name, role, priority_day, unit_number FROM users WHERE building_id = $1 ORDER BY created_at',
      [req.buildingId]
    );
    res.json({ success: true, data: result.rows });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// POST /users/push-token — register or update device push token
router.post('/push-token', authenticate, async (req: AuthRequest, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.length > 512) {
    return res.status(400).json({ success: false, error: 'token required' });
  }
  try {
    await query(
      `UPDATE users SET push_token = $1, updated_at = NOW() WHERE id = $2`,
      [token, req.user!.userId]
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to save push token' });
  }
});

// PATCH /users/me — update push token, name, unit number, avatar, or car profile
router.patch('/me', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, push_token, unit_number, avatar_url, car_make, car_model, battery_kwh, target_percent } = req.body;
  try {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
        return res.status(400).json({ success: false, error: 'name must be 1–100 characters' });
      }
      fields.push(`name = $${idx++}`); values.push(name.trim());
    }
    // Ignore null push_token — explicit null would clear notifications silently
    if (push_token !== undefined && push_token !== null) {
      if (typeof push_token !== 'string' || push_token.length > 512) {
        return res.status(400).json({ success: false, error: 'push_token must be a string under 512 characters' });
      }
      fields.push(`push_token = $${idx++}`); values.push(push_token);
    }
    if (unit_number !== undefined) { fields.push(`unit_number = $${idx++}`); values.push(unit_number); }
    if (avatar_url !== undefined && avatar_url !== null) {
      if (typeof avatar_url !== 'string' || avatar_url.length > 512) {
        return res.status(400).json({ success: false, error: 'avatar_url must be under 512 characters' });
      }
      fields.push(`avatar_url = $${idx++}`); values.push(avatar_url);
    }
    // Car profile (v1.1 Feature 3) — all optional, null clears a field.
    for (const [key, val] of [['car_make', car_make], ['car_model', car_model]] as const) {
      if (val !== undefined) {
        if (val !== null && (typeof val !== 'string' || val.length > 60)) {
          return res.status(400).json({ success: false, error: `${key} must be a string under 60 characters` });
        }
        fields.push(`${key} = $${idx++}`); values.push(val === null ? null : val.trim() || null);
      }
    }
    if (battery_kwh !== undefined) {
      const kwh = battery_kwh === null ? null : parseFloat(String(battery_kwh));
      if (kwh !== null && (isNaN(kwh) || kwh < 10 || kwh > 300)) {
        return res.status(400).json({ success: false, error: 'battery_kwh must be between 10 and 300' });
      }
      fields.push(`battery_kwh = $${idx++}`); values.push(kwh);
    }
    if (target_percent !== undefined) {
      const pct = target_percent === null ? null : parseInt(String(target_percent), 10);
      if (pct !== null && (isNaN(pct) || pct < 50 || pct > 100)) {
        return res.status(400).json({ success: false, error: 'target_percent must be between 50 and 100' });
      }
      fields.push(`target_percent = $${idx++}`); values.push(pct);
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: 'Nothing to update' });
    }

    values.push(req.user!.userId);
    const result = await query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, role, priority_day, unit_number, avatar_url, car_make, car_model, battery_kwh, target_percent`,
      values
    );
    res.json({ success: true, data: result.rows[0] });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to update profile' });
  }
});

// DELETE /users/me — self-service account deletion (App Store Guideline 5.1.1(v)).
// Scrubs all PII and credentials but keeps the pseudonymized billing history —
// wallet transactions are the building's financial records.
// NOTE: must stay registered before DELETE /users/:id or ':id' would swallow 'me'.
router.delete('/me', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    if (req.user!.role === 'admin') {
      const admins = await query(`SELECT COUNT(*) FROM users WHERE role = 'admin' AND building_id = $1`, [req.buildingId]);
      if (parseInt(admins.rows[0].count) <= 1) {
        return res.status(400).json({
          success: false,
          error: 'You are the only admin. Make another resident admin before deleting your account.',
        });
      }
    }

    const anonEmail = `deleted.${userId.slice(0, 8)}@2020ev.internal`;
    const deadHash = await bcrypt.hash(crypto.randomUUID(), 8);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      const r = await client.query(
        `UPDATE users
         SET name = 'Former resident', email = $2, password_hash = $3,
             push_token = NULL, avatar_url = NULL, priority_day = NULL,
             unit_number = NULL, is_placeholder = true, role = 'member'
         WHERE id = $1
         RETURNING id`,
        [userId, anonEmail, deadHash]
      );
      if (r.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[users] Account deletion failed:', err);
    res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
});

// PATCH /users/:id — admin: update priority_day, role (within their building)
router.patch('/:id', authenticate, resolveBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { priority_day, role, unit_number } = req.body;

  const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', null];
  if (priority_day !== undefined && !validDays.includes(priority_day)) {
    return res.status(400).json({ success: false, error: 'Invalid day' });
  }

  try {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (priority_day !== undefined) { fields.push(`priority_day = $${idx++}`); values.push(priority_day); }
    if (role !== undefined) {
      if (!['admin', 'member'].includes(role)) {
        return res.status(400).json({ success: false, error: "role must be 'admin' or 'member'" });
      }
      fields.push(`role = $${idx++}`); values.push(role);
    }
    if (unit_number !== undefined) { fields.push(`unit_number = $${idx++}`); values.push(unit_number); }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: 'Nothing to update' });
    }

    values.push(req.params.id);
    values.push(req.buildingId);
    const result = await query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} AND building_id = $${idx + 1} RETURNING id, name, role, priority_day, unit_number`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// DELETE /users/:id — admin only (within their building)
router.delete('/:id', authenticate, resolveBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  if (req.params.id === req.user!.userId) {
    return res.status(400).json({ success: false, error: 'Cannot remove yourself' });
  }
  try {
    const result = await query('DELETE FROM users WHERE id = $1 AND building_id = $2', [req.params.id, req.buildingId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to remove user' });
  }
});

export default router;
