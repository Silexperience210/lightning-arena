#!/usr/bin/env node
// =====================================================
// LIGHTNING ARENA SERVER - Main Entry Point
// Hybrid NWC + Escrow Payment Infrastructure
// =====================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const knex = require('knex');
const redis = require('redis');
const { createLightningClient } = require('./src/lnd-client');
const PaymentRouter = require('./src/PaymentRouter');

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3000' },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Database connection
const db = knex({
  client: 'postgresql',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'lightning',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'lightning_arena'
  },
  pool: { min: 2, max: 20 }
});

// Redis connection
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.connect().catch(console.error);

// LND connection — only initialize if explicitly enabled to avoid ENOENT crash in NWC-only mode
const lnd = process.env.LND_ENABLED !== 'false'
  ? createLightningClient({
      server: process.env.LND_GRPC_HOST,
      macaroonPath: process.env.LND_MACAROON_PATH,
      tlsCertPath: process.env.LND_TLS_CERT_PATH
    })
  : null;

// Payment Router initialization
const paymentRouter = new PaymentRouter({
  db,
  lnd,
  redis: redisClient,
  options: {
    maxRetries: 3,
    retryDelayMs: 2000,
    paymentTimeoutMs: 30000,
    feePercent: 1.0
  }
});

// Listen for real-time payment events
paymentRouter.on('transferCompleted', (data) => {
  // Broadcast to game room
  io.to(`game:${data.gameId}`).emit('payment:completed', {
    transferId: data.transferId,
    from: data.from,
    to: data.to,
    amount: data.amount,
    mode: data.mode,
    tx: data.tx
  });
});

// =====================================================
// AUTHENTICATION MIDDLEWARE
// =====================================================

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireGameHost(req, res, next) {
  const { gameId } = req.params;
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  db('games').where('id', gameId).first()
    .then(game => {
      if (!game) return res.status(404).json({ error: 'Game not found' });
      if (game.host_id !== userId) return res.status(403).json({ error: 'Only the game host can perform this action' });
      next();
    })
    .catch(err => {
      console.error('requireGameHost error:', err);
      res.status(500).json({ error: 'Authorization check failed' });
    });
}

// =====================================================
// AUTH ROUTES
// =====================================================

