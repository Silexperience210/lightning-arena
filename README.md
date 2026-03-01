# ⚡ Lightning Arena Server

**Hybrid NWC + Escrow Payment Infrastructure** for the SuperTuxKart Lightning Arena mod.

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        LIGHTNING ARENA                          │
│                    Hybrid Payment Architecture                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   NWC Mode   │    │ Hybrid Mode  │    │ Escrow Mode  │      │
│  │  (Instant)   │◄──►│  (Bridge)    │◄──►│  (Standard)  │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         │                   │                   │              │
│         ▼                   ▼                   ▼              │
│  ┌──────────────────────────────────────────────────────┐     │
│  │              PAYMENT ROUTER ENGINE                    │     │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │     │
│  │  │ Route       │  │ NWC P2P     │  │ Escrow      │   │     │
│  │  │ Determiner  │  │ Executor    │  │ Ledger      │   │     │
│  │  └─────────────┘  └─────────────┘  └─────────────┘   │     │
│  └──────────────────────────┬───────────────────────────┘     │
│                             │                                  │
│                             ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                    DATA LAYER                             │ │
│  │  PostgreSQL (transfers, users) ◄──► Redis (cache, sessions)│ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 🎯 Key Features

### 1. Hybrid Wallet Support

| Feature | NWC Mode | Escrow Mode |
|---------|----------|-------------|
| **Wallets** | Alby, BlueWallet, Blixt | WoS, Phoenix, Standard LN |
| **Speed** | Instant (~1s) | Virtual (<10ms) |
| **Fees** | 0% | 0% |
| **Setup** | NWC Connection URI | Lightning Address |
| **Custody** | Non-custodial | Server holds game funds |

### 2. Payment Modes

```javascript
// MODE 1: NWC P2P (Both players have NWC)
Player A (NWC) ──► makes invoice ──► Player B (NWC) pays directly
                   
// MODE 2: Escrow Internal (Both escrow)
Player A (Escrow) ──► server updates ledger ──► Player B (Escrow)

// MODE 3: Hybrid NWC → Escrow
Player A (NWC) ──► pays server LND ──► server credits Player B (Escrow)

// MODE 4: Hybrid Escrow → NWC  
Player A (Escrow) ──► server debits ──► pays Player B (NWC) via LND
```

### 3. Security

- **NWC Encryption**: AES-256-GCM for NWC URIs at rest
- **Transaction Atomicity**: PostgreSQL ACID guarantees
- **Replay Protection**: HMAC-SHA256 signatures on game events
- **Auto-Fallback**: Escrow backup when NWC fails

## 🚀 Quick Start

### Option A: NWC P2P Only (No LND required!)
For instant wallet-to-wallet payments using Nostr Wallet Connect.

```bash
# 1. Clone
git clone https://github.com/silexperience210/lightning-arena.git
cd lightning-arena

# 2. Configure (minimal)
cp .env.example .env
# Edit .env - only need JWT_SECRET, NWC_ENCRYPTION_KEY, DB_PASSWORD

# 3. Start (NO LND needed!)
docker-compose -f docker-compose.nwc-only.yml up -d

# 4. Done! http://localhost:3000
```

**Requirements for players:** All players must have NWC-compatible wallets (Alby, BlueWallet, Blixt).

### Option B: Full Hybrid Mode (LND required)
For full escrow support and compatibility with all Lightning wallets.

### Prerequisites

- Docker & Docker Compose
- Node.js 18+ (for local dev)
- LND node (testnet or mainnet) - ONLY for hybrid/escrow modes

### 1. Clone & Setup

```bash
git clone https://github.com/yourusername/lightning-arena-server.git
cd lightning-arena-server
cp .env.example .env
# Edit .env with your configuration
```

### 2. Generate Keys

```bash
# Generate JWT secret
openssl rand -hex 32

# Generate AES-256 encryption key for NWC
openssl rand -hex 32
```

### 3. Start Services

```bash
docker-compose up -d
```

### 4. Initialize Database

```bash
docker-compose exec postgres psql -U lightning -d lightning_arena -f /docker-entrypoint-initdb.d/schema.sql
```

### 5. Verify

```bash
curl http://localhost:3001/api/health
```

## 📡 API Endpoints

### Authentication
```http
POST /api/auth/register
POST /api/auth/login
```

### Wallet
```http
POST /api/wallet/detect           # Detect wallet type
POST /api/wallet/nwc/connect      # Connect NWC wallet
POST /api/wallet/nwc/disconnect   # Disconnect NWC
GET  /api/wallet/balance          # Get hybrid balance
POST /api/wallet/deposit          # Create deposit invoice
GET  /api/wallet/deposit/:hash    # Check deposit status
POST /api/wallet/withdraw         # Request withdrawal
```

### Game
```http
POST /api/games                   # Create game room
POST /api/games/:code/join        # Join game
GET  /api/games/:id               # Get game status
```

### Payment
```http
POST /api/payments/execute        # Execute transfer
GET  /api/payments/history        # Transfer history
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing key | Required |
| `NWC_ENCRYPTION_KEY` | AES-256 key (hex) | Required |
| `DB_PASSWORD` | PostgreSQL password | Required |
| `LND_GRPC_HOST` | LND gRPC endpoint | localhost:10009 |
| `LND_MACAROON_PATH` | Path to admin.macaroon | Required |
| `LND_TLS_CERT_PATH` | Path to tls.cert | Required |

## 📊 Database Schema

### Key Tables

```sql
users (id, username, ln_address, wallet_type, 
       nwc_uri_encrypted, escrow_balance_sats, ...)

games (id, room_code, status, buy_in_sats, 
       total_pot_sats, server_fee_sats, ...)

transfers (id, game_id, from_user_id, to_user_id,
           amount_sats, payment_mode, status, ...)
```

See `schema.sql` for complete schema.

## 🧪 Testing

```bash
# Run unit tests
npm test

# Run integration tests
npm run test:integration

# Load test
npm run test:load
```

## 🏭 Production Deployment

### AWS (Terraform)

```bash
cd terraform/
terraform init
terraform plan
terraform apply
```

### Required Resources

- ECS Fargate (API containers)
- RDS PostgreSQL
- ElastiCache Redis
- EC2 (LND node)
- Application Load Balancer
- Route53 DNS

### Security Checklist

- [ ] Enable TLS 1.3 only
- [ ] Configure WAF rules
- [ ] Set up CloudWatch alarms
- [ ] Enable database encryption at rest
- [ ] Rotate JWT secrets regularly
- [ ] Backup LND channels

## 📈 Monitoring

### Metrics

```javascript
// Prometheus metrics exposed at /metrics
lightning_transfers_total{mode="nwc_p2p"}
lightning_transfers_total{mode="escrow_internal"}
lightning_transfer_duration_seconds
lightning_escrow_balance_sats
lnd_wallet_balance_sats
```

### Logs

```bash
# View API logs
docker-compose logs -f api

# View LND logs
docker-compose logs -f lnd
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📜 License

MIT License - See LICENSE file for details

## 🔗 Resources

- [NWC Specification](https://github.com/getAlby/nostr-wallet-connect)
- [LND Documentation](https://docs.lightning.engineering/)
- [SuperTuxKart](https://supertuxkart.net/)

---

**⚡ Built by Bitcoiners, for Bitcoiners ⚡**
