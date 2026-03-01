-- =====================================================
-- LIGHTNING ARENA - Database Schema
-- Architecture: Hybrid NWC + Escrow
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- TABLE: users
-- Hybrid wallet support (NWC + Escrow)
-- =====================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(32) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE,
    ln_address VARCHAR(255) NOT NULL,
    
    -- Wallet type detection
    wallet_type VARCHAR(16) NOT NULL DEFAULT 'escrow' 
        CHECK (wallet_type IN ('nwc', 'escrow', 'standard')),
    
    -- NWC Mode fields (nullable)
    nwc_pubkey VARCHAR(255),
    nwc_uri_encrypted TEXT,
    nwc_uri_iv VARCHAR(32),
    nwc_uri_auth_tag VARCHAR(32),
    nwc_budget_sats INTEGER DEFAULT 100000, -- budget limit
    nwc_budget_renewal VARCHAR(16) DEFAULT 'daily' CHECK (nwc_budget_renewal IN ('never', 'daily', 'weekly', 'monthly', 'yearly')),
    nwc_expires_at TIMESTAMP,
    nwc_last_used TIMESTAMP,
    
    -- Escrow Mode fields
    escrow_balance_sats INTEGER DEFAULT 0 CHECK (escrow_balance_sats >= 0),
    escrow_locked_sats INTEGER DEFAULT 0 CHECK (escrow_locked_sats >= 0),
    escrow_total_deposited INTEGER DEFAULT 0,
    escrow_total_withdrawn INTEGER DEFAULT 0,
    
    -- Reputation & Security
    reputation_score INTEGER DEFAULT 100 CHECK (reputation_score >= 0 AND reputation_score <= 100),
    is_banned BOOLEAN DEFAULT FALSE,
    ban_reason TEXT,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_login TIMESTAMP,
    last_ip INET,
    
    -- Preferences
    preferred_mode VARCHAR(16) DEFAULT 'auto' -- auto, nwc, escrow
);

-- Indexes for users
CREATE INDEX idx_users_ln_address ON users(ln_address);
CREATE INDEX idx_users_wallet_type ON users(wallet_type);
CREATE INDEX idx_users_reputation ON users(reputation_score) WHERE reputation_score < 50;

-- =====================================================
-- TABLE: games (rooms)
-- =====================================================
CREATE TABLE games (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_code VARCHAR(8) UNIQUE NOT NULL,
    
    -- Game config
    status VARCHAR(16) NOT NULL DEFAULT 'lobby' 
        CHECK (status IN ('lobby', 'playing', 'finished', 'cancelled')),
    game_mode VARCHAR(32) DEFAULT 'ffa', -- ffa, team, 1v1
    
    -- Economics
    buy_in_sats INTEGER NOT NULL CHECK (buy_in_sats >= 1000),
    max_players INTEGER NOT NULL DEFAULT 4,
    server_fee_percent DECIMAL(4,2) DEFAULT 1.00, -- 1%
    server_fee_sats INTEGER DEFAULT 0,
    total_pot_sats INTEGER DEFAULT 0,
    
    -- Host
    host_id UUID REFERENCES users(id),
    
    -- Timing
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    finished_at TIMESTAMP,
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '2 hours',
    
    -- Anti-cheat
    game_hash VARCHAR(64), -- SHA256 of game events for verification
    replay_data JSONB
);

CREATE INDEX idx_games_status ON games(status);
CREATE INDEX idx_games_room_code ON games(room_code);
CREATE INDEX idx_games_expires ON games(expires_at) WHERE status IN ('lobby', 'playing');

-- =====================================================
-- TABLE: game_participants
-- =====================================================
CREATE TABLE game_participants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    
    -- In-game identity
    kart_id INTEGER,
    player_name VARCHAR(32),
    
    -- Economics tracking
    initial_balance INTEGER NOT NULL,
    final_balance INTEGER,
    net_profit INTEGER GENERATED ALWAYS AS (COALESCE(final_balance, 0) - initial_balance) STORED,
    total_hits_given INTEGER DEFAULT 0,
    total_hits_taken INTEGER DEFAULT 0,
    total_damage_dealt INTEGER DEFAULT 0,
    total_damage_taken INTEGER DEFAULT 0,
    
    -- Status
    status VARCHAR(16) DEFAULT 'active' 
        CHECK (status IN ('active', 'disconnected', 'reconnected', 'eliminated', 'winner')),
    
    -- Disconnexion handling
    disconnect_count INTEGER DEFAULT 0,
    disconnected_at TIMESTAMP,
    reconnected_at TIMESTAMP,
    
    -- Timing
    joined_at TIMESTAMP DEFAULT NOW(),
    eliminated_at TIMESTAMP,
    
    UNIQUE(game_id, user_id)
);

CREATE INDEX idx_participants_game ON game_participants(game_id);
CREATE INDEX idx_participants_user ON game_participants(user_id);
CREATE INDEX idx_participants_status ON game_participants(status);

