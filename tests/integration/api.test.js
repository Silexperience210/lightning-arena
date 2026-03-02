// =====================================================
// Integration tests — Express API (HTTP layer)
//
// Strategy: all external I/O (Postgres, Redis, LND, NWC) is mocked so tests
// run without a live database.  The PaymentRouter is also mocked — its logic
// is covered separately in the unit tests.
//
// Key invariants verified here:
//   • Correct HTTP status codes for every outcome
//   • Authentication middleware rejects missing / invalid tokens
//   • Authorization middleware prevents cross-user operations
//   • LNURL-auth returns 501 (not 200)
//   • Fee calculation arithmetic is correct
// =====================================================

'use strict';

// ── Shared query builder used by the mock DB ──────────────────────────────────
// All methods are chainable jest.fn()s.  Per-test overrides use mockReturnValueOnce
// on the terminal methods (.first, .returning, .update, etc.).

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

// db(tableName) → qb (shared, reset before each test)
const mockDb = jest.fn(() => qb);
mockDb.transaction = jest.fn().mockImplementation(async (cb) => cb(mockDb));
mockDb.raw = jest.fn().mockReturnValue({ toString: () => '' });

// ── External module mocks ──────────────────────────────────────────────────────
// These are hoisted by Jest and must be declared before any require().

jest.mock('knex', () => jest.fn(() => mockDb));

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect:    jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    get:        jest.fn().mockResolvedValue(null),
    set:        jest.fn().mockResolvedValue('OK')
  }))
}));

// LND_ENABLED=false in setup.js, so createLightningClient is never called.
// Mock it anyway to avoid 'module not found' errors if lnd-client.js is missing.
jest.mock('../../src/lnd-client', () => ({
  createLightningClient: jest.fn(() => null)
}));

jest.mock('@getalby/sdk', () => ({
  nwc: {
    NWCClient: jest.fn().mockImplementation(() => ({
      getInfo:     jest.fn().mockResolvedValue({ pubkey: 'testpubkey' }),
      makeInvoice: jest.fn(),
      payInvoice:  jest.fn()
    }))
  }
}));

// Mock PaymentRouter — unit tests cover its internals
const mockPaymentRouterInstance = {
  on:              jest.fn(),
  emit:            jest.fn(),
  encrypt:         jest.fn().mockReturnValue({ encrypted: 'enc', iv: '00'.repeat(16), authTag: '00'.repeat(16) }),
  executeTransfer: jest.fn().mockResolvedValue({
    success: true, transferId: 'tx-test-1', mode: 'ESCROW_INTERNAL'
  }),
  startRetryWorker:   jest.fn(),
  startCleanupWorker: jest.fn()
};
jest.mock('../../src/PaymentRouter', () => jest.fn(() => mockPaymentRouterInstance));

// Mock bcrypt to skip real hashing (saves ~100 ms per hash in tests)
jest.mock('bcrypt', () => ({
  hash:    jest.fn().mockResolvedValue('$2b$10$fakehash'),
  compare: jest.fn().mockResolvedValue(false)  // default: wrong password
}));

// ── Require modules AFTER mocks are installed ─────────────────────────────────

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');

// server.js attaches routes to `app` and exports { app, db }
const { app } = require('../../server');

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-jwt-secret-32-chars-minimum!'; // matches setup.js

