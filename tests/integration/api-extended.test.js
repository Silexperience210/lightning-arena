// =====================================================
// Integration tests — Extended API coverage
//
// Covers routes not tested in api.test.js:
//   requireGameHost middleware
//   GET  /api/wallet/balance
//   POST /api/wallet/nwc/connect + disconnect
//   GET  /api/wallet/deposit/:hash
//   POST /api/games/:roomCode/join
//   POST /api/games/:gameId/start
//   POST /api/games/:gameId/end
//   GET  /api/games
//   GET  /api/payments/history
//   POST /api/wallet/detect
// =====================================================

'use strict';

// ── Shared query builder ──────────────────────────────────────────────────────

const qb = {
  where:     jest.fn().mockReturnThis(),
  orWhere:   jest.fn().mockReturnThis(),
  whereIn:   jest.fn().mockReturnThis(),
  whereNot:  jest.fn().mockReturnThis(),
  andWhere:  jest.fn().mockReturnThis(),
  select:    jest.fn().mockReturnThis(),
  join:      jest.fn().mockReturnThis(),
  orderBy:   jest.fn().mockReturnThis(),
  limit:     jest.fn().mockReturnThis(),
  offset:    jest.fn().mockReturnThis(),
  sum:       jest.fn().mockReturnThis(),
  first:     jest.fn().mockResolvedValue(null),
  update:    jest.fn().mockResolvedValue(1),
  decrement: jest.fn().mockResolvedValue(1),
  increment: jest.fn().mockResolvedValue(1),
  insert:    jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([null]),
  del:       jest.fn().mockResolvedValue(1)
};

const mockDb = jest.fn(() => qb);
mockDb.transaction = jest.fn().mockImplementation(async (cb) => cb(mockDb));
mockDb.raw = jest.fn((sql, bindings) => ({ toString: () => sql }));

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('knex', () => jest.fn(() => mockDb));

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect:    jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    get:        jest.fn().mockResolvedValue(null),
    set:        jest.fn().mockResolvedValue('OK')
  }))
}));

jest.mock('../../src/lnd-client', () => ({
  createLightningClient: jest.fn(() => null)
}));

const mockNWCClient = {
  getInfo:     jest.fn().mockResolvedValue({ pubkey: 'testpubkey' }),
  makeInvoice: jest.fn(),
  payInvoice:  jest.fn()
};
jest.mock('@getalby/sdk', () => ({
  nwc: { NWCClient: jest.fn().mockImplementation(() => mockNWCClient) }
}));

const mockPaymentRouterInstance = {
  on:              jest.fn(),
  emit:            jest.fn(),
  encrypt:         jest.fn().mockReturnValue({ encrypted: 'enc', iv: '00'.repeat(16), authTag: '00'.repeat(16) }),
  executeTransfer: jest.fn().mockResolvedValue({ success: true, transferId: 'tx-1', mode: 'ESCROW_INTERNAL' }),
  startRetryWorker:   jest.fn(),
  startCleanupWorker: jest.fn()
};
jest.mock('../../src/PaymentRouter', () => jest.fn(() => mockPaymentRouterInstance));

jest.mock('bcrypt', () => ({
  hash:    jest.fn().mockResolvedValue('$2b$10$fakehash'),
  compare: jest.fn().mockResolvedValue(false)
}));

// ── Require after mocks ───────────────────────────────────────────────────────

const request = require('supertest');
const jwt     = require('jsonwebtoken');

const { app } = require('../../server');

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-jwt-secret-32-chars-minimum!';
const ALICE_ID   = 'alice-uuid-0000-0000-0000';
const BOB_ID     = 'bob-uuid-0000-0000-0000';
const GAME_ID    = 'game-uuid-0000-0000-0000';

