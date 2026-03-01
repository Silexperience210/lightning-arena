/**
 * Lightning Arena - Validation serveur anti-triche
 * 
 * Ce script valide les victoires signées envoyées par le client STK.
 * Le serveur DOIT utiliser la MÊME clé secrète et le MÊME algorithme.
 */

const crypto = require('crypto');

// MÊME CLÉ SECRÈTE QUE DANS three_strikes_battle.cpp
const LIGHTNING_SECRET_KEY = "STK_LightningArena_Secret_2024!";

/**
 * Implémentation exacte de l'algorithme de signature du client (FNV-1a + XOR)
 * ATTENTION: Doit être IDENTIQUE à l'implémentation C++
 */
function signVictory(winnerName, winnerSats, timestamp, secret) {
    // Construire le message: winner:sats:timestamp:secret
    const message = `${winnerName}:${winnerSats}:${timestamp}:${secret}`;
    
    // FNV-1a hash (64-bit)
    let hash = BigInt.asUintN(64, 0xcbf29ce484222325n);
    const prime = BigInt.asUintN(64, 0x100000001b3n);
    const goldenRatio = BigInt.asUintN(64, 0x9e3779b97f4a7c15n);
    
    for (let i = 0; i < message.length; i++) {
        hash ^= BigInt(message.charCodeAt(i));
        hash = BigInt.asUintN(64, hash * prime);
        
        // XOR avec position + rotation
        hash ^= BigInt.asUintN(64, BigInt(i) * goldenRatio);
        hash = BigInt.asUintN(64, (hash << 13n) | (hash >> 51n));
    }
    
    // Double hash avec secret
    hash ^= BigInt.asUintN(64, 0xdeadbeefcafebaben);
    for (let i = 0; i < secret.length; i++) {
        hash ^= BigInt(secret.charCodeAt(i));
        hash = BigInt.asUintN(64, hash * prime);
    }
    
    // Convertir en hex (16 chars)
    return hash.toString(16).padStart(16, '0');
}

/**
 * Valide un fichier de victoire
 * @param {Object} victoryData - Données du fichier lightning_victory.json
 * @returns {boolean} - true si valide, false sinon
 */
function validateVictory(victoryData) {
    console.log("🔐 Validation de la victoire...");
    console.log("   Gagnant:", victoryData.winner);
    console.log("   Sats:", victoryData.sats);
    console.log("   Timestamp:", victoryData.timestamp);
    
    // Vérifier que tous les champs requis sont présents
    if (!victoryData.winner || !victoryData.sats || !victoryData.timestamp || !victoryData.signature) {
        console.error("❌ Données incomplètes");
        return false;
    }
    
    // Recalculer la signature
    const computedSig = signVictory(
        victoryData.winner,
        victoryData.sats,
        victoryData.timestamp,
        LIGHTNING_SECRET_KEY
    );
    
    console.log("   Signature reçue:", victoryData.signature);
    console.log("   Signature calculée:", computedSig);
    
    // Comparer les signatures
    if (computedSig.toLowerCase() === victoryData.signature.toLowerCase()) {
        console.log("✅ Signature VALIDE - Victoire authentique!");
        return true;
    } else {
        console.error("❌ Signature INVALIDE - Tentative de triche détectée!");
        return false;
    }
}

/**
 * Vérifie si le joueur a été déconnecté trop longtemps
 * @param {Object} disconnectedPlayers - Map des joueurs déconnectés
 * @param {string} ticketId - ID du ticket
 * @returns {Object|null} - Info de timeout ou null
 */
