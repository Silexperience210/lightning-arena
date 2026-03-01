# ⚡ Lightning Arena - Architecture P2P avec Nostr Wallet Connect

## 🎯 Concept

Pas de serveur, pas de dépôt préalable. Chaque joueur garde son wallet sur son téléphone et autorise les paiements P2P en temps réel via NWC.

## 🔗 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    JOUEUR A (Téléphone)                          │
│  ┌──────────────┐                                               │
│  │   Wallet     │  Phoenix/BlueWallet/Alby                    │
│  │  (Lightning) │                                               │
│  └──────┬───────┘                                               │
│         │                                                        │
│         │ Nostr Wallet Connect (NIP-47)                         │
│         │ URI: nostr+walletconnect://...                        │
│         │                                                        │
│         ▼                                                        │
├─────────────────────────────────────────────────────────────────┤
│                    JOUEUR A (PC - STK)                           │
│  ┌──────────────┐      ┌──────────────┐                        │
│  │  NWC Client  │◄────►│ Lightning    │                        │
│  │   (C++)      │      │ Arena Mod    │                        │
│  └──────┬───────┘      └──────────────┘                        │
└─────────┼───────────────────────────────────────────────────────┘
          │
          │  Nostr Relay (wss://relay.damus.io)
          │  - Messages chiffrés (NIP-44)
          │  - Éphémères (pas de stockage)
          ▼
┌─────────┼───────────────────────────────────────────────────────┐
│         │        JOUEUR B (PC - STK)                           │
│  ┌──────┴───────┐      ┌──────────────┐                        │
│  │  NWC Client  │◄────►│ Lightning    │                        │
│  │   (C++)      │      │ Arena Mod    │                        │
│  └──────┬───────┘      └──────────────┘                        │
└─────────┼───────────────────────────────────────────────────────┘
          │ Nostr Wallet Connect
          │
          ▼
┌─────────┴───────────────────────────────────────────────────────┐
│                    JOUEUR B (Téléphone)                          │
│                    [Wallet Lightning]                            │
└─────────────────────────────────────────────────────────────────┘
```

## 🔄 Flow de Jeu

### 1. Connexion NWC (Avant partie)

```
Joueur A:
1. Ouvre son wallet mobile (Phoenix)
2. Scan le QR code dans STK
3. Autorise: "Autoriser STK à payer jusqu'à 1000 sats ?"
4. STK reçoit: pubkey + secret pour NWC

Joueur B:
→ Même processus
```

### 2. Pendant la Partie (P2P Real-time)

```
SCÉNARIO: Joueur A touche Joueur B avec un gâteau (-50 sats)

┌─────────────────────────────────────────────────────────────┐
│  1. HIT DÉTECTÉ                                             │
│     - STK A détecte collision avec gâteau                   │
│     - Calcule: -50 sats à payer                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  2. DEMANDE DE PAIEMENT (NWC)                               │
│     - STK A envoie à son wallet (via NWC):                  │
│       {                                                     │
│         "method": "pay_invoice",                            │
│         "params": {                                         │
│           "invoice": "lnbc500n1p...",  // Invoice de B      │
│           "amount": 50,                                     │
│           "description": "Lightning Arena - Hit by Tux"     │
│       }                                                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  3. NOTIFICATION SUR TÉLÉPHONE                              │
│     - Wallet A affiche: "Payer 50 sats à Bob ?"             │
│     - Joueur A approuve (ou refuse!)                        │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  4. PAIEMENT LIGHTNING                                      │
│     - Wallet A paie l'invoice de B                          │
│     - Réponse: { "preimage": "abc123...", "payment_hash" }  │
│     - Preimage = preuve de paiement                         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  5. SYNCHRONISATION P2P                                     │
│     - STK A broadcast via Nostr: "J'ai payé B, 50 sats"     │
│     - Preuve: preimage + payment_hash                       │
│     - Signé avec clé Nostr du joueur                        │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  6. VÉRIFICATION & MISE À JOUR                              │
│     - STK B reçoit le message Nostr                         │
│     - Vérifie le paiement Lightning (lookup_invoice)        │
│     - Met à jour le solde: +50 sats pour B                  │
│     - Met à jour le solde: -50 sats pour A                  │
│     - Affiche: "Tux vous a payé 50 sats!"                   │
└─────────────────────────────────────────────────────────────┘
```

### 3. Fin de Partie

```
Gagnant = Joueur avec le plus de sats reçus
Perdants = Leurs balances sont négatives (ils ont payé)

Pas de "retrait" à faire :
- Les sats sont déjà dans les wallets respectifs
- En temps réel pendant la partie
```

## 🔐 Sécurité & Anti-Triche

### Problème: Que faire si un joueur refuse de payer ?

**Solution 1: Stake préalable (Recommandé)**
```
Avant partie:
1. Chaque joueur stake 1000 sats dans un 2-of-2 multisig
   OU channel Lightning bidirectionnel
2. Pendant partie: paiements via le channel
3. Fin partie: channel fermé, chacun récupère son solde
```

**Solution 2: Réputation (Gentleman)**
```
- Système de réputation Nostr (NIP-56)
- Joueurs qui ne paient pas = bad reputation
- Exclus des futures parties
```

**Solution 3: Timeout + Forfeit**
```
- Si joueur ne valide pas paiement sous 30 secondes
- Considéré comme abandon
- Kick du serveur
- Solde actuel = solde final
```

## 📦 Implémentation Technique

### Côté C++ (STK)

```cpp
class NWCClient {
private:
    std::string wallet_pubkey;
    std::string wallet_secret;
    std::string relay_url = "wss://relay.damus.io";
    
public:
    // Connexion initiale (scan QR)
    bool connect(const std::string& nwc_uri);
    
    // Demande de paiement
    struct PaymentRequest {
        std::string invoice;
        int amount_sats;
        std::string description;
    };
    
    // Envoie la demande au wallet mobile
    PaymentResult requestPayment(const PaymentRequest& req);
    
    // Reçoit notification paiement réussi
    void onPaymentSuccess(std::string preimage, std::string payment_hash);
    
    // Broadcast via Nostr aux autres joueurs
    void broadcastPaymentProof(std::string recipient_pubkey, 
                               std::string preimage, 
                               int amount);
};
```

### Côté Web (Interface de connexion)

```html
<!-- Connection NWC -->
<div class="nwc-connect">
    <h2>Connect Your Wallet</h2>
    <p>1. Open Phoenix/BlueWallet on your phone</p>
    <p>2. Scan this QR code:</p>
    <canvas id="nwc-qr"></canvas>
    <p>3. Approve the connection</p>
    
    <div id="nwc-status" class="hidden">
        ✅ Connected!
        <p>Balance: <span id="nwc-balance">0</span> sats</p>
    </div>
</div>
```

### Protocol Nostr (NIP-47)

```json
// Requête de paiement
{
  "id": "uuid",
  "method": "pay_invoice",
  "params": {
    "invoice": "lnbc500n1p...",
    "amount": 50
  }
}

// Réponse succès
{
  "id": "uuid",
  "result_type": "pay_invoice",
  "result": {
    "preimage": "abcdef123456...",
    "payment_hash": "xyz789...",
    "amount": 50,
    "fees_paid": 1
  }
}
```

## 🎮 Avantages NWC

| Aspect | Avec Serveur | Avec NWC P2P |
|--------|-------------|--------------|
| **Confiance** | Doit croire le serveur | Trustless |
| **Clés** | Serveur a des clés | Joueur garde ses clés |
| **Frais** | Frais serveur | Juste frais LN |
| **Downtime** | Serveur peut tomber | Toujours up (P2P) |
| **KYC** | Serveur = risque régulation | Aucun KYC |
| **Censure** | Serveur bannable | Impossible à censurer |

## ⚠️ Limitations

1. **UX**: Joueur doit approuver chaque paiement sur téléphone
   - Solution: Agréger les paiements (toutes les 30s)

2. **Latency**: ~3-5 secondes par paiement
   - Solution: Channel state updates (pas on-chain)

3. **Offline**: Wallet doit être en ligne
   - Solution: Notification push au téléphone

## 🚀 Prochaines Étapes

1. [ ] Intégrer librairie NWC C++ (ou wrapper C)
2. [ ] Créer interface QR code scanning
3. [ ] Implémenter broadcast Nostr
4. [ ] Tests P2P entre 2 machines
5. [ ] Optimisation UX (batch payments)

---

**Tu veux que j'implémente cette architecture NWC P2P ?**