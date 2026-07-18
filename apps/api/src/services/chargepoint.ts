/**
 * ChargePoint Web Services API v5.1 — SOAP client
 * Endpoint: https://webservices.chargepoint.com/webservices/chargepoint/services/5.1
 * Auth: WS-Security UsernameToken in SOAP header
 *
 * Multi-tenant: every call takes a per-building `CpConfig` (station id + API
 * credentials). `getBuildingCpConfig()` loads and decrypts a building's stored
 * credentials, falling back to the global env vars ONLY for the default "2020"
 * building during the transition.
 */

import https from 'https';
import { query } from '../db';
import { decryptSecret, credEncryptionAvailable } from '../utils/crypto';

const CP_ENDPOINT = 'https://webservices.chargepoint.com/webservices/chargepoint/services/5.1';

export interface CpConfig {
  username: string;
  password: string;
  stationId: string;
}

/**
 * Resolve a building's ChargePoint config: decrypt its stored credentials, or
 * fall back to the global env vars for the default building only. Returns null
 * when the building has no usable ChargePoint configuration (caller should skip).
 */
export async function getBuildingCpConfig(buildingId: string | null): Promise<CpConfig | null> {
  if (!buildingId) return null;
  const r = await query<{ slug: string; cp_station_id: string | null; cp_api_key_enc: string | null; cp_api_password_enc: string | null }>(
    `SELECT slug, cp_station_id, cp_api_key_enc, cp_api_password_enc FROM buildings WHERE id = $1`,
    [buildingId]
  );
  const b = r.rows[0];
  if (!b) return null;

  let username = '';
  let password = '';
  if (b.cp_api_key_enc && b.cp_api_password_enc && credEncryptionAvailable()) {
    try {
      username = decryptSecret(b.cp_api_key_enc);
      password = decryptSecret(b.cp_api_password_enc);
    } catch (err) {
      console.error(`[chargepoint] Failed to decrypt credentials for building ${buildingId}`);
      return null;
    }
  } else if (b.slug === '2020') {
    // Legacy fallback: the original building still uses env-var credentials until
    // they're migrated into its encrypted columns. Other buildings must store their own.
    username = process.env.CP_API_KEY || '';
    password = process.env.CP_API_PASSWORD || '';
  }

  const stationId = b.cp_station_id || (b.slug === '2020' ? (process.env.CP_STATION_ID || '1:19522681') : '');
  if (!username || !password || !stationId) return null;
  return { username, password, stationId };
}

function soapEnvelope(body: string, cfg: CpConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
  xmlns:cp="urn:dictionary:com.chargepoint.webservices">
  <soapenv:Header>
    <wsse:Security>
      <wsse:UsernameToken>
        <wsse:Username>${cfg.username}</wsse:Username>
        <wsse:Password>${cfg.password}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>
    ${body}
  </soapenv:Body>
</soapenv:Envelope>`;
}

function soapPost(xmlBody: string, cfg: CpConfig): Promise<string> {
  const envelope = soapEnvelope(xmlBody, cfg);
  return new Promise((resolve, reject) => {
    const url = new URL(CP_ENDPOINT);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(envelope),
        'SOAPAction': '""',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('ChargePoint API timeout')); });
    req.write(envelope);
    req.end();
  });
}

/** Extract text content of first matching XML tag */
function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\/(?:[^:>]+:)?${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

/** Extract all occurrences of a tag as an array of inner XML strings */
function extractAllTags(xml: string, tag: string): string[] {
  const regex = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\/(?:[^:>]+:)?${tag}>`, 'gi');
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

export type ChargerStatus = 'AVAILABLE' | 'IN_USE' | 'OFFLINE' | 'UNKNOWN';

export interface StationStatus {
  stationId: string;
  status: ChargerStatus;
  portStatuses: { portNumber: string; status: string; sessionId?: string }[];
  rawStatus: string;
}

export interface ChargingSession {
  sessionId: string;
  chargepointUserId?: string;  // numeric CP user ID from userID SOAP field
  startTime: string;
  endTime?: string;
  energyKwh: number;
  durationMinutes: number;
  portNumber: string;
}

export interface CurrentLoad {
  stationId: string;
  loadKw: number;
  allowedLoadKw: number;
}

/**
 * GET real-time station status
 */