function signToken(payload = {}) {
  return jwt.sign(
    { userId: 'default-user-id', username: 'testuser', ...payload },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

const ALICE_ID   = 'alice-uuid-0000-0000-0000';
const BOB_ID     = 'bob-uuid-0000-0000-0000';
const GAME_ID    = 'game-uuid-0000-0000-0000';

beforeEach(() => {
  // Reset all mock call counts and return values before each test
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
  bcrypt.compare.mockResolvedValue(false);
  bcrypt.hash.mockResolvedValue('$2b$10$fakehash');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  const validBody = {
    username:  'alice',
    email:     'alice@test.com',
    lnAddress: 'alice@getalby.com',
    password:  'password123'
  };

  test('201 — creates user and returns JWT token', async () => {
    // No existing user
    qb.first.mockResolvedValueOnce(null);
    // Inserted user row
    qb.returning.mockResolvedValueOnce([{
      id:                   ALICE_ID,
      username:             'alice',
      ln_address:           'alice@getalby.com',
      wallet_type:          'escrow',
      escrow_balance_sats:  0
    }]);

    const res = await request(app)
      .post('/api/auth/register')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toMatchObject({ username: 'alice' });

    // Verify the JWT is valid
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded).toHaveProperty('userId', ALICE_ID);
  });

  test('409 — duplicate username or LN address', async () => {
    qb.first.mockResolvedValueOnce({ id: 'existing', username: 'alice' });

    const res = await request(app)
      .post('/api/auth/register')
      .send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('201 — registers without optional email', async () => {
    qb.first.mockResolvedValueOnce(null);
    qb.returning.mockResolvedValueOnce([{
      id: ALICE_ID, username: 'alice',
      ln_address: 'alice@getalby.com', wallet_type: 'escrow', escrow_balance_sats: 0
    }]);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', lnAddress: 'alice@getalby.com', password: 'pw' });

    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  const aliceUser = {
    id:            ALICE_ID,
    username:      'alice',
    ln_address:    'alice@getalby.com',
    wallet_type:   'escrow',
    password_hash: '$2b$10$fakehash',
    escrow_balance_sats: 50000,
    nwc_budget_sats:     null
  };

  test('200 — returns token when credentials are valid', async () => {
    qb.first.mockResolvedValueOnce(aliceUser);  // user lookup
    qb.update.mockResolvedValueOnce(1);          // last_login update
    bcrypt.compare.mockResolvedValueOnce(true);  // password match

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.username).toBe('alice');
  });

  test('401 — wrong password', async () => {
    qb.first.mockResolvedValueOnce(aliceUser);
    bcrypt.compare.mockResolvedValueOnce(false); // password mismatch

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  test('401 — user not found', async () => {
    qb.first.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'any' });

    expect(res.status).toBe(401);
  });

  test('401 — account has no password hash (NWC-only account)', async () => {
    qb.first.mockResolvedValueOnce({ ...aliceUser, password_hash: null });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'password123' });

    expect(res.status).toBe(401);
  });

  test('400 — lnAuth missing required fields (k1, key)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ lnAuth: { sig: 'abc' } }); // missing k1 and key

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/k1.*sig.*key|requires/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: Authentication middleware
// ─────────────────────────────────────────────────────────────────────────────

describe('Authentication middleware', () => {
  test('401 — no token on protected route', async () => {
    const res = await request(app).get('/api/wallet/balance');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  test('401 — malformed / invalid token', async () => {
    const res = await request(app)
      .get('/api/wallet/balance')
      .set('Authorization', 'Bearer this.is.not.valid');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('401 — expired token', async () => {
    const expired = jwt.sign(
      { userId: ALICE_ID, username: 'alice' },
      JWT_SECRET,
      { expiresIn: '-1s' } // already expired
    );

    const res = await request(app)
      .get('/api/wallet/balance')
      .set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
  });

  test('passes through with a valid token (wallet balance route)', async () => {
    const user = {
      id: ALICE_ID, username: 'alice', wallet_type: 'escrow',
      escrow_balance_sats: 50000, escrow_locked_sats: 1000
    };
    qb.first.mockResolvedValueOnce(user);         // users query
    qb.first.mockResolvedValueOnce({ total: 0 }); // nwcBalance
    qb.first.mockResolvedValueOnce({ total: 0 }); // pendingWithdrawals

    const res = await request(app)
      .get('/api/wallet/balance')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`);

    // Should not be 401
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: POST /api/payments/execute — authorization
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/payments/execute', () => {
  const aliceToken = signToken({ userId: ALICE_ID, username: 'alice' });

  test('403 — cannot initiate payment on behalf of another user', async () => {
    const res = await request(app)
      .post('/api/payments/execute')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        gameId:     GAME_ID,
        fromUserId: BOB_ID,   // NOT alice — should be blocked
        toUserId:   ALICE_ID,
        amount:     1000,
        weapon:     'banana'
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/behalf of another user/i);
  });

  test('200 — succeeds when fromUserId matches authenticated user', async () => {
    mockPaymentRouterInstance.executeTransfer.mockResolvedValueOnce({
      success: true, transferId: 'tx-alice-1', mode: 'ESCROW_INTERNAL'
    });

    const res = await request(app)
      .post('/api/payments/execute')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        gameId:     GAME_ID,
        fromUserId: ALICE_ID,  // matches token userId
        toUserId:   BOB_ID,
        amount:     1000,
        weapon:     'banana'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPaymentRouterInstance.executeTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ fromUserId: ALICE_ID, amount: 1000 })
    );
  });

  test('401 — no token', async () => {
    const res = await request(app)
      .post('/api/payments/execute')
      .send({ gameId: GAME_ID, fromUserId: ALICE_ID, toUserId: BOB_ID, amount: 100 });

    expect(res.status).toBe(401);
  });

  test('500 — payment router throws', async () => {
    mockPaymentRouterInstance.executeTransfer.mockRejectedValueOnce(
      new Error('Insufficient escrow balance')
    );

    const res = await request(app)
      .post('/api/payments/execute')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ gameId: GAME_ID, fromUserId: ALICE_ID, toUserId: BOB_ID, amount: 9999999 });

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/Insufficient/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: POST /api/wallet/deposit — LND disabled
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/wallet/deposit (LND disabled)', () => {
  test('503 — when LND is not available', async () => {
    const res = await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`)
      .send({ amountSats: 10000 });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not available/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: POST /api/wallet/withdraw — atomic balance check
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/wallet/withdraw', () => {
  const aliceToken = signToken({ userId: ALICE_ID });

  test('400 — insufficient balance (update returns 0)', async () => {
    qb.update.mockResolvedValueOnce(0); // atomic check failed
    qb.returning.mockResolvedValueOnce([{ id: 'wd-1' }]);

    const res = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ amountSats: 999999, lnAddress: 'alice@getalby.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient balance/i);
  });

  test('200 — withdrawal queued when balance is sufficient', async () => {
    qb.update.mockResolvedValueOnce(1); // balance deducted successfully
    qb.returning.mockResolvedValueOnce([{ id: 'wd-1' }]);

    const res = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ amountSats: 5000, lnAddress: 'alice@getalby.com' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7: POST /api/games — create game
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/games', () => {
  test('201 — creates game with room code', async () => {
    qb.returning.mockResolvedValueOnce([{
      id:          GAME_ID,
      room_code:   'ABCD1234',
      status:      'lobby',
      buy_in_sats: 10000,
      max_players: 4
    }]);

    const res = await request(app)
      .post('/api/games')
      .set('Authorization', `Bearer ${signToken({ userId: ALICE_ID })}`)
      .send({ buyInSats: 10000, maxPlayers: 4 });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('gameId', GAME_ID);
    expect(res.body).toHaveProperty('roomCode', 'ABCD1234');
  });

  test('401 — requires authentication', async () => {
    const res = await request(app).post('/api/games').send({ buyInSats: 10000 });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8: Server fee arithmetic (pure unit tests for correctness)
// ─────────────────────────────────────────────────────────────────────────────
// These verify the formula used in POST /api/games/:gameId/end without going
// through the full HTTP stack (which requires mocking requireGameHost, etc.).

describe('Server fee calculation', () => {
  function calcFee(totalPot, feePercent = 1.0) {
    const serverFeeSats   = Math.floor(totalPot * feePercent / 100);
    const winnerPayoutSats = totalPot - serverFeeSats;
    return { serverFeeSats, winnerPayoutSats };
  }

  test('1% fee on 100,000 sats → fee=1000, payout=99000', () => {
    expect(calcFee(100000)).toEqual({ serverFeeSats: 1000, winnerPayoutSats: 99000 });
  });

  test('1% fee on 10,001 sats → fee=100 (floor), payout=9901', () => {
    expect(calcFee(10001)).toEqual({ serverFeeSats: 100, winnerPayoutSats: 9901 });
  });

  test('1% fee on 999 sats → fee=9 (floor), payout=990', () => {
    expect(calcFee(999)).toEqual({ serverFeeSats: 9, winnerPayoutSats: 990 });
  });

  test('fee + payout always equals total pot', () => {
    [1000, 9999, 50000, 100000, 1234567].forEach(pot => {
      const { serverFeeSats, winnerPayoutSats } = calcFee(pot);
      expect(serverFeeSats + winnerPayoutSats).toBe(pot);
    });
  });

  test('zero fee percent → full payout', () => {
    expect(calcFee(50000, 0)).toEqual({ serverFeeSats: 0, winnerPayoutSats: 50000 });
  });

  test('server never receives more than 1% plus rounding', () => {
    [10000, 25000, 100000].forEach(pot => {
      const { serverFeeSats } = calcFee(pot, 1.0);
      expect(serverFeeSats).toBeLessThanOrEqual(Math.ceil(pot * 0.01));
      expect(serverFeeSats).toBeGreaterThanOrEqual(Math.floor(pot * 0.01));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 9: GET /api/games/:gameId/state
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/games/:gameId/state', () => {
  const aliceToken = signToken({ userId: ALICE_ID });

  test('404 — game not found', async () => {
    qb.first.mockResolvedValueOnce(null);  // game lookup
    qb.returning.mockResolvedValueOnce([]); // participants (won't be called but be safe)

    // Provide both parallel DB calls
    qb.first.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/games/${GAME_ID}/state`)
      .set('Authorization', `Bearer ${aliceToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
