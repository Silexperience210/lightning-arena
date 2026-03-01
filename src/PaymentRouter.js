// =====================================================
// PAYMENT ROUTER - Hybrid NWC + Escrow Architecture
// Bitcoin Maximalist Design - Zero Custody
// =====================================================

const { nwc } = require('@getalby/sdk');
const crypto = require('crypto');
const EventEmitter = require('events');

class PaymentRouter extends EventEmitter {
  constructor(config) {
    super();
    this.db = config.db;
    this.lnd = config.lnd; // LND gRPC client
    this.redis = config.redis;
    
    // Encryption key for NWC URIs (must be 32 bytes)
    this.encryptionKey = Buffer.from(process.env.NWC_ENCRYPTION_KEY, 'hex');
    
    // Configuration
    this.config = {
      maxRetries: 3,
      retryDelayMs: 2000,
      paymentTimeoutMs: 30000,
      nwcDefaultBudget: 100000, // 100k sats daily
      feePercent: 1.0, // 1% server fee
      ...config.options
    };
    
    // Active NWC connections cache
    this.nwcConnections = new Map();
    
    // Start background workers
    this.startRetryWorker();
    this.startCleanupWorker();
  }

  // =====================================================
  // CORE: Route Determination (The Brain)
  // =====================================================
  
  async determineOptimalRoute(fromUserId, toUserId) {
    const fromUser = await this.getUserWithDecryptedNWC(fromUserId);
    const toUser = await this.getUserWithDecryptedNWC(toUserId);
    
    if (!fromUser || !toUser) {
      throw new Error('User not found');
    }
    
    const fromHasNWC = this.isNWCValid(fromUser);
    const toHasNWC = this.isNWCValid(toUser);
    
    // Route decision matrix
    if (fromHasNWC && toHasNWC) {
      return {
        type: 'NWC_P2P',
        fromMode: 'nwc',
        toMode: 'nwc',
        fee: 0,
        speed: 'instant',
        description: 'Direct P2P via NWC'
      };
    }
    
    if (!fromHasNWC && !toHasNWC) {
      return {
        type: 'ESCROW_INTERNAL',
        fromMode: 'escrow',
        toMode: 'escrow',
        fee: 0,
        speed: 'virtual',
        description: 'Internal ledger update'
      };
    }
    
    if (fromHasNWC && !toHasNWC) {
      return {
        type: 'HYBRID_NWC_TO_ESCROW',
        fromMode: 'nwc',
        toMode: 'escrow',
        fee: 0,
        speed: 'mixed',
        description: 'NWC payer to Escrow receiver'
      };
    }
    
    return {
      type: 'HYBRID_ESCROW_TO_NWC',
      fromMode: 'escrow',
      toMode: 'nwc',
      fee: 0,
      speed: 'mixed',
      description: 'Escrow payer to NWC receiver'
    };
  }

  // =====================================================
  // CORE: Execute Transfer (The Heart)
  // =====================================================
  
  async executeTransfer(transferData) {
    const { gameId, fromUserId, toUserId, amount, weapon, reason } = transferData;
    
    // Validate
    if (amount <= 0) throw new Error('Invalid amount');
    if (fromUserId === toUserId) throw new Error('Self-transfer not allowed');
    
    // Determine route
    const route = await this.determineOptimalRoute(fromUserId, toUserId);
    console.log(`[PaymentRouter] Route: ${route.type} | ${amount}sats | ${route.description}`);
    
    // Create transfer record
    const transferId = await this.createTransferRecord({
      gameId,
      fromUserId,
      toUserId,
      amount,
      weapon,
      reason,
      paymentMode: this.mapRouteToPaymentMode(route.type),
      status: 'pending'
    });
    
    try {
      let result;
      
      switch (route.type) {
        case 'NWC_P2P':
          result = await this.executeNWCP2P(transferId, fromUserId, toUserId, amount, reason);
          break;
          
        case 'ESCROW_INTERNAL':
          result = await this.executeEscrowInternal(transferId, fromUserId, toUserId, amount);
          break;
          
        case 'HYBRID_NWC_TO_ESCROW':
          result = await this.executeHybridNWCToEscrow(transferId, fromUserId, toUserId, amount, reason);
          break;
          
        case 'HYBRID_ESCROW_TO_NWC':
          result = await this.executeHybridEscrowToNWC(transferId, fromUserId, toUserId, amount, reason);
          break;
          
        default:
          throw new Error(`Unknown route type: ${route.type}`);
      }
      
      // Emit event for real-time updates
      this.emit('transferCompleted', {
        transferId,
        gameId,
        from: fromUserId,
        to: toUserId,
        amount,
        mode: route.type,
        tx: result.tx
      });
      
      return {
        success: true,
        transferId,
        mode: route.type,
        ...result
      };
      
    } catch (error) {
      console.error(`[PaymentRouter] Transfer failed:`, error);
      await this.markTransferFailed(transferId, error.message);
      
      // Attempt fallback for NWC failures
      if (route.type.startsWith('NWC') || route.type.startsWith('HYBRID')) {
        console.log(`[Fallback] Attempting escrow fallback for ${transferId}`);
        return this.executeEscrowFallback(transferId, fromUserId, toUserId, amount);
      }
      
      throw error;
    }
  }

