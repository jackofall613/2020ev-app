import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';

/** Actor claim set on impersonation ("ghost login") tokens — the super-admin
 *  acting as a building admin (RFC 8693 style). Presence of `act` means the
 *  session is impersonated and must be audit-logged + banner-flagged. */
export interface ImpersonationActor {
  sub: string;   // super-admin user id doing the impersonating
  imp: true;
}

export interface JWTPayload {
  userId: string;
  role: string;                  // 'super_admin' | 'admin' (building admin) | 'member'
  buildingId?: string | null;    // tenant scope; null/undefined for super_admin or legacy tokens
  act?: ImpersonationActor;       // present only on impersonation tokens
}

export const signAccessToken = (payload: JWTPayload): string =>
  jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn as any });

/** Short-lived, non-refreshable token for super-admin "view as building" support.
 *  Carries the `act` claim so every action is attributable + audit-logged. */
export const signImpersonationToken = (payload: JWTPayload): string =>
  jwt.sign(payload, config.jwt.secret, { expiresIn: '30m' });

export const signRefreshToken = (payload: JWTPayload): string =>
  jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiresIn as any });

export const verifyAccessToken = (token: string): JWTPayload =>
  jwt.verify(token, config.jwt.secret) as JWTPayload;

export const verifyRefreshToken = (token: string): JWTPayload =>
  jwt.verify(token, config.jwt.refreshSecret) as JWTPayload;

/**
 * Deterministic hash for storing/looking up refresh tokens at rest.
 * Refresh tokens are high-entropy signed JWTs (already unguessable), so a fast
 * unsalted SHA-256 is the right primitive. Critically, unlike bcrypt it does NOT
 * truncate at 72 bytes — two distinct refresh JWTs for the same user share a
 * >72-byte prefix (identical header + userId/role/buildingId claims), so bcrypt
 * compared them as equal and token revocation/rotation silently never worked.
 */
export const hashRefreshToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');
