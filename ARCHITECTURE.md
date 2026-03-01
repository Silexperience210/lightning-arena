# Lightning Arena Architecture

## Overview

Lightning Arena is a **Battle Royale** racing game with Bitcoin Lightning Network integration. Players compete in a "Three Strikes Battle" mode where each hit transfers satoshis between players in real-time.

## Core Concept: Battle Royale + Lightning

### Game Mode: Three Strikes Battle

```
Initial State:
┌─────────────────────────────────────────────────┐
│  10 Players × 1000 sats = 10,000 sats in play   │
│  Each player starts with 100% health (1000/1000)│
└─────────────────────────────────────────────────┘

On Hit:
┌─────────────────────────────────────────────────┐
│  Player A hits Player B with Bowling Ball (-100)│
│  → 100 sats transfer: B → A instantly ⚡        │
│  → Player B health: 900/1000 (-10%)             │
└─────────────────────────────────────────────────┘

Elimination:
┌─────────────────────────────────────────────────┐
│  Player C reaches 0 sats                        │
│  → Spectator mode activated 👻                  │
│  → Can watch remaining players                  │
│  → Balance saved for reconnection (7 days)      │
└─────────────────────────────────────────────────┘

Victory:
┌─────────────────────────────────────────────────┐
│  Last player standing wins the pot! 🏆          │
│  → Signature verified with HMAC-SHA256          │
│  → Auto-withdrawal to winner's LN address       │
└─────────────────────────────────────────────────┘
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     SuperTuxKart Mod                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │   │
│  │  │  Game Logic  │  │ LightningUI  │  │  Networking  │          │   │
│  │  │   (C++)      │  │   (Overlay)  │  │  (ENet+GEP)  │          │   │
│  │  └──────┬───────┘  └──────────────┘  └──────┬───────┘          │   │
│  │         │                                     │                 │   │
│  │  ┌──────▼───────┐                    ┌────────▼──────┐          │   │
│  │  │ three_strikes│◄──────────────────►│ ProtocolMgr   │          │   │
│  │  │  _battle.cpp │  GE_LIGHTNING_     │ (Client/Server)│         │   │
│  │  │              │  TRANSFER events   │               │          │   │
│  │  └──────────────┘                    └───────────────┘          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              ▲                                          │
│                              │ WebSocket / HTTP                        │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────┐
│                           SERVER LAYER                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                      Lightning Arena API                           │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │  │
│  │  │   Express    │  │  Socket.io   │  │  Payment     │            │  │
│  │  │   Server     │  │  (Real-time) │  │  Router      │            │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘            │  │
│  │         │                 │                 │                    │  │
│  │  ┌──────▼─────────────────▼─────────────────▼──────┐             │  │
│  │  │              HYBRID PAYMENT ENGINE               │             │  │
│  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐         │             │  │
│  │  │  │NWC P2P  │  │ Hybrid  │  │ Escrow  │         │             │  │
│  │  │  │ Mode    │  │ Bridge  │  │ Ledger  │         │             │  │
│  │  │  └────┬────┘  └────┬────┘  └────┬────┘         │             │  │
│  │  └───────┼────────────┼────────────┼──────────────┘             │  │
│  └──────────┼────────────┼────────────┼────────────────────────────┘  │
└─────────────┼────────────┼────────────┼────────────────────────────────┘
              │            │            │
┌─────────────▼────────────▼────────────▼────────────────────────────────┐
│                         INFRASTRUCTURE LAYER                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────┐   │
│  │  PostgreSQL  │  │    Redis     │  │  LND Node    │  │  NWC     │   │
│  │  (Transfers, │  │  (Cache,     │  │  (Lightning  │  │ (Nostr   │   │
│  │   Users)     │  │   Sessions)  │  │   Network)   │  │ Wallet)  │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Payment Flow

### NWC P2P Mode (Instant)
```
Player A (NWC)          Server           Player B (NWC)
     │                     │                    │
     │  1. Hit Event       │                    │
     │────────────────────►│                    │
     │                     │  2. Route to B     │
     │                     │───────────────────►│
     │                     │  3. Invoice        │
     │                     │◄───────────────────│
     │  4. Invoice         │                    │
     │◄────────────────────│                    │
     │  5. Payment (NWC)   │                    │
     │─────────────────────┼────────────────────►
     │                     │  6. Preimage       │
     │                     │◄───────────────────│
     │  7. Confirm         │                    │
     │◄────────────────────│                    │
```

### Escrow Mode (Virtual)
```
Player A (Escrow)       Server           Player B (Escrow)
     │                     │                    │
     │  1. Hit Event       │                    │
     │────────────────────►│                    │
     │                     │  2. Atomic TX      │
     │                     │  ┌──────────────┐  │
     │                     │  │ BEGIN        │  │
     │                     │  │ DEBIT A      │  │
     │                     │  │ CREDIT B     │  │
     │                     │  │ COMMIT       │  │
     │                     │  └──────────────┘  │
     │                     │                    │
     │  3. Confirm         │                    │
     │◄────────────────────│                    │
```

## Weapon Damage Table

| Weapon | Damage | Sats | Effect |
|--------|--------|------|--------|
| Bowling Ball | 10% | -100 | Heavy hit |
| Cake | 5% | -50 | Standard |
| Swatter | 10% | -100 | Quick hit |
| Bubblegum | 5% | -50 | Trap |
| Banana | 3% | -30 | Slip |
| Collision | 2% | -20 | Bump |

## Data Models

### User
```javascript
{
  id: UUID,
  username: string,
  ln_address: string,
  wallet_type: 'nwc' | 'escrow' | 'standard',
  escrow_balance_sats: number,
  nwc_uri_encrypted: string (AES-256-GCM)
}
```

### Game
```javascript
{
  id: UUID,
  room_code: string (6 chars),
  status: 'lobby' | 'playing' | 'finished',
  buy_in_sats: number,
  total_pot_sats: number,
  server_fee_percent: number
}
```

### Transfer
```javascript
{
  id: UUID,
  game_id: UUID,
  from_user_id: UUID,
  to_user_id: UUID,
  amount_sats: number,
  weapon_type: string,
  payment_mode: 'nwc_direct' | 'escrow_internal' | 'hybrid_nwc_to_escrow' | 'hybrid_escrow_to_nwc',
  status: 'pending' | 'completed' | 'failed'
}
```

## Security

### Anti-Cheat
- HMAC-SHA256 signatures on all hit events
- Server-authoritative hit validation
- Ticket-based replay protection
- 0.5s cooldown between hits from same player

### Financial Security
- AES-256-GCM encryption for NWC URIs
- Atomic database transactions
- Automatic fallback to escrow on NWC failure
- 7-day balance preservation for disconnections

## Technologies

- **Game**: SuperTuxKart (C++) + AngelScript
- **Server**: Node.js + Express + Socket.io
- **Database**: PostgreSQL 16
- **Cache**: Redis 7
- **Lightning**: LND + @getalby/sdk (NWC)
- **Frontend**: React + CSS Glassmorphism
- **Infrastructure**: Docker + Docker Compose

## License

MIT - See LICENSE file
