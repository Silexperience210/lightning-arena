// =============================================================================
// Migration: 20260302120000 — Convert satoshi columns from INTEGER to BIGINT
// =============================================================================
//
// WHY:
//   INTEGER (32-bit) maxes out at 2,147,483,647.
//   Cumulative columns (escrow_total_deposited, escrow_total_withdrawn) will
//   overflow for any account that processes more than ~21.5M transactions at
//   100 sats each. BIGINT (64-bit) caps at 9,223,372,036,854,775,807 —
//   effectively limitless for any conceivable Bitcoin activity.
//
// SAFETY:
//   INTEGER → BIGINT is a lossless widening cast. PostgreSQL preserves all
//   existing CHECK constraints, DEFAULT values, NOT NULL flags, and indexes
//   automatically. No data is modified.
//
// GENERATED COLUMNS (net_amount, net_profit):
//   PostgreSQL does not allow ALTER TYPE directly on GENERATED ALWAYS AS
//   STORED columns. They must be dropped and recreated. This is safe because
//   their value is always derived — no data is lost.
//
// TRANSACTION:
//   Knex wraps migrations in a transaction by default. If any step fails,
//   the entire migration rolls back cleanly.
// =============================================================================

exports.up = async function (knex) {
  // ── 1. users ───────────────────────────────────────────────────────────────
  // All columns that accumulate satoshi values over a lifetime of gameplay.
  await knex.raw(`
    ALTER TABLE users
      ALTER COLUMN nwc_budget_sats        TYPE BIGINT,
      ALTER COLUMN escrow_balance_sats    TYPE BIGINT,
      ALTER COLUMN escrow_locked_sats     TYPE BIGINT,
      ALTER COLUMN escrow_total_deposited TYPE BIGINT,
      ALTER COLUMN escrow_total_withdrawn TYPE BIGINT
  `);

  // ── 2. games ───────────────────────────────────────────────────────────────
  // total_pot_sats is the sum of all player buy-ins — scales with player count.
  await knex.raw(`
    ALTER TABLE games
      ALTER COLUMN buy_in_sats     TYPE BIGINT,
      ALTER COLUMN server_fee_sats TYPE BIGINT,
      ALTER COLUMN total_pot_sats  TYPE BIGINT
  `);

  // ── 3. game_participants ───────────────────────────────────────────────────
  // net_profit is GENERATED ALWAYS AS STORED — must be dropped before altering
  // its source columns, then recreated with the new BIGINT type.
  await knex.raw(`ALTER TABLE game_participants DROP COLUMN net_profit`);

  await knex.raw(`
    ALTER TABLE game_participants
      ALTER COLUMN initial_balance TYPE BIGINT,
      ALTER COLUMN final_balance   TYPE BIGINT
  `);

  await knex.raw(`
    ALTER TABLE game_participants
      ADD COLUMN net_profit BIGINT
        GENERATED ALWAYS AS (COALESCE(final_balance, 0) - initial_balance) STORED
  `);

  // ── 4. transfers ───────────────────────────────────────────────────────────
  // net_amount is GENERATED ALWAYS AS STORED — same drop + recreate pattern.
  await knex.raw(`ALTER TABLE transfers DROP COLUMN net_amount`);

  await knex.raw(`
    ALTER TABLE transfers
      ALTER COLUMN amount_sats TYPE BIGINT,
      ALTER COLUMN fee_sats    TYPE BIGINT
  `);

  await knex.raw(`
    ALTER TABLE transfers
      ADD COLUMN net_amount BIGINT
        GENERATED ALWAYS AS (amount_sats - fee_sats) STORED
  `);

  // ── 5. deposits ────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE deposits
      ALTER COLUMN amount_sats TYPE BIGINT
  `);

  // ── 6. withdrawals ─────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE withdrawals
      ALTER COLUMN amount_sats TYPE BIGINT,
      ALTER COLUMN fee_sats    TYPE BIGINT
  `);
};

// =============================================================================
// DOWN — Revert BIGINT → INTEGER
//
// WARNING: Only safe if no stored value exceeds 2,147,483,647.
//          Intended for development rollbacks only, never for production.
// =============================================================================

exports.down = async function (knex) {
  // ── 1. users ───────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE users
      ALTER COLUMN nwc_budget_sats        TYPE INTEGER,
      ALTER COLUMN escrow_balance_sats    TYPE INTEGER,
      ALTER COLUMN escrow_locked_sats     TYPE INTEGER,
      ALTER COLUMN escrow_total_deposited TYPE INTEGER,
      ALTER COLUMN escrow_total_withdrawn TYPE INTEGER
  `);

  // ── 2. games ───────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE games
      ALTER COLUMN buy_in_sats     TYPE INTEGER,
      ALTER COLUMN server_fee_sats TYPE INTEGER,
      ALTER COLUMN total_pot_sats  TYPE INTEGER
  `);

  // ── 3. game_participants ───────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE game_participants DROP COLUMN net_profit`);

  await knex.raw(`
    ALTER TABLE game_participants
      ALTER COLUMN initial_balance TYPE INTEGER,
      ALTER COLUMN final_balance   TYPE INTEGER
  `);

  await knex.raw(`
    ALTER TABLE game_participants
      ADD COLUMN net_profit INTEGER
        GENERATED ALWAYS AS (COALESCE(final_balance, 0) - initial_balance) STORED
  `);

  // ── 4. transfers ───────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE transfers DROP COLUMN net_amount`);

  await knex.raw(`
    ALTER TABLE transfers
      ALTER COLUMN amount_sats TYPE INTEGER,
      ALTER COLUMN fee_sats    TYPE INTEGER
  `);

  await knex.raw(`
    ALTER TABLE transfers
      ADD COLUMN net_amount INTEGER
        GENERATED ALWAYS AS (amount_sats - fee_sats) STORED
  `);

  // ── 5. deposits ────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE deposits
      ALTER COLUMN amount_sats TYPE INTEGER
  `);

  // ── 6. withdrawals ─────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE withdrawals
      ALTER COLUMN amount_sats TYPE INTEGER,
      ALTER COLUMN fee_sats    TYPE INTEGER
  `);
};
