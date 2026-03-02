// =====================================================
// PAYMENT ROUTER v2.1 - SIMPLIFIED NWC
// NWC gère les budgets natifs, le serveur orchestre seulement
// =====================================================

const { nwc } = require('@getalby/sdk');
const crypto = require('crypto');
const EventEmitter = require('events');

class PaymentRouter extends EventEmitter {
  constructor(config) {
    super();
    this.db = config.db;
    this.lnd = config.lnd;
    this.redis = config.redis;
    
    this.lndEnabled = config.lnd && process.env.LND_ENABLED !== 'false';
    
    this.encryptionKey = Buffer.from(process.env.NWC_ENCRYPTION_KEY, 'hex');
    
    this.config = {
      maxRetries: 3,
      retryDelayMs: 2000,
      paymentTimeoutMs: 30000,
      ...config.options
    };
    
    this.nwcConnections = new Map();
    
    this.startRetryWorker();
    this.startCleanupWorker();
  }

  // =====================================================
  // CORE: Route Determination
  // =====================================================
  
  async determineOptimalRoute(fromUserId, toUserId) {
    const fromUser = await this.getUserWithDecryptedNWC(fromUserId);
    const toUser = await this.getUserWithDecryptedNWC(toUserId);
    
    if (!fromUser || !toUser) {
      throw new Error('User not found');
    }
    
    const fromHasNWC = this.isNWCValid(fromUser);
    const toHasNWC = this.isNWCValid(toUser);
    
    if (fromHasNWC && toHasNWC) {
      return {
        type: 'NWC_P2P',
        fee: 0,
        speed: 'instant',
        description: 'Direct P2P via NWC'
      };
    }
    
    if (!fromHasNWC && !toHasNWC) {
      return {
        type: 'ESCROW_INTERNAL',
        fee: 0,
        speed: 'virtual',
        description: 'Internal ledger update'
      };
    }
    
    if (fromHasNWC && !toHasNWC) {
      return {
        type: 'HYBRID_NWC_TO_ESCROW',
        fee: 0,
        speed: 'mixed',
        description: 'NWC payer to Escrow receiver'
      };
    }
    
    return {
      type: 'HYBRID_ESCROW_TO_NWC',
      fee: 0,
      speed: 'mixed',
      description: 'Escrow payer to NWC receiver'
    };
  }

  // =====================================================
  // CORE: Execute Transfer
  // =====================================================
  
