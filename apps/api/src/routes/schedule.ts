import { Router, Response } from 'express';
import { authenticate, resolveBuilding, AuthRequest } from '../middleware/auth';
import { query } from '../db';

const router = Router();

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

// GET /schedule
router.get('/', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, name, priority_day FROM users WHERE priority_day IS NOT NULL AND building_id = $1`,
      [req.buildingId]
    );

    const assignments = WEEKDAYS.map((day) => {
      const user = result.rows.find((u) => u.priority_day === day);
      return {
        day,
        user_id: user?.id || null,
        user_name: user?.name || null,
      };
    });

    res.json({
      success: true,
      data: { assignments, weekend_rule: 'fcfs' },
    });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch schedule' });
  }
});

// GET /schedule/today
router.get('/today', authenticate, resolveBuilding, async (req: AuthRequest, res: Response) => {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const today = days[new Date().getDay()];

  if (today === 'saturday' || today === 'sunday') {
    return res.json({ success: true, data: { day: today, rule: 'fcfs', priority_user: null } });
  }

  try {
    const result = await query(
      `SELECT id, name, priority_day FROM users WHERE priority_day = $1 AND building_id = $2`,
      [today, req.buildingId]
    );
    const priorityUser = result.rows[0] || null;

    res.json({
      success: true,
      data: {
        day: today,
        rule: 'priority',
        priority_user: priorityUser
          ? { id: priorityUser.id, name: priorityUser.name }
          : null,
      },
    });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch today schedule' });
  }
});

export default router;