-- =====================================================
-- TABLE: transfers (payment ledger)
-- THE MOST IMPORTANT TABLE - records every sat movement
-- =====================================================
CREATE TABLE transfers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    game_id UUID NOT NULL REFERENCES games(id),
    
    -- Who
    from_user_id UUID NOT NULL REFERENCES users(id),
    to_user_id UUID NOT NULL REFERENCES users(id),
    
    -- How much
    amount_sats INTEGER NOT NULL CHECK (amount_sats > 0),
    fee_sats INTEGER DEFAULT 0,
    net_amount INTEGER GENERATED ALWAYS AS (amount_sats - fee_sats) STORED,
    
    -- Why
    weapon_type VARCHAR(32), -- bowling, cake, swatter, bubblegum, banana, collision
    reason TEXT,
    
    -- Payment mode (the hybrid magic)
    payment_mode VARCHAR(32) NOT NULL 
        CHECK (payment_mode IN (
            'nwc_direct',           -- P2P NWC (both players NWC)
            'escrow_internal',      -- Virtual ledger (both escrow)
            'hybrid_nwc_to_escrow', -- NWC payer → Escrow receiver
            'hybrid_escrow_to_nwc', -- Escrow payer → NWC receiver
            'escrow_withdrawal',    -- Final withdrawal
            'server_fee'            -- Our fee
        )),
    
    -- NWC specific (if applicable)
    payment_hash VARCHAR(255),
    preimage VARCHAR(255),
    invoice_request TEXT,
    nwc_response JSONB,
    
    -- Escrow specific (if applicable)
    escrow_tx_reference UUID,
    
    -- LND node info (for tracking)
    lnd_tx_id VARCHAR(255),
    
    -- Status
    status VARCHAR(16) DEFAULT 'pending' 
        CHECK (status IN ('pending', 'completed', 'failed', 'refunded', 'expired')),
    
    -- Timing
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes',
    
    -- Retry logic
    retry_count INTEGER DEFAULT 0,
    last_error TEXT
);

-- Critical indexes for performance
CREATE INDEX idx_transfers_game ON transfers(game_id);
CREATE INDEX idx_transfers_from ON transfers(from_user_id);
CREATE INDEX idx_transfers_to ON transfers(to_user_id);
CREATE INDEX idx_transfers_status ON transfers(status);
CREATE INDEX idx_transfers_mode ON transfers(payment_mode);
CREATE INDEX idx_transfers_created ON transfers(created_at);

-- Partial index for pending transfers (fast lookup for retry logic)
CREATE INDEX idx_transfers_pending ON transfers(status, retry_count) 
    WHERE status IN ('pending', 'failed') AND retry_count < 3;

-- =====================================================
-- TABLE: deposits (escrow mode)
-- =====================================================
CREATE TABLE deposits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    game_id UUID REFERENCES games(id), -- NULL if general deposit
    
    amount_sats INTEGER NOT NULL CHECK (amount_sats > 0),
    
    -- Lightning invoice
    payment_hash VARCHAR(255) UNIQUE NOT NULL,
    payment_request TEXT NOT NULL,
    preimage VARCHAR(255),
    
    -- Status
    status VARCHAR(16) DEFAULT 'pending' 
        CHECK (status IN ('pending', 'paid', 'expired', 'refunded')),
    
    -- Timing
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '1 hour',
    paid_at TIMESTAMP,
    
    -- For duplicate detection
    UNIQUE(user_id, payment_hash)
);

CREATE INDEX idx_deposits_user ON deposits(user_id);
CREATE INDEX idx_deposits_status ON deposits(status);
CREATE INDEX idx_deposits_game ON deposits(game_id);

-- =====================================================
-- TABLE: withdrawals (escrow mode)
-- =====================================================
CREATE TABLE withdrawals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    game_id UUID REFERENCES games(id), -- NULL if general withdrawal
    
    amount_sats INTEGER NOT NULL CHECK (amount_sats > 0),
    fee_sats INTEGER DEFAULT 0,
    
    -- Destination
    destination_ln_address VARCHAR(255) NOT NULL,
    
    -- LND payment tracking
    payment_hash VARCHAR(255),
    preimage VARCHAR(255),
    lnd_payment_id VARCHAR(255),
    
    -- Status
    status VARCHAR(16) DEFAULT 'pending' 
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    
    -- Timing
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    
    -- Error tracking
    error_message TEXT,
    retry_count INTEGER DEFAULT 0
);

CREATE INDEX idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX idx_withdrawals_status ON withdrawals(status);

