import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../db';
import { signAccessToken, signRefreshToken, verifyRefreshToken, hashRefreshToken } from '../utils/jwt';
import { generateInviteToken } from '../utils/invite';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth';
import { config } from '../config';
import { safeEqual } from '../utils/secure';
import { sendEmail, emailEnabled } from '../services/email';
import { z } from 'zod';

const router = Router();

// ── Per-account login throttle ────────────────────────────────────────────────
// Complements the per-IP express-rate-limit in index.ts: a distributed attack
// (many IPs, one account) still locks out after MAX_FAILS. In-memory is fine —
// single API instance; resets on deploy, which only ever helps the user.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
const loginFails = new Map<string, number[]>();

function recordLoginFail(email: string): void {
  const key = email.toLowerCase();
  const now = Date.now();
  const fails = (loginFails.get(key) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
  fails.push(now);
  loginFails.set(key, fails);
}
function loginThrottled(email: string): boolean {
  const now = Date.now();
  const fails = (loginFails.get(email.toLowerCase()) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
  return fails.length >= MAX_FAILS;
}
function clearLoginFails(email: string): void {
  loginFails.delete(email.toLowerCase());
}

// POST /auth/bootstrap — creates the first admin invite, only works when NO users exist
router.post('/bootstrap', async (req: Request, res: Response) => {
  try {
    const countResult = await query('SELECT COUNT(*) FROM users');
    if (parseInt(countResult.rows[0].count) > 0) {
      return res.status(403).json({ success: false, error: 'App already set up' });
    }
    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    // Legacy single-tenant-clone path: first admin of the default building.
    const buildingId = (await query(`SELECT id FROM buildings WHERE slug = '2020'`)).rows[0]?.id ?? null;
    await query(
      "INSERT INTO invite_codes (token, email, created_by, expires_at, building_id, role) VALUES ($1, $2, NULL, $3, $4, 'admin')",
      [token, req.body.email || null, expiresAt, buildingId]
    );
    res.status(201).json({
      success: true,
      data: { token, message: 'Use this token to register as admin' },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Bootstrap failed' });
  }
});

// POST /auth/bootstrap-superadmin — one-time seed of the platform super-admin.
// Guarded by the shared INGEST_SECRET (Railway env only), so it needs no existing
// account and no DB access. Refuses once a super-admin exists. building_id is NULL
// (super-admin spans all buildings).
router.post('/bootstrap-superadmin', async (req: Request, res: Response) => {
  const secret = process.env.INGEST_SECRET;
  if (!secret || !safeEqual(req.headers['x-ingest-secret'], secret)) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : 'Super Admin';
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12) {
    return res.status(400).json({ success: false, error: 'valid email and password (min 12 chars) required' });
  }
  try {
    const existing = await query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'A super-admin already exists' });
    }
    const dupe = await query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    if (dupe.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'That email is already in use' });
    }
    const password_hash = await bcrypt.hash(password, 12);
    const r = await query(
      `INSERT INTO users (name, email, password_hash, role, building_id)
       VALUES ($1, $2, $3, 'super_admin', NULL)
       RETURNING id, name, email, role`,
      [name, email, password_hash]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('[auth] bootstrap-superadmin failed:', err);
    res.status(500).json({ success: false, error: 'Failed to create super-admin' });
  }
});

const registerSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(100),
  password: z.string().min(12),
  email: z.string().email().optional(), // used only when the invite has no email attached
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(12),
});