  // =====================================================
  // MODE 1: NWC P2P (Both players have NWC)
  // =====================================================
  
  async executeNWCP2P(transferId, fromUserId, toUserId, amount, description) {
    const fromUser = await this.getUserWithDecryptedNWC(fromUserId);
    const toUser = await this.getUserWithDecryptedNWC(toUserId);
    
    // Step 1: Receiver creates invoice
    const toNWC = this.getNWCClient(toUser.nwc_uri_decrypted);
    
    const invoiceResult = await toNWC.makeInvoice({
      amount: amount * 1000, // millisats
      description: description || `Lightning Arena - Payment from ${fromUser.username}`,
      expiry: 120 // 2 minutes
    });
    
    console.log(`[NWC_P2P] Invoice created by receiver: ${invoiceResult.invoice.substring(0, 50)}...`);
    
    // Step 2: Payer pays the invoice
    const fromNWC = this.getNWCClient(fromUser.nwc_uri_decrypted);
    
    const paymentResult = await fromNWC.payInvoice({
      invoice: invoiceResult.invoice,
      amount: amount * 1000
    });
    
    if (!paymentResult.preimage) {
      throw new Error('Payment failed - no preimage received');
    }
    
    console.log(`[NWC_P2P] Payment successful: ${paymentResult.preimage.substring(0, 20)}...`);
    
    // Step 3: Record success
    await this.db('transfers')
      .where('id', transferId)
      .update({
        status: 'completed',
        preimage: paymentResult.preimage,
        payment_hash: paymentResult.payment_hash,
        invoice_request: invoiceResult.invoice,
        completed_at: new Date()
      });
    
    return {
      tx: paymentResult.preimage,
      paymentHash: paymentResult.payment_hash,
      mode: 'nwc_p2p'
    };
  }

  // =====================================================
  // MODE 2: Escrow Internal (Virtual ledger)
  // =====================================================
  
  async executeEscrowInternal(transferId, fromUserId, toUserId, amount) {
    // Atomic transaction
    await this.db.transaction(async (trx) => {
      // Check balance
      const fromBalance = await trx('users')
        .where('id', fromUserId)
        .select('escrow_balance_sats')
        .first();
      
      if (fromBalance.escrow_balance_sats < amount) {
        throw new Error('Insufficient escrow balance');
      }
      
      // Debit payer
      await trx('users')
        .where('id', fromUserId)
        .decrement('escrow_balance_sats', amount);
      
      // Credit receiver
      await trx('users')
        .where('id', toUserId)
        .increment('escrow_balance_sats', amount);
      
      // Mark transfer complete
      await trx('transfers')
        .where('id', transferId)
        .update({
          status: 'completed',
          completed_at: new Date()
        });
    });
    
    console.log(`[Escrow] Internal transfer completed: ${transferId}`);
    
    return {
      tx: transferId, // Use transfer ID as virtual tx reference
      mode: 'escrow_internal'
    };
  }

  // =====================================================
  // MODE 3: Hybrid NWC → Escrow
  // =====================================================
  
