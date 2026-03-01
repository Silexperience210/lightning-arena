# Contributing to Lightning Arena

Thank you for your interest in contributing to Lightning Arena! ⚡

## Development Setup

```bash
# Clone the repo
git clone https://github.com/yourusername/lightning-arena.git
cd lightning-arena

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Start development services
docker-compose up -d postgres redis

# Run migrations
npm run db:migrate

# Start dev server
npm run dev
```

## Code Style

- ESLint for JavaScript
- Prettier for formatting
- Conventional commits

## Testing

```bash
npm test
npm run test:integration
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Commit Message Convention

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `style:` Formatting
- `refactor:` Code restructuring
- `test:` Tests
- `chore:` Maintenance

## Security

Please report security issues to security@lightning-arena.com
