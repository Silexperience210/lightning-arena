// =====================================================
// PAYMENT ROUTER v2.0 - NWC Expert Implementation
// Optimisé avec Notifications NIP-47, Budgets, Métadonnées
// =====================================================

const { nwc } = require('@getalby/sdk');
const crypto = require('crypto');
const EventEmitter = require('events');

class PaymentRouterV2 extends EventEmitter {
  constructor(config) {
    super();
    this.db = config.db;
    this.lnd = config.lnd;
    this.redis = config.redis;
    
    this.lndEnabled = config.lnd && process.env.LND_ENABLED !== 'false';
    this.nwcNotificationsEnabled = process.env.NWC_NOTIFICATIONS_ENABLED === 'true';
    
    this.encryptionKey = Buffer.from(process.env.NWC_ENCRYPTION_KEY, 'hex');
    
    this.config = {
      maxRetries: 3,
      retryDelayMs: 2000,
      paymentTimeoutMs: 30000,
      nwcDefaultBudget: 100000,
      feePercent: 1.0,
      notificationRelay: process.env.NWC_NOTIFICATION_RELAY || 'wss://relay.getalby.com/v1',
      ...config.options
    };
    
    this.nwcConnections = new Map();
    this.nwcNotificationHandlers = new Map(); // NEW: Gestionnaires de notifications
    
    this.startRetryWorker();
    this.startCleanupWorker();
    
    // NEW: Démarrer l'écoute des notifications si activé
    if (this.nwcNotificationsEnabled) {
      this.startNotificationListener();
    }
  }

  // =====================================================
  // NOUVEAUTÉ: Gestion des budgets NWC (NIP-47 budget_renewal)
  // =====================================================
  
  async createNWCConnectionWithBudget(userId, options = {}) {
    const {
      name = 'Lightning Arena',
      maxAmount = this.config.nwcDefaultBudget,
      budgetRenewal = 'daily', // never, daily, weekly, monthly, yearly
      expiresAt = null,
      requestMethods = ['pay_invoice', 'make_invoice', 'get_balance', 'lookup_invoice']
    } = options;
    
    // Construction de l'URI de connexion avec budget
    // Format: /apps/new?name=...&pubkey=...&max_amount=...&budget_renewal=...
    const connectionParams = new URLSearchParams({
      name,
      max_amount: maxAmount.toString(),
      budget_renewal: budgetRenewal,
      request_methods: requestMethods.join(' ')
    });
    
    if (expiresAt) {
      connectionParams.set('expires_at', Math.floor(expiresAt / 1000).toString());
    }
    
    return {
      connectionUrl: `https://nwc.getalby.com/apps/new?${connectionParams.toString()}`,
      maxAmount,
      budgetRenewal,
      expiresAt
    };
  }

  // =====================================================
  // NOUVEAUTÉ: Notifications NIP-47 (payment_received/payment_sent)
  // =====================================================
  
  startNotificationListener() {
    console.log('[NWC] Starting notification listener...');
    
    // S'abonner aux notifications Redis pour les mises à jour NWC
    if (this.redis) {
      this.redis.subscribe('nwc:notifications', (message) => {
        const notification = JSON.parse(message);
        this.handleNWCNotification(notification);
      });
    }
  }
  
  async handleNWCNotification(notification) {
    const { notification_type, notification: data } = notification;
    
    console.log(`[NWC Notification] ${notification_type}:`, data);
    
    switch (notification_type) {
      case 'payment_received':
        // Un joueur a reçu un paiement (utile pour vérifier les soldes)
        await this.handleIncomingPayment(data);
        break;
        
      case 'payment_sent':
        // Un paiement a été envoyé
        await this.handleOutgoingPayment(data);
        break;
        
      default:
        console.log(`[NWC] Unknown notification type: ${notification_type}`);
    }
  }
  
  async handleIncomingPayment(data) {
    // Mettre à jour le solde en temps réel
    const { payment_hash, amount, preimage } = data;
    
    // Émettre un événement pour le frontend
    this.emit('balance:updated', {
      type: 'incoming',
      paymentHash: payment_hash,
      amount: Math.floor(amount / 1000), // msats → sats
      preimage
    });
  }
  
  async handleOutgoingPayment(data) {
    const { payment_hash, amount, preimage, fees_paid } = data;
    
    this.emit('payment:sent', {
      paymentHash: payment_hash,
      amount: Math.floor(amount / 1000),
      feesPaid: Math.floor((fees_paid || 0) / 1000),
      preimage
    });
  }

  // =====================================================
  // NOUVEAUTÉ: Synchronisation transactionnelle NWC
  // =====================================================
  
