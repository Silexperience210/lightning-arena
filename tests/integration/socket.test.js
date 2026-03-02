// =====================================================
// Integration tests — WebSocket layer (socket.io)
//
// Strategy: same mock pattern as api.test.js — all external I/O is replaced
// by jest.fn()s so the suite runs without a live database or Redis.
// The http.Server is bound to port 0 (OS-assigned) in beforeAll so multiple
// test workers never collide.
//
// Suites:
//   1. auth          (4 tests)
//   2. game:join     (3 tests)
//   3. game:hit      (4 tests)
//   4. disconnect    (2 tests)
// =====================================================

'use strict';

// ── Shared query builder (chainable mocks) ────────────────────────────────────

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
mockDb.raw = jest.fn().mockReturnValue({ toString: () => '' });

// ── External module mocks (hoisted before require) ───────────────────────────

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

jest.mock('@getalby/sdk', () => ({
  nwc: {
    NWCClient: jest.fn().mockImplementation(() => ({
      getInfo:     jest.fn().mockResolvedValue({ pubkey: 'testpubkey' }),
      makeInvoice: jest.fn(),
      payInvoice:  jest.fn()
    }))
  }
}));

const mockPaymentRouterInstance = {
  on:                 jest.fn(),
  emit:               jest.fn(),
  encrypt:            jest.fn().mockReturnValue({ encrypted: 'enc', iv: '00'.repeat(16), authTag: '00'.repeat(16) }),
  executeTransfer:    jest.fn().mockResolvedValue({ success: true, transferId: 'tx-1', mode: 'ESCROW_INTERNAL' }),
  startRetryWorker:   jest.fn(),
  startCleanupWorker: jest.fn()
};
jest.mock('../../src/PaymentRouter', () => jest.fn(() => mockPaymentRouterInstance));

jest.mock('bcrypt', () => ({
  hash:    jest.fn().mockResolvedValue('$2b$10$fakehash'),
  compare: jest.fn().mockResolvedValue(false)
}));

// ── Require AFTER mocks ───────────────────────────────────────────────────────

const jwt      = require('jsonwebtoken');
const ioClient = require('socket.io-client');

const { server, io } = require('../../server');

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-jwt-secret-32-chars-minimum!';
const ALICE_ID   = 'alice-uuid-0000-0000-0000';
const BOB_ID     = 'bob-uuid-0000-0000-0000';
const GAME_ID    = 'game-uuid-0000-0000-0000';

// ── Helpers ───────────────────────────────────────────────────────────────────

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

