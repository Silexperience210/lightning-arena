// =====================================================
// Unit tests — PaymentRouter
//
// Strategy: inject a mock `db` factory instead of a real Postgres connection.
// Each test controls exactly what the DB returns via the `config` argument.
// The NWC SDK and LND gRPC are mocked at the module level.
// =====================================================

'use strict';

// ── Mock @getalby/sdk before requiring PaymentRouter ─────────────────────────
const mockMakeInvoice = jest.fn();
const mockPayInvoice  = jest.fn();

jest.mock('@getalby/sdk', () => ({
  nwc: {
    NWCClient: jest.fn().mockImplementation(() => ({
      makeInvoice: mockMakeInvoice,
      payInvoice:  mockPayInvoice
    }))
  }
}));

const PaymentRouter = require('../../src/PaymentRouter');

// ── Mock DB factory ───────────────────────────────────────────────────────────
//
// Returns a jest.fn() that behaves like knex(tableName) and exposes the most
// common chainable methods.  Per-table return values can be overridden via the
// optional `config` map:
//
//   createDb({ users: { first: myUser, decrement: 1 } })
//
// `db.transaction(cb)` runs `cb(trx)` synchronously with its own builder map.
//
function createBuilder(tableConfig = {}) {
  const builder = {
    where:     jest.fn().mockReturnThis(),
    whereIn:   jest.fn().mockReturnThis(),
    whereNot:  jest.fn().mockReturnThis(),
    andWhere:  jest.fn().mockReturnThis(),
    select:    jest.fn().mockReturnThis(),
    join:      jest.fn().mockReturnThis(),
    orderBy:   jest.fn().mockReturnThis(),
    limit:     jest.fn().mockReturnThis(),
    first:     jest.fn().mockResolvedValue(tableConfig.first   ?? null),
    update:    jest.fn().mockResolvedValue(tableConfig.update  ?? 1),
    decrement: jest.fn().mockResolvedValue(tableConfig.decrement ?? 1),
    increment: jest.fn().mockResolvedValue(1),
    insert:    jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([tableConfig.returning ?? 'transfer-uuid-1']),
    del:       jest.fn().mockResolvedValue(1)
  };
  return builder;
}