  async syncNWCTransactions(userId, since = null) {
    const user = await this.getUserWithDecryptedNWC(userId);
    if (!this.isNWCValid(user)) return;
    
    const client = this.getNWCClient(user.nwc_uri_decrypted);
    
    try {
      // Récupérer l'historique des transactions
      const transactions = await client.listTransactions({
        from: since ? Math.floor(since / 1000) : undefined,
        limit: 100
      });
      
      console.log(`[NWC] Synced ${transactions.transactions?.length || 0} transactions for user ${userId}`);
      
      // Mettre à jour la base de données avec les transactions manquantes
      for (const tx of transactions.transactions || []) {
        await this.upsertTransaction(userId, tx);
      }
      
      return transactions;
    } catch (err) {
      console.error(`[NWC] Failed to sync transactions for ${userId}:`, err);
      throw err;
    }
  }
  
  async upsertTransaction(userId, tx) {
    // Vérifier si la transaction existe déjà
    const existing = await this.db('transfers')
      .where('payment_hash', tx.payment_hash)
      .first();
    
    if (existing) return;
    
    // Insérer la transaction
    await this.db('transfers').insert({
      from_user_id: tx.type === 'outgoing' ? userId : null,
      to_user_id: tx.type === 'incoming' ? userId : null,
      amount_sats: Math.floor(tx.amount / 1000),
      payment_hash: tx.payment_hash,
      preimage: tx.preimage,
      payment_mode: 'nwc_direct',
      status: tx.settled_at ? 'completed' : 'pending',
      created_at: new Date(tx.created_at * 1000),
      completed_at: tx.settled_at ? new Date(tx.settled_at * 1000) : null
    });
  }

  // =====================================================
  // OPTIMISATION: NWC P2P avec métadonnées et vérification améliorée
  // =====================================================
  
  async executeNWCP2P(transferId, fromUserId, toUserId, amount, description) {
    const fromUser = await this.getUserWithDecryptedNWC(fromUserId);
    const toUser = await this.getUserWithDecryptedNWC(toUserId);
    
    // Vérifier les budgets avant transaction
    await this.validateNWCBudget(fromUserId, amount);
    
    const toNWC = this.getNWCClient(toUser.nwc_uri_decrypted);
    
    // NOUVEAUTÉ: Ajout de métadonnées pour traçabilité
    const invoiceResult = await toNWC.makeInvoice({
      amount: amount * 1000,
      description: description || `Lightning Arena - ${fromUser.username} → ${toUser.username}`,
      expiry: 120,
      // Métadonnées optionnelles (si supporté par le wallet)
      metadata: {
        game: 'lightning_arena',
        from: fromUser.username,
        to: toUser.username,
        transfer_id: transferId
      }
    });
    
    console.log(`[NWC_P2P] Invoice: ${invoiceResult.invoice?.substring(0, 50)}...`);
    
    // Vérifier que l'invoice est valide
    if (!invoiceResult.invoice) {
      throw new Error('Failed to create invoice - no invoice returned');
    }
    
    const fromNWC = this.getNWCClient(fromUser.nwc_uri_decrypted);
    
    // NOUVEAUTÉ: Tag d'expiration pour la requête (NIP-47)
    const expirationTime = Math.floor(Date.now() / 1000) + 60; // 60 secondes TTL
    
    const paymentResult = await fromNWC.payInvoice({
      invoice: invoiceResult.invoice,
      amount: amount * 1000,
      // Certains wallets supportent metadata dans pay_invoice aussi
      metadata: {
        transfer_id: transferId,
        game_round: 'active'
      }
    });
    
    if (!paymentResult.preimage) {
      throw new Error('Payment failed - no preimage');
    }
    
    // NOUVEAUTÉ: Vérification immédiate avec lookup_invoice
    const verification = await toNWC.lookupInvoice({
      payment_hash: paymentResult.payment_hash
    });
    
    if (!verification.settled_at) {
      console.warn(`[NWC_P2P] Invoice not yet settled, waiting async...`);
    }
    
    // Enregistrement avec métadonnées enrichies
    await this.db('transfers')
      .where('id', transferId)
      .update({
        status: 'completed',
        preimage: paymentResult.preimage,
        payment_hash: paymentResult.payment_hash,
        invoice_request: invoiceResult.invoice,
        completed_at: new Date(),
        nwc_response: JSON.stringify({
          paymentResult,
          verification,
          metadata: { from: fromUser.username, to: toUser.username }
        })
      });
    
    // Mettre à jour les budgets
    await this.updateNWCUsage(fromUserId, amount);
    
    return {
      tx: paymentResult.preimage,
      paymentHash: paymentResult.payment_hash,
      mode: 'nwc_p2p',
      settled: !!verification.settled_at
    };
  }
  
  // =====================================================
  // NOUVEAUTÉ: Validation et gestion des budgets
  // =====================================================
  
