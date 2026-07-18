/**
 * Expo Push Notifications service
 * Uses Node built-in https — no extra dependencies.
 */

import https from 'https';
import { query } from '../db';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function sendPush(token: string, title: string, body: string, data?: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ to: token, title, body, sound: 'default', ...(data ? { data } : {}) });
    const url = new URL(EXPO_PUSH_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      res.resume(); // drain response — we don't need to read it
      res.on('end', () => resolve());
    });

    req.on('error', (err) => {
      console.error('[notifications] Push failed for token', token, err.message);
      resolve(); // fire-and-forget — never throw
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve();
    });

    req.write(payload);
    req.end();
  });
}

/** Send a push notification to a specific user (fire-and-forget). Optional
 *  `data` rides along in the Expo payload so the app can deep-link on tap. */
export async function notifyUser(userId: string, title: string, body: string, data?: Record<string, string>): Promise<void> {
  try {
    const r = await query(
      `SELECT push_token FROM users WHERE id = $1 AND push_token IS NOT NULL`,
      [userId]
    );
    if (!r.rows[0]?.push_token) return;
    await sendPush(r.rows[0].push_token, title, body, data);
  } catch (err) {
    console.error('[notifications] notifyUser error:', err);
  }
}

/** Send a push notification to every member of a building except the author
 *  (fire-and-forget). Used for feed posts so the message board actually
 *  reaches people who don't have the app open. */
export async function notifyBuildingMembers(
  buildingId: string | null,
  excludeUserId: string,
  title: string,
  body: string
): Promise<void> {
  if (!buildingId) return;
  try {
    const r = await query(
      `SELECT push_token FROM users
       WHERE building_id = $1 AND id <> $2 AND push_token IS NOT NULL`,
      [buildingId, excludeUserId]
    );
    await Promise.all(r.rows.map((row) => sendPush(row.push_token, title, body)));
  } catch (err) {
    console.error('[notifications] notifyBuildingMembers error:', err);
  }
}

/** Send a push notification to a building's admins (fire-and-forget).
 *  Scoped by building_id so one building's events never notify another's admins,
 *  and the platform super-admin (building_id NULL) isn't spammed per-building. */
export async function notifyAdmins(buildingId: string | null, title: string, body: string): Promise<void> {
  try {
    const r = await query(
      `SELECT push_token FROM users WHERE role = 'admin' AND building_id = $1 AND push_token IS NOT NULL`,
      [buildingId]
    );
    await Promise.all(r.rows.map((row) => sendPush(row.push_token, title, body)));
  } catch (err) {
    console.error('[notifications] notifyAdmins error:', err);
  }
}
