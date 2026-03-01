# Lightning Arena - Project Context

## 🎯 Overview

**Lightning Arena** is a Bitcoin Lightning Network integrated Battle Royale racing game based on SuperTuxKart. Players compete in "Three Strikes Battle" mode where each hit transfers satoshis between players in real-time.

**Repository:** `C:\dev\stk-code\lightning_server`  
**GitHub:** https://github.com/Silexperience210/lightning-arena  
**Stack:** Node.js + Express + PostgreSQL + Redis + Socket.io + React + C++ (STK Mod)

---

## 🏗️ Architecture

### Core Concept
```
Battle Royale + Lightning Payments
- 10 players × 1000 sats = 10,000 sats in play
- Each hit transfers sats: victim → attacker
- Weapons have different damage/satoshi values
- Last player standing wins the pot
```

### Payment Modes

| Mode | Description | Requirements |
|------|-------------|--------------|
| **NWC_P2P** | Direct wallet-to-wallet via Nostr Wallet Connect | Both players need NWC (Alby, BlueWallet, Blixt) |
| **ESCROW_INTERNAL** | Virtual ledger update in PostgreSQL | Both players in escrow mode |
| **HYBRID_NWC_TO_ESCROW** | NWC payer → Server LND → Escrow receiver | LND required |
| **HYBRID_ESCROW_TO_NWC** | Escrow payer → Server LND → NWC receiver | LND required |

**IMPORTANT:** Default mode is NWC_P2P_ONLY (no LND required). Server acts as orchestrator only.

---

## 📁 Project Structure

```
lightning_server/
├── server.js                    # Main Express server
├── schema.sql                   # PostgreSQL schema
├── package.json                 # Dependencies
├── .env.example                 # Configuration template
│
├── src/
│   ├── PaymentRouter.js         # V2 - Simplified NWC orchestrator
│   ├── PaymentRouter.v1.js      # Backup of V1
│   ├── lnd-client.js            # LND gRPC client (optional)
│   └── worker.js                # Background jobs
│
├── frontend/
│   └── src/components/
│       ├── WalletConnector.jsx  # React UI (Glassmorphism)
│       ├── WalletConnector.css  # Apple-style design
│       ├── package.json         # React deps
│       └── Dockerfile           # Build container
│
├── stk-mod/                     # SuperTuxKart C++ mod
│   ├── src/modes/
│   │   ├── three_strikes_battle.cpp
│   │   └── three_strikes_battle.hpp
│   └── README.md
│
├── scripts/                     # Deployment automation
│   ├── start-ngrok.sh / .ps1
│   ├── start-localtunnel.sh / .ps1
│   └── quick-demo.sh / .ps1
│
├── docker-compose.yml           # Full stack (with LND)
├── docker-compose.nwc-only.yml  # NWC only (recommended)
├── docker-compose.ngrok.yml     # Public with ngrok
├── docker-compose.localtunnel.yml # Public without token
├── docker-compose.cloudflare.yml  # Public with fixed URL
│
└── docs/
    ├── FLUID_INTEGRATION.md     # UX transition solutions
    ├── NWC_OPTIMIZATIONS.md     # NWC expert analysis
    └── ARCHITECTURE.md          # Technical architecture
```

---

## 🚀 Quick Start Commands

```bash
# 1. Local development (NWC only, no LND)
docker-compose -f docker-compose.nwc-only.yml up -d

# 2. Public deployment without token
./scripts/start-localtunnel.sh

# 3. Public deployment with ngrok
./scripts/start-ngrok.sh YOUR_NGROK_TOKEN

# 4. Production with fixed URL (Cloudflare)
docker-compose -f docker-compose.cloudflare.yml up -d
```

---

## 🔧 Key Technical Details

### NWC P2P Flow (Primary Mode)
```javascript
// 1. Receiver creates invoice via their NWC
const invoice = await toNWC.makeInvoice({
  amount: amount * 1000,  // millisats
  description: "Lightning Arena",
  expiry: 120
});

// 2. Payer pays via their NWC
const payment = await fromNWC.payInvoice({ invoice });

// 3. Server logs the result
await db('transfers').update({
  status: 'completed',
  preimage: payment.preimage
});
```

**Note:** Budget management is handled NATIVE by NWC (max_amount, budget_renewal), NOT by server.

### Environment Variables
```bash
# Required for NWC-only mode
JWT_SECRET=...                    # openssl rand -hex 32
NWC_ENCRYPTION_KEY=...            # openssl rand -hex 32  
DB_PASSWORD=...

# Optional (for hybrid mode with LND)
LND_ENABLED=false                 # Set to true if using LND
LND_GRPC_HOST=localhost:10009
LND_MACAROON_PATH=...
LND_TLS_CERT_PATH=...
```

### Weapon Damage Table
| Weapon | Damage | Sats |
|--------|--------|------|
| Bowling Ball | 10% | -100 |
| Swatter | 10% | -100 |
| Cake | 5% | -50 |
| Bubblegum | 5% | -50 |
| Banana | 3% | -30 |
| Collision | 2% | -20 |

---

## 🎮 SuperTuxKart Integration

### Current Status
- C++ mod exists in `stk-mod/`
- Game mode: Three Strikes Battle
- Network protocol: Custom GE_LIGHTNING_TRANSFER events
- Needs: Deep linking integration for fluid UX

### Next Steps (To Discuss)
1. **Deep Linking** (Recommended): Add stk:// protocol handler
2. **QR Code**: In-game QR for mobile wallet connection
3. **Electron App**: Unified desktop application
4. **CEF WebView**: Native web rendering in STK

See `docs/FLUID_INTEGRATION.md` for complete analysis.

---

## 💡 Important Design Decisions

1. **NWC manages budgets natively** - Server doesn't validate limits
2. **No LND required for NWC-P2P** - Pure wallet-to-wallet
3. **Server is orchestrator only** - No custody of funds
4. **AES-256-GCM encryption** for NWC URIs at rest
5. **Atomic PostgreSQL transactions** for escrow mode

---

## 🔗 Related Repositories

- **GitHub:** https://github.com/Silexperience210/lightning-arena
- **STK Source:** https://github.com/supertuxkart/stk-code
- **NWC Spec:** https://nips.nostr.com/47
- **Alby SDK:** https://github.com/getAlby/js-sdk

---

## 📞 Context for AI Assistant

When resuming work on this project:

1. **Always check** `C:\dev\stk-code\lightning_server` exists
2. **Default mode** is NWC_P2P_ONLY (no LND complications)
3. **PaymentRouter.js** is V2 (simplified, not V1)
4. **Frontend** uses React with glassmorphism design
5. **STK mod** is C++ in `stk-mod/src/modes/`
6. **Next priority** is fluid UX (Deep Linking / QR Code)

**Current blockers to address:**
- STK needs stk:// protocol handler for deep linking
- Wallet connection UX needs to be seamless (not popup windows)
- Testing with real NWC wallets (Alby, BlueWallet)

---

*Last updated: 2026-03-01*  
*Project status: Core complete, UX integration pending*