-- =====================================================
-- TABLE: game_events (for replay & anti-cheat)
-- =====================================================
CREATE TABLE game_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    
    event_type VARCHAR(32) NOT NULL, -- hit, death, powerup, disconnect, reconnect
    event_data JSONB NOT NULL,
    
    timestamp TIMESTAMP DEFAULT NOW(),
    server_timestamp TIMESTAMP DEFAULT NOW(),
    
    -- Client signature verification
    client_signature VARCHAR(255),
    server_signature VARCHAR(255),
    
    -- For ordering
    sequence_number INTEGER
);

CREATE INDEX idx_events_game ON game_events(game_id);
CREATE INDEX idx_events_type ON game_events(event_type);
CREATE INDEX idx_events_sequence ON game_events(game_id, sequence_number);

-- =====================================================
-- VIEWS for easy querying
-- =====================================================

-- User balance view (combines both modes)
CREATE VIEW user_balances AS
SELECT 
    u.id,
    u.username,
    u.wallet_type,
    u.escrow_balance_sats,
    u.escrow_locked_sats,
    (u.escrow_balance_sats - u.escrow_locked_sats) AS escrow_available_sats,
    COALESCE(SUM(CASE 
        WHEN t.status = 'completed' AND t.to_user_id = u.id THEN t.amount_sats
        WHEN t.status = 'completed' AND t.from_user_id = u.id THEN -t.amount_sats
        ELSE 0 
    END), 0) AS nwc_net_balance_sats
FROM users u
LEFT JOIN transfers t ON (t.from_user_id = u.id OR t.to_user_id = u.id)
    AND t.payment_mode = 'nwc_direct'
    AND t.created_at > NOW() - INTERVAL '24 hours'
GROUP BY u.id;

-- Game stats view
CREATE VIEW game_stats AS
SELECT 
    g.id,
    g.room_code,
    g.status,
    g.buy_in_sats,
    g.total_pot_sats,
    COUNT(DISTINCT gp.id) AS player_count,
    COUNT(DISTINCT CASE WHEN gp.status = 'winner' THEN gp.id END) AS winner_count,
    SUM(CASE WHEN t.status = 'completed' THEN t.fee_sats ELSE 0 END) AS total_fees_collected
FROM games g
LEFT JOIN game_participants gp ON gp.game_id = g.id
LEFT JOIN transfers t ON t.game_id = g.id
GROUP BY g.id;

-- =====================================================
-- FUNCTIONS & TRIGGERS
-- =====================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to get user total balance (hybrid calculation)
CREATE OR REPLACE FUNCTION get_user_total_balance(user_uuid UUID)
RETURNS INTEGER AS $$
DECLARE
    escrow_bal INTEGER;
    nwc_24h_bal INTEGER;
BEGIN
    SELECT escrow_balance_sats INTO escrow_bal
    FROM users WHERE id = user_uuid;
    
    SELECT COALESCE(SUM(CASE 
        WHEN to_user_id = user_uuid THEN amount_sats
        WHEN from_user_id = user_uuid THEN -amount_sats
        ELSE 0
    END), 0)
    INTO nwc_24h_bal
    FROM transfers
    WHERE (from_user_id = user_uuid OR to_user_id = user_uuid)
    AND payment_mode = 'nwc_direct'
    AND status = 'completed'
    AND created_at > NOW() - INTERVAL '24 hours';
    
    RETURN COALESCE(escrow_bal, 0) + COALESCE(nwc_24h_bal, 0);
END;
$$ LANGUAGE plpgsql;

-- Function to retry failed transfers
CREATE OR REPLACE FUNCTION retry_failed_transfers()
RETURNS INTEGER AS $$
DECLARE
    retried_count INTEGER := 0;
    transfer_record RECORD;
BEGIN
    FOR transfer_record IN 
        SELECT id FROM transfers 
        WHERE status IN ('pending', 'failed') 
        AND retry_count < 3
        AND expires_at > NOW()
        AND created_at > NOW() - INTERVAL '10 minutes'
    LOOP
        -- Mark for retry (actual retry logic handled by worker)
        UPDATE transfers 
        SET retry_count = retry_count + 1,
            status = 'pending'
        WHERE id = transfer_record.id;
        
        retried_count := retried_count + 1;
    END LOOP;
    
    RETURN retried_count;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- CLEANUP POLICY (automatic data retention)
-- =====================================================

-- Auto-delete old pending deposits
CREATE OR REPLACE FUNCTION cleanup_old_pending()
RETURNS void AS $$
BEGIN
    UPDATE deposits 
    SET status = 'expired' 
    WHERE status = 'pending' 
    AND expires_at < NOW();
    
    UPDATE transfers 
    SET status = 'expired' 
    WHERE status = 'pending' 
    AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Run cleanup every 5 minutes via cron or pg_cron
-- SELECT cron.schedule('0 */5 * * *', 'SELECT cleanup_old_pending()');

-- =====================================================
-- INITIAL DATA
-- =====================================================

-- Create indexes for common queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_created ON users(created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_games_created ON games(created_at);

-- Done!
-- Run this with: psql -d lightning_arena -f schema.sql
