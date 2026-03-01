# ⚡ Lightning Arena - Serveur Escrow avec NWC

## 🎯 Concept

Le serveur **orchestrateur** (pas custodian) :
- Ne détient **JAMAIS** les fonds
- Utilise **Nostr Wallet Connect** pour déclencher les paiements
- Agit comme "referee" mais ne touche pas les sats

```
AVANT (Custodial):
┌──────────┐     ┌──────────────┐     ┌──────────┐
│ Joueur A │────►│   SERVEUR    │────►│ Joueur B │
│ 1000 sats│     │ (hold funds) │     │  gagnant │
└──────────┘     └──────────────┘     └──────────┘

APRÈS (Escrow NWC):
┌──────────┐     ┌──────────────┐     ┌──────────┐
│ Joueur A │◄───►│   SERVEUR    │◄───►│ Joueur B │
│  Wallet  │ NWC │ (orchestrate)│ NWC │  Wallet  │
└──────────┘     └──────────────┘     └──────────┘
       │                                        │
       └──────────── P2P Direct ────────────────┘
```

## 🔗 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SERVEUR NODE.JS                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              ESCROW SERVICE (Orchestrateur)              │   │
│  │                                                          │   │
│  │  • Gestion des parties (room_id, joueurs, scores)        │   │
│  │  • Validation des hits (anti-cheat serveur)              │   │
│  │  • Calcul des transferts (qui paye qui, combien)         │   │
│  │  • DÉCLENCHEMENT des paiements via NWC (pas d'envoi)    │   │
│  │                                                          │   │
│  │  ❌ NE DÉTIENT PAS : Clés privées, fonds, sats          │   │
│  │  ✅ DÉTIENT : État du jeu, signatures, preuves          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              │ Nostr Wallet Connect             │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              NWC PROXY (Sécurisé)                        │   │
│  │                                                          │   │
│  │  • Stocke les NWC URIs chiffrées (AES-256)              │   │
│  │  • Envoie les requêtes pay_invoice aux wallets          │   │
│  │  • Reçoit les confirmations (preimage)                  │   │
│  │  • Rotation des clés régulière                          │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
              │                              │
              │ NWC                          │ NWC
              │                              │
┌─────────────▼──────────────┐  ┌───────────▼──────────────────┐
│      JOUEUR A              │  │        JOUEUR B              │
│  ┌─────────────────────┐   │  │   ┌─────────────────────┐    │
│  │   Wallet Lightning  │   │  │   │   Wallet Lightning  │    │
│  │   (Phoenix/Alby)    │   │  │   │   (Phoenix/Alby)    │    │
│  │                     │   │  │   │                     │    │
│  │ Solde: 5000 sats    │   │  │   │ Solde: 3000 sats    │    │
│  │                     │   │  │   │                     │    │
│  │ Autorisation NWC:   │   │  │   │ Autorisation NWC:   │    │
│  │ "Payer jusqu'à      │   │  │   │ "Payer jusqu'à      │    │
│  │  1000 sats/24h"     │   │  │   │  1000 sats/24h"     │    │
│  │  pour LightningArena"│   │  │   │  pour LightningArena"│    │
│  └─────────────────────┘   │  │   └─────────────────────┘    │
└────────────────────────────┘  └──────────────────────────────┘
```

## 🔄 Flow Complet

### 1. INSCRIPTION & CONNEXION NWC

```
Joueur A arrive sur lightning-arena.com:

┌─────────────────────────────────────────────┐
│  1. Créer compte (pseudo, email)            │
│                                             │
│  2. Connecter Wallet (NWC):                 │
│     ┌─────────────────────────────┐        │
│     │  ⚡ Scan avec ton wallet     │        │
│     │                              │        │
│     │  [QR CODE NWC URI]           │        │
│     │                              │        │
│     │  Phoenix / BlueWallet / Alby │        │
│     └─────────────────────────────┘        │
│                                             │
│  3. Autorisation côté wallet:               │
│     "Autoriser LightningArena à:            │
│      • Voir votre solde                     │
│      • Payer jusqu'à 1000 sats par jour     │
│      • Ne pas recevoir (vous gardez clés)"  │
│                                             │
│  4. Serveur reçoit: NWC URI (chiffrée)      │
│     → Stockée dans DB avec user_id          │
└─────────────────────────────────────────────┘
```

### 2. CRÉATION DE PARTIE

```
Joueur A crée une partie:

┌─────────────────────────────────────────────┐
│  Paramètres:                                │
│  • Mode: 1v1, FFA 4, FFA 8                  │
│  • Buy-in: 1000 sats (fixe ou variable)     │
│  • Durée max: 10 minutes                    │
│  • Armes: Standard ou Toutes                │
│                                             │
│  Serveur:                                   │
│  • Crée room_id: "arena-xyz789"             │
│  • Attend que joueurs rejoignent            │
│  • Vérifie que chaque joueur a:             │
│    - NWC connecté                           │
│    - Solde >= buy-in (get_balance)          │
│    - Quota de paiement disponible           │
└─────────────────────────────────────────────┘
```

### 3. DÉBUT DE PARTIE - LOCK DES FONDS

```
Tous les joueurs rejoignent (ex: 4 joueurs):

Pour chaque joueur:
┌─────────────────────────────────────────────┐
│  SERVEUR ──NWC──► WALLET JOUEUR            │
│                                             │
│  Requête: lookup_invoice pour buy-in       │
│  Montant: 1000 sats                        │
│  Description: "Lightning Arena - Buy-in    │
│               Partie #arena-xyz789"        │
│                                             │
│  Joueur voit sur téléphone:                │
│  "Payer 1000 sats pour rejoindre la partie?│
│   [Confirmer] [Annuler]"                   │
│                                             │
│  Si confirmé:                              │
│  • Paiement envoyé à l'invoice serveur     │
│  • Mais... (voir ci-dessous)               │
└─────────────────────────────────────────────┘

⚠️ IMPORTANT: Le serveur ne garde pas les fonds!

Solution 1: Multisig 2-of-3
  - Joueur A, Joueur B, et Serveur (arbitre)
  - Fonds bloqués, débloqués à la fin
  
Solution 2: Hash Time-Locked Contracts (HTLC)
  - Paiement conditionnel au résultat
  
Solution 3: "Gentleman + Réputation" (plus simple)
  - Pas de lock, confiance + système de rating
  - Si joueur refuse de payer → ban + rating négatif
  
Solution 4: STAKE via NWC (recommandé)
  - NWC autorisation: "Bloquer 1000 sats"
  - Fonds restent sur wallet mais "réservés"
  - Libération automatique à la fin
```

### 4. PENDANT LA PARTIE - HITS & PAIEMENTS

```
SCÉNARIO: Tux (A) touche Beastie (B) avec Bowling (-250 sats)

┌─────────────────────────────────────────────┐
│  ÉTAPE 1: HIT DÉTECTÉ (STK)                 │
│  ───────────────────────────                 │
│  STK A envoie au serveur:                   │
│  {                                          │
│    "type": "hit",                           │
│    "room_id": "arena-xyz789",               │
│    "hitter": "Tux",                         │
│    "victim": "Beastie",                     │
│    "weapon": "bowling",                     │
│    "damage": 250,                           │
│    "timestamp": 1234567890,                 │
│    "signature": "hmac..."                   │
│  }                                          │
└─────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│  ÉTAPE 2: VALIDATION SERVEUR                │
│  ───────────────────────────                 │
│  Serveur vérifie:                           │
│  ✓ HMAC signature valide                    │
│  ✓ Temps cohérent (pas de replay)           │
│  ✓ Distance/position réaliste (anti-cheat)  │
│  ✓ Beastie n'est pas déjà mort              │
│                                             │
│  Si valide:                                 │
│  • Calcule: Beastie doit payer 250 à Tux    │
│  • Met à jour les scores en DB              │
│  • Envoie requête de paiement               │
└─────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│  ÉTAPE 3: DÉCLENCHEMENT PAIEMENT (NWC)      │
│  ─────────────────────────────────────       │
│  SERVEUR ──NWC──► WALLET BEASTIE            │
│                                             │
│  Requête: make_invoice                      │
│  {                                          │
│    "amount": 250,                           │
│    "description": "Lightning Arena -        │
│                    Pay Tux for bowling hit  │
│                    Partie #arena-xyz789"    │
│  }                                          │
│                                             │
│  Réponse: invoice "lnbc250n1p..."           │
│                                             │
│  PUIS:                                      │
│                                             │
│  SERVEUR ──NWC──► WALLET TUX                │
│                                             │
│  Requête: pay_invoice                       │
│  {                                          │
│    "invoice": "lnbc250n1p...",              │
│    "amount": 250                            │
│  }                                          │
└─────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│  ÉTAPE 4: CONFIRMATION                      │
│  ─────────────────                          │
│  Tous les joueurs reçoivent via WebSocket:  │
│  {                                          │
│    "event": "payment_confirmed",            │
│    "from": "Beastie",                       │
│    "to": "Tux",                             │
│    "amount": 250,                           │
│    "tx_id": "preimage_abc123..."            │
│  }                                          │
│                                             │
│  HUD mis à jour en temps réel!              │
└─────────────────────────────────────────────┘
```

### 5. FIN DE PARTIE - AUTO-WITHDRAWAL

```
Gagnant: Tux avec 3250 sats (gagné 2250)

Automatiquement:
┌─────────────────────────────────────────────┐
│  SERVEUR calcule:                           │
│  • Tux a gagné: 2250 sats net               │
│  • Fonds déjà sur son wallet (P2P direct)   │
│                                             │
│  Pas besoin de "retrait"!                   │
│  Les sats sont DÉJÀ dans son wallet.        │
│                                             │
│  Ce qu'il voit:                             │
│  "🎉 Victoire!                              │
│   Gain net: +2250 sats                      │
│   Transactions: 12 paiements reçus          │
│   Solde actuel: 7250 sats"                  │
└─────────────────────────────────────────────┘

Perdant: Beastie avec 200 sats (perdu 800)
└─────────────────────────────────────────────┘
│  "💸 Partie terminée                        │
│   Perte nette: -800 sats                    │
│   Solde actuel: 2200 sats"                  │
└─────────────────────────────────────────────┘
```

## 🔐 Sécurité Escrow

### Ce que le serveur NE peut PAS faire:
❌ Voir les clés privées des wallets  
❌ Envoyer de l'argent sans autorisation NWC  
❌ Garder les fonds (ils passent directement P2P)  
❌ Mentir sur les paiements (preimage publique)  

### Ce que le serveur PEUT faire:
✅ Ordonner les paiements (qui paye qui)  
✅ Valider les hits (anti-cheat)  
✅ Gérer l'état du jeu (vie, scores)  
✅ Bannir les tricheurs  

## 💰 Modèle Économique (Frais)

```
Option 1: Pourcentage par transaction
  • Chaque hit: 1% de frais au serveur
  • Ex: Hit de 100 sats → 99 au gagnant, 1 au serveur
  • Transparent, proportionnel

Option 2: Frais fixe par partie
  • 50 sats par joueur pour créer une partie
  • Payé une fois au début
  • Simple, prévisible

Option 3: Gratuit + Donations
  • Pas de frais obligatoires
  • "Tip le serveur" optionnel
  • Modèle communautaire

Option 4: Premium Features
  • Parties gratuites: 4 joueurs max
  • Parties premium: 8+ joueurs, modes spéciaux
  • Abonnement mensuel: features avancées
```

## 🛡️ Anti-Triche

```
Problème: Joueur modifie son client pour dire "J'ai touché"

Solutions:

1. Serveur Authoritative
   - Client envoie: "J'ai tiré un gâteau à (x,y,z)"
   - Serveur calcule: collision ? qui touché ?
   - Client affiche hit SEULEMENT si serveur valide

2. Witness Nodes (optionnel)
   - Autres joueurs valident les hits
   - Consensus type blockchain
   - Plus décentralisé mais complexe

3. Replay Analysis
   - Enregistrement de la partie
   - Analyse post-partie des trajectoires
   - Ban si irrégularités détectées
```

## 🚀 Implémentation

### Stack Technique

```
Backend:
- Node.js + Express
- PostgreSQL (rooms, users, scores)
- Redis (cache temps réel)
- WebSocket (mises à jour live)
- Nostr SDK (NWC communication)

Frontend:
- React / Vue.js
- QR code scanner (NWC)
- WebSocket client
- HUD overlay (si besoin)

NWC:
- @getalby/sdk (Node.js)
- ou nwc-cli
```

### DB Schema

```sql
-- Utilisateurs
users:
  id, username, email, created_at
  nwc_uri_encrypted, nwc_pubkey, nwc_budget_max

-- Parties
rooms:
  id, status (waiting/playing/finished)
  buy_in, max_players, created_at, started_at

-- Joueurs dans partie
room_players:
  room_id, user_id, kart_id, joined_at
  initial_balance, final_balance, status

-- Hits (transferts)
transfers:
  id, room_id, from_user_id, to_user_id
  amount, weapon, timestamp, tx_preimage
  verified (bool)
```

## 📊 Comparatif Architectures

| Critère | Custodial | P2P Pur NWC | Escrow NWC |
|---------|-----------|-------------|------------|
| Serveur détient fonds | ✅ Oui | ❌ Non | ❌ Non |
| UX joueur | 😊 Simple | 😫 Complexe | 😊 Simple |
| Confiance requise | 🔴 Serveur | 🟢 Aucune | 🟡 Minimale |
| Risque rug pull | 🔴 Élevé | 🟢 Nul | 🟢 Nul |
| Scalabilité | 🟢 Bonne | 🟡 Moyenne | 🟢 Bonne |
| Frais | 🟢 Bas | 🟢 Très bas | 🟢 Bas |
| Anonyme | 🟡 Non | 🟢 Oui | 🟡 Non |

---

**Tu veux que j'implémente cette architecture Escrow NWC ?**