// POST /auth/register — complete registration via invite token
router.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.message });
  }

  const { token, name, password } = parsed.data;

  try {
    // Validate invite
    const inviteResult = await query(
      `SELECT * FROM invite_codes WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [token]
    );
    if (inviteResult.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid or expired invite' });
    }
    const invite = inviteResult.rows[0];

    // Invite email wins; an email-less invite must supply one at registration,
    // otherwise the account would have no email and could never log in.
    const email = (invite.email || parsed.data.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required to register' });
    }

    // Check if email already registered
    const emailCheck = await query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    // Tenant + role come from the invite (multi-tenant). Legacy fallback: the very
    // first user in an otherwise-empty DB becomes admin of the default building.
    const countResult = await query('SELECT COUNT(*) FROM users');
    const isFirstUser = parseInt(countResult.rows[0].count) === 0;
    const role = invite.role || (isFirstUser ? 'admin' : 'member');
    const buildingId =
      invite.building_id ||
      (await query(`SELECT id FROM buildings WHERE slug = '2020'`)).rows[0]?.id ||
      null;

    const userResult = await query(
      `INSERT INTO users (name, email, password_hash, role, building_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role, priority_day, building_id`,
      [name, email, password_hash, role, buildingId]
    );
    const user = userResult.rows[0];

    // Mark invite as used
    await query('UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE id = $2', [
      user.id,
      invite.id,
    ]);

    const accessToken = signAccessToken({ userId: user.id, role: user.role, buildingId: user.building_id });
    const refreshToken = signRefreshToken({ userId: user.id, role: user.role, buildingId: user.building_id });

    // Store refresh token hash
    const tokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    res.status(201).json({
      success: true,
      data: { user, accessToken, refreshToken },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid input' });
  }

  const { email, password } = parsed.data;

  try {
    if (loginThrottled(email)) {
      return res.status(429).json({ success: false, error: 'Too many attempts — try again in 15 minutes' });
    }

    const result = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (result.rows.length === 0) {
      recordLoginFail(email);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      recordLoginFail(email);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    clearLoginFails(email);

    const accessToken = signAccessToken({ userId: user.id, role: user.role, buildingId: user.building_id });
    const refreshToken = signRefreshToken({ userId: user.id, role: user.role, buildingId: user.building_id });

    const tokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
          priority_day: user.priority_day,
          unit_number: user.unit_number,
          building_id: user.building_id,
          avatar_url: user.avatar_url ?? null,
          // Car profile (v1.1) — the app's user object is rebuilt from this
          // payload on every login; omitting these made the profile "vanish"
          // after re-login (and a blank re-save would wipe the server copy).
          car_make: user.car_make ?? null,
          car_model: user.car_model ?? null,
          battery_kwh: user.battery_kwh == null ? null : parseFloat(user.battery_kwh),
          target_percent: user.target_percent ?? null,
        },
        accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// POST /auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ success: false, error: 'No refresh token' });
  }

  try {
    const payload = verifyRefreshToken(refreshToken);
    // Opportunistic housekeeping — expired tokens would otherwise accumulate forever
    await query('DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at <= NOW()', [payload.userId]);
    // Exact match on the SHA-256 hash — no per-token bcrypt loop, and revocation
    // actually works (see hashRefreshToken).
    const tokenHash = hashRefreshToken(refreshToken);
    const result = await query(
      'SELECT id FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND expires_at > NOW()',
      [payload.userId, tokenHash]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid refresh token' });
    }
    // Rotate: single-use — delete the matched token before issuing a new pair.
    await query('DELETE FROM refresh_tokens WHERE id = $1', [result.rows[0].id]);

    const userResult = await query('SELECT id, role, building_id FROM users WHERE id = $1', [payload.userId]);
    const user = userResult.rows[0];

    const newAccessToken = signAccessToken({ userId: user.id, role: user.role, buildingId: user.building_id });
    const newRefreshToken = signRefreshToken({ userId: user.id, role: user.role, buildingId: user.building_id });

    const newTokenHash = hashRefreshToken(newRefreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, newTokenHash, expiresAt]
    );

    res.json({
      success: true,
      data: { accessToken: newAccessToken, refreshToken: newRefreshToken },
    });
  } catch {
    res.status(401).json({ success: false, error: 'Invalid refresh token' });
  }
});

// POST /auth/logout
router.post('/logout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user!.userId]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

// POST /auth/change-password — signed-in user changes their own password.
// Verifies the current password, then invalidates ALL existing refresh tokens
// (logs out other devices) and issues a fresh pair so the caller stays signed in.
router.post('/change-password', authenticate, async (req: AuthRequest, res: Response) => {
  // An impersonation ("view as") session must never be able to change the real
  // building admin's password — that would be an account takeover.
  if (req.user!.act?.imp) {
    return res.status(403).json({ success: false, error: 'Password cannot be changed during a support session' });
  }

  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'New password must be at least 12 characters' });
  }
  const { current_password, new_password } = parsed.data;
  if (current_password === new_password) {
    return res.status(400).json({ success: false, error: 'New password must be different from the current one' });
  }

  try {
    const result = await query('SELECT id, password_hash, role, building_id FROM users WHERE id = $1', [req.user!.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const user = result.rows[0];

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      // 400 (not 401) so clients can treat 401 unambiguously as an expired session.
      return res.status(400).json({ success: false, error: 'Current password is incorrect' });
    }

    const password_hash = await bcrypt.hash(new_password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [password_hash, user.id]);

    // Invalidate every existing refresh token, then mint a fresh pair for the caller.
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
    const accessToken = signAccessToken({ userId: user.id, role: user.role, buildingId: user.building_id });
    const refreshToken = signRefreshToken({ userId: user.id, role: user.role, buildingId: user.building_id });
    const tokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    res.json({ success: true, data: { accessToken, refreshToken } });
  } catch (err) {
    console.error('[auth] change-password failed:', err);
    res.status(500).json({ success: false, error: 'Failed to change password' });
  }
});

// POST /auth/forgot-password — { email }. Always answers 200 with the same body
// (never reveals whether an account exists). If the account exists and email
// sending is configured (RESEND_API_KEY), a single-use 30-minute reset link is
// emailed, pointing at the portal's public /reset page. Placeholder accounts
// (*.placeholder@2020ev.internal) are skipped — their mailboxes don't exist.
router.post('/forgot-password', async (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const generic = { success: true, data: { message: 'If that email has an account, a reset link is on its way.' } };
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.json(generic);

  try {
    const result = await query(
      `SELECT id, name FROM users WHERE LOWER(email) = LOWER($1) AND is_placeholder IS NOT TRUE`,
      [email]
    );
    const user = result.rows[0];
    if (!user) return res.json(generic);

    if (!emailEnabled()) {
      // Email not configured yet — don't mint tokens nobody can receive.
      console.warn('[auth] forgot-password requested but RESEND_API_KEY is not set');
      return res.json(generic);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );

    const portalUrl = process.env.PORTAL_URL || 'https://2020ev-admin.vercel.app';
    const link = `${portalUrl}/reset?token=${token}`;
    await sendEmail(
      email,
      'Reset your 2020EV password',
      `<p>Hi ${user.name || 'there'},</p>
       <p>Someone (hopefully you) asked to reset your 2020EV password. The link below works once and expires in 30 minutes:</p>
       <p><a href="${link}">Reset my password</a></p>
       <p>If you didn't ask for this, you can ignore this email — your password is unchanged.</p>`
    );
    res.json(generic);
  } catch (err) {
    console.error('[auth] forgot-password failed:', err);
    res.json(generic); // still generic — never leak state via errors
  }
});

