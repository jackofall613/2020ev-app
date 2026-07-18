import { Router, Response } from 'express';
import { authenticate, requireAdmin, resolveBuilding, AuthRequest } from '../middleware/auth';
import { query } from '../db';
import { notifyBuildingMembers } from '../services/notifications';
import { z } from 'zod';

const router = Router();

const messageSchema = z.object({
  body: z.string().min(1).max(500),
  type: z.enum(['chat', 'exception']).default('chat'),
});

// GET /feed
router.get('/', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  try {
    const result = await query(
      `SELECT f.*, u.name as user_name FROM feed_messages f
       JOIN users u ON f.user_id = u.id
       WHERE f.building_id = $2
       ORDER BY f.created_at DESC LIMIT $1`,
      [limit, req.buildingId]
    );
    res.json({ success: true, data: result.rows.reverse() });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch feed' });
  }
});

// POST /feed — send a chat or exception message
router.post('/', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid message' });
  }

  const { body, type } = parsed.data;

  try {
    const result = await query(
      `INSERT INTO feed_messages (user_id, type, body, building_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user!.userId, type, body, req.buildingId]
    );

    // Push the post to everyone else in the building (fire-and-forget — the
    // message board was previously silent unless you had the app open).
    query(`SELECT name FROM users WHERE id = $1`, [req.user!.userId])
      .then((r) => {
        const author = r.rows[0]?.name || 'A neighbor';
        const preview = body.length > 120 ? `${body.slice(0, 117)}…` : body;
        return notifyBuildingMembers(req.buildingId ?? null, req.user!.userId, `💬 ${author}`, preview);
      })
      .catch(() => {});

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to post message' });
  }
});

// DELETE /feed/:id — admin only (scoped to their building)
router.delete('/:id', authenticate, resolveBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query('DELETE FROM feed_messages WHERE id = $1 AND building_id = $2', [req.params.id, req.buildingId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to delete message' });
  }
});

export default router;
