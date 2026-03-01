#!/usr/bin/env node
/**
 * Background Worker for Lightning Arena
 * Handles: Payment retries, Expired cleanup, Withdrawal processing
 */

require('dotenv').config();

const knex = require('knex');
const redis = require('redis');
const { createLightningClient } = require('./lnd-client');
const PaymentRouter = require('./PaymentRouter');

// Initialize connections
const db = knex({
  client: 'postgresql',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'lightning',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'lightning_arena'
  }
});

const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

const lnd = createLightningClient({
  server: process.env.LND_GRPC_HOST,
  macaroonPath: process.env.LND_MACAROON_PATH,
  tlsCertPath: process.env.LND_TLS_CERT_PATH
});

const paymentRouter = new PaymentRouter({ db, lnd, redis: redisClient });

// Worker state
const workerState = {
  isRunning: true,
  lastHeartbeat: Date.now()
};

// =====================================================
// JOB HANDLERS
// =====================================================

/**
 * Retry failed/pending transfers
 */
async function retryFailedTransfers() {
  try {
    const pending = await db('transfers')
      .whereIn('status', ['pending', 'failed'])
      .where('retry_count', '<', 3)
      .where('expires_at', '>', new Date())
      .where('created_at', '>', new Date(Date.now() - 600000))
      .select('*');

    for (const transfer of pending) {
      console.log(`[Worker] Retrying transfer ${transfer.id}`);
      
      try {
        await paymentRouter.executeTransfer({
          gameId: transfer.game_id,
          fromUserId: transfer.from_user_id,
          toUserId: transfer.to_user_id,
          amount: transfer.amount_sats,
          weapon: transfer.weapon_type,
          reason: `Retry attempt ${transfer.retry_count + 1}`
        });
        
        console.log(`[Worker] Transfer ${transfer.id} succeeded on retry`);
      } catch (err) {
        await db('transfers')
          .where('id', transfer.id)
          .update({
            retry_count: db.raw('retry_count + 1'),
            last_error: err.message
          });
      }
    }
  } catch (err) {
    console.error('[Worker] Retry job error:', err);
  }
}

/**
 * Cleanup expired deposits and transfers
 */
async function cleanupExpired() {
  try {
    // Expire old pending deposits
    const expiredDeposits = await db('deposits')
      .where('status', 'pending')
      .where('expires_at', '<', new Date())
      .update({ status: 'expired' })
      .returning('id');
    
    if (expiredDeposits.length > 0) {
      console.log(`[Worker] Expired ${expiredDeposits.length} deposits`);
    }

    // Expire old pending transfers
    const expiredTransfers = await db('transfers')
      .where('status', 'pending')
      .where('expires_at', '<', new Date())
      .update({ status: 'expired' })
      .returning('id');
    
    if (expiredTransfers.length > 0) {
      console.log(`[Worker] Expired ${expiredTransfers.length} transfers`);
    }

    // Cleanup old game rooms (older than 2 hours, still in lobby)
    const oldGames = await db('games')
      .where('status', 'lobby')
      .where('created_at', '<', new Date(Date.now() - 2 * 60 * 60 * 1000))
      .update({ status: 'cancelled' })
      .returning('id');
    
    if (oldGames.length > 0) {
      console.log(`[Worker] Cancelled ${oldGames.length} stale game rooms`);
    }
  } catch (err) {
    console.error('[Worker] Cleanup error:', err);
  }
}

/**
 * Process pending withdrawals
 */