function createDb(config = {}) {
  const builders = {};

  const db = jest.fn((tableName) => {
    if (!builders[tableName]) {
      builders[tableName] = createBuilder(config[tableName] ?? {});
    }
    return builders[tableName];
  });

  db.transaction = jest.fn().mockImplementation(async (cb) => {
    const trxBuilders = {};
    const trx = jest.fn((tableName) => {
      if (!trxBuilders[tableName]) {
        trxBuilders[tableName] = createBuilder(config[tableName] ?? {});
      }
      return trxBuilders[tableName];
    });
    trx.raw = jest.fn().mockReturnValue({ toSQL: () => '' });
    return cb(trx);
  });

  db.raw = jest.fn().mockReturnValue({ toSQL: () => '' });

  // Expose the builders map so tests can assert on specific calls
  db._builders = builders;
  return db;
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

const ENCRYPTION_KEY = Buffer.from('a'.repeat(64), 'hex');

function makeRouter(dbConfig = {}, lndOverride = null) {
  const db  = createDb(dbConfig);
  const lnd = lndOverride; // null → lndEnabled = false

  const router = new PaymentRouter({
    db,
    lnd,
    redis: null,
    options: {
      retryDelayMs:      999999, // disable background timer during tests
      paymentTimeoutMs: 30000
    }
  });

  // Stub out background workers to avoid dangling setInterval handles
  jest.spyOn(router, 'startRetryWorker').mockImplementation(() => {});
  jest.spyOn(router, 'startCleanupWorker').mockImplementation(() => {});

  return { router, db };
}

// A user with a valid NWC URI (not expired, not banned, wallet_type = 'nwc')
function nwcUser(overrides = {}) {
  return {
    id:                'user-nwc-id',
    username:          'alice',
    wallet_type:       'nwc',
    nwc_uri_encrypted: 'deadbeef',
    nwc_uri_iv:        '0'.repeat(32),
    nwc_uri_auth_tag:  '0'.repeat(32),
    nwc_uri_decrypted: 'nostr+walletconnect://fake',
    nwc_expires_at:    null,
    is_banned:         false,
    escrow_balance_sats: 50000,
    ...overrides
  };
}

// A user with only an escrow balance (no NWC)
function escrowUser(overrides = {}) {
  return {
    id:                'user-escrow-id',
    username:          'bob',
    wallet_type:       'escrow',
    nwc_uri_encrypted: null,
    nwc_uri_decrypted: null,
    nwc_expires_at:    null,
    is_banned:         false,
    escrow_balance_sats: 50000,
    ...overrides
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: isNWCValid
// ─────────────────────────────────────────────────────────────────────────────

describe('isNWCValid', () => {
  let router;

  beforeEach(() => {
    ({ router } = makeRouter());
    // Prevent the constructor from starting workers again (they were already spied)
    jest.clearAllMocks();
  });

  test('returns true for a valid NWC user', () => {
    expect(router.isNWCValid(nwcUser())).toBe(true);
  });

  test('returns false when user is null', () => {
    expect(router.isNWCValid(null)).toBe(false);
  });

  test('returns false when wallet_type !== nwc', () => {
    expect(router.isNWCValid(nwcUser({ wallet_type: 'escrow' }))).toBe(false);
  });

  test('returns false when nwc_uri_decrypted is null', () => {
    expect(router.isNWCValid(nwcUser({ nwc_uri_decrypted: null }))).toBe(false);
  });

  test('returns false when NWC is expired', () => {
    const expiredDate = new Date(Date.now() - 1000).toISOString();
    expect(router.isNWCValid(nwcUser({ nwc_expires_at: expiredDate }))).toBe(false);
  });

  test('returns true when nwc_expires_at is in the future', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    expect(router.isNWCValid(nwcUser({ nwc_expires_at: futureDate }))).toBe(true);
  });

  test('returns false when user is banned', () => {
    expect(router.isNWCValid(nwcUser({ is_banned: true }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: encrypt / decrypt round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('encrypt / decrypt', () => {
  let router;

  beforeEach(() => {
    ({ router } = makeRouter());
  });

  test('round-trips arbitrary text correctly', () => {
    const plaintext = 'nostr+walletconnect://secret-uri-12345';
    const { encrypted, iv, authTag } = router.encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(iv).toHaveLength(32);       // 16 bytes → 32 hex chars
    expect(authTag).toHaveLength(32);  // same
    expect(router.decrypt(encrypted, iv, authTag)).toBe(plaintext);
  });

  test('different calls produce different ciphertext (random IV)', () => {
    const pt = 'same-plaintext';
    const enc1 = router.encrypt(pt);
    const enc2 = router.encrypt(pt);
    expect(enc1.encrypted).not.toBe(enc2.encrypted);
    expect(enc1.iv).not.toBe(enc2.iv);
  });

  test('decrypt throws on tampered auth tag', () => {
    const { encrypted, iv } = router.encrypt('data');
    const badTag = 'f'.repeat(32);
    expect(() => router.decrypt(encrypted, iv, badTag)).toThrow();
  });

  test('decrypt throws on tampered ciphertext', () => {
    const { encrypted, iv, authTag } = router.encrypt('data');
    const tampered = '00' + encrypted.slice(2);
    expect(() => router.decrypt(tampered, iv, authTag)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: determineOptimalRoute
// ─────────────────────────────────────────────────────────────────────────────

describe('determineOptimalRoute', () => {
  const FROM = 'user-a';
  const TO   = 'user-b';

  function routerWithUsers(fromUser, toUser) {
    const { router, db } = makeRouter();
    // getUserWithDecryptedNWC calls db('users').where('id', ...).first()
    // We need it to return different users per call.  Use sequential mocking.
    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(fromUser)
      .mockResolvedValueOnce(toUser);
    return router;
  }

  test('NWC_P2P when both users have valid NWC', async () => {
    const router = routerWithUsers(nwcUser({ id: FROM }), nwcUser({ id: TO }));
    const route  = await router.determineOptimalRoute(FROM, TO);
    expect(route.type).toBe('NWC_P2P');
    expect(route.fee).toBe(0);
  });

  test('ESCROW_INTERNAL when both users are escrow-only', async () => {
    const router = routerWithUsers(escrowUser({ id: FROM }), escrowUser({ id: TO }));
    const route  = await router.determineOptimalRoute(FROM, TO);
    expect(route.type).toBe('ESCROW_INTERNAL');
  });

  test('HYBRID_NWC_TO_ESCROW when payer has NWC, receiver has escrow', async () => {
    const router = routerWithUsers(nwcUser({ id: FROM }), escrowUser({ id: TO }));
    const route  = await router.determineOptimalRoute(FROM, TO);
    expect(route.type).toBe('HYBRID_NWC_TO_ESCROW');
  });

  test('HYBRID_ESCROW_TO_NWC when payer has escrow, receiver has NWC', async () => {
    const router = routerWithUsers(escrowUser({ id: FROM }), nwcUser({ id: TO }));
    const route  = await router.determineOptimalRoute(FROM, TO);
    expect(route.type).toBe('HYBRID_ESCROW_TO_NWC');
  });

  test('throws when payer is not found', async () => {
    const router = routerWithUsers(null, nwcUser({ id: TO }));
    await expect(router.determineOptimalRoute(FROM, TO)).rejects.toThrow('User not found');
  });

  test('throws when receiver is not found', async () => {
    const router = routerWithUsers(nwcUser({ id: FROM }), null);
    await expect(router.determineOptimalRoute(FROM, TO)).rejects.toThrow('User not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: executeEscrowInternal
// ─────────────────────────────────────────────────────────────────────────────

describe('executeEscrowInternal', () => {
  const TRANSFER_ID = 'transfer-uuid-1';
  const FROM        = 'user-a';
  const TO          = 'user-b';
  const AMOUNT      = 1000;

  test('succeeds: deducts from sender, credits receiver, marks transfer completed', async () => {
    const { router, db } = makeRouter({
      users:     { decrement: 1, increment: 1 },
      transfers: { update: 1 }
    });

    const result = await router.executeEscrowInternal(TRANSFER_ID, FROM, TO, AMOUNT);

    expect(result).toMatchObject({ tx: TRANSFER_ID, mode: 'escrow_internal' });

    // Verify the transaction was used
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('throws Insufficient escrow balance when sender has no funds', async () => {
    const { router, db } = makeRouter({
      users: { decrement: 0 }  // 0 rows updated → balance check failed
    });

    // Override the transaction mock to propagate the real error
    db.transaction.mockImplementationOnce(async (cb) => {
      const trx = jest.fn((tableName) => {
        if (tableName === 'users') {
          return {
            where:     jest.fn().mockReturnThis(),
            decrement: jest.fn().mockResolvedValue(0), // balance too low
            increment: jest.fn().mockResolvedValue(1)
          };
        }
        return createBuilder();
      });
      return cb(trx);
    });

    await expect(
      router.executeEscrowInternal(TRANSFER_ID, FROM, TO, AMOUNT)
    ).rejects.toThrow('Insufficient escrow balance');
  });

  test('does NOT increment receiver when sender deduction fails', async () => {
    const { router, db } = makeRouter();
    const receiverIncrement = jest.fn().mockResolvedValue(1);

    db.transaction.mockImplementationOnce(async (cb) => {
      const trx = jest.fn((tableName) => ({
        where:     jest.fn().mockReturnThis(),
        decrement: jest.fn().mockResolvedValue(0),       // fails
        increment: tableName === 'users' ? receiverIncrement : jest.fn().mockResolvedValue(1)
      }));
      return cb(trx).catch(() => {}); // swallow to check side effects
    });

    try {
      await router.executeEscrowInternal(TRANSFER_ID, FROM, TO, AMOUNT);
    } catch (_) {}

    expect(receiverIncrement).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: executeHybridEscrowToNWC
// ─────────────────────────────────────────────────────────────────────────────

describe('executeHybridEscrowToNWC', () => {
  const TRANSFER_ID = 'transfer-uuid-2';
  const FROM        = 'user-escrow';
  const TO          = 'user-nwc';
  const AMOUNT      = 2000;

  const mockLnd = {
    sendPaymentSync: jest.fn()
  };

  function makeHybridRouter(lndResponse, dbDecrement = 1) {
    const { router, db } = makeRouter(
      { users: { decrement: dbDecrement, increment: 1, first: escrowUser({ id: FROM }) } },
      mockLnd
    );

    // LND_ENABLED=false in setup.js overrides the constructor check.
    // Force lndEnabled to true on this instance so we can test the actual LND logic.
    router.lndEnabled = true;

    // getUserWithDecryptedNWC for the NWC receiver
    jest.spyOn(router, 'getUserWithDecryptedNWC').mockResolvedValue(
      nwcUser({ id: TO })
    );

    // Use a SINGLE persistent builder for 'users' so callers can inspect all
    // db('users') calls — including the refund increment — after the fact.
    const usersBuilder = createBuilder({});
    usersBuilder.first.mockResolvedValue(escrowUser({ id: FROM }));
    usersBuilder.decrement.mockResolvedValue(dbDecrement);
    usersBuilder.increment.mockResolvedValue(1);

    db.mockImplementation((tableName) => {
      if (tableName === 'users') return usersBuilder;
      return createBuilder({});
    });

    mockLnd.sendPaymentSync.mockResolvedValue(lndResponse);
    mockMakeInvoice.mockResolvedValue({ invoice: 'lnbc1test...' });

    return { router, db, usersBuilder };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('succeeds: deducts escrow, pays LND, marks transfer completed', async () => {
    const { router } = makeHybridRouter({
      payment_preimage: Buffer.from('preimage_hex', 'utf8'),
      payment_error:    ''
    });

    const result = await router.executeHybridEscrowToNWC(
      TRANSFER_ID, FROM, TO, AMOUNT, 'hit'
    );

    expect(result.mode).toBe('hybrid_escrow_to_nwc');
    expect(mockLnd.sendPaymentSync).toHaveBeenCalledTimes(1);
  });

  test('refunds escrow when LND payment fails', async () => {
    const { router, usersBuilder } = makeHybridRouter({
      payment_preimage: null,
      payment_error:    'ROUTE_NOT_FOUND'
    });

    await expect(
      router.executeHybridEscrowToNWC(TRANSFER_ID, FROM, TO, AMOUNT, 'hit')
    ).rejects.toThrow('ROUTE_NOT_FOUND');

    // The deduct-before-pay + refund-on-failure pattern: increment must fire
    expect(usersBuilder.increment).toHaveBeenCalled();
  });

  test('throws Insufficient escrow balance when decrement returns 0', async () => {
    const { router } = makeHybridRouter(
      { payment_preimage: Buffer.from('x'), payment_error: '' },
      0  // decrement returns 0 → insufficient balance
    );

    await expect(
      router.executeHybridEscrowToNWC(TRANSFER_ID, FROM, TO, AMOUNT, 'hit')
    ).rejects.toThrow('Insufficient escrow balance');

    // LND must NOT have been called
    expect(mockLnd.sendPaymentSync).not.toHaveBeenCalled();
  });

  test('throws when LND is disabled', async () => {
    const { router } = makeRouter(
      { users: { decrement: 1 } },
      null  // lnd = null → lndEnabled = false
    );

    await expect(
      router.executeHybridEscrowToNWC(TRANSFER_ID, FROM, TO, AMOUNT, 'hit')
    ).rejects.toThrow('Hybrid mode requires LND');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: executeTransfer — routing + fallback logic
// ─────────────────────────────────────────────────────────────────────────────

describe('executeTransfer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects amount <= 0', async () => {
    const { router } = makeRouter();
    await expect(
      router.executeTransfer({ gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 0 })
    ).rejects.toThrow('Invalid amount');
  });

  test('rejects self-transfer', async () => {
    const { router } = makeRouter();
    await expect(
      router.executeTransfer({ gameId: 'g1', fromUserId: 'a', toUserId: 'a', amount: 100 })
    ).rejects.toThrow('Self-transfer not allowed');
  });

  test('routes to ESCROW_INTERNAL for two escrow users', async () => {
    const { router } = makeRouter({
      users:     { decrement: 1, increment: 1, first: escrowUser() },
      transfers: { returning: 'tx-id-1', update: 1 }
    });

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(escrowUser({ id: 'a' }))
      .mockResolvedValueOnce(escrowUser({ id: 'b' }));

    jest.spyOn(router, 'executeEscrowInternal').mockResolvedValue({
      tx: 'tx-id-1', mode: 'escrow_internal'
    });

    const result = await router.executeTransfer({
      gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 500
    });

    expect(result.success).toBe(true);
    // executeTransfer returns { mode: route.type, ...result }; the ...result spread
    // overrides mode with the lowercase value from executeEscrowInternal.
    expect(result.mode).toBe('escrow_internal');
    expect(router.executeEscrowInternal).toHaveBeenCalledTimes(1);
  });

  test('falls back to escrow when NWC_P2P fails', async () => {
    const { router } = makeRouter({
      transfers: { returning: 'tx-id-2', update: 1 }
    });

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(nwcUser({ id: 'a' }))
      .mockResolvedValueOnce(nwcUser({ id: 'b' }));

    // NWC fails
    jest.spyOn(router, 'executeNWCP2P').mockRejectedValue(new Error('budget exceeded'));
    jest.spyOn(router, 'executeEscrowFallback').mockResolvedValue({
      success: true, mode: 'escrow_fallback', fallback: true
    });

    const result = await router.executeTransfer({
      gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 500
    });

    expect(result.fallback).toBe(true);
    expect(router.executeEscrowFallback).toHaveBeenCalledTimes(1);
  });

  test('does NOT fall back for HYBRID_ESCROW_TO_NWC failures', async () => {
    const { router } = makeRouter({
      transfers: { returning: 'tx-id-3', update: 1 }
    });

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(escrowUser({ id: 'a' }))
      .mockResolvedValueOnce(nwcUser({ id: 'b' }));

    jest.spyOn(router, 'executeHybridEscrowToNWC').mockRejectedValue(
      new Error('LND error')
    );
    jest.spyOn(router, 'executeEscrowFallback').mockResolvedValue({ success: true });

    await expect(
      router.executeTransfer({ gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 500 })
    ).rejects.toThrow('LND error');

    // Fallback must NOT be called for HYBRID
    expect(router.executeEscrowFallback).not.toHaveBeenCalled();
  });

  test('does NOT fall back for HYBRID_NWC_TO_ESCROW failures', async () => {
    const { router } = makeRouter({
      transfers: { returning: 'tx-id-4', update: 1 }
    });

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(nwcUser({ id: 'a' }))
      .mockResolvedValueOnce(escrowUser({ id: 'b' }));

    jest.spyOn(router, 'executeHybridNWCToEscrow').mockRejectedValue(
      new Error('NWC rejected')
    );
    jest.spyOn(router, 'executeEscrowFallback').mockResolvedValue({ success: true });

    await expect(
      router.executeTransfer({ gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 500 })
    ).rejects.toThrow('NWC rejected');

    expect(router.executeEscrowFallback).not.toHaveBeenCalled();
  });

  test('emits transferCompleted event on success', async () => {
    const { router } = makeRouter({
      transfers: { returning: 'tx-id-5', update: 1 }
    });

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(escrowUser({ id: 'a' }))
      .mockResolvedValueOnce(escrowUser({ id: 'b' }));

    jest.spyOn(router, 'executeEscrowInternal').mockResolvedValue({
      tx: 'tx-id-5', mode: 'escrow_internal'
    });

    const emitSpy = jest.spyOn(router, 'emit');

    await router.executeTransfer({
      gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 100
    });

    expect(emitSpy).toHaveBeenCalledWith('transferCompleted', expect.objectContaining({
      amount: 100
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7: mapRouteToPaymentMode
// ─────────────────────────────────────────────────────────────────────────────

describe('mapRouteToPaymentMode', () => {
  let router;

  beforeEach(() => {
    ({ router } = makeRouter());
  });

  test.each([
    ['NWC_P2P',             'nwc_direct'],
    ['ESCROW_INTERNAL',     'escrow_internal'],
    ['HYBRID_NWC_TO_ESCROW','hybrid_nwc_to_escrow'],
    ['HYBRID_ESCROW_TO_NWC','hybrid_escrow_to_nwc']
  ])('%s → %s', (routeType, expected) => {
    expect(router.mapRouteToPaymentMode(routeType)).toBe(expected);
  });

  test('unknown route → unknown', () => {
    expect(router.mapRouteToPaymentMode('MYSTERY')).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8: executeNWCP2P
// ─────────────────────────────────────────────────────────────────────────────

describe('executeNWCP2P', () => {
  const TRANSFER_ID = 'transfer-nwc-1';
  const FROM        = 'user-nwc-a';
  const TO          = 'user-nwc-b';
  const AMOUNT      = 500;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('succeeds: creates invoice, pays it, and marks transfer completed', async () => {
    const { router } = makeRouter();

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(nwcUser({ id: FROM, username: 'alice' }))
      .mockResolvedValueOnce(nwcUser({ id: TO, username: 'bob' }));

    mockMakeInvoice.mockResolvedValue({ invoice: 'lnbc500test' });
    mockPayInvoice.mockResolvedValue({ preimage: 'abc123preimage', payment_hash: 'hash123' });

    const result = await router.executeNWCP2P(TRANSFER_ID, FROM, TO, AMOUNT, 'hit');

    expect(result.mode).toBe('nwc_p2p');
    expect(result.tx).toBe('abc123preimage');
    expect(mockMakeInvoice).toHaveBeenCalledTimes(1);
    expect(mockPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('throws when payInvoice returns no preimage', async () => {
    const { router } = makeRouter();

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(nwcUser({ id: FROM }))
      .mockResolvedValueOnce(nwcUser({ id: TO }));

    mockMakeInvoice.mockResolvedValue({ invoice: 'lnbc500test' });
    mockPayInvoice.mockResolvedValue({ preimage: null }); // payment failed

    await expect(
      router.executeNWCP2P(TRANSFER_ID, FROM, TO, AMOUNT, 'hit')
    ).rejects.toThrow('Payment failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 9: executeHybridNWCToEscrow
// ─────────────────────────────────────────────────────────────────────────────

describe('executeHybridNWCToEscrow', () => {
  const TRANSFER_ID = 'transfer-hybrid-nwc';
  const FROM        = 'user-nwc';
  const TO          = 'user-escrow';
  const AMOUNT      = 1500;

  const mockLnd = {
    addInvoice:      jest.fn(),
    sendPaymentSync: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('succeeds: NWC pays LND invoice, credits receiver escrow', async () => {
    const { router } = makeRouter({}, mockLnd);
    router.lndEnabled = true;

    jest.spyOn(router, 'getUserWithDecryptedNWC').mockResolvedValue(
      nwcUser({ id: FROM, username: 'alice' })
    );

    mockLnd.addInvoice.mockResolvedValue({ payment_request: 'lnbc_server_invoice' });
    mockPayInvoice.mockResolvedValue({ preimage: 'nwc_preimage_123' });

    const result = await router.executeHybridNWCToEscrow(
      TRANSFER_ID, FROM, TO, AMOUNT, 'hit'
    );

    expect(result.mode).toBe('hybrid_nwc_to_escrow');
    expect(result.tx).toBe('nwc_preimage_123');
    expect(mockLnd.addInvoice).toHaveBeenCalledTimes(1);
    expect(mockPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('throws when payment preimage is missing', async () => {
    const { router } = makeRouter({}, mockLnd);
    router.lndEnabled = true;

    jest.spyOn(router, 'getUserWithDecryptedNWC').mockResolvedValue(
      nwcUser({ id: FROM })
    );

    mockLnd.addInvoice.mockResolvedValue({ payment_request: 'lnbc_invoice' });
    mockPayInvoice.mockResolvedValue({ preimage: null });

    await expect(
      router.executeHybridNWCToEscrow(TRANSFER_ID, FROM, TO, AMOUNT, 'hit')
    ).rejects.toThrow('Hybrid payment failed');
  });

  test('throws when LND is disabled', async () => {
    const { router } = makeRouter({}, null); // lnd = null → lndEnabled = false

    await expect(
      router.executeHybridNWCToEscrow(TRANSFER_ID, FROM, TO, AMOUNT, 'hit')
    ).rejects.toThrow('Hybrid mode requires LND');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 10: executeEscrowFallback — error path
// ─────────────────────────────────────────────────────────────────────────────

describe('executeEscrowFallback — error path', () => {
  test('throws "Both NWC and escrow failed" when internal escrow also fails', async () => {
    const { router } = makeRouter();

    jest.spyOn(router, 'executeEscrowInternal').mockRejectedValue(
      new Error('Escrow DB down')
    );

    await expect(
      router.executeEscrowFallback('tx-fallback', 'user-a', 'user-b', 1000)
    ).rejects.toThrow('Both NWC and escrow failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 11: getNWCClient — cached connection
// ─────────────────────────────────────────────────────────────────────────────

describe('getNWCClient — caching', () => {
  test('returns the same client instance on second call within 5 min', () => {
    const { router } = makeRouter();
    const uri    = 'nostr+walletconnect://test-uri-cache';
    const first  = router.getNWCClient(uri);
    const second = router.getNWCClient(uri);
    expect(first).toBe(second); // same object reference from cache
  });

  test('creates a new client if URI is different', () => {
    const { router } = makeRouter();
    const a = router.getNWCClient('nostr+walletconnect://uri-a');
    const b = router.getNWCClient('nostr+walletconnect://uri-b');
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 12: getUserWithDecryptedNWC — decrypt error path
// ─────────────────────────────────────────────────────────────────────────────

describe('getUserWithDecryptedNWC — decrypt failure', () => {
  test('returns user with nwc_uri_decrypted = null when decryption fails', async () => {
    const { router, db } = makeRouter();

    const userWithBadEncryption = {
      id: 'user-bad-nwc',
      wallet_type: 'nwc',
      nwc_uri_encrypted: 'badhex',
      nwc_uri_iv:        'badhex',
      nwc_uri_auth_tag:  'badhex'
    };

    db('users').first.mockResolvedValueOnce(userWithBadEncryption);

    const result = await router.getUserWithDecryptedNWC('user-bad-nwc');

    expect(result).not.toBeNull();
    expect(result.nwc_uri_decrypted).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 13: retryExistingTransfer
// ─────────────────────────────────────────────────────────────────────────────

describe('retryExistingTransfer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('retries ESCROW_INTERNAL route and emits transferCompleted', async () => {
    const { router } = makeRouter();
    const transfer = {
      id:          'tx-retry-1',
      game_id:     'game-1',
      from_user_id: 'user-a',
      to_user_id:   'user-b',
      amount_sats:  1000,
      reason:       'retry'
    };

    jest.spyOn(router, 'determineOptimalRoute').mockResolvedValue({ type: 'ESCROW_INTERNAL' });
    jest.spyOn(router, 'executeEscrowInternal').mockResolvedValue({ tx: 'tx-retry-1', mode: 'escrow_internal' });
    const emitSpy = jest.spyOn(router, 'emit');

    await router.retryExistingTransfer(transfer);

    expect(router.executeEscrowInternal).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('transferCompleted', expect.objectContaining({ amount: 1000 }));
  });

  test('marks transfer failed when retry throws', async () => {
    const { router } = makeRouter();
    const transfer = {
      id: 'tx-retry-fail', game_id: 'g1',
      from_user_id: 'a', to_user_id: 'b', amount_sats: 500, reason: ''
    };

    jest.spyOn(router, 'determineOptimalRoute').mockResolvedValue({ type: 'ESCROW_INTERNAL' });
    jest.spyOn(router, 'executeEscrowInternal').mockRejectedValue(new Error('retry DB error'));
    jest.spyOn(router, 'markTransferFailed').mockResolvedValue(undefined);

    await router.retryExistingTransfer(transfer); // should NOT throw — error is swallowed

    expect(router.markTransferFailed).toHaveBeenCalledWith('tx-retry-fail', 'retry DB error');
  });

  test('retries NWC_P2P route', async () => {
    const { router } = makeRouter();
    const transfer = {
      id: 'tx-nwc-retry', game_id: 'g2',
      from_user_id: 'a', to_user_id: 'b', amount_sats: 750, reason: 'hit'
    };

    jest.spyOn(router, 'determineOptimalRoute').mockResolvedValue({ type: 'NWC_P2P' });
    jest.spyOn(router, 'executeNWCP2P').mockResolvedValue({ tx: 'preimage-x', mode: 'nwc_p2p' });

    await router.retryExistingTransfer(transfer);

    expect(router.executeNWCP2P).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 14: executeTransfer — additional branches
// ─────────────────────────────────────────────────────────────────────────────

describe('executeTransfer — additional branches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('routes to NWC_P2P for two NWC users (success, covers break)', async () => {
    const { router } = makeRouter({
      transfers: { returning: 'tx-nwc-1', update: 1 }
    });

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(nwcUser({ id: 'a' }))
      .mockResolvedValueOnce(nwcUser({ id: 'b' }));

    jest.spyOn(router, 'executeNWCP2P').mockResolvedValue({
      tx: 'nwc-tx-1', mode: 'nwc_p2p'
    });

    const result = await router.executeTransfer({
      gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 300
    });

    expect(result.success).toBe(true);
    expect(router.executeNWCP2P).toHaveBeenCalledTimes(1);
  });

  test('routes to HYBRID_NWC_TO_ESCROW (success, covers break)', async () => {
    const { router } = makeRouter({
      transfers: { returning: 'tx-hybrid-1', update: 1 }
    });

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(nwcUser({ id: 'a' }))
      .mockResolvedValueOnce(escrowUser({ id: 'b' }));

    jest.spyOn(router, 'executeHybridNWCToEscrow').mockResolvedValue({
      tx: 'hybrid-nwc-1', mode: 'hybrid_nwc_to_escrow'
    });

    const result = await router.executeTransfer({
      gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 400
    });

    expect(result.success).toBe(true);
    expect(router.executeHybridNWCToEscrow).toHaveBeenCalledTimes(1);
  });

  test('routes to HYBRID_ESCROW_TO_NWC (success, covers break)', async () => {
    const { router } = makeRouter({
      transfers: { returning: 'tx-hybrid-escrow-1', update: 1 }
    });

    jest.spyOn(router, 'getUserWithDecryptedNWC')
      .mockResolvedValueOnce(escrowUser({ id: 'a' }))
      .mockResolvedValueOnce(nwcUser({ id: 'b' }));

    jest.spyOn(router, 'executeHybridEscrowToNWC').mockResolvedValue({
      tx: 'hybrid-escrow-1', mode: 'hybrid_escrow_to_nwc'
    });

    const result = await router.executeTransfer({
      gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 350
    });

    expect(result.success).toBe(true);
    expect(router.executeHybridEscrowToNWC).toHaveBeenCalledTimes(1);
  });

  test('throws for unknown route type (covers default: branch)', async () => {
    const { router } = makeRouter({
      transfers: { returning: 'tx-unknown-1', update: 1 }
    });

    jest.spyOn(router, 'determineOptimalRoute').mockResolvedValue({ type: 'UNKNOWN_ROUTE_TYPE' });
    jest.spyOn(router, 'markTransferFailed').mockResolvedValue(undefined);

    await expect(
      router.executeTransfer({ gameId: 'g1', fromUserId: 'a', toUserId: 'b', amount: 100 })
    ).rejects.toThrow('Unknown route type: UNKNOWN_ROUTE_TYPE');

    expect(router.markTransferFailed).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 15: executeEscrowFallback — success path
// ─────────────────────────────────────────────────────────────────────────────

describe('executeEscrowFallback — success path', () => {
  test('returns success with escrow_fallback mode when escrow succeeds', async () => {
    const { router } = makeRouter();

    jest.spyOn(router, 'executeEscrowInternal').mockResolvedValue({
      tx: 'fallback-tx-1', mode: 'escrow_internal'
    });

    const result = await router.executeEscrowFallback('tx-fb', 'user-a', 'user-b', 500);

    expect(result.success).toBe(true);
    expect(result.mode).toBe('escrow_fallback');
    expect(result.fallback).toBe(true);
    expect(router.executeEscrowInternal).toHaveBeenCalledWith('tx-fb', 'user-a', 'user-b', 500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 16: retryExistingTransfer — unknown route type
// ─────────────────────────────────────────────────────────────────────────────

describe('retryExistingTransfer — HYBRID routes and unknown type', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('retries HYBRID_NWC_TO_ESCROW route (covers case branch)', async () => {
    const { router } = makeRouter();
    const transfer = {
      id: 'tx-hybrid-nwc-retry', game_id: 'g4',
      from_user_id: 'a', to_user_id: 'b', amount_sats: 600, reason: 'hit'
    };

    jest.spyOn(router, 'determineOptimalRoute').mockResolvedValue({ type: 'HYBRID_NWC_TO_ESCROW' });
    jest.spyOn(router, 'executeHybridNWCToEscrow').mockResolvedValue({ tx: 'hybrid-tx-1', mode: 'hybrid_nwc_to_escrow' });
    const emitSpy = jest.spyOn(router, 'emit');

    await router.retryExistingTransfer(transfer);

    expect(router.executeHybridNWCToEscrow).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('transferCompleted', expect.objectContaining({ amount: 600 }));
  });

  test('retries HYBRID_ESCROW_TO_NWC route (covers case branch)', async () => {
    const { router } = makeRouter();
    const transfer = {
      id: 'tx-hybrid-escrow-retry', game_id: 'g5',
      from_user_id: 'a', to_user_id: 'b', amount_sats: 700, reason: 'hit'
    };

    jest.spyOn(router, 'determineOptimalRoute').mockResolvedValue({ type: 'HYBRID_ESCROW_TO_NWC' });
    jest.spyOn(router, 'executeHybridEscrowToNWC').mockResolvedValue({ tx: 'hybrid-tx-2', mode: 'hybrid_escrow_to_nwc' });
    const emitSpy = jest.spyOn(router, 'emit');

    await router.retryExistingTransfer(transfer);

    expect(router.executeHybridEscrowToNWC).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('transferCompleted', expect.objectContaining({ amount: 700 }));
  });

  test('marks transfer failed for unrecognized route type (covers default: branch)', async () => {
    const { router } = makeRouter();
    const transfer = {
      id: 'tx-unknown-retry', game_id: 'g6',
      from_user_id: 'a', to_user_id: 'b', amount_sats: 200, reason: ''
    };

    jest.spyOn(router, 'determineOptimalRoute').mockResolvedValue({ type: 'UNKNOWN_ROUTE_TYPE' });
    jest.spyOn(router, 'markTransferFailed').mockResolvedValue(undefined);

    await router.retryExistingTransfer(transfer); // should NOT throw — error is swallowed

    expect(router.markTransferFailed).toHaveBeenCalledWith(
      'tx-unknown-retry',
      'Unknown route type: UNKNOWN_ROUTE_TYPE'
    );
  });
});