  async executeTransfer(transferData) {
    const { gameId, fromUserId, toUserId, amount, weapon, reason } = transferData;
    
    if (amount <= 0) throw new Error('Invalid amount');
    if (fromUserId === toUserId) throw new Error('Self-transfer not allowed');
    
    const route = await this.determineOptimalRoute(fromUserId, toUserId);
    console.log(`[PaymentRouter] Route: ${route.type} | ${amount}sats`);
    
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

      // Only fall back to escrow for NWC_P2P failures (e.g. budget exceeded, network error).
      // NEVER fall back for HYBRID routes: the payer's real wallet was not debited,
      // so crediting the receiver from the escrow ledger would create sats from thin air.
      if (route.type === 'NWC_P2P') {
        console.log(`[Fallback] NWC P2P failed, attempting escrow fallback`);
        return this.executeEscrowFallback(transferId, fromUserId, toUserId, amount);
      }

      throw error;
    }
  }

  // =====================================================
  // MODE 1: NWC P2P - SIMPLE & RAPIDE
  // =====================================================
  // 
  // Le wallet NWC gère automatiquement:
  // - Les budgets (max_amount, budget_renewal)
  // - Le rejet si limite dépassée
  // - La sécurité (aucune clé sur le serveur)
  //
  // Le serveur fait juste:
  // 1. Créer l'invoice (receiver)
  // 2. Payer l'invoice (payer)
  // 3. Logger le résultat
  
  async executeNWCP2P(transferId, fromUserId, toUserId, amount, description) {
    const fromUser = await this.getUserWithDecryptedNWC(fromUserId);
    const toUser = await this.getUserWithDecryptedNWC(toUserId);
    
    // Étape 1: Le RECEIVER crée l'invoice via son NWC
    const toNWC = this.getNWCClient(toUser.nwc_uri_decrypted);
    
    const invoiceResult = await toNWC.makeInvoice({
      amount: amount * 1000, // millisats
      description: description || `Lightning Arena - ${fromUser.username}`,
      expiry: 120 // 2 minutes
    });
    
    console.log(`[NWC] Invoice created: ${invoiceResult.invoice?.substring(0, 50)}...`);
    
    // Étape 2: Le PAYER paye via son NWC
    const fromNWC = this.getNWCClient(fromUser.nwc_uri_decrypted);
    
    // NWC gère automatiquement:
    // - Vérification du budget natif
    // - Rejet si limite dépassée
    // - Paiement via le wallet connecté
    const paymentResult = await fromNWC.payInvoice({
      invoice: invoiceResult.invoice
    });
    
    if (!paymentResult.preimage) {
      throw new Error('Payment failed - NWC may have rejected (budget limit?)');
    }
    
    console.log(`[NWC] Payment success: ${paymentResult.preimage.substring(0, 20)}...`);
    
    // Étape 3: Logger
    await this.db('transfers')
      .where('id', transferId)
      .update({
        status: 'completed',
        preimage: paymentResult.preimage,
        payment_hash: paymentResult.payment_hash,
        completed_at: new Date()
      });
    
    return {
      tx: paymentResult.preimage,
      paymentHash: paymentResult.payment_hash,
      mode: 'nwc_p2p'
    };
  }

  // =====================================================
  // MODE 2: Escrow Internal
  // =====================================================
  
  async executeEscrowInternal(transferId, fromUserId, toUserId, amount) {
    await this.db.transaction(async (trx) => {
      // Atomic deduction: only succeeds if balance is sufficient, preventing race conditions
      const deducted = await trx('users')
        .where('id', fromUserId)
        .where('escrow_balance_sats', '>=', amount)
        .decrement('escrow_balance_sats', amount);

      if (deducted === 0) {
        throw new Error('Insufficient escrow balance');
      }

      await trx('users').where('id', toUserId).increment('escrow_balance_sats', amount);
      await trx('transfers').where('id', transferId).update({
        status: 'completed',
        completed_at: new Date()
      });
    });
    
    return {
      tx: transferId,
      mode: 'escrow_internal'
    };
  }

  // =====================================================
  // MODE 3 & 4: Hybrid (requièrent LND)
  // =====================================================
  
  async executeHybridNWCToEscrow(transferId, fromUserId, toUserId, amount, description) {
    if (!this.lndEnabled) {
      throw new Error('Hybrid mode requires LND');
    }
    
    const fromUser = await this.getUserWithDecryptedNWC(fromUserId);
    
    // Invoice vers LND du serveur
    const invoice = await this.lnd.addInvoice({
      value: amount,
      memo: description || `Hybrid: ${fromUser.username}`,
      expiry: 120
    });
    
    // NWC paie
    const fromNWC = this.getNWCClient(fromUser.nwc_uri_decrypted);
    const payment = await fromNWC.payInvoice({
      invoice: invoice.payment_request
    });
    
    if (!payment.preimage) throw new Error('Hybrid payment failed');

    // Credit receiver and mark transfer complete atomically
    await this.db.transaction(async (trx) => {
      await trx('users').where('id', toUserId).increment('escrow_balance_sats', amount);
      await trx('transfers').where('id', transferId).update({
        status: 'completed',
        preimage: payment.preimage,
        completed_at: new Date()
      });
    });

    return {
      tx: payment.preimage,
      mode: 'hybrid_nwc_to_escrow'
    };
  }
  
  async executeHybridEscrowToNWC(transferId, fromUserId, toUserId, amount, description) {
    if (!this.lndEnabled) {
      throw new Error('Hybrid mode requires LND');
    }

    const toUser = await this.getUserWithDecryptedNWC(toUserId);
    const fromUser = await this.db('users').where('id', fromUserId).first();

    // Atomically reserve the balance BEFORE sending — deduct now, refund if LND fails.
    // This prevents a race condition where two concurrent transfers both pass the balance check.
    const reserved = await this.db('users')
      .where('id', fromUserId)
      .where('escrow_balance_sats', '>=', amount)
      .decrement('escrow_balance_sats', amount);

    if (reserved === 0) {
      throw new Error('Insufficient escrow balance');
    }

    try {
      // Invoice NWC du receiver
      const toNWC = this.getNWCClient(toUser.nwc_uri_decrypted);
      const invoiceResult = await toNWC.makeInvoice({
        amount: amount * 1000,
        description: description || `Payment from ${fromUser.username}`,
        expiry: 120
      });

      // LND paie
      const payment = await this.lnd.sendPaymentSync({
        payment_request: invoiceResult.invoice,
        timeout_seconds: 60
      });

      if (payment.payment_error) throw new Error(payment.payment_error);

      await this.db('transfers').where('id', transferId).update({
        status: 'completed',
        preimage: payment.payment_preimage.toString('hex'),
        completed_at: new Date()
      });

      return {
        tx: payment.payment_preimage.toString('hex'),
        mode: 'hybrid_escrow_to_nwc'
      };
    } catch (err) {
      // LND payment failed — refund the reserved balance
      await this.db('users').where('id', fromUserId).increment('escrow_balance_sats', amount);
      throw err;
    }
  }

  // =====================================================
  // FALLBACK
  // =====================================================
  
  async executeEscrowFallback(transferId, fromUserId, toUserId, amount) {
    try {
      await this.executeEscrowInternal(transferId, fromUserId, toUserId, amount);
      
      await this.db('transfers').where('id', transferId).update({
        payment_mode: 'ESCROW_INTERNAL',
        note: 'NWC fallback to escrow'
      });
      
      return { success: true, mode: 'escrow_fallback', fallback: true };
    } catch (escrowError) {
      throw new Error('Both NWC and escrow failed');
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
    const cached = this.nwcConnections.get(nwcUri);
    if (cached && Date.now() - cached.created < 300000) {
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
    const user = await this.db('users').where('id', userId).first();
    if (!user) return null;
    
    if (user.nwc_uri_encrypted) {
      try {
        user.nwc_uri_decrypted = this.decrypt(
          user.nwc_uri_encrypted,
          user.nwc_uri_iv,
          user.nwc_uri_auth_tag
        );
      } catch (err) {
        console.error(`Failed to decrypt NWC URI for ${userId}:`, err);
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
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(iv, 'hex'));
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
  
  // Retry an existing transfer record without creating a new one.
  // executeTransfer() always creates a new record, so retrying via it causes infinite accumulation.
  async retryExistingTransfer(transfer) {
    const route = await this.determineOptimalRoute(transfer.from_user_id, transfer.to_user_id);
    try {
      let result;
      switch (route.type) {
        case 'NWC_P2P':
          result = await this.executeNWCP2P(transfer.id, transfer.from_user_id, transfer.to_user_id, transfer.amount_sats, transfer.reason);
          break;
        case 'ESCROW_INTERNAL':
          result = await this.executeEscrowInternal(transfer.id, transfer.from_user_id, transfer.to_user_id, transfer.amount_sats);
          break;
        case 'HYBRID_NWC_TO_ESCROW':
          result = await this.executeHybridNWCToEscrow(transfer.id, transfer.from_user_id, transfer.to_user_id, transfer.amount_sats, transfer.reason);
          break;
        case 'HYBRID_ESCROW_TO_NWC':
          result = await this.executeHybridEscrowToNWC(transfer.id, transfer.from_user_id, transfer.to_user_id, transfer.amount_sats, transfer.reason);
          break;
        default:
          throw new Error(`Unknown route type: ${route.type}`);
      }
      this.emit('transferCompleted', {
        transferId: transfer.id,
        gameId: transfer.game_id,
        from: transfer.from_user_id,
        to: transfer.to_user_id,
        amount: transfer.amount_sats,
        mode: route.type,
        tx: result.tx
      });
    } catch (err) {
      await this.markTransferFailed(transfer.id, err.message);
    }
  }

  startRetryWorker() {
    setInterval(async () => {
      try {
        const pending = await this.db('transfers')
          .whereIn('status', ['pending', 'failed'])
          .where('retry_count', '<', this.config.maxRetries)
          .where('expires_at', '>', new Date())
          .select('*');

        for (const transfer of pending) {
          try {
            await this.retryExistingTransfer(transfer);
          } catch (retryErr) {
            console.error(`[RetryWorker] Failed:`, retryErr.message);
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
        await this.db('transfers')
          .where('status', 'pending')
          .where('expires_at', '<', new Date())
          .update({ status: 'expired' });
        
        const now = Date.now();
        for (const [uri, data] of this.nwcConnections) {
          if (now - data.created > 600000) {
            this.nwcConnections.delete(uri);
          }
        }
      } catch (err) {
        console.error('[CleanupWorker] Error:', err);
      }
    }, 60000);
  }
}

module.exports = PaymentRouter;
