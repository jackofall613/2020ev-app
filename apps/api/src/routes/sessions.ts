import { Router, Response } from 'express';
import { authenticate, resolveBuilding, AuthRequest } from '../middleware/auth';
import { query } from '../db';
import { notifyNextResident, advanceQueue, broadcastQueueUpdate } from '../services/chargerWatch';
import { z } from 'zod';

const router = Router();

const startSessionSchema = z.object({
  type: z.enum(['top_up', 'normal', 'long']),
  estimated_hours: z.number().min(0.5).max(6),
  notes: z.string().optional(),
});

// GET /sessions/active — get current active session
router.get('/active', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT s.*, u.name as user_name FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.status = 'active' AND s.building_id = $1
       ORDER BY s.started_at DESC LIMIT 1`,
      [req.buildingId]
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch active session' });
  }
});

// POST /sessions/start
router.post('/start', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  const parsed = startSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.message });
  }

  const { type, estimated_hours, notes } = parsed.data;

  try {
    // Check no active session exists in this building
    const activeCheck = await query(
      `SELECT id FROM sessions WHERE status = 'active' AND building_id = $1`,
      [req.buildingId]
    );
    if (activeCheck.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Charger already in use' });
    }

    // While a queue offer is held ("charger's free, held for you 15 min"), only
    // the hold-holder can start — otherwise the hold means nothing.
    const hold = await query(
      `SELECT q.user_id, u.name FROM charger_queue q
       JOIN users u ON u.id = q.user_id
       WHERE q.building_id = $1 AND q.status = 'offered' AND q.offer_expires_at > NOW()`,
      [req.buildingId]
    );
    if (hold.rows[0] && hold.rows[0].user_id !== req.user!.userId) {
      return res.status(409).json({
        success: false,
        error: `The charger is held for ${hold.rows[0].name} from the queue — join the queue to get a turn`,
      });
    }

    const estimatedEnd = new Date(Date.now() + estimated_hours * 60 * 60 * 1000);

    let session;
    try {
      const result = await query(
        `INSERT INTO sessions (user_id, type, estimated_end, notes, building_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.user!.userId, type, estimatedEnd, notes || null, req.buildingId]
      );
      session = result.rows[0];
    } catch (err: any) {
      // sessions_single_active unique index — two concurrent starts raced past the pre-check
      if (err?.code === '23505') {
        return res.status(409).json({ success: false, error: 'Charger already in use' });
      }
      throw err;
    }

    // Starting a session resolves the starter's live queue entry — the offered
    // person plugging in without tapping "On my way" still counts as claimed.
    const claimed = await query(
      `UPDATE charger_queue SET status = 'claimed', resolved_at = NOW()
       WHERE building_id = $1 AND user_id = $2 AND status IN ('waiting','offered')
       RETURNING id`,
      [req.buildingId, req.user!.userId]
    );
    if (claimed.rows.length > 0) broadcastQueueUpdate(req.buildingId ?? null).catch(() => {});

    // Get user name for feed
    const userResult = await query('SELECT name FROM users WHERE id = $1', [req.user!.userId]);
    const userName = userResult.rows[0]?.name;

    const finishTime = estimatedEnd.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });

    // Post to feed
    await query(
      `INSERT INTO feed_messages (user_id, type, body, session_id, building_id) VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user!.userId,
        'session_start',
        `${userName} plugged in. Done around ${finishTime}.`,
        session.id,
        req.buildingId,
      ]
    );

    res.status(201).json({ success: true, data: { ...session, user_name: userName } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to start session' });
  }
});

// POST /sessions/:id/end
router.post('/:id/end', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE sessions SET status = 'completed', actual_end = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'active' AND building_id = $3 RETURNING *`,
      [req.params.id, req.user!.userId, req.buildingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found or not yours' });
    }

    const userResult = await query('SELECT name FROM users WHERE id = $1', [req.user!.userId]);
    const userName = userResult.rows[0]?.name;

    await query(
      `INSERT INTO feed_messages (user_id, type, body, session_id, building_id) VALUES ($1, $2, $3, $4, $5)`,
      [req.user!.userId, 'session_end', `${userName} is done. Charger is open.`, req.params.id, req.buildingId]
    );

    // Hand the charger to the queue: offer the front of the line a 15-min hold.
    // When nobody's queued, fall back to pinging today's priority-day resident.
    let queueNotified = false;
    try {
      queueNotified = await advanceQueue(req.buildingId ?? null, { assumeFree: true });
    } catch (err) {
      console.error('[sessions] queue advance on end failed:', err);
    }
    if (!queueNotified) {
      notifyNextResident(req.buildingId ?? null, req.user!.userId).catch(() => {});
    }

    res.json({ success: true, data: result.rows[0], queue_notified: queueNotified });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to end session' });
  }
});

// GET /sessions/history
router.get('/history', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

  try {
    const result = await query(
      `SELECT s.*, u.name as user_name FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.building_id = $3
       ORDER BY s.started_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset, req.buildingId]
    );
    res.json({ success: true, data: result.rows });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
});

export default router;