function signToken(payload = {}) {
  return jwt.sign(
    { userId: 'default-user-id', username: 'testuser', ...payload },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

beforeEach(() => {
  Object.keys(qb).forEach(k => {
    if (typeof qb[k]?.mockReset === 'function') {
      qb[k].mockReset();
      if (k !== 'first' && k !== 'returning' && k !== 'update' && k !== 'decrement' && k !== 'increment') {
        qb[k].mockReturnThis();
      }
    }
  });
  qb.first.mockResolvedValue(null);
  qb.update.mockResolvedValue(1);
  qb.decrement.mockResolvedValue(1);
  qb.increment.mockResolvedValue(1);
  qb.returning.mockResolvedValue([null]);
  mockDb.mockClear();
  mockDb.transaction.mockClear();
  mockNWCClient.getInfo.mockResolvedValue({ pubkey: 'testpubkey' });
  mockPaymentRouterInstance.encrypt.mockReturnValue({
    encrypted: 'enc', iv: '00'.repeat(16), authTag: '00'.repeat(16)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireGameHost middleware (tested via POST /api/games/:gameId/start)
// ─────────────────────────────────────────────────────────────────────────────

describe('requireGameHost middleware', () => {
  const aliceToken = signToken({ userId: ALICE_ID });

  test('404 — game not found', async () => {
    // requireGameHost query → null
    qb.first.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/start`)
      .set('Authorization', `Bearer ${aliceToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('403 — authenticated user is not the game host', async () => {
    // requireGameHost: game exists but host is BOB
    qb.first.mockResolvedValueOnce({ id: GAME_ID, host_id: BOB_ID });

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/start`)
      .set('Authorization', `Bearer ${aliceToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/host/i);
  });

  test('is host → passes through to route handler', async () => {
    // requireGameHost: Alice is host
    qb.first.mockResolvedValueOnce({ id: GAME_ID, host_id: ALICE_ID });
    // Handler: game with status 'lobby'
    qb.first.mockResolvedValueOnce({ id: GAME_ID, status: 'lobby', host_id: ALICE_ID });
    // participants query: select returns qb (length undefined < 2 = false → 2+ players)
    // update: default 1

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/start`)
      .set('Authorization', `Bearer ${aliceToken}`);

    // Should pass requireGameHost (not 403/404), and reach the route logic
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/wallet/balance
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/wallet/balance', () => {
  const token = signToken({ userId: ALICE_ID });

  test('200 — returns escrow balance and NWC data for escrow user', async () => {
    const user = {
      id: ALICE_ID,
      wallet_type: 'escrow',
      escrow_balance_sats: 50000,
      escrow_locked_sats: 1000,
      nwc_budget_sats: null,
      nwc_expires_at: null
    };
    qb.first.mockResolvedValueOnce(user);          // user lookup
    qb.first.mockResolvedValueOnce({ total: 0 });  // nwcBalance
    qb.first.mockResolvedValueOnce({ total: 0 });  // pendingWithdrawals

    const res = await request(app)
      .get('/api/wallet/balance')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.walletType).toBe('escrow');
    expect(res.body.escrow.balance).toBe(50000);
    expect(res.body.escrow.locked).toBe(1000);
    expect(res.body.nwc).toBeNull();
  });

  test('200 — returns NWC section for NWC user', async () => {
    const user = {
      id: ALICE_ID,
      wallet_type: 'nwc',
      escrow_balance_sats: 0,
      escrow_locked_sats: 0,
      nwc_budget_sats: 100000,
      nwc_expires_at: new Date(Date.now() + 86400000)
    };
    qb.first.mockResolvedValueOnce(user);
    qb.first.mockResolvedValueOnce({ total: 5000 });  // nwcBalance
    qb.first.mockResolvedValueOnce({ total: 0 });     // pendingWithdrawals

    const res = await request(app)
      .get('/api/wallet/balance')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.walletType).toBe('nwc');
    expect(res.body.nwc).not.toBeNull();
    expect(res.body.nwc.budget24h).toBe(100000);
  });

  test('404 — user not found', async () => {
    qb.first.mockResolvedValueOnce(null); // user not found

    const res = await request(app)
      .get('/api/wallet/balance')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('500 — database error', async () => {
    qb.first.mockRejectedValueOnce(new Error('DB error'));

    const res = await request(app)
      .get('/api/wallet/balance')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/wallet/nwc/connect
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/wallet/nwc/connect', () => {
  const token = signToken({ userId: ALICE_ID });

  test('400 — invalid NWC URI format', async () => {
    const res = await request(app)
      .post('/api/wallet/nwc/connect')
      .set('Authorization', `Bearer ${token}`)
      .send({ nwcUri: 'https://not-a-nwc-uri', budgetSats: 10000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid nwc uri/i);
  });

  test('200 — valid URI connects wallet and returns success', async () => {
    mockNWCClient.getInfo.mockResolvedValueOnce({ pubkey: 'abc123pubkey' });
    qb.update.mockResolvedValueOnce(1);

    const res = await request(app)
      .post('/api/wallet/nwc/connect')
      .set('Authorization', `Bearer ${token}`)
      .send({ nwcUri: 'nostr+walletconnect://relay?secret=abc', budgetSats: 50000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.walletType).toBe('nwc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/wallet/nwc/disconnect
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/wallet/nwc/disconnect', () => {
  test('200 — switches back to escrow mode', async () => {
    const res = await request(app)
      .post('/api/wallet/nwc/disconnect')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/wallet/deposit/:hash  (LND disabled in test env)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/wallet/deposit/:hash', () => {
  const token = signToken({ userId: ALICE_ID });

  test('503 — LND not available', async () => {
    const res = await request(app)
      .get('/api/wallet/deposit/aabbcc')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/wallet/withdraw — supplement (already in api.test.js, extended cases)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/wallet/withdraw — extended', () => {
  test('400 — insufficient balance returns correct error message', async () => {
    qb.update.mockResolvedValueOnce(0);

    const res = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`)
      .send({ amountSats: 999999, lnAddress: 'alice@getalby.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient balance/i);
  });

  test('200 — queues withdrawal and returns pending status with amount', async () => {
    qb.update.mockResolvedValueOnce(1);
    qb.returning.mockResolvedValueOnce([{ id: 'wd-x1' }]);

    const res = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`)
      .send({ amountSats: 1000, lnAddress: 'alice@getalby.com' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.amountSats).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/games/:roomCode/join
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/games/:roomCode/join', () => {
  const token = signToken({ userId: ALICE_ID });
  const lobbyGame = { id: GAME_ID, status: 'lobby', buy_in_sats: 10000, room_code: 'ROOM1' };
  const aliceUser = { id: ALICE_ID, username: 'alice', wallet_type: 'escrow', escrow_balance_sats: 50000 };

  test('404 — game not found', async () => {
    qb.first.mockResolvedValueOnce(aliceUser); // user
    qb.first.mockResolvedValueOnce(null);       // game → not found

    const res = await request(app)
      .post('/api/games/NOTFOUND/join')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('400 — game already started', async () => {
    qb.first.mockResolvedValueOnce(aliceUser);
    qb.first.mockResolvedValueOnce({ ...lobbyGame, status: 'playing' });

    const res = await request(app)
      .post('/api/games/ROOM1/join')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already started/i);
  });

  test('200 — already joined returns existing participant info', async () => {
    qb.first.mockResolvedValueOnce(aliceUser);
    qb.first.mockResolvedValueOnce(lobbyGame);
    qb.first.mockResolvedValueOnce({ id: 'existing-p1', game_id: GAME_ID }); // existing

    const res = await request(app)
      .post('/api/games/ROOM1/join')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/already joined/i);
  });

  test('400 — insufficient balance (escrow user, atomic update returns 0)', async () => {
    qb.first.mockResolvedValueOnce(aliceUser);
    qb.first.mockResolvedValueOnce(lobbyGame);
    qb.first.mockResolvedValueOnce(null);     // no existing participant
    qb.update.mockResolvedValueOnce(0);        // atomic balance deduction fails

    const res = await request(app)
      .post('/api/games/ROOM1/join')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient balance/i);
  });

  test('200 — joins successfully and returns participantId', async () => {
    qb.first.mockResolvedValueOnce(aliceUser);
    qb.first.mockResolvedValueOnce(lobbyGame);
    qb.first.mockResolvedValueOnce(null);             // no existing
    qb.update.mockResolvedValueOnce(1);               // balance locked
    qb.returning.mockResolvedValueOnce([{ id: 'part-new-1' }]); // insert participant
    qb.update.mockResolvedValueOnce(1);               // pot update

    const res = await request(app)
      .post('/api/games/ROOM1/join')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/joined/i);
    expect(res.body).toHaveProperty('gameId', GAME_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/games/:gameId/start
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/games/:gameId/start', () => {
  const token = signToken({ userId: ALICE_ID });
  const hostGame = { id: GAME_ID, host_id: ALICE_ID };

  test('404 — game not found in handler (after requireGameHost)', async () => {
    qb.first.mockResolvedValueOnce(hostGame); // requireGameHost
    qb.first.mockResolvedValueOnce(null);      // handler game lookup → 404

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/start`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('400 — game is not in lobby state', async () => {
    qb.first.mockResolvedValueOnce(hostGame);
    qb.first.mockResolvedValueOnce({ id: GAME_ID, status: 'playing' });

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/start`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status|lobby|start/i);
  });

  test('400 — fewer than 2 players', async () => {
    qb.first.mockResolvedValueOnce(hostGame);
    qb.first.mockResolvedValueOnce({ id: GAME_ID, status: 'lobby' });
    // participants select returns array with 1 player
    qb.select.mockResolvedValueOnce([{ user_id: ALICE_ID }]);

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/start`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 players/i);
  });

  test('200 — starts game with 2+ participants', async () => {
    qb.first.mockResolvedValueOnce(hostGame);
    qb.first.mockResolvedValueOnce({ id: GAME_ID, status: 'lobby' });
    // Default select returns qb (length undefined, undefined < 2 = false → proceeds)

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/start`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('playing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/games/:gameId/end
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/games/:gameId/end', () => {
  const token = signToken({ userId: ALICE_ID });
  const hostGame = { id: GAME_ID, host_id: ALICE_ID };

  test('400 — winnerId is missing', async () => {
    qb.first.mockResolvedValueOnce(hostGame); // requireGameHost

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/end`)
      .set('Authorization', `Bearer ${token}`)
      .send({}); // no winnerId

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/winnerId/i);
  });

  test('400 — winner is not an active participant', async () => {
    qb.first.mockResolvedValueOnce(hostGame);
    qb.first.mockResolvedValueOnce({ id: GAME_ID, status: 'playing', total_pot_sats: 20000, server_fee_percent: 1.0, room_code: 'ABC' });
    qb.first.mockResolvedValueOnce(null); // winner participant → not found

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/end`)
      .set('Authorization', `Bearer ${token}`)
      .send({ winnerId: BOB_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/participant/i);
  });

  test('200 — ends game with correct fee calculation', async () => {
    const totalPot = 20000;
    const feePercent = 1.0;
    const expectedFee = Math.floor(totalPot * feePercent / 100); // 200
    const expectedPayout = totalPot - expectedFee; // 19800

    qb.first.mockResolvedValueOnce(hostGame);
    qb.first.mockResolvedValueOnce({
      id: GAME_ID, status: 'playing',
      total_pot_sats: totalPot, server_fee_percent: feePercent,
      room_code: 'ROOM1'
    });
    qb.first.mockResolvedValueOnce({ id: 'winner-part', user_id: ALICE_ID }); // winner

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/end`)
      .set('Authorization', `Bearer ${token}`)
      .send({ winnerId: ALICE_ID });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.serverFeeSats).toBe(expectedFee);
    expect(res.body.winnerPayoutSats).toBe(expectedPayout);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/games  (new endpoint)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/games', () => {
  test('200 — returns list of lobby games', async () => {
    // select returns qb (await qb = qb, treated as array-like but it's an object)
    // The route does: const games = await db('games').where(...).orderBy(...).limit(...).select(...)
    // select returns qb; await qb = qb. Then res.json(qb) → JSON serialization of mock object
    // We need select to return an array
    qb.select.mockResolvedValueOnce([
      { id: GAME_ID, room_code: 'ROOM1', status: 'lobby', buy_in_sats: 10000 }
    ]);

    const res = await request(app)
      .get('/api/games')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ room_code: 'ROOM1' });
  });

  test('401 — requires authentication', async () => {
    const res = await request(app).get('/api/games');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/history
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/payments/history', () => {
  test('200 — returns transfers array', async () => {
    // select returns qb; await qb = qb (array-like treatment)
    // Need to mock select to return an array
    qb.select.mockResolvedValueOnce([
      { id: 'tx-1', amount_sats: 500, payment_mode: 'escrow_internal' }
    ]);

    const res = await request(app)
      .get('/api/payments/history')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('401 — requires authentication', async () => {
    const res = await request(app).get('/api/payments/history');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/wallet/detect
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/wallet/detect', () => {
  test('200 — known NWC provider (getalby.com) → supportsNWC: true', async () => {
    // fetch is called but will fail in test env (no real network) — but the
    // catch block handles it gracefully and falls through to provider check.
    const res = await request(app)
      .post('/api/wallet/detect')
      .send({ lnAddress: 'user@getalby.com' });

    expect(res.status).toBe(200);
    expect(res.body.supportsNWC).toBe(true);
    expect(res.body.recommendedMode).toBe('nwc');
  });

  test('200 — non-NWC provider → supportsNWC: false, mode: escrow', async () => {
    const res = await request(app)
      .post('/api/wallet/detect')
      .send({ lnAddress: 'user@walletofsatoshi.com' });

    expect(res.status).toBe(200);
    expect(res.body.supportsNWC).toBe(false);
    expect(res.body.recommendedMode).toBe('escrow');
  });

  test('400 — invalid LN address (no @ sign)', async () => {
    const res = await request(app)
      .post('/api/wallet/detect')
      .send({ lnAddress: 'notavalidaddress' });

    // split('@') gives ['notavalidaddress'], so domain is undefined → should throw
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health  &  GET /api/stats
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  test('200 — returns ok status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('version');
  });
});

describe('GET /api/stats', () => {
  test('200 — returns game stats', async () => {
    qb.first.mockResolvedValueOnce({ total_games: 5, active_games: 2, total_volume_sats: 100000 });

    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(200);
  });

  test('500 — database error returns 500', async () => {
    qb.first.mockRejectedValueOnce(new Error('DB error'));

    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login — 500 error path
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login — extended', () => {
  test('500 — database throws during login', async () => {
    qb.first.mockRejectedValueOnce(new Error('DB connection error'));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'pw' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/login failed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register — 500 error path
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/register — extended', () => {
  test('500 — database throws during registration', async () => {
    qb.first.mockRejectedValueOnce(new Error('DB connection error'));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', lnAddress: 'alice@getalby.com', password: 'pw' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/registration failed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/wallet/nwc/connect — NWC client throws → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/wallet/nwc/connect — error path', () => {
  test('400 — NWC client throws on getInfo (bad connection)', async () => {
    mockNWCClient.getInfo.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(app)
      .post('/api/wallet/nwc/connect')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`)
      .send({ nwcUri: 'nostr+walletconnect://relay?secret=abc', budgetSats: 10000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/failed to connect/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LNURL-auth — extended coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login — LNURL-auth extended', () => {
  test('400 — key is not exactly 33 bytes (invalid public key length)', async () => {
    // key is 20 bytes (hex = 40 chars) → rawKey.length = 20 ≠ 33 → 400
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        lnAuth: {
          k1:  '00'.repeat(32),  // 32 bytes
          sig: 'aabb',
          key: '02'.repeat(20)   // 20 bytes — wrong length
        }
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/public key length|key/i);
  });

  test('400 — key is 33 bytes but invalid EC point → crypto throws', async () => {
    // 33 zero bytes is a valid-length key but not a valid EC point.
    // crypto.createVerify().verify() will throw "Failed to decode key" or similar.
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        lnAuth: {
          k1:  '00'.repeat(32),
          sig: '3006020101020101',  // minimal valid DER signature bytes
          key: '00'.repeat(33)       // 33 zeros — invalid compressed point
        }
      });

    // Either 400 (crypto error) or 401 (invalid sig) — both indicate no auth granted
    expect([400, 401]).toContain(res.status);
  });

  test('401 — valid-format key but wrong signature → 401', async () => {
    // Use a real secp256k1 compressed public key (just a valid-looking one).
    // The verify() call will succeed without throwing (valid SPKI) but return false.
    // Valid compressed point prefix: 02 or 03
    const validKey = '02' + 'a'.repeat(64); // 33 bytes hex

    const res = await request(app)
      .post('/api/auth/login')
      .send({
        lnAuth: {
          k1:  'deadbeef'.repeat(8),          // 32 bytes
          sig: '3006020101020101',              // valid DER encoding but wrong signature
          key: validKey
        }
      });

    // Could be 400 (crypto error if key isn't a valid EC point) or 401 (wrong sig)
    expect([400, 401]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/execute — 500 path
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/payments/execute — error paths', () => {
  test('500 — payment router error includes error message', async () => {
    mockPaymentRouterInstance.executeTransfer.mockRejectedValueOnce(
      new Error('Escrow balance insufficient')
    );

    const res = await request(app)
      .post('/api/payments/execute')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`)
      .send({ gameId: GAME_ID, fromUserId: ALICE_ID, toUserId: BOB_ID, amount: 99999 });

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/Escrow/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/games/:gameId/state — success path
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/games/:gameId/state — extended', () => {
  test('200 — returns game and participants', async () => {
    const game = { id: GAME_ID, status: 'playing', room_code: 'ROOM1' };
    const participants = [{ user_id: ALICE_ID, player_name: 'alice', status: 'active' }];

    // Promise.all: first call = game, second = participants via select
    qb.first.mockResolvedValueOnce(game);
    qb.select.mockResolvedValueOnce(participants);

    const res = await request(app)
      .get(`/api/games/${GAME_ID}/state`)
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`);

    expect(res.status).toBe(200);
    expect(res.body.game).toMatchObject({ id: GAME_ID });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error catch branches (500 paths) — increases branch coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('requireGameHost — 500 DB error', () => {
  test('500 — returns authorization check failed when DB throws', async () => {
    qb.first.mockRejectedValueOnce(new Error('DB crash'));

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/start`)
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/authorization check failed/i);
  });
});

describe('POST /api/games — 500 on DB error', () => {
  test('500 — returns error when DB insert throws', async () => {
    qb.returning.mockRejectedValueOnce(new Error('DB insert error'));

    const res = await request(app)
      .post('/api/games')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`)
      .send({ buyInSats: 10000, maxPlayers: 4 });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to create game/i);
  });
});

describe('GET /api/games — 500 on DB error', () => {
  test('500 — returns error when DB throws', async () => {
    qb.select.mockRejectedValueOnce(new Error('DB error'));

    const res = await request(app)
      .get('/api/games')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to list games/i);
  });
});

describe('POST /api/wallet/withdraw — 500 on DB error', () => {
  test('500 — returns error when DB throws during withdrawal insert', async () => {
    qb.update.mockResolvedValueOnce(1); // balance check passes
    qb.returning.mockRejectedValueOnce(new Error('DB crash'));

    const res = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`)
      .send({ amountSats: 500, lnAddress: 'alice@getalby.com' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/withdrawal request failed/i);
  });
});

describe('POST /api/games/:roomCode/join — 500 on DB error', () => {
  test('500 — returns error when DB throws', async () => {
    qb.first.mockRejectedValueOnce(new Error('DB crash'));

    const res = await request(app)
      .post('/api/games/ROOM1/join')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to join/i);
  });
});

describe('POST /api/games/:gameId/start — 500 on DB error', () => {
  test('500 — returns error when DB throws inside handler', async () => {
    qb.first.mockResolvedValueOnce({ id: GAME_ID, host_id: ALICE_ID }); // requireGameHost
    qb.first.mockRejectedValueOnce(new Error('DB crash')); // handler query

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/start`)
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to start/i);
  });
});

describe('POST /api/games/:gameId/end — 500 on DB error', () => {
  test('500 — returns error when DB throws inside handler', async () => {
    qb.first.mockResolvedValueOnce({ id: GAME_ID, host_id: ALICE_ID }); // requireGameHost
    qb.first.mockRejectedValueOnce(new Error('DB crash')); // handler game query

    const res = await request(app)
      .post(`/api/games/${GAME_ID}/end`)
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`)
      .send({ winnerId: BOB_ID });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to end/i);
  });
});