export async function getStationStatus(cfg: CpConfig): Promise<StationStatus> {
  const body = `
    <cp:getStationStatus>
      <stationID>${cfg.stationId}</stationID>
    </cp:getStationStatus>`;

  const xml = await soapPost(body, cfg);

  // Parse port statuses
  const portBlocks = extractAllTags(xml, 'Port');
  const portStatuses = portBlocks.map((block) => ({
    portNumber: extractTag(block, 'portNumber') || extractTag(block, 'PortNumber'),
    status: extractTag(block, 'Status') || extractTag(block, 'status'),
    sessionId: extractTag(block, 'sessionID') || undefined,
  }));

  // Derive overall status from ports
  let status: ChargerStatus = 'UNKNOWN';
  const responseCode = extractTag(xml, 'responseCode');

  const networkStatus = extractTag(xml, 'networkStatus').toUpperCase();
  if (responseCode && responseCode !== '100') {
    status = 'OFFLINE';
  } else if (networkStatus === 'UNREACHABLE' || networkStatus === 'NOT CONNECTED') {
    status = 'OFFLINE';
  } else if (portStatuses.length > 0) {
    const allStatuses = portStatuses.map(p => p.status.toUpperCase());
    if (allStatuses.some(s => s === 'UNREACHABLE' || s === 'OFFLINE' || s === 'FAULTED' || s === 'UNAVAILABLE')) {
      status = 'OFFLINE';
    } else if (allStatuses.some(s => s === 'INUSE' || s === 'IN_USE' || s === 'CHARGING')) {
      status = 'IN_USE';
    } else if (allStatuses.every(s => s === 'AVAILABLE')) {
      status = 'AVAILABLE';
    } else {
      status = 'AVAILABLE';
    }
  }

  return {
    stationId: cfg.stationId,
    status,
    portStatuses,
    rawStatus: extractTag(xml, 'Status') || '',
  };
}

/**
 * GET recent charging sessions (last N days)
 */
export async function getChargingSessions(cfg: CpConfig, fromDate: Date, toDate: Date): Promise<ChargingSession[]> {
  const fmt = (d: Date) => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  const body = `
    <cp:getChargingSessionData>
      <stationID>${cfg.stationId}</stationID>
      <fromTimeStamp>${fmt(fromDate)}</fromTimeStamp>
      <toTimeStamp>${fmt(toDate)}</toTimeStamp>
    </cp:getChargingSessionData>`;

  const xml = await soapPost(body, cfg);

  const sessionBlocks = extractAllTags(xml, 'ChargingSessionData');

  return sessionBlocks.map((block) => {
    const energyStr = extractTag(block, 'Energy');
    const durationStr = extractTag(block, 'Duration');
    const cpUserId = extractTag(block, 'userID');

    return {
      sessionId: extractTag(block, 'sessionID'),
      chargepointUserId: cpUserId || undefined,
      startTime: extractTag(block, 'startTime'),
      endTime: extractTag(block, 'endTime') || undefined,
      energyKwh: energyStr ? parseFloat(energyStr) : 0,
      durationMinutes: durationStr ? Math.round(parseFloat(durationStr) / 60) : 0,
      portNumber: extractTag(block, 'portNumber') || '1',
    };
  });
}

export interface ChargePointUser {
  userId: string;
  fullName: string;
  email?: string;
}

/**
 * Resolve a ChargePoint numeric userID to a real name + email via getUsers.
 * getChargingSessionData only exposes the numeric userID, but getUsers carries
 * firstName/lastName plus customInfos (email, unit, vehicle). Returns null if
 * the user can't be resolved.
 */
export async function getUser(cfg: CpConfig, userId: string): Promise<ChargePointUser | null> {
  const body = `
    <cp:getUsers>
      <searchQuery><userID>${userId}</userID></searchQuery>
    </cp:getUsers>`;

  const xml = await soapPost(body, cfg);
  if (!extractTag(xml, 'user')) return null;

  const firstName = extractTag(xml, 'firstName');
  const lastName = extractTag(xml, 'lastName');
  const fullName = `${firstName} ${lastName}`.trim();

  // Email lives in customInfos: <customInfo><Key>Email address</Key><Value>..</Value></customInfo>
  let email: string | undefined;
  for (const ci of extractAllTags(xml, 'customInfo')) {
    if (extractTag(ci, 'Key').toLowerCase().includes('email')) {
      email = extractTag(ci, 'Value').trim() || undefined;
      break;
    }
  }

  if (!fullName && !email) return null;
  return { userId, fullName, email };
}

/**
 * GET current power draw
 */
export async function getCurrentLoad(cfg: CpConfig): Promise<CurrentLoad> {
  const body = `
    <cp:getLoad>
      <stationID>${cfg.stationId}</stationID>
    </cp:getLoad>`;

  const xml = await soapPost(body, cfg);

  return {
    stationId: cfg.stationId,
    loadKw: parseFloat(extractTag(xml, 'Load') || '0'),
    allowedLoadKw: parseFloat(extractTag(xml, 'AllowedLoad') || '0'),
  };
}