  async executeHybridNWCToEscrow(transferId, fromUserId, toUserId, amount, description) {
    const fromUser = await this.getUserWithDecryptedNWC(fromUserId);
    
    // Create invoice to server's LND node
    const invoice = await this.lnd.addInvoice({
      value: amount,
      memo: description || `Hybrid: ${fromUser.username} → Escrow user`,
      expiry: 120
    });
    
    // Have the NWC user pay it
    const fromNWC = this.getNWCClient(fromUser.nwc_uri_decrypted);
    
    const payment = await fromNWC.payInvoice({
      invoice: invoice.payment_request,
      amount: amount * 1000
    });
    
    if (!payment.preimage) {
      throw new Error('Hybrid payment failed');
    }
    
    // Credit the escrow user immediately
    await this.db('users')
      .where('id', toUserId)
      .increment('escrow_balance_sats', amount);
    
    // Record
    await this.db('transfers')
      .where('id', transferId)
      .update({
        status: 'completed',
        preimage: payment.preimage,
        payment_hash: payment.payment_hash,
        completed_at: new Date()
      });
    
    return {
      tx: payment.preimage,
      mode: 'hybrid_nwc_to_escrow'
    };
  }

  // =====================================================
  // MODE 4: Hybrid Escrow → NWC
  // =====================================================
  
  async executeHybridEscrowToNWC(transferId, fromUserId, toUserId, amount, description) {
    const toUser = await this.getUserWithDecryptedNWC(toUserId);
    
    // Check escrow balance
    const fromUser = await this.db('users')
      .where('id', fromUserId)
      .select('escrow_balance_sats', 'username')
      .first();
    
    if (fromUser.escrow_balance_sats < amount) {
      throw new Error('Insufficient escrow balance for hybrid payment');
    }
    
    // Get invoice from NWC receiver
    const toNWC = this.getNWCClient(toUser.nwc_uri_decrypted);
    
    const invoiceResult = await toNWC.makeInvoice({
      amount: amount * 1000,
      description: description || `Payment from ${fromUser.username}`,
      expiry: 120
    });
    
    // Pay via LND
    const payment = await this.lnd.sendPaymentSync({
      payment_request: invoiceResult.invoice,
      timeout_seconds: 60
    });
    
    if (payment.payment_error) {
      throw new Error(`LND payment failed: ${payment.payment_error}`);
    }
    
    // Debit escrow
    await this.db('users')
      .where('id', fromUserId)
      .decrement('escrow_balance_sats', amount);
    
    // Record
    await this.db('transfers')
      .where('id', transferId)
      .update({
        status: 'completed',
        preimage: payment.payment_preimage.toString('hex'),
        payment_hash: payment.payment_hash,
        lnd_tx_id: payment.payment_hash,
        completed_at: new Date()
      });
    
    return {
      tx: payment.payment_preimage.toString('hex'),
      mode: 'hybrid_escrow_to_nwc'
    };
  }

  // =====================================================
  // FALLBACK: Escrow when NWC fails
  // =====================================================
  
  async executeEscrowFallback(transferId, fromUserId, toUserId, amount) {
    console.log(`[Fallback] Executing escrow fallback for transfer ${transferId}`);
    
    try {
      // Try internal escrow
      await this.executeEscrowInternal(transferId, fromUserId, toUserId, amount);
      
      // Update the transfer record to show it was a fallback
      await this.db('transfers')
        .where('id', transferId)
        .update({
          payment_mode: 'ESCROW_INTERNAL', // Override the original mode
          note: 'NWC fallback to escrow'
        });
      
      return {
        success: true,
        mode: 'escrow_fallback',
        fallback: true
      };
    } catch (escrowError) {
      console.error(`[Fallback] Escrow fallback also failed:`, escrowError);
      throw new Error('Both NWC and escrow payment failed');
    }
  }

  // =====================================================
  // UTILITY METHODS
  // =====================================================
  
  isNWCValid(user) {
    if (!user || user.wallet_type !== 'nwc') return false;
    if (!user.nwc_uri_decrypted) return false;
    if (user.nwc_expires_at && new Date(user.nwc_expires_at) < new Date()) return false;
    if (user.is_banned) return false;
    return true;
  }
  
