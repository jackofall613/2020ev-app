import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JWTPayload } from '../utils/jwt';
import { query } from '../db';

export interface AuthRequest extends Request {
  user?: JWTPayload;
  /** Tenant scope resolved by `resolveBuilding` — the building this request acts on. */
  buildingId?: string | null;
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  try {
    const token = authHeader.split(' ')[1];
    req.user = verifyAccessToken(token);
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

/** Admin-capable: a building admin OR the super-admin (all buildings). */
export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
};

/** Platform operator only. */
export const requireSuperAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: 'Super-admin access required' });
  }
  next();
};

/**
 * Resolve the building this request is scoped to, into `req.buildingId`.
 * The value is ALWAYS server-trusted:
 *  - super-admin (not impersonating): may select a building via `X-Building-Id`
 *    header or `?building_id=` — allowed only because the token says super_admin.
 *    May be null for cross-building list endpoints.
 *  - everyone else (building admin, member, impersonation token): the building_id
 *    baked into their token. Legacy tokens minted before P2 lack it, so we fall
 *    back to the user's stored building_id.
 * Never reads a client-supplied building for a non-super-admin.
 */
export const resolveBuilding = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u) return res.status(401).json({ success: false, error: 'Not authenticated' });

  if (u.role === 'super_admin' && !u.act) {
    const sel = req.header('X-Building-Id') || (typeof req.query.building_id === 'string' ? req.query.building_id : '');
    req.buildingId = sel || null;
    return next();
  }

  if (u.buildingId) {
    req.buildingId = u.buildingId;
    auditImpersonatedAction(req);
    return next();
  }

  // Legacy token without buildingId — resolve from the user's row.
  try {
    const r = await query<{ building_id: string | null }>('SELECT building_id FROM users WHERE id = $1', [u.userId]);
    req.buildingId = r.rows[0]?.building_id ?? null;
    auditImpersonatedAction(req);
    next();
  } catch {
    res.status(500).json({ success: false, error: 'Failed to resolve building' });
  }
};

/** When the request runs under a super-admin impersonation token, record any
 *  mutating action to the building's portal access log (fire-and-forget). */
function auditImpersonatedAction(req: AuthRequest) {
  const act = req.user?.act;
  if (!act?.imp || !req.buildingId) return;
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return;
  const path = (req.originalUrl || req.url || '').split('?')[0];
  query(
    `INSERT INTO portal_access_log (building_id, super_admin_user_id, action, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.buildingId, act.sub, `${req.method} ${path}`, req.ip ?? null, String(req.headers['user-agent'] || '').slice(0, 300) || null]
  ).catch(() => {});
}

/** A specific building must be in scope. Use on tenant endpoints that cannot run
 *  building-agnostic (i.e. a super-admin must have selected one). */
export const requireBuilding = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.buildingId) {
    return res.status(400).json({ success: false, error: 'building_id is required (select a building)' });
  }
  next();
};