// Register / Login
app.post('/api/auth/register', async (req, res) => {
  const { username, email, lnAddress, password } = req.body;
  
  try {
    // Check if username or lnAddress exists
    const existing = await db('users')
      .where('username', username)
      .orWhere('ln_address', lnAddress)
      .first();
    
    if (existing) {
      return res.status(409).json({ error: 'Username or LN address already exists' });
    }
    
    // Hash password if provided (for non-NWC login)
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 10);
    }
    
    // Create user
    const [user] = await db('users').insert({
      username,
      email,
      ln_address: lnAddress,
      password_hash: passwordHash,
      wallet_type: 'escrow',
      escrow_balance_sats: 0,
      created_at: new Date()
    }).returning(['id', 'username', 'ln_address', 'wallet_type', 'escrow_balance_sats']);
    
    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.status(201).json({ user, token });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, lnAuth } = req.body;
  
  try {
    // Support multiple auth methods
    let user;
    
    if (lnAuth) {
      // LNURL-auth requires cryptographic signature verification which is not yet implemented.
      // Allowing login without signature verification would let anyone impersonate any user.
      return res.status(501).json({ error: 'LNURL-auth is not yet implemented. Please use password authentication.' });
    } else {
      // Password auth
      user = await db('users').where('username', username).first();
      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    if (!user) return res.status(401).json({ error: 'User not found' });
    
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    // Update last login
    await db('users').where('id', user.id).update({
      last_login: new Date(),
      last_ip: req.ip
    });
    
    res.json({
      user: {
        id: user.id,
        username: user.username,
        ln_address: user.ln_address,
        wallet_type: user.wallet_type,
        escrow_balance_sats: user.escrow_balance_sats,
        nwc_budget_sats: user.nwc_budget_sats
      },
      token
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// =====================================================
// WALLET DETECTION & SETUP
// =====================================================

// Detect if LN address supports NWC
app.post('/api/wallet/detect', async (req, res) => {
  const { lnAddress } = req.body;
  
  try {
    // Try to resolve LN address
    const [username, domain] = lnAddress.split('@');
    
    // Fetch well-known NWC info
    try {
      const response = await fetch(`https://${domain}/.well-known/nostr-wallet-connect?user=${username}`);
      if (response.ok) {
        const nwcInfo = await response.json();
        return res.json({
          supportsNWC: true,
          nwcInfo,
          lnAddress,
          recommendedMode: 'nwc'
        });
      }
    } catch (e) {
      // Domain doesn't support NWC well-known
    }
    
    // Check if it's a known NWC-compatible provider
    const nwcProviders = ['getalby.com', 'bluewallet.io', 'blixtwallet.com'];
    const isNWCProvider = nwcProviders.some(p => domain.includes(p));
    
    // Check if it's a known non-NWC provider (WoS, Phoenix)
    const standardProviders = ['walletofsatoshi.com', 'phoenix.acinq.co'];
    const isStandardProvider = standardProviders.some(p => domain.includes(p));
    
    res.json({
      supportsNWC: isNWCProvider,
      lnAddress,
      provider: domain,
      recommendedMode: isNWCProvider ? 'nwc' : (isStandardProvider ? 'escrow' : 'escrow'),
      message: isNWCProvider 
        ? 'This wallet supports NWC! You can use instant P2P payments.'
        : 'This wallet works best with Escrow mode. Your funds will be held securely during gameplay.'
    });
  } catch (err) {
    res.status(400).json({ error: 'Invalid LN address' });
  }
});

// Connect NWC wallet
app.post('/api/wallet/nwc/connect', authenticate, async (req, res) => {
  const { nwcUri, budgetSats = 100000 } = req.body;
  const userId = req.user.userId;
  
  try {
    // Validate NWC URI format
    if (!nwcUri.startsWith('nostr+walletconnect://')) {
      return res.status(400).json({ error: 'Invalid NWC URI format' });
    }
    
    // Test the connection
    const { nwc: nwcSDK } = require('@getalby/sdk');
    const client = new nwcSDK.NWCClient({ nostrWalletConnectUrl: nwcUri });
    
    // Get wallet info
    const walletInfo = await client.getInfo();
    console.log('NWC Wallet connected:', walletInfo);
    
    // Encrypt NWC URI
    const encrypted = paymentRouter.encrypt(nwcUri);
    
    // Update user
    await db('users').where('id', userId).update({
      wallet_type: 'nwc',
      nwc_pubkey: walletInfo.pubkey || null,
      nwc_uri_encrypted: encrypted.encrypted,
      nwc_uri_iv: encrypted.iv,
      nwc_uri_auth_tag: encrypted.authTag,
      nwc_budget_sats: budgetSats,
      nwc_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h expiry
      nwc_last_used: new Date(),
      updated_at: new Date()
    });
    
    res.json({
      success: true,
      walletType: 'nwc',
      budgetSats,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      message: 'NWC wallet connected successfully!'
    });
  } catch (err) {
    console.error('NWC connection error:', err);
    res.status(400).json({ 
      error: 'Failed to connect NWC wallet',
      details: err.message
    });
  }
});

// Disconnect NWC
app.post('/api/wallet/nwc/disconnect', authenticate, async (req, res) => {
  const userId = req.user.userId;
  
  await db('users').where('id', userId).update({
    wallet_type: 'escrow',
    nwc_uri_encrypted: null,
    nwc_uri_iv: null,
    nwc_uri_auth_tag: null,
    nwc_pubkey: null,
    updated_at: new Date()
  });
  
  res.json({ success: true, message: 'NWC disconnected, switched to Escrow mode' });
});

// Get user balance (hybrid view)
app.get('/api/wallet/balance', authenticate, async (req, res) => {
  const userId = req.user.userId;
  
  try {
    const user = await db('users').where('id', userId).first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Get escrow balance
    const escrowBalance = user.escrow_balance_sats;
    
    // Get NWC 24h balance (virtual from transfers)
    const nwcBalance = await db('transfers')
      .where(function() {
        this.where('from_user_id', userId).orWhere('to_user_id', userId);
      })
      .where('payment_mode', 'nwc_direct')
      .where('status', 'completed')
      .where('created_at', '>', db.raw("NOW() - INTERVAL '24 hours'"))
      .sum({ total: db.raw("CASE WHEN to_user_id = ? THEN amount_sats ELSE -amount_sats END", [userId]) })
      .first();
    
    // Get pending withdrawals
    const pendingWithdrawals = await db('withdrawals')
      .where('user_id', userId)
      .whereIn('status', ['pending', 'processing'])
      .sum('amount_sats as total')
      .first();
    
    res.json({
      walletType: user.wallet_type,
      escrow: {
        balance: escrowBalance,
        locked: user.escrow_locked_sats,
        available: escrowBalance - user.escrow_locked_sats,
        pendingWithdrawal: pendingWithdrawals.total || 0
      },
      nwc: user.wallet_type === 'nwc' ? {
        budget24h: user.nwc_budget_sats,
        balance24h: nwcBalance.total || 0,
        remaining: user.nwc_budget_sats - (nwcBalance.total || 0),
        expiresAt: user.nwc_expires_at
      } : null,
      totalAvailable: escrowBalance - user.escrow_locked_sats + (nwcBalance.total || 0)
    });
  } catch (err) {
    console.error('Balance error:', err);
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// =====================================================
// ESCROW DEPOSITS & WITHDRAWALS
// =====================================================

// Create deposit invoice
app.post('/api/wallet/deposit', authenticate, async (req, res) => {
  const { amountSats, gameId } = req.body;
  const userId = req.user.userId;

  if (!lnd) {
    return res.status(503).json({ error: 'Deposits via Lightning are not available in NWC-only mode' });
  }

  try {
    // Create LND invoice
    const invoice = await lnd.addInvoice({
      value: amountSats,
      memo: gameId ? `Deposit for game ${gameId}` : 'Lightning Arena deposit',
      expiry: 3600 // 1 hour
    });
    
    // Record deposit
    await db('deposits').insert({
      user_id: userId,
      game_id: gameId || null,
      amount_sats: amountSats,
      payment_hash: invoice.r_hash.toString('hex'),
      payment_request: invoice.payment_request,
      status: 'pending',
      created_at: new Date(),
      expires_at: new Date(Date.now() + 3600000)
    });
    
    res.json({
      invoice: invoice.payment_request,
      paymentHash: invoice.r_hash.toString('hex'),
      amountSats,
      expiresAt: new Date(Date.now() + 3600000)
    });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Failed to create deposit invoice' });
  }
});

// Check deposit status
app.get('/api/wallet/deposit/:paymentHash', authenticate, async (req, res) => {
  const { paymentHash } = req.params;

  if (!lnd) {
    return res.status(503).json({ error: 'LND not available' });
  }

  try {
    const deposit = await db('deposits')
      .where('payment_hash', paymentHash)
      .first();

    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });

    // IDOR guard: users can only check their own deposits
    if (deposit.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Check LND if still pending
    if (deposit.status === 'pending') {
      const lookup = await lnd.lookupInvoice({ r_hash_str: paymentHash });
      
      if (lookup.settled) {
        // Payment received — use atomic update to prevent double-crediting on concurrent requests
        await db.transaction(async (trx) => {
          const updated = await trx('deposits')
            .where('id', deposit.id)
            .where('status', 'pending') // atomic guard: only one concurrent winner
            .update({
              status: 'paid',
              preimage: lookup.r_preimage.toString('hex'),
              paid_at: new Date()
            });

          if (updated === 0) {
            // Another concurrent request already processed this deposit
            return;
          }

          await trx('users')
            .where('id', deposit.user_id)
            .increment('escrow_balance_sats', deposit.amount_sats)
            .increment('escrow_total_deposited', deposit.amount_sats);
        });

        deposit.status = 'paid';
        
        // Notify user via WebSocket
        io.to(`user:${deposit.user_id}`).emit('deposit:confirmed', {
          paymentHash,
          amountSats: deposit.amount_sats
        });
      }
    }
    
    res.json({
      status: deposit.status,
      amountSats: deposit.amount_sats,
      paidAt: deposit.paid_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check deposit status' });
  }
});

// Request withdrawal
app.post('/api/wallet/withdraw', authenticate, async (req, res) => {
  const { amountSats, lnAddress } = req.body;
  const userId = req.user.userId;
  
  try {
    // Atomic check + deduction in a single UPDATE to prevent concurrent double-withdrawal
    const updated = await db('users')
      .where('id', userId)
      .where('escrow_balance_sats', '>=', amountSats)
      .update({
        escrow_balance_sats: db.raw('escrow_balance_sats - ?', [amountSats]),
        escrow_locked_sats: db.raw('escrow_locked_sats + ?', [amountSats])
      });

    if (updated === 0) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Create withdrawal record
    const [withdrawal] = await db('withdrawals').insert({
      user_id: userId,
      amount_sats: amountSats,
      destination_ln_address: lnAddress,
      status: 'pending',
      created_at: new Date()
    }).returning('id');
    
    // Process async (don't wait for payment)
    processWithdrawal(withdrawal.id);
    
    res.json({
      withdrawalId: withdrawal.id,
      status: 'pending',
      amountSats,
      destination: lnAddress
    });
  } catch (err) {
    res.status(500).json({ error: 'Withdrawal request failed' });
  }
});

async function processWithdrawal(withdrawalId) {
  try {
    const withdrawal = await db('withdrawals').where('id', withdrawalId).first();
    if (!withdrawal) return;

    // Guard: LND required to send payments
    if (!lnd) {
      throw new Error('LND not available — cannot process withdrawal');
    }

    // Update status
    await db('withdrawals').where('id', withdrawalId).update({ status: 'processing' });

    // Resolve LN address to invoice
    // This is simplified - real implementation needs LNURL-pay resolution
    const [username, domain] = withdrawal.destination_ln_address.split('@');

    // Fetch LNURL-pay endpoint
    const lnurlResponse = await fetch(`https://${domain}/.well-known/lnurlp/${username}`);
    const lnurlData = await lnurlResponse.json();

    // Request invoice
    const callbackUrl = new URL(lnurlData.callback);
    callbackUrl.searchParams.set('amount', withdrawal.amount_sats * 1000);

    const invoiceResponse = await fetch(callbackUrl.toString());
    const invoiceData = await invoiceResponse.json();

    // Pay via LND
    const payment = await lnd.sendPaymentSync({
      payment_request: invoiceData.pr,
      timeout_seconds: 60,
      fee_limit_sat: Math.ceil(withdrawal.amount_sats * 0.01) // 1% max fee
    });
    
    if (payment.payment_error) {
      throw new Error(payment.payment_error);
    }
    
    // Success
    await db.transaction(async (trx) => {
      await trx('withdrawals').where('id', withdrawalId).update({
        status: 'completed',
        payment_hash: payment.payment_hash,
        preimage: payment.payment_preimage.toString('hex'),
        lnd_payment_id: payment.payment_hash,
        completed_at: new Date()
      });
      
      await trx('users').where('id', withdrawal.user_id).update({
        escrow_locked_sats: db.raw('escrow_locked_sats - ?', [withdrawal.amount_sats]),
        escrow_total_withdrawn: db.raw('escrow_total_withdrawn + ?', [withdrawal.amount_sats])
      });
    });
    
    // Notify user
    io.to(`user:${withdrawal.user_id}`).emit('withdrawal:completed', {
      withdrawalId: withdrawal.id,
      amountSats: withdrawal.amount_sats
    });
    
  } catch (err) {
    console.error('Withdrawal processing error:', err);
    
    // Refund locked balance
    await db.transaction(async (trx) => {
      await trx('withdrawals').where('id', withdrawalId).update({
        status: 'failed',
        error_message: err.message
      });
      
      const withdrawal = await trx('withdrawals').where('id', withdrawalId).first();
      
      await trx('users').where('id', withdrawal.user_id).update({
        escrow_balance_sats: db.raw('escrow_balance_sats + ?', [withdrawal.amount_sats]),
        escrow_locked_sats: db.raw('escrow_locked_sats - ?', [withdrawal.amount_sats])
      });
    });
  }
}

// =====================================================
// GAME ROUTES
// =====================================================

// Create game room
app.post('/api/games', authenticate, async (req, res) => {
  const { buyInSats = 10000, maxPlayers = 4, gameMode = 'ffa' } = req.body;
  const userId = req.user.userId;
  
  try {
    const roomCode = generateRoomCode();
    
    const [game] = await db('games').insert({
      room_code: roomCode,
      host_id: userId,
      status: 'lobby',
      game_mode: gameMode,
      buy_in_sats: buyInSats,
      max_players: maxPlayers,
      server_fee_percent: 1.0,
      total_pot_sats: 0,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours
    }).returning('*');
    
    res.status(201).json({
      gameId: game.id,
      roomCode: game.room_code,
      status: game.status,
      buyInSats,
      maxPlayers
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create game' });
  }
});

// Join game
app.post('/api/games/:roomCode/join', authenticate, async (req, res) => {
  const { roomCode } = req.params;
  const userId = req.user.userId;

  try {
    const [user, game] = await Promise.all([
      db('users').where('id', userId).first(),
      db('games').where('room_code', roomCode).first()
    ]);

    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.status !== 'lobby') return res.status(400).json({ error: 'Game already started' });

    // Check if already joined
    const existing = await db('game_participants')
      .where({ game_id: game.id, user_id: userId })
      .first();

    if (existing) {
      return res.json({ message: 'Already joined', participantId: existing.id });
    }

    // Lock buy-in atomically (same pattern as withdrawal to prevent double-join race condition)
    if (user.wallet_type === 'escrow') {
      const locked = await db('users')
        .where('id', userId)
        .where('escrow_balance_sats', '>=', game.buy_in_sats)
        .update({
          escrow_balance_sats: db.raw('escrow_balance_sats - ?', [game.buy_in_sats]),
          escrow_locked_sats: db.raw('escrow_locked_sats + ?', [game.buy_in_sats])
        });

      if (locked === 0) {
        return res.status(400).json({
          error: 'Insufficient balance',
          requiredSats: game.buy_in_sats
        });
      }
    }
    
    // Add participant
    const [participant] = await db('game_participants').insert({
      game_id: game.id,
      user_id: userId,
      player_name: user.username,
      initial_balance: game.buy_in_sats,
      status: 'active',
      joined_at: new Date()
    }).returning('id');
    
    // Update game pot
    await db('games').where('id', game.id).update({
      total_pot_sats: db.raw('total_pot_sats + ?', [game.buy_in_sats])
    });
    
    // Join socket room
    io.to(`game:${game.id}`).emit('player:joined', {
      userId,
      username: user.username,
      walletType: user.wallet_type
    });
    
    res.json({
      participantId: participant.id,
      gameId: game.id,
      message: 'Joined successfully'
    });
  } catch (err) {
    console.error('Join error:', err);
    res.status(500).json({ error: 'Failed to join game' });
  }
});

// =====================================================
// PAYMENT ROUTES (The Core)
// =====================================================

// Execute payment (called by game server)
app.post('/api/payments/execute', authenticate, async (req, res) => {
  const { gameId, fromUserId, toUserId, amount, weapon, reason } = req.body;

  // Authorization: only the payer themselves can trigger a payment from their account
  if (parseInt(fromUserId) !== req.user.userId) {
    return res.status(403).json({ error: 'Cannot initiate payment on behalf of another user' });
  }

  try {
    const result = await paymentRouter.executeTransfer({
      gameId,
      fromUserId,
      toUserId,
      amount,
      weapon,
      reason
    });
    
    res.json(result);
  } catch (err) {
    console.error('Payment execution error:', err);
    res.status(500).json({ 
      error: 'Payment failed',
      message: err.message
    });
  }
});

// Get transfer history
app.get('/api/payments/history', authenticate, async (req, res) => {
  const userId = req.user.userId;
  const { limit = 50, offset = 0 } = req.query;
  
  try {
    const transfers = await db('transfers')
      .where('from_user_id', userId)
      .orWhere('to_user_id', userId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .select('*');
    
    res.json(transfers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// =====================================================
// WEBSOCKET HANDLING
// =====================================================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Authenticate socket
  socket.on('auth', (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.join(`user:${decoded.userId}`);
      socket.emit('auth:success', { userId: decoded.userId });
    } catch (err) {
      socket.emit('auth:error', { error: 'Invalid token' });
    }
  });
  
  // Join game room — requires authenticated socket + active participation
  socket.on('game:join', async (gameId) => {
    if (!socket.userId) {
      socket.emit('error', { message: 'Authentication required before joining a game room' });
      return;
    }

    try {
      const participant = await db('game_participants')
        .where({ game_id: gameId, user_id: socket.userId })
        .first();

      if (!participant) {
        socket.emit('error', { message: 'You are not a participant of this game' });
        return;
      }

      socket.join(`game:${gameId}`);
      console.log(`Socket ${socket.id} (user ${socket.userId}) joined game ${gameId}`);
    } catch (err) {
      console.error('game:join socket error:', err);
    }
  });
  
  // Handle game events
  socket.on('game:hit', async (data) => {
    const { gameId, victimId, hitterId, weapon, damage } = data;

    // Only the authenticated hitter can emit their own hit events
    if (!socket.userId || socket.userId !== hitterId) {
      socket.emit('error', { message: 'Unauthorized: hitter mismatch' });
      return;
    }

    // Validate damage bounds
    if (typeof damage !== 'number' || damage <= 0 || damage > 1000) {
      socket.emit('error', { message: 'Invalid damage value' });
      return;
    }

    try {
      // Verify both players are active participants in this game
      const participants = await db('game_participants')
        .where('game_id', gameId)
        .whereIn('user_id', [hitterId, victimId])
        .where('status', 'active')
        .select('user_id');

      if (participants.length < 2) {
        socket.emit('error', { message: 'Invalid game participants' });
        return;
      }

      io.to(`game:${gameId}`).emit('game:hit', {
        victimId,
        hitterId,
        weapon,
        damage,
        timestamp: Date.now()
      });
    } catch (err) {
      console.error('game:hit error:', err);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// =====================================================
// HEALTH & UTILITIES
// =====================================================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db('games')
      .select(
        db.raw('COUNT(*) as total_games'),
        db.raw("COUNT(CASE WHEN status = 'playing' THEN 1 END) as active_games"),
        db.raw('SUM(CASE WHEN status = \'finished\' THEN total_pot_sats END) as total_volume_sats')
      )
      .first();
    
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0, O, 1, I
  const bytes = require('crypto').randomBytes(6);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// =====================================================
// START SERVER
// =====================================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     ⚡ LIGHTNING ARENA SERVER v1.0.0 ⚡                   ║
║     Hybrid NWC + Escrow Payment Infrastructure           ║
╠══════════════════════════════════════════════════════════╣
║  Port:        ${PORT.toString().padEnd(44)} ║
║  Database:    ${(process.env.DB_HOST || 'localhost').padEnd(44)} ║
║  Redis:       ${(process.env.REDIS_URL || 'localhost:6379').padEnd(44)} ║
║  LND:         ${(process.env.LND_GRPC_HOST || 'Not configured').padEnd(44)} ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