  getNWCClient(nwcUri) {
    // Cache NWC clients to avoid reconnecting
    const cached = this.nwcConnections.get(nwcUri);
    if (cached && Date.now() - cached.created < 300000) { // 5 min cache
      return cached.client;
    }
    
    const client = new nwc.NWCClient({
      nostrWalletConnectUrl: nwcUri
    });
    
    this.nwcConnections.set(nwcUri, {
      client,
      created: Date.now()
    });
    
    return client;
  }
  
  async getUserWithDecryptedNWC(userId) {
    const user = await this.db('users')
      .where('id', userId)
      .first();
    
    if (!user) return null;
    
    // Decrypt NWC URI if present
    if (user.nwc_uri_encrypted) {
      try {
        user.nwc_uri_decrypted = this.decrypt(
          user.nwc_uri_encrypted,
          user.nwc_uri_iv,
          user.nwc_uri_auth_tag
        );
      } catch (err) {
        console.error(`Failed to decrypt NWC URI for user ${userId}:`, err);
        user.nwc_uri_decrypted = null;
      }
    }
    
    return user;
  }
  
  encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex')
    };
  }
  
  decrypt(encrypted, iv, authTag) {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  mapRouteToPaymentMode(routeType) {
    const mapping = {
      'NWC_P2P': 'nwc_direct',
      'ESCROW_INTERNAL': 'escrow_internal',
      'HYBRID_NWC_TO_ESCROW': 'hybrid_nwc_to_escrow',
      'HYBRID_ESCROW_TO_NWC': 'hybrid_escrow_to_nwc'
    };
    return mapping[routeType] || 'unknown';
  }
  
  async createTransferRecord(data) {
    const [id] = await this.db('transfers').insert({
      game_id: data.gameId,
      from_user_id: data.fromUserId,
      to_user_id: data.toUserId,
      amount_sats: data.amount,
      weapon_type: data.weapon,
      reason: data.reason,
      payment_mode: data.paymentMode,
      status: data.status,
      created_at: new Date(),
      expires_at: new Date(Date.now() + this.config.paymentTimeoutMs)
    }).returning('id');
    
    return id;
  }
  
  async markTransferFailed(transferId, error) {
    await this.db('transfers')
      .where('id', transferId)
      .update({
        status: 'failed',
        last_error: error,
        retry_count: this.db.raw('retry_count + 1')
      });
  }
  
  // =====================================================
  // BACKGROUND WORKERS
  // =====================================================
  
  startRetryWorker() {
    setInterval(async () => {
      try {
        const pending = await this.db('transfers')
          .whereIn('status', ['pending', 'failed'])
          .where('retry_count', '<', this.config.maxRetries)
          .where('expires_at', '>', new Date())
          .where('created_at', '>', new Date(Date.now() - 600000)) // 10 min max
          .select('*');
        
        for (const transfer of pending) {
          console.log(`[RetryWorker] Retrying transfer ${transfer.id}`);
          
          try {
            await this.executeTransfer({
              gameId: transfer.game_id,
              fromUserId: transfer.from_user_id,
              toUserId: transfer.to_user_id,
              amount: transfer.amount_sats,
              weapon: transfer.weapon_type,
              reason: 'Retry: ' + transfer.reason
            });
          } catch (retryErr) {
            console.error(`[RetryWorker] Retry failed for ${transfer.id}:`, retryErr.message);
          }
        }
      } catch (err) {
        console.error('[RetryWorker] Error:', err);
      }
    }, this.config.retryDelayMs);
  }
  
  startCleanupWorker() {
    setInterval(async () => {
      try {
        // Expire old pending transfers
        await this.db('transfers')
          .where('status', 'pending')
          .where('expires_at', '<', new Date())
          .update({ status: 'expired' });
        
        // Clear old NWC connection cache
        const now = Date.now();
        for (const [uri, data] of this.nwcConnections) {
          if (now - data.created > 600000) { // 10 min
            this.nwcConnections.delete(uri);
          }
        }
      } catch (err) {
        console.error('[CleanupWorker] Error:', err);
      }
    }, 60000); // Every minute
  }
}

module.exports = PaymentRouter;
