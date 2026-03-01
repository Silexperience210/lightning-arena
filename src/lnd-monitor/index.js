#!/usr/bin/env node
/**
 * LND Invoice Monitor
 * Listens for incoming payments and notifies API
 */

const { createLightningClient } = require('../lnd-client');
const redis = require('redis');

async function startMonitor() {
  const lnd = createLightningClient({
    server: process.env.LND_HOST || 'localhost:10009',
    macaroonPath: '/app/lnd/admin.macaroon',
    tlsCertPath: '/app/lnd/tls.cert'
  });

  const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });
  await redisClient.connect();

  console.log('[LND-Monitor] Starting invoice subscription...');

  const stream = lnd.subscribeInvoices({});

  stream.on('data', async (invoice) => {
    if (invoice.settled) {
      const paymentHash = invoice.r_hash.toString('hex');
      console.log(`[LND-Monitor] Payment received: ${paymentHash}`);
      
      // Publish to Redis for API to handle
      await redisClient.publish('invoice:settled', JSON.stringify({
        paymentHash,
        amtPaidSat: parseInt(invoice.amt_paid_sat),
        settleIndex: invoice.settle_index
      }));
    }
  });

  stream.on('error', (err) => {
    console.error('[LND-Monitor] Stream error:', err);
    process.exit(1);
  });

  stream.on('end', () => {
    console.log('[LND-Monitor] Stream ended, restarting...');
    setTimeout(startMonitor, 5000);
  });
}

startMonitor().catch(console.error);
