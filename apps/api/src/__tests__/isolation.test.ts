/**
 * Cross-building isolation tests (multi-tenancy).
 *
 * Proves that a building_admin scoped to building A can never read or mutate
 * building B's data through the real routers + auth/resolveBuilding middleware,
 * and that the per-building billing dedup index lets the same ChargePoint session
 * id exist in two buildings without collision.
 *
 * Requires a DEDICATED test Postgres — set DATABASE_URL to a database whose name
 * contains "test". The suite DROPs and rebuilds the public schema, so it refuses
 * to run against anything that doesn't look like a throwaway test DB.
 *
 *   DATABASE_URL=postgres://.../mt_test npm test
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { app, runMigrations } from '../index';
import { pool } from '../db';
import { signAccessToken } from '../utils/jwt';

const CS = process.env.DATABASE_URL || '';
if (!/test/i.test(CS)) {
  throw new Error(
    'Refusing to run isolation tests: DATABASE_URL must point at a dedicated test database (name containing "test"). ' +
    'These tests DROP and rebuild the schema.'
  );
}

async function bootstrapSchema() {
  // Clean slate — nuke everything (tables, triggers, functions) then rebuild.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
  const dbDir = path.join(__dirname, '..', 'db');
  const files = [
    'schema.sql',
    'migrations/001_add_avatar_url.sql',
    'migrations/002_add_settings.sql',
    'migrations/003_add_wallets.sql',
    'migrations/004_chargepoint_drivers.sql',
  ];
  for (const f of files) {
    await pool.query(fs.readFileSync(path.join(dbDir, f), 'utf8'));
  }
  await runMigrations(); // adds buildings + building_id + roles + NOT NULL + composite indexes
}

interface Bldg { id: string; adminToken: string; adminId: string; memberId: string; }

async function seedBuilding(slug: string, cpSessionId: string): Promise<Bldg> {
  const b = await pool.query(`INSERT INTO buildings (slug, name) VALUES ($1, $2) RETURNING id`, [slug, `Bldg ${slug}`]);
  const buildingId = b.rows[0].id;

  const admin = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, building_id) VALUES ($1,$2,'x','admin',$3) RETURNING id`,
    [`${slug} admin`, `admin@${slug}.test`, buildingId]
  );
  const member = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, building_id, priority_day) VALUES ($1,$2,'x','member',$3,'monday') RETURNING id`,
    [`${slug} member`, `member@${slug}.test`, buildingId]
  );
  const adminId = admin.rows[0].id;
  const memberId = member.rows[0].id;

  await pool.query(`INSERT INTO wallets (user_id, balance_cents, building_id) VALUES ($1,5000,$2),($3,5000,$2)`, [adminId, buildingId, memberId]);
  await pool.query(
    `INSERT INTO sessions (user_id, type, status, estimated_end, building_id) VALUES ($1,'normal','completed',NOW(),$2)`,
    [memberId, buildingId]
  );
  await pool.query(
    `INSERT INTO feed_messages (user_id, type, body, building_id) VALUES ($1,'chat',$2,$3)`,
    [memberId, `hello from ${slug}`, buildingId]
  );
  await pool.query(
    `INSERT INTO wallet_transactions (user_id, amount_cents, type, description, kwh, chargepoint_session_id, building_id)
     VALUES ($1,-500,'charge',$2,3.5,$3,$4)`,
    [memberId, `charge ${slug}`, cpSessionId, buildingId]
  );
  await pool.query(
    `INSERT INTO settings (key, value, building_id) VALUES ('electricity_rate_cents_per_kwh', $1, $2)`,
    [String(slug === 'alpha' ? 22 : 33), buildingId]
  );

  const adminToken = signAccessToken({ userId: adminId, role: 'admin', buildingId });
  return { id: buildingId, adminToken, adminId, memberId };
}

let A: Bldg;
let B: Bldg;
const SHARED_CP_SESSION = '999000111'; // same id used in BOTH buildings

beforeAll(async () => {
  await bootstrapSchema();
  A = await seedBuilding('alpha', SHARED_CP_SESSION);
  B = await seedBuilding('beta', SHARED_CP_SESSION);
});

afterAll(async () => {
  await pool.end();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('cross-building read isolation (building A admin cannot see B)', () => {
  test('GET /users returns only building A users', async () => {
    const res = await request(app).get('/users').set(auth(A.adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((u: any) => u.id);
    expect(ids).toContain(A.adminId);
    expect(ids).toContain(A.memberId);
    expect(ids).not.toContain(B.adminId);
    expect(ids).not.toContain(B.memberId);
  });

  test('GET /wallet/users returns only building A wallets', async () => {
    const res = await request(app).get('/wallet/users').set(auth(A.adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((u: any) => u.id);
    expect(ids.sort()).toEqual([A.adminId, A.memberId].sort());
  });

  test('GET /wallet/activity returns only building A charges', async () => {
    const res = await request(app).get('/wallet/activity').set(auth(A.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].user_id).toBe(A.memberId);
  });

  test('GET /sessions/history returns only building A sessions', async () => {
    const res = await request(app).get('/sessions/history').set(auth(A.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].user_id).toBe(A.memberId);
  });

  test('GET /feed returns only building A messages', async () => {
    const res = await request(app).get('/feed').set(auth(A.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].body).toBe('hello from alpha');
  });

  test('GET /schedule returns only building A priority assignments', async () => {
    const res = await request(app).get('/schedule').set(auth(A.adminToken));
    expect(res.status).toBe(200);
    const monday = res.body.data.assignments.find((a: any) => a.day === 'monday');
    expect(monday.user_id).toBe(A.memberId); // not B's member
  });

  test('GET /settings/electricity-rate returns building A rate (22), not B (33)', async () => {
    const res = await request(app).get('/settings/electricity-rate').set(auth(A.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.rate_cents).toBe(22);
  });
});

describe('cross-building write isolation', () => {
  test('admin A cannot credit a building B user (404)', async () => {
    const res = await request(app)
      .post('/wallet/credit')
      .set(auth(A.adminToken))
      .send({ user_id: B.memberId, amount_dollars: 10 });
    expect(res.status).toBe(404);
  });

  test('admin A cannot delete a building B user', async () => {
    const res = await request(app).delete(`/users/${B.memberId}`).set(auth(A.adminToken));
    expect(res.status).toBe(404);
    // B's member still exists
    const still = await pool.query('SELECT 1 FROM users WHERE id = $1', [B.memberId]);
    expect(still.rows.length).toBe(1);
  });

  test('admin A cannot change a building B user role/priority (404)', async () => {
    const res = await request(app)
      .patch(`/users/${B.memberId}`)
      .set(auth(A.adminToken))
      .send({ priority_day: 'friday' });
    expect(res.status).toBe(404);
  });
});

describe('super-admin building deletion (DELETE /admin/buildings/:id)', () => {
  // Fake userId is fine — requireSuperAdmin only checks role, and the endpoint
  // only logs the id (no FK on it).
  const superToken = signAccessToken({ userId: '00000000-0000-0000-0000-000000000000', role: 'super_admin', buildingId: null });

  test('a building admin is forbidden and the target survives (403)', async () => {
    const res = await request(app).delete(`/admin/buildings/${B.id}`).set(auth(A.adminToken)).send({ confirm_slug: 'beta' });
    expect(res.status).toBe(403);
    expect((await pool.query('SELECT 1 FROM buildings WHERE id = $1', [B.id])).rows.length).toBe(1);
  });

  test('the primary "2020" building cannot be deleted (403)', async () => {
    const t = await pool.query(`SELECT id FROM buildings WHERE slug = '2020'`);
    const res = await request(app).delete(`/admin/buildings/${t.rows[0].id}`).set(auth(superToken)).send({ confirm_slug: '2020' });
    expect(res.status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM buildings WHERE slug = '2020'`)).rows.length).toBe(1);
  });

  test('a wrong confirm_slug is rejected and nothing is deleted (400)', async () => {
    const g = await seedBuilding('gamma', '555000');
    const res = await request(app).delete(`/admin/buildings/${g.id}`).set(auth(superToken)).send({ confirm_slug: 'nope' });
    expect(res.status).toBe(400);
    expect((await pool.query('SELECT 1 FROM buildings WHERE id = $1', [g.id])).rows.length).toBe(1);
    // tidy up for the next test
    await request(app).delete(`/admin/buildings/${g.id}`).set(auth(superToken)).send({ confirm_slug: 'gamma' });
  });

  test('correct confirm_slug deletes the building + all tenant rows, leaving others intact', async () => {
    const g = await seedBuilding('delta', '556000');
    await pool.query(`INSERT INTO charger_queue (building_id, user_id) VALUES ($1, $2)`, [g.id, g.memberId]);
    const res = await request(app).delete(`/admin/buildings/${g.id}`).set(auth(superToken)).send({ confirm_slug: 'delta' });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted.slug).toBe('delta');
    for (const [t, col] of [['buildings', 'id'], ['users', 'building_id'], ['wallets', 'building_id'],
                            ['sessions', 'building_id'], ['feed_messages', 'building_id'],
                            ['wallet_transactions', 'building_id'], ['settings', 'building_id'],
                            ['charger_queue', 'building_id']] as const) {
      expect((await pool.query(`SELECT 1 FROM ${t} WHERE ${col} = $1`, [g.id])).rows.length).toBe(0);
    }
    // Building A is untouched.
    expect((await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE building_id = $1', [A.id])).rows[0].c).toBe(2);
  });
});

describe('per-building billing dedup', () => {
  test('the same chargepoint_session_id exists independently in both buildings', async () => {
    const r = await pool.query(
      `SELECT building_id FROM wallet_transactions WHERE chargepoint_session_id = $1`,
      [SHARED_CP_SESSION]
    );
    const buildings = r.rows.map((x: any) => x.building_id).sort();
    expect(buildings.sort()).toEqual([A.id, B.id].sort());
  });

  test('a duplicate chargepoint_session_id within one building is rejected', async () => {
    await expect(
      pool.query(
        `INSERT INTO wallet_transactions (user_id, amount_cents, type, description, kwh, chargepoint_session_id, building_id)
         VALUES ($1,-100,'charge','dup',1,$2,$3)`,
        [A.memberId, SHARED_CP_SESSION, A.id]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('charger queue — cross-building isolation + offer engine (v1.1)', () => {
  let aMember: string;
  let bMember: string;

  beforeAll(() => {
    aMember = signAccessToken({ userId: A.memberId, role: 'member', buildingId: A.id });
    bMember = signAccessToken({ userId: B.memberId, role: 'member', buildingId: B.id });
  });

  test('B member joining B’s queue is offered instantly (charger free) — A’s queue stays empty', async () => {
    const join = await request(app).post('/queue/join').set(auth(bMember));
    expect(join.status).toBe(201);
    expect(join.body.data.me.status).toBe('offered');
    expect(join.body.data.me.position).toBe(0);

    const aQueue = await request(app).get('/queue').set(auth(A.adminToken));
    expect(aQueue.status).toBe(200);
    expect(aQueue.body.data.entries.length).toBe(0);
    expect(aQueue.body.data.offered).toBeNull();
  });

  test('A member queues behind A’s active session as waiting #1; B unaffected', async () => {
    const start = await request(app).post('/sessions/start').set(auth(A.adminToken))
      .send({ type: 'normal', estimated_hours: 2 });
    expect(start.status).toBe(201);

    const join = await request(app).post('/queue/join').set(auth(aMember));
    expect(join.status).toBe(201);
    expect(join.body.data.me.status).toBe('waiting');
    expect(join.body.data.me.position).toBe(1);

    const bQueue = await request(app).get('/queue').set(auth(B.adminToken));
    expect(bQueue.body.data.entries.map((e: any) => e.user_id)).toEqual([B.memberId]);
  });

  test('joining twice is a no-op (still one live entry)', async () => {
    const again = await request(app).post('/queue/join').set(auth(aMember));
    expect(again.status).toBe(201);
    const q = await request(app).get('/queue').set(auth(A.adminToken));
    expect(q.body.data.entries.filter((e: any) => e.user_id === A.memberId).length).toBe(1);
  });

  test('ending the session hands the charger to A’s queue (offer + queue_notified)', async () => {
    const active = await request(app).get('/sessions/active').set(auth(A.adminToken));
    const end = await request(app).post(`/sessions/${active.body.data.id}/end`).set(auth(A.adminToken));
    expect(end.status).toBe(200);
    expect(end.body.queue_notified).toBe(true);

    const q = await request(app).get('/queue').set(auth(aMember));
    expect(q.body.data.me.status).toBe('offered');
    expect(q.body.data.me.position).toBe(0);
    expect(new Date(q.body.data.me.offer_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('while A member holds the offer, others cannot start — the holder can, which claims their entry', async () => {
    const blocked = await request(app).post('/sessions/start').set(auth(A.adminToken))
      .send({ type: 'normal', estimated_hours: 2 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/held for/i);

    const start = await request(app).post('/sessions/start').set(auth(aMember))
      .send({ type: 'top_up', estimated_hours: 1 });
    expect(start.status).toBe(201);

    const q = await request(app).get('/queue').set(auth(aMember));
    expect(q.body.data.entries.length).toBe(0);
    const row = await pool.query(
      `SELECT status FROM charger_queue WHERE building_id = $1 AND user_id = $2 ORDER BY joined_at DESC LIMIT 1`,
      [A.id, A.memberId]
    );
    expect(row.rows[0].status).toBe('claimed');
  });

  test('the active charger cannot also queue (409)', async () => {
    const res = await request(app).post('/queue/join').set(auth(aMember));
    expect(res.status).toBe(409);
  });

  test('B member passes their offer; B’s queue empties without touching A', async () => {
    const pass = await request(app).post('/queue/pass').set(auth(bMember));
    expect(pass.status).toBe(200);
    const bQueue = await request(app).get('/queue').set(auth(B.adminToken));
    expect(bQueue.body.data.entries.length).toBe(0);
    // A still has its (claimed→resolved) state and an active session — untouched
    const active = await request(app).get('/sessions/active').set(auth(A.adminToken));
    expect(active.body.data.user_id).toBe(A.memberId);
  });

  test('pass without an offer is rejected (409)', async () => {
    const res = await request(app).post('/queue/pass').set(auth(bMember));
    expect(res.status).toBe(409);
  });

  test('claim ("On my way") keeps the hold alive until plug-in', async () => {
    const active = await request(app).get('/sessions/active').set(auth(aMember));
    await request(app).post(`/sessions/${active.body.data.id}/end`).set(auth(aMember));

    const join = await request(app).post('/queue/join').set(auth(A.adminToken));
    expect(join.body.data.me.status).toBe('offered');
    const claim = await request(app).post('/queue/claim').set(auth(A.adminToken));
    expect(claim.status).toBe(200);
    // Still holding: the entry stays offered (with claimed_at) so the engine
    // can't re-offer the charger to someone else mid-walk...
    expect(claim.body.data.me.status).toBe('offered');
    expect(claim.body.data.me.claimed_at).not.toBeNull();
    const { advanceQueue } = require('../services/chargerWatch');
    expect(await advanceQueue(A.id, { checkCp: true })).toBe(true); // hold intact
    // ...and others still can't start a session over the hold.
    const blocked = await request(app).post('/sessions/start').set(auth(aMember))
      .send({ type: 'top_up', estimated_hours: 1 });
    expect(blocked.status).toBe(409);
    // Plugging in resolves the claimed hold.
    const start = await request(app).post('/sessions/start').set(auth(A.adminToken))
      .send({ type: 'top_up', estimated_hours: 1 });
    expect(start.status).toBe(201);
    const q = await request(app).get('/queue').set(auth(A.adminToken));
    expect(q.body.data.entries.length).toBe(0);
    const row = await pool.query(
      `SELECT status FROM charger_queue WHERE building_id = $1 AND user_id = $2 ORDER BY joined_at DESC LIMIT 1`,
      [A.id, A.adminId]
    );
    expect(row.rows[0].status).toBe('claimed');
    // tidy: free the charger for the next tests
    const a2 = await request(app).get('/sessions/active').set(auth(A.adminToken));
    await request(app).post(`/sessions/${a2.body.data.id}/end`).set(auth(A.adminToken));
  });

  test('leave cancels a live entry', async () => {
    const join = await request(app).post('/queue/join').set(auth(aMember));
    expect(join.body.data.me.status).toBe('offered'); // charger free → instant hold
    const leave = await request(app).post('/queue/leave').set(auth(aMember));
    expect(leave.status).toBe(200);
    expect(leave.body.data.me).toBeNull();
  });

  test('an expired offer auto-advances to the next waiting resident (5-min tick path)', async () => {
    await pool.query(
      `INSERT INTO charger_queue (building_id, user_id, status, joined_at, offered_at, offer_expires_at)
       VALUES ($1, $2, 'offered', NOW() - interval '30 minutes', NOW() - interval '20 minutes', NOW() - interval '5 minutes')`,
      [A.id, A.memberId]
    );
    await pool.query(`INSERT INTO charger_queue (building_id, user_id) VALUES ($1, $2)`, [A.id, A.adminId]);

    const { advanceQueue } = require('../services/chargerWatch');
    const advanced = await advanceQueue(A.id, { checkCp: true });
    expect(advanced).toBe(true);

    const rows = await pool.query(
      `SELECT user_id, status FROM charger_queue WHERE building_id = $1 AND status IN ('waiting','offered','expired')
       ORDER BY joined_at ASC`,
      [A.id]
    );
    expect(rows.rows.find((r: any) => r.user_id === A.memberId)?.status).toBe('expired');
    expect(rows.rows.find((r: any) => r.user_id === A.adminId)?.status).toBe('offered');
    // tidy: resolve the admin's offer so later suites start clean
    await request(app).post('/queue/pass').set(auth(A.adminToken));
  });

  test('at most one live offer per building is enforced at the DB level', async () => {
    await pool.query(
      `INSERT INTO charger_queue (building_id, user_id, status, offered_at, offer_expires_at)
       VALUES ($1, $2, 'offered', NOW(), NOW() + interval '15 minutes')`,
      [B.id, B.memberId]
    );
    await expect(
      pool.query(
        `INSERT INTO charger_queue (building_id, user_id, status, offered_at, offer_expires_at)
         VALUES ($1, $2, 'offered', NOW(), NOW() + interval '15 minutes')`,
        [B.id, B.adminId]
      )
    ).rejects.toMatchObject({ code: '23505' });
    await pool.query(`UPDATE charger_queue SET status = 'cancelled', resolved_at = NOW()
                      WHERE building_id = $1 AND status IN ('waiting','offered')`, [B.id]);
  });
});

describe('v1.1 Features 2+3 — car profiles, idle fee, anti-camping escalation', () => {
  let aMember: string;

  beforeAll(() => {
    aMember = signAccessToken({ userId: A.memberId, role: 'member', buildingId: A.id });
  });

  test('PATCH /users/me accepts a car profile and rejects out-of-range values', async () => {
    const ok = await request(app).patch('/users/me').set(auth(aMember))
      .send({ car_make: 'Hyundai', car_model: 'Ioniq 5', battery_kwh: 77.4, target_percent: 80 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.car_model).toBe('Ioniq 5');
    expect(ok.body.data.target_percent).toBe(80);

    const bad = await request(app).patch('/users/me').set(auth(aMember)).send({ target_percent: 40 });
    expect(bad.status).toBe(400);
    const bad2 = await request(app).patch('/users/me').set(auth(aMember)).send({ battery_kwh: 5 });
    expect(bad2.status).toBe(400);
  });

  test('idle fee is OFF by default and settings are per-building', async () => {
    const a = await request(app).get('/settings/idle-fee').set(auth(A.adminToken));
    expect(a.status).toBe(200);
    expect(a.body.data.idle_fee_cents_per_15min).toBe(0);

    const set = await request(app).patch('/settings/idle-fee').set(auth(B.adminToken))
      .send({ idle_fee_cents_per_15min: 100, idle_grace_min: 15 });
    expect(set.status).toBe(200);

    // Building A is untouched by B's setting.
    const a2 = await request(app).get('/settings/idle-fee').set(auth(A.adminToken));
    expect(a2.body.data.idle_fee_cents_per_15min).toBe(0);
    const b = await request(app).get('/settings/idle-fee').set(auth(B.adminToken));
    expect(b.body.data.idle_fee_cents_per_15min).toBe(100);

    const bad = await request(app).patch('/settings/idle-fee').set(auth(B.adminToken))
      .send({ idle_fee_cents_per_15min: 501, idle_grace_min: 15 });
    expect(bad.status).toBe(400);
  });

  test('getIdleFeeConfig: null when off, config when set', async () => {
    const { getIdleFeeConfig } = require('../services/chargerWatch');
    expect(await getIdleFeeConfig(A.id)).toBeNull();
    expect(await getIdleFeeConfig(B.id)).toEqual({ feeCents: 100, graceMin: 15 });
  });

  test('idle fee is strictly prospective and bills each verified block exactly once', async () => {
    const { accrueIdleFee } = require('../services/chargerWatch');
    const feeCfg = { feeCents: 100, graceMin: 15 };
    const refetch = async (id: string) =>
      (await pool.query(`SELECT * FROM sessions WHERE id = $1`, [id])).rows[0];
    const txCount = async (id: string) =>
      (await pool.query(`SELECT COUNT(*)::int AS c FROM wallet_transactions WHERE session_id = $1`, [id])).rows[0].c;

    // Car idle for 10 HOURS before anyone queued → first eligible tick only
    // anchors the meter; NOTHING is retro-billed for the empty-queue night.
    const ins = await pool.query(
      `INSERT INTO sessions (user_id, type, status, estimated_end, building_id, idle_reminder_at)
       VALUES ($1, 'normal', 'active', NOW(), $2, NOW() - interval '10 hours')
       RETURNING *`,
      [B.memberId, B.id]
    );
    let session = ins.rows[0];
    await accrueIdleFee(session, 1, feeCfg);
    expect(await txCount(session.id)).toBe(0);
    session = await refetch(session.id);
    expect(session.idle_fee_billed_through).not.toBeNull();

    // 16 verified-eligible minutes later → exactly one 15-min block billed.
    await pool.query(
      `UPDATE sessions SET idle_fee_billed_through = NOW() - interval '16 minutes' WHERE id = $1`,
      [session.id]
    );
    session = await refetch(session.id);
    await accrueIdleFee(session, 2, feeCfg);
    const tx = await pool.query(
      `SELECT amount_cents, type, description FROM wallet_transactions WHERE session_id = $1`,
      [session.id]
    );
    expect(tx.rows.length).toBe(1);
    expect(tx.rows[0].type).toBe('charge');
    expect(tx.rows[0].amount_cents).toBe(-100);
    expect(tx.rows[0].description).toMatch(/Idle fee/);
    const bal = await pool.query(`SELECT balance_cents FROM wallets WHERE user_id = $1`, [B.memberId]);
    expect(bal.rows[0].balance_cents).toBe(4900); // seeded 5000 − 100

    // A long gap (some gate blocked billing: queue empty, CP outage, fee off,
    // car charging) re-anchors instead of lump-sum billing the gap.
    await pool.query(
      `UPDATE sessions SET idle_fee_billed_through = NOW() - interval '3 hours' WHERE id = $1`,
      [session.id]
    );
    session = await refetch(session.id);
    await accrueIdleFee(session, 2, feeCfg);
    expect(await txCount(session.id)).toBe(1);

    // A stale caller (thinks 0 blocks were billed) is stopped by the CAS guard.
    await pool.query(
      `UPDATE sessions SET idle_fee_billed_through = NOW() - interval '16 minutes' WHERE id = $1`,
      [session.id]
    );
    session = await refetch(session.id);
    await accrueIdleFee({ ...session, idle_fee_blocks_billed: 0 }, 2, feeCfg);
    expect(await txCount(session.id)).toBe(1);

    // Ended sessions never bill, even with a billable window open.
    await pool.query(
      `UPDATE sessions SET status = 'completed', actual_end = NOW(),
              idle_fee_billed_through = NOW() - interval '16 minutes' WHERE id = $1`,
      [session.id]
    );
    session = await refetch(session.id);
    await accrueIdleFee(session, 2, feeCfg);
    expect(await txCount(session.id)).toBe(1);
  });

  test('estimated-passed nudge uses queue-aware copy path and escalates once after 20 min', async () => {
    const { checkOneSession } = require('../services/chargerWatch');
    const ins = await pool.query(
      `INSERT INTO sessions (user_id, type, status, estimated_end, building_id, started_at)
       VALUES ($1, 'normal', 'active', NOW() - interval '1 minute', $2, NOW() - interval '2 hours')
       RETURNING id`,
      [A.memberId, A.id]
    );
    const sid = ins.rows[0].id;
    await pool.query(`INSERT INTO charger_queue (building_id, user_id) VALUES ($1, $2)`, [A.id, A.adminId]);
    const fetchRow = async () => (await pool.query(
      `SELECT s.*, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [sid]
    )).rows[0];

    await checkOneSession(await fetchRow());
    let row = await fetchRow();
    expect(row.estimated_reminder_at).not.toBeNull();
    expect(row.idle_escalated_at).toBeNull(); // second nudge needs 20 more minutes

    await pool.query(
      `UPDATE sessions SET estimated_reminder_at = NOW() - interval '25 minutes' WHERE id = $1`, [sid]
    );
    await checkOneSession(await fetchRow());
    row = await fetchRow();
    expect(row.idle_escalated_at).not.toBeNull();

    // Re-running never re-escalates (one-shot flag).
    const escalatedAt = row.idle_escalated_at;
    await checkOneSession(await fetchRow());
    expect((await fetchRow()).idle_escalated_at).toEqual(escalatedAt);

    await pool.query(`UPDATE sessions SET status = 'completed', actual_end = NOW() WHERE id = $1`, [sid]);
    await pool.query(
      `UPDATE charger_queue SET status = 'cancelled', resolved_at = NOW()
       WHERE building_id = $1 AND status IN ('waiting','offered')`, [A.id]
    );
  });
});
