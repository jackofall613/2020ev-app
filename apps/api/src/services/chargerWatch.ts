/**
 * Charger watch — background job that nudges residents to move their car.
 *
 * Runs every few minutes while a session is active and fires at most one push
 * per trigger per session (flags stored on the sessions row, so a server restart
 * never re-sends). Three triggers:
 *   1. estimated finish time passed
 *   2. car appears finished charging (charger IN_USE but drawing ~no power)
 *   3. over the hard time cap
 */

import { query, pool } from '../db';
import { getStationStatus, getCurrentLoad, getBuildingCpConfig } from './chargepoint';
import { notifyUser, notifyAdmins } from './notifications';
import { emitToBuilding } from './realtime';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;   // every 5 minutes
const IDLE_KW_THRESHOLD = 0.5;             // below this while plugged in = likely finished
const MIN_ELAPSED_FOR_IDLE_MIN = 20;       // ignore the initial charge ramp
const HARD_CAP_HOURS = 6;
export const OFFER_HOLD_MIN = 15;          // how long a queue offer is held
const ESCALATION_AFTER_MIN = 20;           // second nudge this long after the first, queue only
const IDLE_FEE_BLOCK_MIN = 15;             // idle fee accrues per completed 15-min block
// If eligible ticks stop arriving for longer than one block + tick slack, some
// gate (queue emptied, fee off, car drew power, CP unreachable) blocked billing
// in between — that time is SKIPPED, never retro-billed.
const IDLE_FEE_MAX_GAP_MS = (IDLE_FEE_BLOCK_MIN + 8) * 60 * 1000;

/** Check every building's active session (at most one per building). */
export async function checkActiveSession(): Promise<void> {
  const r = await query(
    `SELECT s.id, s.user_id, s.building_id, u.name, s.started_at, s.estimated_end,
            s.estimated_reminder_at, s.idle_reminder_at, s.cap_reminder_at,
            s.idle_escalated_at, s.idle_fee_blocks_billed, s.idle_fee_billed_through
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.status = 'active'`
  );
  for (const session of r.rows) {
    try {
      await checkOneSession(session);
    } catch (err: any) {
      console.error(`[chargerWatch] session ${session.id} check failed:`, err?.message);
    }
  }

  // Queue maintenance — expire lapsed offers and auto-advance. This is also the
  // safety net that catches "charger went AVAILABLE with people waiting" when no
  // session-end event fired (e.g. a session that was never ended in the app).
  try {
    const qb = await query(
      `SELECT DISTINCT building_id FROM charger_queue WHERE status IN ('waiting','offered')`
    );
    for (const row of qb.rows) {
      try {
        await advanceQueue(row.building_id, { checkCp: true });
      } catch (err: any) {
        console.error(`[chargerWatch] queue advance failed for building ${row.building_id}:`, err?.message);
      }
    }
  } catch (err: any) {
    console.error('[chargerWatch] queue maintenance failed:', err?.message);
  }
}

