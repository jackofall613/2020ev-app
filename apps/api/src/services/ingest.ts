/**
 * Daily auto-ingest from ChargePoint SOAP API.
 * Pulls yesterday's sessions and runs them through the same driver-mapping
 * pipeline as the CSV importer. The SOAP sessionID == CSV Plug In Event ID,
 * so the (building_id, chargepoint_session_id) unique index prevents double-billing
 * if the admin also manually uploads the CSV for the same day.
 *
 * Multi-tenant: iterates every billable building that has a ChargePoint config,
 * ingesting each against its own credentials/station.
 */

import { getChargingSessions, getUser, getBuildingCpConfig, ChargePointUser, CpConfig } from './chargepoint';
import { processRows, CPRow } from '../routes/wallet';
import { notifyAdmins } from './notifications';
import { query } from '../db';

interface IngestTotals {
  processed: number;
  charged: number;
  unknown: number;
  already_billed: number;
  total_deducted_cents: number;
}

/** Ingest yesterday's sessions for every billable building with a CP config. */
export async function ingestYesterdaysSessions(): Promise<IngestTotals> {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 24 * 60 * 60 * 1000);

  const bRes = await query<{ id: string; slug: string }>(
    `SELECT id, slug FROM buildings WHERE billing_status IN ('trial', 'active')`
  );
  console.log(`[ingest] Auto-ingest across ${bRes.rows.length} billable building(s) — window: ${fromDate.toISOString()} → ${toDate.toISOString()}`);

  const totals: IngestTotals = { processed: 0, charged: 0, unknown: 0, already_billed: 0, total_deducted_cents: 0 };

  for (const b of bRes.rows) {
    const cfg = await getBuildingCpConfig(b.id);
    if (!cfg) {
      console.log(`[ingest] Skipping building ${b.slug} (${b.id}) — no ChargePoint config`);
      continue;
    }
    try {
      const r = await ingestBuildingSessions(b.id, b.slug, cfg, fromDate, toDate);
      totals.processed += r.processed;
      totals.charged += r.charged;
      totals.unknown += r.unknown;
      totals.already_billed += r.already_billed;
      totals.total_deducted_cents += r.total_deducted_cents;
    } catch (err: any) {
      console.error(`[ingest] Building ${b.slug} (${b.id}) failed: ${err.message}`);
    }
  }

  console.log(`[ingest] All buildings done — charged=${totals.charged} unknown=${totals.unknown} alreadyBilled=${totals.already_billed} total=$${(totals.total_deducted_cents / 100).toFixed(2)}`);
  return totals;
}

/** Ingest one building's yesterday sessions against its own ChargePoint config. */
async function ingestBuildingSessions(
  buildingId: string,
  slug: string,
  cfg: CpConfig,
  fromDate: Date,
  toDate: Date
): Promise<IngestTotals> {
  const sessions = await getChargingSessions(cfg, fromDate, toDate);
  console.log(`[ingest][${slug}] ChargePoint SOAP returned ${sessions.length} raw sessions`);

  if (sessions.length === 0) {
    return { processed: 0, charged: 0, unknown: 0, already_billed: 0, total_deducted_cents: 0 };
  }

  for (const s of sessions) {
    console.log(`[ingest][${slug}] SOAP session — id=${s.sessionId} userId=${s.chargepointUserId ?? 'none'} kwh=${s.energyKwh} start=${s.startTime} end=${s.endTime ?? 'none'}`);
  }

  // Resolve real names + emails for the distinct ChargePoint users in this batch.
  const userIds = [...new Set(sessions.map(s => s.chargepointUserId).filter(Boolean))] as string[];
  const userInfo = new Map<string, ChargePointUser>();
  for (const uid of userIds) {
    try {
      const u = await getUser(cfg, uid);
      if (u) {
        userInfo.set(uid, u);
        console.log(`[ingest][${slug}] Resolved CP user ${uid} → ${u.fullName}${u.email ? ` <${u.email}>` : ''}`);
      } else {
        console.log(`[ingest][${slug}] getUsers returned no record for CP user ${uid}`);
      }
    } catch (e: any) {
      console.log(`[ingest][${slug}] getUsers failed for CP user ${uid}: ${e.message}`);
    }
  }

  // Convert SOAP sessions to CPRow format.
  const rows: CPRow[] = sessions
    .filter(s => {
      if (!s.endTime) { console.log(`[ingest][${slug}] SKIP session ${s.sessionId} — no endTime`); return false; }
      if (s.energyKwh <= 0) { console.log(`[ingest][${slug}] SKIP session ${s.sessionId} — zero/negative kWh (${s.energyKwh})`); return false; }
      return true;
    })
    .map(s => {
      const info = s.chargepointUserId ? userInfo.get(s.chargepointUserId) : undefined;
      return {
        plugInEventId: s.sessionId,
        driverAccountNumber: s.chargepointUserId
          ? `CP_USER_${s.chargepointUserId}`
          : `CP_SESSION_${s.sessionId}`,
        driverName: info?.fullName
          || (s.chargepointUserId ? `ChargePoint User #${s.chargepointUserId}` : 'Unknown Driver'),
        chargepointUserId: s.chargepointUserId ?? '',
        email: info?.email,
        plugConnectTime: new Date(s.startTime),
        plugDisconnectTime: new Date(s.endTime!),
        kwh: s.energyKwh,
      };
    });

  console.log(`[ingest][${slug}] ${rows.length} sessions eligible for billing (after filtering)`);

  const filename = `auto-ingest-${fromDate.toISOString().slice(0, 10)}`;
  const result = await processRows(buildingId, rows, 'auto', filename);

  console.log(`[ingest][${slug}] COMPLETE — processed=${result.rows_total} billed=${result.rows_matched} unmatched=${result.rows_unmatched} alreadyBilled=${result.rows_already_billed} totalDeducted=$${(result.total_deducted_cents / 100).toFixed(2)}`);
  if (result.unknown_drivers.length > 0) {
    console.log(`[ingest][${slug}] Unknown drivers: ${result.unknown_drivers.join(', ')}`);
  }

  // Notify this building's admins with a summary
  if (result.rows_matched > 0 || result.rows_unmatched > 0) {
    notifyAdmins(
      buildingId,
      `Daily ingest: ${result.rows_matched} session${result.rows_matched !== 1 ? 's' : ''} billed`,
      `$${(result.total_deducted_cents / 100).toFixed(2)} deducted${result.rows_unmatched > 0 ? ` · ${result.rows_unmatched} unmatched` : ''}${result.rows_already_billed > 0 ? ` · ${result.rows_already_billed} skipped` : ''}`
    ).catch(() => {});
  }

  return {
    processed: result.rows_total,
    charged: result.rows_matched,
    unknown: result.rows_unmatched,
    already_billed: result.rows_already_billed,
    total_deducted_cents: result.total_deducted_cents,
  };
}