async function processWithdrawals() {
  try {
    const pending = await db('withdrawals')
      .where('status', 'pending')
      .where('retry_count', '<', 3)
      .orderBy('created_at', 'asc')
      .limit(10)
      .select('*');

    for (const withdrawal of pending) {
      console.log(`[Worker] Processing withdrawal ${withdrawal.id}`);
      
      try {
        // Update to processing
        await db('withdrawals')
          .where('id', withdrawal.id)
          .update({ status: 'processing' });

        // Resolve LN address and pay
        // Simplified - real implementation needs full LNURL resolution
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
          fee_limit_sat: Math.ceil(withdrawal.amount_sats * 0.01)
        });

        if (payment.payment_error) {
          throw new Error(payment.payment_error);
        }

        // Success - update records
        await db.transaction(async (trx) => {
          await trx('withdrawals')
            .where('id', withdrawal.id)
            .update({
              status: 'completed',
              payment_hash: payment.payment_hash,
              preimage: payment.payment_preimage.toString('hex'),
              lnd_payment_id: payment.payment_hash,
              completed_at: new Date()
            });

          await trx('users')
            .where('id', withdrawal.user_id)
            .decrement('escrow_locked_sats', withdrawal.amount_sats)
            .increment('escrow_total_withdrawn', withdrawal.amount_sats);
        });

        console.log(`[Worker] Withdrawal ${withdrawal.id} completed`);
        
      } catch (err) {
        console.error(`[Worker] Withdrawal ${withdrawal.id} failed:`, err.message);
        
        // Refund if max retries reached
        const newRetryCount = withdrawal.retry_count + 1;
        
        if (newRetryCount >= 3) {
          // Refund to user balance
          await db.transaction(async (trx) => {
            await trx('withdrawals')
              .where('id', withdrawal.id)
              .update({
                status: 'failed',
                error_message: err.message,
                retry_count: newRetryCount
              });

            await trx('users')
              .where('id', withdrawal.user_id)
              .increment('escrow_balance_sats', withdrawal.amount_sats)
              .decrement('escrow_locked_sats', withdrawal.amount_sats);
          });
          
          console.log(`[Worker] Withdrawal ${withdrawal.id} refunded after max retries`);
        } else {
          await db('withdrawals')
            .where('id', withdrawal.id)
            .update({
              retry_count: newRetryCount,
              error_message: err.message
            });
        }
      }
    }
  } catch (err) {
    console.error('[Worker] Withdrawal processing error:', err);
  }
}

/**
 * Send heartbeat to Redis
 */
async function sendHeartbeat() {
  try {
    await redisClient.setEx('worker:heartbeat', 60, JSON.stringify({
      timestamp: Date.now(),
      status: 'healthy'
    }));
    workerState.lastHeartbeat = Date.now();
  } catch (err) {
    console.error('[Worker] Heartbeat failed:', err);
  }
}

// =====================================================
// MAIN WORKER LOOP
// =====================================================

async function startWorker() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║     LIGHTNING ARENA - Background Worker        ║');
  console.log('╚════════════════════════════════════════════════╝');
  
  // Connect to Redis
  await redisClient.connect();
  console.log('[Worker] Connected to Redis');
  
  // Job schedules (in milliseconds)
  const schedules = {
    retry: 5000,      // Every 5 seconds
    cleanup: 60000,   // Every minute
    withdrawal: 10000, // Every 10 seconds
    heartbeat: 30000  // Every 30 seconds
  };

  let lastRun = {
    retry: 0,
    cleanup: 0,
    withdrawal: 0,
    heartbeat: 0
  };

  console.log('[Worker] Starting main loop...');

  while (workerState.isRunning) {
    const now = Date.now();

    // Retry failed transfers
    if (now - lastRun.retry >= schedules.retry) {
      await retryFailedTransfers();
      lastRun.retry = now;
    }

    // Process withdrawals
    if (now - lastRun.withdrawal >= schedules.withdrawal) {
      await processWithdrawals();
      lastRun.withdrawal = now;
    }

    // Cleanup expired
    if (now - lastRun.cleanup >= schedules.cleanup) {
      await cleanupExpired();
      lastRun.cleanup = now;
    }

    // Send heartbeat
    if (now - lastRun.heartbeat >= schedules.heartbeat) {
      await sendHeartbeat();
      lastRun.heartbeat = now;
    }

    // Small delay to prevent CPU spinning
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Worker] SIGTERM received, shutting down...');
  workerState.isRunning = false;
  await db.destroy();
  await redisClient.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Worker] SIGINT received, shutting down...');
  workerState.isRunning = false;
  await db.destroy();
  await redisClient.quit();
  process.exit(0);
});

// Start
startWorker().catch(err => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