/** Exported for tests — production entry is checkActiveSession(). */
export async function checkOneSession(session: any): Promise<void> {
  const now = Date.now();
  const elapsedMin = (now - new Date(session.started_at).getTime()) / 60000;
  const mark = (col: string) =>
    query(`UPDATE sessions SET ${col} = NOW() WHERE id = $1`, [session.id]);

  // Feature 2: how many neighbors are queued right now — drives the harsher
  // copy, the one-shot second escalation, and the (opt-in) idle fee.
  let waitingCount = 0;
  try {
    const wc = await query(
      `SELECT COUNT(*)::int AS c FROM charger_queue WHERE building_id = $1 AND status = 'waiting'`,
      [session.building_id]
    );
    waitingCount = wc.rows[0]?.c ?? 0;
  } catch { /* queue table missing mid-migration — fall back to plain copy */ }
  const neighborsWaiting =
    waitingCount === 1 ? 'A neighbor is waiting for the charger' : `${waitingCount} neighbors are waiting for the charger`;

  // 1. Estimated finish time passed
  if (session.estimated_end && !session.estimated_reminder_at &&
      now > new Date(session.estimated_end).getTime()) {
    notifyUser(session.user_id, 'Charging time’s up',
      waitingCount > 0
        ? `Your estimated finish time has passed — please move your car. ${neighborsWaiting}.`
        : 'Your estimated finish time has passed — please move your car when you can so the next resident can charge.')
      .catch(() => {});
    await mark('estimated_reminder_at');
  }

  // 2. Car appears finished (charger still IN_USE but pulling ~no power), and
  //    4. opt-in idle fee — both need this building's live ChargePoint state,
  //    so they share one fetch. Never bill when ChargePoint is unreachable.
  const needIdleDetect = !session.idle_reminder_at && elapsedMin > MIN_ELAPSED_FOR_IDLE_MIN;
  const feeCfg = session.idle_reminder_at && waitingCount > 0
    ? await getIdleFeeConfig(session.building_id)
    : null;
  if (needIdleDetect || feeCfg) {
    try {
      const cfg = await getBuildingCpConfig(session.building_id);
      if (cfg) {
        const [status, load] = await Promise.all([getStationStatus(cfg), getCurrentLoad(cfg)]);
        const isIdle = status.status === 'IN_USE' && load.loadKw < IDLE_KW_THRESHOLD;
        if (needIdleDetect && isIdle) {
          notifyUser(session.user_id, 'Your car looks done charging',
            waitingCount > 0
              ? `The charger is barely drawing power — if you’re finished, please unplug. ${neighborsWaiting}.`
              : 'The charger is barely drawing power — if you’re finished, please unplug and move your car for the next resident.')
            .catch(() => {});
          await mark('idle_reminder_at');
        }
        if (feeCfg && isIdle) {
          await accrueIdleFee(session, waitingCount, feeCfg);
        }
      }
    } catch { /* ChargePoint unreachable — try again next tick */ }
  }

  // 3. One-shot escalation, only while people are actually queued: a further
  //    ESCALATION_AFTER_MIN after the first nudge (idle or estimated).
  if (!session.idle_escalated_at && waitingCount > 0) {
    const firstNudge = session.idle_reminder_at ?? session.estimated_reminder_at;
    if (firstNudge && now - new Date(firstNudge).getTime() > ESCALATION_AFTER_MIN * 60 * 1000) {
      notifyUser(session.user_id, 'Neighbors are waiting for the charger',
        `${neighborsWaiting} and your car ${session.idle_reminder_at ? 'looks done' : 'is past its estimated finish'} — please unplug and move it now.`)
        .catch(() => {});
      await mark('idle_escalated_at');
    }
  }

  // 5. Over the hard cap
  if (!session.cap_reminder_at && elapsedMin > HARD_CAP_HOURS * 60) {
    notifyUser(session.user_id, `Over the ${HARD_CAP_HOURS}-hour limit`,
      `You’ve passed the ${HARD_CAP_HOURS}-hour charging cap — please wrap up and move your car.`)
      .catch(() => {});
    notifyAdmins(session.building_id, 'Charger overstay',
      `${session.name} has been charging more than ${HARD_CAP_HOURS} hours.`)
      .catch(() => {});
    await mark('cap_reminder_at');
  }
}

/** Idle-fee settings for a building. Off (null) unless an admin has set a
 *  positive per-15-min fee — several buildings won't want this at all. */
export async function getIdleFeeConfig(
  buildingId: string
): Promise<{ feeCents: number; graceMin: number } | null> {
  try {
    const r = await query(
      `SELECT key, value FROM settings
       WHERE building_id = $1 AND key IN ('idle_fee_cents_per_15min','idle_grace_min')`,
      [buildingId]
    );
    const map: Record<string, string> = {};
    for (const row of r.rows) map[row.key] = String(row.value);
    const feeCents = parseInt(map.idle_fee_cents_per_15min ?? '0', 10) || 0;
    const graceMin = parseInt(map.idle_grace_min ?? '15', 10) || 15;
    return feeCents > 0 ? { feeCents, graceMin } : null;
  } catch {
    return null; // never bill on uncertainty
  }
}

/**
 * Feature 2 (opt-in): meter VERIFIED idle-and-queued time and bill it in
 * completed 15-min blocks. This runs only on eligible ticks — fee enabled,
 * neighbors waiting, ChargePoint confirming the car idle — and
 * `idle_fee_billed_through` anchors the meter: it starts at the first eligible
 * tick and restarts after any gap in eligible ticks, so fees are strictly
 * prospective. Time a gate blocked (queue empty overnight, fee enabled
 * mid-idle, car drawing power, CP outage) is skipped, never retro-billed.
 * The counter CAS (with status='active') means crashes and concurrent ticks
 * can only ever under-bill. Fully transparent: wallet line item + push.
 */
