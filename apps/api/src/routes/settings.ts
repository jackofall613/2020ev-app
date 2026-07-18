import { Router, Response } from 'express';
import { authenticate, requireAdmin, resolveBuilding, AuthRequest } from '../middleware/auth';
import { query } from '../db';

const router = Router();

const DEFAULT_RULES = [
  { icon: '⏱', text: 'Soft target: 2–4 hours' },
  { icon: '🔴', text: 'Hard cap: 6 hours max' },
  { icon: '📋', text: 'Announce in feed when plugging in' },
  { icon: '🚗', text: 'Move car promptly when done' },
];

const DEFAULT_RATE_CENTS = 18; // $0.18/kWh

// GET /settings/rules — public, any authenticated user
router.get('/rules', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      "SELECT value FROM settings WHERE key = 'rules' AND building_id = $1",
      [req.buildingId]
    );
    const rules = result.rows.length > 0 ? result.rows[0].value : DEFAULT_RULES;
    res.json({ success: true, data: rules });
  } catch {
    res.json({ success: true, data: DEFAULT_RULES });
  }
});

// PATCH /settings/rules — admin only
router.patch('/rules', authenticate, resolveBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { rules } = req.body;
  if (!Array.isArray(rules)) {
    return res.status(400).json({ success: false, error: 'rules must be an array' });
  }
  // Validate each rule has icon + text
  for (const r of rules) {
    if (typeof r.icon !== 'string' || typeof r.text !== 'string') {
      return res.status(400).json({ success: false, error: 'Each rule needs icon and text fields' });
    }
  }
  try {
    await query(
      `INSERT INTO settings (key, value, updated_at, building_id)
       VALUES ('rules', $1, NOW(), $2)
       ON CONFLICT (building_id, key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(rules), req.buildingId]
    );
    res.json({ success: true, data: rules });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to save rules' });
  }
});

// GET /settings/electricity-rate — admin only
router.get('/electricity-rate', authenticate, resolveBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      "SELECT value, updated_at FROM settings WHERE key = 'electricity_rate_cents_per_kwh' AND building_id = $1",
      [req.buildingId]
    );
    const rateCents = result.rows[0]
      ? Math.round(parseFloat(result.rows[0].value))
      : DEFAULT_RATE_CENTS;
    const updatedAt = result.rows[0]?.updated_at ?? null;
    res.json({
      success: true,
      data: { rate_cents: rateCents, rate_dollars: (rateCents / 100).toFixed(4), updated_at: updatedAt },
    });
  } catch (err) {
    console.error('[settings] Failed to fetch electricity rate:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch electricity rate' });
  }
});

// PATCH /settings/electricity-rate — admin only
router.patch('/electricity-rate', authenticate, resolveBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { rate_cents } = req.body;
  const parsed = parseInt(String(rate_cents), 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 200) {
    return res.status(400).json({
      success: false,
      error: 'rate_cents must be an integer between 1 and 200 (i.e. $0.01–$2.00 per kWh)',
    });
  }
  try {
    await query(
      `INSERT INTO settings (key, value, updated_at, building_id)
       VALUES ('electricity_rate_cents_per_kwh', $1, NOW(), $2)
       ON CONFLICT (building_id, key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [String(parsed), req.buildingId]
    );
    console.log(`[settings] Electricity rate updated to ${parsed}¢/kWh ($${(parsed / 100).toFixed(4)}/kWh) by admin`);
    res.json({ success: true, data: { rate_cents: parsed, rate_dollars: (parsed / 100).toFixed(4) } });
  } catch (err) {
    console.error('[settings] Failed to update electricity rate:', err);
    res.status(500).json({ success: false, error: 'Failed to update electricity rate' });
  }
});

// ── Idle fee (v1.1 Feature 2, opt-in — OFF by default) ──────────────────────
// A per-15-min fee billed while a finished car blocks the charger with
// neighbors queued, after a grace period. fee = 0 disables the whole thing.

const DEFAULT_IDLE_GRACE_MIN = 15;

// GET /settings/idle-fee — admin only
router.get('/idle-fee', authenticate, resolveBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT key, value FROM settings
       WHERE building_id = $1 AND key IN ('idle_fee_cents_per_15min','idle_grace_min')`,
      [req.buildingId]
    );
    const map: Record<string, string> = {};
    for (const row of result.rows) map[row.key] = String(row.value);
    res.json({
      success: true,
      data: {
        idle_fee_cents_per_15min: parseInt(map.idle_fee_cents_per_15min ?? '0', 10) || 0,
        idle_grace_min: parseInt(map.idle_grace_min ?? String(DEFAULT_IDLE_GRACE_MIN), 10) || DEFAULT_IDLE_GRACE_MIN,
      },
    });
  } catch (err) {
    console.error('[settings] Failed to fetch idle fee:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch idle fee settings' });
  }
});

// PATCH /settings/idle-fee — admin only
router.patch('/idle-fee', authenticate, resolveBuilding, requireAdmin, async (req: AuthRequest, res: Response) => {
  const fee = parseInt(String(req.body.idle_fee_cents_per_15min), 10);
  const grace = parseInt(String(req.body.idle_grace_min), 10);
  if (isNaN(fee) || fee < 0 || fee > 500) {
    return res.status(400).json({
      success: false,
      error: 'idle_fee_cents_per_15min must be an integer between 0 (off) and 500 (i.e. up to $5.00 per 15 min)',
    });
  }
  if (isNaN(grace) || grace < 5 || grace > 120) {
    return res.status(400).json({ success: false, error: 'idle_grace_min must be an integer between 5 and 120' });
  }
  try {
    for (const [key, value] of [
      ['idle_fee_cents_per_15min', String(fee)],
      ['idle_grace_min', String(grace)],
    ] as const) {
      await query(
        `INSERT INTO settings (key, value, updated_at, building_id)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (building_id, key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, value, req.buildingId]
      );
    }
    console.log(`[settings] Idle fee updated: ${fee}¢/15min after ${grace} min grace (0 = off)`);
    res.json({ success: true, data: { idle_fee_cents_per_15min: fee, idle_grace_min: grace } });
  } catch (err) {
    console.error('[settings] Failed to update idle fee:', err);
    res.status(500).json({ success: false, error: 'Failed to update idle fee settings' });
  }
});

export default router;
