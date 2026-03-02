// =====================================================
// Test environment bootstrap
// Loaded BEFORE any test file runs.
// =====================================================

// Minimal environment vars so modules that read process.env at require-time
// (e.g. PaymentRouter reads NWC_ENCRYPTION_KEY in the constructor) don't crash.
process.env.NODE_ENV         = 'test';
process.env.JWT_SECRET       = 'test-jwt-secret-32-chars-minimum!';
// 32-byte hex key for AES-256-GCM
process.env.NWC_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.LND_ENABLED      = 'false';
process.env.DATABASE_URL     = 'postgresql://test:test@localhost/test';
process.env.REDIS_URL        = 'redis://localhost:6379';
process.env.PORT             = '0'; // random port — avoids conflicts

// Silence console noise during tests unless DEBUG_TESTS=1 is set
if (!process.env.DEBUG_TESTS) {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
}

// Global timeout for async tests
jest.setTimeout(10000);

// Jest uses fake timers for setInterval/setTimeout created during tests
// when --fakeTimers is set, but PaymentRouter's background workers use
// real setInterval.  We use --forceExit at the CLI level instead of
// fake timers to avoid interfering with time-dependent assertions.
// (See "test" script in package.json.)