// POST /auth/reset-password — { token, new_password>=12 }. Consumes a reset
// token: updates the hash, marks the token used, and revokes ALL refresh tokens
// (logs out every device) — same posture as change-password.
router.post('/reset-password', async (req: Request, res: Response) => {
  const schema = z.object({ token: z.string().min(32), new_password: z.string().min(12) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Password must be at least 12 characters' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(parsed.data.token).digest('hex');
    const result = await query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(400).json({ success: false, error: 'This reset link is invalid or has expired — request a new one.' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.new_password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, row.user_id]);
    await query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [row.id]);
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [row.user_id]);

    res.json({ success: true, data: { message: 'Password updated — you can sign in now.' } });
  } catch (err) {
    console.error('[auth] reset-password failed:', err);
    res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

// POST /auth/invite — admin creates invite link
router.post('/invite', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const email = typeof req.body.email === 'string' && req.body.email.trim()
    ? req.body.email.trim().toLowerCase()
    : null;
  const token = generateInviteToken();
  const expiresAt = new Date(
    Date.now() + config.invite.expiryHours * 60 * 60 * 1000
  );

  // The invitee's role — only a building admin or resident can be minted here.
  const role = req.body.role === 'admin' ? 'admin' : 'member';

  try {
    // Scope the invite to a building. Super-admin must name it explicitly; a
    // building admin can only invite into their own building.
    let buildingId: string | null;
    if (req.user!.role === 'super_admin') {
      buildingId = typeof req.body.building_id === 'string' && req.body.building_id ? req.body.building_id : null;
      if (!buildingId) {
        return res.status(400).json({ success: false, error: 'building_id is required for super-admin invites' });
      }
    } else {
      buildingId = req.user!.buildingId ?? null;
      if (!buildingId) {
        const r = await query<{ building_id: string | null }>(`SELECT building_id FROM users WHERE id = $1`, [req.user!.userId]);
        buildingId = r.rows[0]?.building_id ?? null;
      }
    }

    await query(
      'INSERT INTO invite_codes (token, email, created_by, expires_at, building_id, role) VALUES ($1, $2, $3, $4, $5, $6)',
      [token, email || null, req.user!.userId, expiresAt, buildingId, role]
    );

    res.status(201).json({
      success: true,
      data: {
        token,
        email,
        role,
        building_id: buildingId,
        expires_at: expiresAt,
        invite_url: `ev2020://invite?token=${token}`,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to create invite' });
  }
});

// GET /auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'SELECT id, name, email, role, priority_day, unit_number, created_at FROM users WHERE id = $1',
      [req.user!.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

export default router;