function checkDisconnectTimeout(disconnectedPlayers, ticketId) {
    if (!disconnectedPlayers || !ticketId) return null;
    
    const player = disconnectedPlayers.get(ticketId);
    if (!player) return null;
    
    const MAX_DISCONNECT_TIME = 7 * 24 * 60 * 60 * 1000; // 7 days
    const elapsed = Date.now() - player.disconnectTime;
    
    if (elapsed > MAX_DISCONNECT_TIME) {
        const elapsedDays = Math.floor(elapsed / (24 * 60 * 60 * 1000));
        return {
            expired: true,
            message: `DISCONNECT_TIMEOUT: You were disconnected for ${elapsedDays} days. Maximum allowed: 7 days. Your balance has been forfeited.`,
            messageFr: `TEMPS DE DÉCONNEXION DÉPASSÉ : Vous avez été déconnecté pendant ${elapsedDays} jours. Maximum: 7 jours. Votre solde a été perdu.`,
            elapsedMinutes: Math.floor(elapsed / 60000),
            elapsedDays: elapsedDays,
            originalSats: player.sats
        };
    }
    
    return null;
}

/**
 * Traite un retrait Lightning
 * @param {Object} victoryData - Données de victoire
 * @param {string} lnAddress - Adresse Lightning du gagnant
 * @param {Map} disconnectedPlayers - Optional: Map des joueurs déconnectés pour vérifier les timeouts
 */
async function processWithdrawal(victoryData, lnAddress, disconnectedPlayers = null) {
    console.log("\n💸 Traitement du retrait...");
    
    // 1. Valider la victoire
    if (!validateVictory(victoryData)) {
        throw new Error("Validation failed - Withdrawal refused");
    }
    
    // 2. Vérifier que la victoire n'a pas déjà été utilisée (anti-replay)
    // TODO: Vérifier dans la base de données que ce ticket_id n'a pas été utilisé
    
    // 3. Vérifier le montant (max 4000 sats pour 4 joueurs)
    const MAX_SATS = 4000; // 4 joueurs * 1000 sats
    if (victoryData.sats > MAX_SATS) {
        throw new Error(`Amount suspicious: ${victoryData.sats} sats (max: ${MAX_SATS})`);
    }
    
    // 4. Vérifier si le joueur a été déconnecté trop longtemps
    if (disconnectedPlayers && victoryData.ticket_id) {
        const timeoutInfo = checkDisconnectTimeout(disconnectedPlayers, victoryData.ticket_id);
        if (timeoutInfo) {
            console.error("❌ DISCONNECT TIMEOUT:", timeoutInfo.message);
            throw new Error(`${timeoutInfo.message}\n\nYou were disconnected for ${timeoutInfo.elapsedDays} days.\nMaximum allowed: 7 days.\n\nYour original balance of ${timeoutInfo.originalSats} sats has been forfeited.\n\nℹ️ With LNAuth authentication, your session is preserved for up to 7 days.`);
        }
    }
    
    // 5. Effectuer le paiement Lightning
    console.log(`⚡ Payment of ${victoryData.sats} sats to ${lnAddress}`);
    
    // TODO: Appel API à votre nœud Lightning (lnd, cln, etc.)
    // const payment = await lightningClient.sendPayment(lnAddress, victoryData.sats);
    
    console.log("✅ Withdrawal processed successfully!");
    return {
        status: "success",
        amount: victoryData.sats,
        recipient: lnAddress,
        timestamp: Date.now()
    };
}

// ===== EXEMPLE D'UTILISATION =====

// Exemple de validation
const exampleVictory = {
    "status": "completed",
    "winner": "Tux",
    "winner_id": 1,
    "sats": 2500,
    "ln_address": "pending",
    "ticket_id": "VICTORY-1234567890",
    "timestamp": 1234567890,
    "total_players": 4,
    "game_mode": "lightning_arena",
    "signature": "a1b2c3d4e5f67890",
    "verified": true
};

// Si exécuté directement
if (require.main === module) {
    console.log("=== Lightning Arena - Validation Serveur ===\n");
    
    // Test avec données d'exemple
    console.log("Test de validation:");
    validateVictory(exampleVictory);
    
    console.log("\n=== Serveur prêt ===");
    console.log("Endpoint API: POST /api/withdraw");
    console.log("Body: { victoryData: {...}, lnAddress: 'user@wallet.com' }");
}

module.exports = { validateVictory, processWithdrawal, signVictory, checkDisconnectTimeout };