// Use 127.0.0.1 explicitly — on Windows localhost can resolve to ::1 (IPv6)
// while Node's server.listen(0) binds 0.0.0.0 (IPv4 only).
function connectClient(url) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { transports: ['websocket', 'polling'], forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let serverUrl;

beforeAll((done) => {
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    serverUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll(() => new Promise((resolve) => io.close(resolve)));

// Reset all mock state before every test (mirrors api.test.js beforeEach)
beforeEach(() => {
  Object.keys(qb).forEach((k) => {
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
});

// Helper: clean disconnect that returns a Promise
function closeSocket(socket) {
  if (!socket || !socket.connected) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('disconnect', resolve);
    socket.disconnect();
  });
}

// ── Suite 1 : auth ────────────────────────────────────────────────────────────

describe('auth', () => {
  let socket;

  afterEach(() => closeSocket(socket));

  test('valid token → auth:success with userId', async () => {
    socket = await connectClient(serverUrl);
    const token = signToken({ userId: ALICE_ID });

    const promise = waitFor(socket, 'auth:success');
    socket.emit('auth', token);
    const payload = await promise;

    expect(payload).toMatchObject({ userId: ALICE_ID });
  });

  test('invalid token → auth:error', async () => {
    socket = await connectClient(serverUrl);

    const promise = waitFor(socket, 'auth:error');
    socket.emit('auth', 'not-a-valid-jwt');
    const payload = await promise;

    expect(payload).toMatchObject({ error: 'Invalid token' });
  });

  test('valid token + disconnected participant → game:state_restored sent to socket', async () => {
    const disconnectedParticipant = {
      id:        'part-1',
      game_id:   GAME_ID,
      user_id:   ALICE_ID,
      room_code: 'ROOM1',
      status:    'disconnected'
    };

    // auth DB query → disconnectedParticipant; update uses default (returns 1)
    qb.first.mockResolvedValueOnce(disconnectedParticipant);

    socket = await connectClient(serverUrl);
    const token = signToken({ userId: ALICE_ID });

    const authSuccessP    = waitFor(socket, 'auth:success');
    const stateRestoredP  = waitFor(socket, 'game:state_restored');
    socket.emit('auth', token);

    await authSuccessP;
    const statePayload = await stateRestoredP;

    expect(statePayload).toMatchObject({ gameId: GAME_ID });
  });

  test('valid token + active disconnect timer → clearTimeout is called', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    // Connect and auth as BOB
    const socket1 = await connectClient(serverUrl);
    const token = signToken({ userId: BOB_ID });

    const auth1Done = waitFor(socket1, 'auth:success');
    socket1.emit('auth', token);
    await auth1Done;

    // Disconnect — this queues a 60s timer for BOB
    const activeParticipant = { id: 'p1', game_id: GAME_ID };
    qb.first.mockResolvedValueOnce(activeParticipant);

    const disc1Done = new Promise((resolve) => socket1.once('disconnect', resolve));
    socket1.disconnect();
    await disc1Done;

    // Give the async disconnect handler time to register the timer
    await new Promise((resolve) => setTimeout(resolve, 100));

    clearTimeoutSpy.mockClear(); // clear calls from socket.io internals above

    // Reconnect — server should call clearTimeout for BOB's timer
    const socket2 = await connectClient(serverUrl);
    const auth2Done = waitFor(socket2, 'auth:success');
    socket2.emit('auth', token);
    await auth2Done;

    // Give the async reconnect handler time to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    const meaningfulCalls = clearTimeoutSpy.mock.calls.filter(([id]) => id != null);
    expect(meaningfulCalls.length).toBeGreaterThan(0);

    clearTimeoutSpy.mockRestore();
    await closeSocket(socket2);
  });
});

// ── Suite 2 : game:join ───────────────────────────────────────────────────────

describe('game:join', () => {
  let socket;

  afterEach(() => closeSocket(socket));

  test('not authenticated → error: Authentication required', async () => {
    socket = await connectClient(serverUrl);

    const promise = waitFor(socket, 'error');
    socket.emit('game:join', GAME_ID);
    const payload = await promise;

    expect(payload.message).toMatch(/Authentication required/);
  });

  test('authenticated but not a participant → error: not a participant', async () => {
    socket = await connectClient(serverUrl);
    const token = signToken({ userId: ALICE_ID });

    // auth: no disconnected participant; game:join: no participant
    // qb.first defaults to null for all calls — no override needed

    const authDone = waitFor(socket, 'auth:success');
    socket.emit('auth', token);
    await authDone;

    const promise = waitFor(socket, 'error');
    socket.emit('game:join', GAME_ID);
    const payload = await promise;

    expect(payload.message).toMatch(/not a participant/);
  });

  test('authenticated and valid participant → socket joins game room (no error)', async () => {
    const participant = { id: 'part-1', game_id: GAME_ID, user_id: ALICE_ID, status: 'active' };

    socket = await connectClient(serverUrl);
    const token = signToken({ userId: ALICE_ID });

    const authDone = waitFor(socket, 'auth:success');
    socket.emit('auth', token);
    await authDone;

    // Wait for auth handler's async DB query (reconnect check) to complete so it
    // consumes the default mock value before we set the game:join mock.
    await new Promise((resolve) => setTimeout(resolve, 50));

    qb.first.mockResolvedValueOnce(participant);

    const errors = [];
    socket.on('error', (e) => errors.push(e));

    socket.emit('game:join', GAME_ID);

    // Wait briefly for any error to arrive
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(errors).toHaveLength(0);
  });
});

// ── Suite 2b : payment:completed relay ────────────────────────────────────────

describe('payment:completed relay', () => {
  test('PaymentRouter transferCompleted → io emits payment:completed to game room', async () => {
    // Retrieve the callback registered by server.js at module load time:
    //   paymentRouter.on('transferCompleted', cb)
    const registeredCall = mockPaymentRouterInstance.on.mock.calls.find(
      ([event]) => event === 'transferCompleted'
    );
    expect(registeredCall).toBeDefined();
    const transferCompletedCb = registeredCall[1];

    // Connect ALICE, auth, then join game room so she receives game:* broadcasts
    const aliceSocket = await connectClient(serverUrl);
    const authDone = waitFor(aliceSocket, 'auth:success');
    aliceSocket.emit('auth', signToken({ userId: ALICE_ID }));
    await authDone;
    await new Promise((r) => setTimeout(r, 50)); // auth async settles

    qb.first.mockResolvedValueOnce({ id: 'p1', game_id: GAME_ID, user_id: ALICE_ID });
    aliceSocket.emit('game:join', GAME_ID);
    await new Promise((r) => setTimeout(r, 50)); // join settles

    // Now listen for the broadcast
    const paymentReceived = waitFor(aliceSocket, 'payment:completed');

    // Trigger the PaymentRouter event
    transferCompletedCb({
      gameId:     GAME_ID,
      transferId: 'tx-relay-1',
      from:       ALICE_ID,
      to:         BOB_ID,
      amount:     500,
      mode:       'ESCROW_INTERNAL'
    });

    const payload = await paymentReceived;
    expect(payload).toMatchObject({ transferId: 'tx-relay-1', amount: 500 });

    await closeSocket(aliceSocket);
  });
});

// ── Suite 3 : game:hit ────────────────────────────────────────────────────────

describe('game:hit', () => {
  let socket;

  afterEach(() => closeSocket(socket));

  // Helper: connect + authenticate a socket
  async function authenticatedSocket(userId) {
    // auth: no disconnected participant
    qb.first.mockResolvedValueOnce(null);
    const s = await connectClient(serverUrl);
    const authDone = waitFor(s, 'auth:success');
    s.emit('auth', signToken({ userId }));
    await authDone;
    return s;
  }

  test('hitterId !== socket.userId → error: Unauthorized', async () => {
    socket = await authenticatedSocket(ALICE_ID);

    const promise = waitFor(socket, 'error');
    socket.emit('game:hit', {
      gameId:   GAME_ID,
      hitterId: BOB_ID,   // mismatch: socket belongs to alice
      victimId: 'victim',
      weapon:   'sword',
      damage:   50
    });
    const payload = await promise;

    expect(payload.message).toMatch(/Unauthorized/);
  });

  test('damage <= 0 → error: Invalid damage value', async () => {
    socket = await authenticatedSocket(ALICE_ID);

    const promise = waitFor(socket, 'error');
    socket.emit('game:hit', {
      gameId:   GAME_ID,
      hitterId: ALICE_ID,
      victimId: BOB_ID,
      weapon:   'sword',
      damage:   0
    });
    const payload = await promise;

    expect(payload.message).toBe('Invalid damage value');
  });

  test('damage > 1000 → error: Invalid damage value', async () => {
    socket = await authenticatedSocket(ALICE_ID);

    const promise = waitFor(socket, 'error');
    socket.emit('game:hit', {
      gameId:   GAME_ID,
      hitterId: ALICE_ID,
      victimId: BOB_ID,
      weapon:   'bazooka',
      damage:   1001
    });
    const payload = await promise;

    expect(payload.message).toBe('Invalid damage value');
  });

  test('participants < 2 → error: Invalid game participants', async () => {
    socket = await authenticatedSocket(ALICE_ID);
    await new Promise((r) => setTimeout(r, 50));

    // DB returns only 1 participant (simulate only hitter found, victim missing/inactive)
    qb.select.mockResolvedValueOnce([{ user_id: ALICE_ID }]);

    const promise = waitFor(socket, 'error');
    socket.emit('game:hit', {
      gameId:   GAME_ID,
      hitterId: ALICE_ID,
      victimId: BOB_ID,
      weapon:   'sword',
      damage:   50
    });
    const payload = await promise;

    expect(payload.message).toBe('Invalid game participants');
  });

  test('valid hit with 2 active participants → game:hit broadcast to room', async () => {
    const aliceSocket = await connectClient(serverUrl);
    const bobSocket   = await connectClient(serverUrl);

    // Sequential setup to avoid race conditions: authenticate each socket,
    // wait for the auth handler's async DB query to complete, then set the
    // game:join mock before emitting the join event.

    const aliceAuth = waitFor(aliceSocket, 'auth:success');
    aliceSocket.emit('auth', signToken({ userId: ALICE_ID }));
    await aliceAuth;
    await new Promise((r) => setTimeout(r, 50)); // auth async settles

    qb.first.mockResolvedValueOnce({ id: 'p1', game_id: GAME_ID, user_id: ALICE_ID });
    aliceSocket.emit('game:join', GAME_ID);
    await new Promise((r) => setTimeout(r, 50)); // join settles

    const bobAuth = waitFor(bobSocket, 'auth:success');
    bobSocket.emit('auth', signToken({ userId: BOB_ID }));
    await bobAuth;
    await new Promise((r) => setTimeout(r, 50)); // auth async settles

    qb.first.mockResolvedValueOnce({ id: 'p2', game_id: GAME_ID, user_id: BOB_ID });
    bobSocket.emit('game:join', GAME_ID);
    await new Promise((r) => setTimeout(r, 50)); // join settles

    // game:hit query: qb.whereIn chain resolves to qb → qb.length is undefined
    // undefined < 2 is false → server proceeds to broadcast
    const hitReceived = waitFor(bobSocket, 'game:hit');

    aliceSocket.emit('game:hit', {
      gameId:   GAME_ID,
      hitterId: ALICE_ID,
      victimId: BOB_ID,
      weapon:   'sword',
      damage:   75
    });

    const hitPayload = await hitReceived;

    expect(hitPayload).toMatchObject({
      hitterId: ALICE_ID,
      victimId: BOB_ID,
      weapon:   'sword',
      damage:   75
    });

    await Promise.all([closeSocket(aliceSocket), closeSocket(bobSocket)]);
  });
});

// ── Suite 4 : disconnect ──────────────────────────────────────────────────────

describe('disconnect', () => {
  test('disconnection during active game → player:disconnected broadcast', async () => {
    const aliceParticipant = { id: 'p1', game_id: GAME_ID, user_id: ALICE_ID, status: 'active' };
    const bobParticipant   = { id: 'p2', game_id: GAME_ID, user_id: BOB_ID,   status: 'active' };
    const activeAlice      = { id: 'p1', game_id: GAME_ID }; // returned by disconnect query

    // first() call order: alice-auth, bob-auth, bob-join, alice-disconnect
    const aliceSocket = await connectClient(serverUrl);
    const bobSocket   = await connectClient(serverUrl);

    // Sequential auth + join to avoid race conditions on the shared qb.first mock.
    const aliceAuth = waitFor(aliceSocket, 'auth:success');
    aliceSocket.emit('auth', signToken({ userId: ALICE_ID }));
    await aliceAuth;
    await new Promise((r) => setTimeout(r, 50)); // auth async settles

    const bobAuth = waitFor(bobSocket, 'auth:success');
    bobSocket.emit('auth', signToken({ userId: BOB_ID }));
    await bobAuth;
    await new Promise((r) => setTimeout(r, 50)); // auth async settles

    // Bob joins game room to receive broadcasts
    qb.first.mockResolvedValueOnce(bobParticipant);
    bobSocket.emit('game:join', GAME_ID);
    await new Promise((resolve) => setTimeout(resolve, 50)); // join settles

    // Set mock for Alice's disconnect active-participant query
    qb.first.mockResolvedValueOnce(activeAlice);

    const disconnectedEvent = waitFor(bobSocket, 'player:disconnected');

    aliceSocket.disconnect();

    const payload = await disconnectedEvent;
    expect(payload).toMatchObject({ userId: ALICE_ID, gameId: GAME_ID });

    await closeSocket(bobSocket);
  });

  test('60s timer fires after disconnect → player:eliminated broadcast', async () => {
    const activeParticipant = { id: 'p-timer', game_id: GAME_ID };

    // Spy on setTimeout: capture the 60-second elimination callback so we can
    // trigger it immediately without waiting or using fake timers (which conflict
    // with socket.io's internal heartbeat timers).
    let eliminationCb = null;
    const origSetTimeout = global.setTimeout;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay, ...args) => {
      if (delay === 60000) {
        eliminationCb = fn;
        return 999; // stub timer id returned to disconnectTimers.set()
      }
      return origSetTimeout(fn, delay, ...args);
    });

    try {
      const observerSocket = await connectClient(serverUrl);

      // Auth BOB (observer) + join game room
      const bobAuth = waitFor(observerSocket, 'auth:success');
      observerSocket.emit('auth', signToken({ userId: BOB_ID }));
      await bobAuth;
      await new Promise((r) => setTimeout(r, 50));

      qb.first.mockResolvedValueOnce({ id: 'p-bob', game_id: GAME_ID, user_id: BOB_ID });
      observerSocket.emit('game:join', GAME_ID);
      await new Promise((r) => setTimeout(r, 50));

      // Auth ALICE, then disconnect
      const aliceSocket = await connectClient(serverUrl);
      const aliceAuth   = waitFor(aliceSocket, 'auth:success');
      aliceSocket.emit('auth', signToken({ userId: ALICE_ID }));
      await aliceAuth;
      await new Promise((r) => setTimeout(r, 50));

      // Disconnect handler will find active participant and set the 60s timer
      qb.first.mockResolvedValueOnce(activeParticipant);
      // Elimination update returns 1 → broadcast fires
      qb.update.mockResolvedValueOnce(1);

      const playerEliminated = waitFor(observerSocket, 'player:eliminated');

      const aliceDisc = new Promise((resolve) => aliceSocket.once('disconnect', resolve));
      aliceSocket.disconnect();
      await aliceDisc;

      // Wait for the async disconnect handler to call setTimeout(cb, 60000)
      await new Promise((r) => origSetTimeout(r, 200));

      expect(eliminationCb).toBeInstanceOf(Function);

      // Fire the elimination callback directly
      await eliminationCb();

      const payload = await playerEliminated;
      expect(payload).toMatchObject({ userId: ALICE_ID, gameId: GAME_ID });

      await closeSocket(observerSocket);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  }, 15000);

  test('disconnection with no active game → no event emitted, no error', async () => {
    // auth: no disconnected; disconnect: no active participant (default null)
    const socket = await connectClient(serverUrl);
    const token  = signToken({ userId: BOB_ID });

    const authDone = waitFor(socket, 'auth:success');
    socket.emit('auth', token);
    await authDone;

    const unexpectedEvents = [];
    socket.onAny((event) => {
      if (event !== 'disconnect') unexpectedEvents.push(event);
    });

    const disconnected = new Promise((resolve) => socket.once('disconnect', resolve));
    socket.disconnect();
    await disconnected;

    // Wait a tick for any spurious async events
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(unexpectedEvents).toHaveLength(0);
  });
});
