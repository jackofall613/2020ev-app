/**
 * "Next Up" charger queue (v1.1 Feature 1).
 *
 * When the charger is busy, residents join a per-building queue. The moment it
 * frees, the front of the queue gets a 15-minute hold (push + in-app offer)
 * with On my way (claim) / Pass; expiry or a pass auto-advances to the next
 * person. Engine + state machine live in services/chargerWatch.ts; every
 * mutation broadcasts `queue:update` to the building's socket room.
 */

import { Router, Response } from 'express';
import { authenticate, resolveBuilding, requireBuilding, AuthRequest } from '../middleware/auth';
import { query } from '../db';
import { advanceQueue, broadcastQueueUpdate, getQueueSnapshot, QueueEntry, OFFER_HOLD_MIN } from '../services/chargerWatch';

const router = Router();

router.use(authenticate, resolveBuilding, requireBuilding);

/** The GET /queue payload — also returned by the mutations so the app can
 *  re-render without a second round-trip. */
async function queuePayload(buildingId: string, userId: string) {
  const entries = await getQueueSnapshot(buildingId);
  const waiting = entries.filter((e: QueueEntry) => e.status === 'waiting');
  const offered = entries.find((e: QueueEntry) => e.status === 'offered') || null;
  const mine = entries.find((e: QueueEntry) => e.user_id === userId) || null;
  return {
    entries,
    waiting_count: waiting.length,
    offered,
    // position 0 = "you're up" (holding the offer); 1 = next in line, etc.
    me: mine
      ? { ...mine, position: mine.status === 'offered' ? 0 : waiting.findIndex((e) => e.id === mine.id) + 1 }
      : null,
  };
}

// GET /queue — the building's live queue + the caller's own place in it
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: await queuePayload(req.buildingId!, req.user!.userId) });
  } catch (err) {
    console.error('[queue] fetch failed:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch queue' });
  }
});

// POST /queue/join — add the caller as waiting (no-op if already in)
router.post('/join', async (req: AuthRequest, res: Response) => {
  try {
    const active = await query(
      `SELECT user_id FROM sessions WHERE building_id = $1 AND status = 'active'`,
      [req.buildingId]
    );
    if (active.rows[0]?.user_id === req.user!.userId) {
      return res.status(409).json({ success: false, error: 'You’re charging right now — no need to queue' });
    }

    await query(
      `INSERT INTO charger_queue (building_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (building_id, user_id) WHERE status IN ('waiting','offered') DO NOTHING`,
      [req.buildingId, req.user!.userId]
    );

    // If the charger is actually free (stale queue / freed without an announced
    // session end), offer immediately instead of waiting for the 5-min tick.
    await advanceQueue(req.buildingId!);
    await broadcastQueueUpdate(req.buildingId!);

    res.status(201).json({ success: true, data: await queuePayload(req.buildingId!, req.user!.userId) });
  } catch (err) {
    console.error('[queue] join failed:', err);
    res.status(500).json({ success: false, error: 'Failed to join queue' });
  }
});

// POST /queue/leave — cancel the caller's live entry
router.post('/leave', async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE charger_queue SET status = 'cancelled', resolved_at = NOW()
       WHERE building_id = $1 AND user_id = $2 AND status IN ('waiting','offered')
       RETURNING offered_at`,
      [req.buildingId, req.user!.userId]
    );
    // Leaving while holding the offer hands it straight to the next person.
    if (r.rows[0]?.offered_at) await advanceQueue(req.buildingId!);
    await broadcastQueueUpdate(req.buildingId!);

    res.json({ success: true, data: await queuePayload(req.buildingId!, req.user!.userId) });
  } catch (err) {
    console.error('[queue] leave failed:', err);
    res.status(500).json({ success: false, error: 'Failed to leave queue' });
  }
});

// POST /queue/claim — "On my way": confirm the offer and extend the hold. The
// entry deliberately STAYS `offered` (= still holding the charger) until the
// resident actually plugs in — session start resolves it to `claimed`.
// Resolving here would drop the hold mid-walk and let the engine re-offer the
// charger to the next person before the claimer arrives.
router.post('/claim', async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE charger_queue
       SET claimed_at = NOW(), offer_expires_at = NOW() + make_interval(mins => $3)
       WHERE building_id = $1 AND user_id = $2 AND status = 'offered' AND offer_expires_at > NOW()
       RETURNING id`,
      [req.buildingId, req.user!.userId, OFFER_HOLD_MIN]
    );
    if (r.rows.length === 0) {
      return res.status(409).json({ success: false, error: 'No active hold to claim — it may have expired' });
    }
    await broadcastQueueUpdate(req.buildingId!);

    res.json({ success: true, data: await queuePayload(req.buildingId!, req.user!.userId) });
  } catch (err) {
    console.error('[queue] claim failed:', err);
    res.status(500).json({ success: false, error: 'Failed to claim' });
  }
});

// POST /queue/pass — the offered caller declines; auto-advance to the next person
router.post('/pass', async (req: AuthRequest, res: Response) => {
  try {
    const r = await query(
      `UPDATE charger_queue SET status = 'passed', resolved_at = NOW()
       WHERE building_id = $1 AND user_id = $2 AND status = 'offered'
       RETURNING id`,
      [req.buildingId, req.user!.userId]
    );
    if (r.rows.length === 0) {
      return res.status(409).json({ success: false, error: 'No active offer to pass' });
    }
    await advanceQueue(req.buildingId!);
    await broadcastQueueUpdate(req.buildingId!);

    res.json({ success: true, data: await queuePayload(req.buildingId!, req.user!.userId) });
  } catch (err) {
    console.error('[queue] pass failed:', err);
    res.status(500).json({ success: false, error: 'Failed to pass' });
  }
});

export default router;