export async function accrueIdleFee(
  session: any,
  waitingCount: number,
  { feeCents, graceMin }: { feeCents: number; graceMin: number }
): Promise<void> {
  const now = Date.now();
  const graceEndMs = new Date(session.idle_reminder_at).getTime() + graceMin * 60 * 1000;
  if (now < graceEndMs) return;

  const alreadyBilled = session.idle_fee_blocks_billed ?? 0;
  const anchorMs = session.idle_fee_billed_through
    ? new Date(session.idle_fee_billed_through).getTime()
    : null;

  // First eligible tick, or eligible ticks stopped arriving for a while:
  // (re)start the meter at NOW and bill nothing for the gap.
  if (anchorMs === null || now - anchorMs > IDLE_FEE_MAX_GAP_MS) {
    await query(
      `UPDATE sessions SET idle_fee_billed_through = $2
       WHERE id = $1 AND status = 'active' AND idle_fee_blocks_billed = $3`,
      [session.id, new Date(now), alreadyBilled]
    );
    session.idle_fee_billed_through = new Date(now).toISOString();
    return;
  }

  const blocks = Math.floor((now - anchorMs) / (IDLE_FEE_BLOCK_MIN * 60 * 1000)); // 0 or 1 by construction
  if (blocks <= 0) return;

  const newAnchor = new Date(anchorMs + blocks * IDLE_FEE_BLOCK_MIN * 60 * 1000);
  const guard = await query(
    `UPDATE sessions
     SET idle_fee_billed_through = $2, idle_fee_blocks_billed = idle_fee_blocks_billed + $3
     WHERE id = $1 AND status = 'active' AND idle_fee_blocks_billed = $4`,
    [session.id, newAnchor, blocks, alreadyBilled]
  );
  if (guard.rowCount === 0) return; // raced, or the session just ended — never bill
  session.idle_fee_blocks_billed = alreadyBilled + blocks;
  session.idle_fee_billed_through = newAnchor.toISOString();

  const amountCents = blocks * feeCents;
  const description =
    `Idle fee — car finished, ${waitingCount} waiting ` +
    `(${blocks} × ${IDLE_FEE_BLOCK_MIN} min @ $${(feeCents / 100).toFixed(2)})`;
  await query(
    `INSERT INTO wallets (user_id, balance_cents, building_id)
     VALUES ($1, 0, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [session.user_id, session.building_id]
  );
  // Ledger row + balance move atomically, matching /wallet/credit's pattern.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount_cents, type, description, kwh, session_id, building_id)
       VALUES ($1, $2, 'charge', $3, NULL, $4, $5)`,
      [session.user_id, -amountCents, description, session.id, session.building_id]
    );
    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE user_id = $2`,
      [amountCents, session.user_id]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
  notifyUser(session.user_id, 'Idle fee charged',
    `$${(amountCents / 100).toFixed(2)} idle fee — your car was done and neighbors were waiting. Please move it to stop further fees.`)
    .catch(() => {});
  console.log(`[chargerWatch] idle fee: $${(amountCents / 100).toFixed(2)} (${blocks} block(s)) — session ${session.id}`);
}

/** Notify the resident whose priority day is today that the charger is free.
 *  Scoped to the building whose charger just freed up. */
export async function notifyNextResident(buildingId: string | null, endedByUserId: string): Promise<void> {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const today = days[new Date().getDay()];
  if (today === 'saturday' || today === 'sunday') return; // weekends are first-come
  const r = await query(
    `SELECT id, name FROM users WHERE priority_day = $1 AND id <> $2 AND building_id = $3 LIMIT 1`,
    [today, endedByUserId, buildingId]
  );
  const next = r.rows[0];
  if (next) {
    notifyUser(next.id, 'Charger’s free',
      'The charger just opened up — it’s your priority day if you still need to charge.')
      .catch(() => {});
  }
}

// ── "Next Up" charger queue engine (v1.1 Feature 1) ─────────────────────────
// State machine per entry: waiting → offered → claimed | passed | expired,
// or waiting/offered → cancelled (user left). Position = joined_at order among
// 'waiting'. Two invariants enforced by partial unique indexes (Migration 016):
// one live entry per user per building, and at most one 'offered' per building.

export interface QueueEntry {
  id: string;
  user_id: string;
  user_name: string;
  status: 'waiting' | 'offered';
  joined_at: string;
  offered_at: string | null;
  offer_expires_at: string | null;
  claimed_at: string | null; // "On my way" tapped — still holding until plug-in
}

/** The building's live queue, offered entry first then waiting in join order. */
export async function getQueueSnapshot(buildingId: string): Promise<QueueEntry[]> {
  const r = await query<QueueEntry>(
    `SELECT q.id, q.user_id, u.name AS user_name, q.status, q.joined_at,
            q.offered_at, q.offer_expires_at, q.claimed_at
     FROM charger_queue q
     JOIN users u ON u.id = q.user_id
     WHERE q.building_id = $1 AND q.status IN ('waiting','offered')
     ORDER BY (q.status = 'offered') DESC, q.joined_at ASC`,
    [buildingId]
  );
  return r.rows;
}

/** Push the current queue to every open app in the building (fire-and-forget). */
export async function broadcastQueueUpdate(buildingId: string | null): Promise<void> {
  if (!buildingId) return;
  try {
    emitToBuilding(buildingId, 'queue:update', { entries: await getQueueSnapshot(buildingId) });
  } catch (err: any) {
    console.error('[chargerWatch] queue broadcast failed:', err?.message);
  }
}

async function formatBuildingTime(buildingId: string, date: Date): Promise<string> {
  let timeZone = 'America/New_York';
  try {
    const r = await query(`SELECT timezone FROM buildings WHERE id = $1`, [buildingId]);
    if (r.rows[0]?.timezone) timeZone = r.rows[0].timezone;
  } catch { /* fall back to default */ }
  try {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  } catch {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
}

/** Is the charger free to offer? Session state is the source of truth; the
 *  ChargePoint check (tick only — too slow for request paths) additionally
 *  catches a car plugged in without an announced session. */
async function chargerIsFree(buildingId: string, checkCp: boolean): Promise<boolean> {
  const active = await query(
    `SELECT 1 FROM sessions WHERE building_id = $1 AND status = 'active'`,
    [buildingId]
  );
  if (active.rows.length > 0) return false;
  if (checkCp) {
    try {
      const cfg = await getBuildingCpConfig(buildingId);
      if (cfg) {
        const status = await getStationStatus(cfg);
        if (status.status === 'IN_USE') return false;
      }
    } catch { /* ChargePoint unreachable — trust session state */ }
  }
  return true;
}

/**
 * The queue engine: expire any lapsed offer, then — if the charger is free and
 * nobody holds a live offer — offer the front of the queue a 15-minute hold.
 * Called on session end (assumeFree), on queue mutations, and from the 5-min
 * tick (checkCp). Returns true when an offer is held after the call, i.e. the
 * next resident has been (or already was) notified.
 */
export async function advanceQueue(
  buildingId: string | null,
  opts: { assumeFree?: boolean; checkCp?: boolean } = {}
): Promise<boolean> {
  if (!buildingId) return false;

  // Loop so one call can burn through several expired offers back to back
  // (e.g. the tick after a long ChargePoint outage).
  for (;;) {
    const expired = await query(
      `UPDATE charger_queue SET status = 'expired', resolved_at = NOW()
       WHERE building_id = $1 AND status = 'offered' AND offer_expires_at <= NOW()
       RETURNING user_id`,
      [buildingId]
    );
    for (const row of expired.rows) {
      notifyUser(row.user_id, 'Your charger hold expired',
        'You didn’t take the charger in time, so it went to the next person. Rejoin the queue anytime.')
        .catch(() => {});
    }
    if (expired.rows.length > 0) await broadcastQueueUpdate(buildingId);

    // Someone still holds a live offer — never offer two people at once.
    const held = await query(
      `SELECT 1 FROM charger_queue WHERE building_id = $1 AND status = 'offered'`,
      [buildingId]
    );
    if (held.rows.length > 0) return true;

    const nextR = await query(
      `SELECT q.id, q.user_id, u.name AS user_name
       FROM charger_queue q JOIN users u ON u.id = q.user_id
       WHERE q.building_id = $1 AND q.status = 'waiting'
       ORDER BY q.joined_at ASC LIMIT 1`,
      [buildingId]
    );
    const next = nextR.rows[0];
    if (!next) return false;

    if (!opts.assumeFree && !(await chargerIsFree(buildingId, opts.checkCp === true))) return false;

    const expiresAt = new Date(Date.now() + OFFER_HOLD_MIN * 60 * 1000);
    try {
      const offered = await query(
        `UPDATE charger_queue SET status = 'offered', offered_at = NOW(), offer_expires_at = $2
         WHERE id = $1 AND status = 'waiting'
         RETURNING id`,
        [next.id, expiresAt]
      );
      if (offered.rows.length === 0) continue; // raced with a mutation — re-evaluate
    } catch (err: any) {
      if (err?.code === '23505') return true; // charger_queue_single_offer — a concurrent call won
      throw err;
    }

    const until = await formatBuildingTime(buildingId, expiresAt);
    notifyUser(next.user_id, '⚡ Charger’s free — it’s your turn',
      `The charger is held for you until ${until}. Open the app to say you’re on your way, or pass.`,
      { type: 'queue_offer' })
      .catch(() => {});
    await broadcastQueueUpdate(buildingId);
    return true;
  }
}

export function scheduleChargerWatch(): void {
  setInterval(() => {
    checkActiveSession().catch((err) =>
      console.error('[chargerWatch] check failed:', err?.message));
  }, CHECK_INTERVAL_MS);
  console.log('[chargerWatch] started — active session + queue check every 5 min');
}
