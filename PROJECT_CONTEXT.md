# ⚡ Lightning Arena - Project Context

> **AI CONTEXT FILE** - Read this when resuming work on this project

## 🎯 What is this?

Bitcoin Lightning Network integrated Battle Royale racing game.
- **Game:** SuperTuxKart mod (C++)
- **Server:** Node.js + Express + PostgreSQL + Redis
- **Payments:** NWC P2P (wallet-to-wallet, no custody)

## 🚀 Quick Resume

```bash
# Project location
cd C:\dev\stk-code\lightning_server

# Start local (NWC only, no LND needed)
docker-compose -f docker-compose.nwc-only.yml up -d

# Or public with localtunnel (no token)
./scripts/start-localtunnel.sh
```

## 📋 Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| Backend API | ✅ Complete | PaymentRouter V2, NWC simplified |
| Database | ✅ Complete | PostgreSQL schema |
| Frontend | ✅ Complete | React, glassmorphism UI |
| Docker | ✅ Complete | Multiple compose files |
| STK Mod | ✅ Complete | C++ three_strikes_battle |
| Deep Linking | ⏳ Pending | UX integration next step |

## 🔑 Key Files

```
src/PaymentRouter.js          # V2 - NWC orchestrator (simplified)
docs/FLUID_INTEGRATION.md     # UX transition solutions
.github/                      # Repo: Silexperience210/lightning-arena
```

## 🎮 Next Priority

**Fluid UX Integration:**
1. Deep Linking (stk:// protocol) - 2 days
2. QR Code in-game - 1 day
3. Testing with real wallets

See `.kimi/skills/lightning-arena/SKILL.md` for full context.

---

**GitHub:** https://github.com/Silexperience210/lightning-arena
