# Lightning Arena - STK Mod

SuperTuxKart mod implementing **Three Strikes Battle** with Bitcoin Lightning Network integration.

## 🎮 Features

- **Battle Royale Mode**: Last kart standing wins the pot
- **P2P Lightning Payments**: Instant satoshi transfers on every hit
- **Weapon System**: Bowling, Cake, Swatter, Bubblegum with different damage
- **Spectator Mode**: Watch after elimination
- **Anti-Cheat**: Server-authoritative validation

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│           SuperTuxKart Client                   │
│  ┌─────────────────────────────────────────┐   │
│  │      ThreeStrikesBattle Mode            │   │
│  │  ┌────────────┐  ┌─────────────────┐   │   │
│  │  │ KartHit()  │  │ LightningUI     │   │   │
│  │  │ - Validate │  │ - Balance       │   │   │
│  │  │ - Transfer │  │ - Payments      │   │   │
│  │  └─────┬──────┘  └─────────────────┘   │   │
│  │        │                                │   │
│  │  ┌─────▼────────────────────────┐       │   │
│  │  │ GameEventsProtocol           │       │   │
│  │  │ GE_LIGHTNING_TRANSFER event  │       │   │
│  │  └─────────────────────────────┘       │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
                        │
                        │ WebSocket
                        ▼
┌─────────────────────────────────────────────────┐
│         Lightning Arena Server                  │
│         (Node.js + PostgreSQL)                  │
└─────────────────────────────────────────────────┘
```

## 📁 Files

| File | Description |
|------|-------------|
| `src/modes/three_strikes_battle.cpp` | Main game mode logic |
| `src/modes/three_strikes_battle.hpp` | Header file |
| `assets/` | UI icons and resources |

## 🔨 Building

### Prerequisites
- SuperTuxKart source code
- CMake 3.16+
- C++17 compiler

### Installation

```bash
# 1. Clone STK source
git clone https://github.com/supertuxkart/stk-code.git
cd stk-code

# 2. Copy mod files
cp -r ../lightning-arena/stk-mod/src/modes/* src/modes/
cp -r ../lightning-arena/stk-mod/assets/* data/gui/icons/

# 3. Build
mkdir cmake_build && cd cmake_build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)

# 4. Run
./bin/supertuxkart
```

## 🎯 Game Mode

### Three Strikes Battle Rules

1. **Buy-in**: 1000 sats = 100% health
2. **On Hit**: Sats transfer from victim to attacker
3. **Weapons**:
   - Bowling Ball: -100 sats (10%)
   - Swatter: -100 sats (10%)
   - Cake: -50 sats (5%)
   - Bubblegum: -50 sats (5%)
   - Banana: -30 sats (3%)
   - Collision: -20 sats (2%)

4. **Elimination**: 0 sats = spectator mode
5. **Victory**: Last player standing wins pot

### Network Protocol

```cpp
// Client sends hit to server
GE_LIGHTNING_TRANSFER
├── victim_id (uint8)
├── hitter_id (uint8)
├── amount (int16)
├── weapon_type (uint8)
└── signature (HMAC-SHA256)

// Server broadcasts to all
GE_LIGHTNING_TRANSFER confirmation
├── success (bool)
├── new_balances[]
└── tx_preimage (optional for NWC)
```

## 🔐 Anti-Cheat

- Server-authoritative hit validation
- 0.5s cooldown between hits from same player
- HMAC-SHA256 signatures on victory claims
- Replay protection with ticket system

## 📡 Server Connection

```cpp
// config/server_config.xml
<lightning-server>
    <url>wss://lightning-arena.com</url>
    <fallback>wss://backup.lightning-arena.com</fallback>
</lightning-server>
```

## 📝 License

GPL-3.0 (Same as SuperTuxKart)

See parent repository for full license.