  async validateNWCBudget(userId, amount) {
    const user = await this.db('users').where('id', userId).first();
    
    if (!user.nwc_budget_sats) return; // Pas de budget configuré
    
    // Calculer l'utilisation dans la période actuelle
    const periodStart = this.getBudgetPeriodStart(user.nwc_budget_renewal || 'daily');
    
    const usage = await this.db('transfers')
      .where('from_user_id', userId)
      .where('payment_mode', 'nwc_direct')
      .where('created_at', '>=', periodStart)
      .sum('amount_sats as total')
      .first();
    
    const totalUsage = parseInt(usage.total) || 0;
    
    if (totalUsage + amount > user.nwc_budget_sats) {
      throw new Error(`NWC budget exceeded: ${totalUsage}/${user.nwc_budget_sats} sats used`);
    }
  }
  
  getBudgetPeriodStart(renewal) {
    const now = new Date();
    
    switch (renewal) {
      case 'daily':
        return new Date(now.setHours(0, 0, 0, 0));
      case 'weekly':
        const day = now.getDay();
        return new Date(now.setDate(now.getDate() - day));
      case 'monthly':
        return new Date(now.setDate(1));
      case 'yearly':
        return new Date(now.setMonth(0, 1));
      default:
        return new Date(0); // Tout l'historique
    }
  }
  
  async updateNWCUsage(userId, amount) {
    // Stocker l'utilisation dans Redis pour accès rapide
    if (this.redis) {
      const key = `nwc:usage:${userId}:${new Date().toISOString().split('T')[0]}`;
      await this.redis.incrBy(key, amount);
      await this.redis.expire(key, 86400 * 2); // 2 jours TTL
    }
  }

  // =====================================================
  // OPTIMISATION: Gestion améliorée des connexions NWC
  // =====================================================
  
  getNWCClient(nwcUri) {
    const cached = this.nwcConnections.get(nwcUri);
    
    // Cache avec validation de connexion
    if (cached && Date.now() - cached.created < 300000) {
      return cached.client;
    }
    
    // NOUVEAUTÉ: Options avancées pour le client NWC
    const client = new nwc.NWCClient({
      nostrWalletConnectUrl: nwcUri,
      relayUrl: this.config.notificationRelay,
      // Timeout personnalisé pour les requêtes
      timeout: 30000
    });
    
    // NOUVEAUTÉ: Gestion des erreurs de connexion
    client.on('error', (err) => {
      console.error(`[NWC] Connection error:`, err);
      this.nwcConnections.delete(nwcUri);
    });
    
    this.nwcConnections.set(nwcUri, {
      client,
      created: Date.now(),
      lastUsed: Date.now()
    });
    
    return client;
  }

  // =====================================================
  // Méthodes existantes (inchangées pour compatibilité)
  // =====================================================
  
  async determineOptimalRoute(fromUserId, toUserId) {
    // ... même code qu'avant
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
  
  async executeTransfer(transferData) {
    // ... même logique avec appel à executeNWCP2P v2
    const { gameId, fromUserId, toUserId, amount, weapon, reason } = transferData;
    
    if (amount <= 0) throw new Error('Invalid amount');
    if (fromUserId === toUserId) throw new Error('Self-transfer not allowed');
    
    const route = await this.determineOptimalRoute(fromUserId, toUserId);
    console.log(`[PaymentRouter] Route: ${route.type} | ${amount}sats | ${route.description}`);
    
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
      
      if (route.type.startsWith('NWC') || route.type.startsWith('HYBRID')) {
        console.log(`[Fallback] Attempting escrow fallback for ${transferId}`);
        return this.executeEscrowFallback(transferId, fromUserId, toUserId, amount);
      }
      
      throw error;
    }
  }
  
  // ... (autres méthodes utilitaires inchangées)
  isNWCValid(user) {
    if (!user || user.wallet_type !== 'nwc') return false;
    if (!user.nwc_uri_decrypted) return false;
    if (user.nwc_expires_at && new Date(user.nwc_expires_at) < new Date()) return false;
    if (user.is_banned) return false;
    return true;
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
  
  async executeEscrowInternal(transferId, fromUserId, toUserId, amount) {
    await this.db.transaction(async (trx) => {
      const fromBalance = await trx('users')
        .where('id', fromUserId)
        .select('escrow_balance_sats')
        .first();
      
      if (fromBalance.escrow_balance_sats < amount) {
        throw new Error('Insufficient escrow balance');
      }
      
      await trx('users').where('id', fromUserId).decrement('escrow_balance_sats', amount);
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
  
  startRetryWorker() {
    setInterval(async () => {
      try {
        const pending = await this.db('transfers')
          .whereIn('status', ['pending', 'failed'])
          .where('retry_count', '<', this.config.maxRetries)
          .where('expires_at', '>', new Date())
          .where('created_at', '>', new Date(Date.now() - 600000))
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
            console.error(`[RetryWorker] Retry failed:`, retryErr.message);
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

module.exports = PaymentRouterV2;
