# =====================================================
# LIGHTNING ARENA API - Dockerfile
# =====================================================

FROM node:20-alpine AS base

# Install dependencies
RUN apk add --no-cache python3 make g++ curl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Copy dependencies from base
COPY --from=base /app/node_modules ./node_modules

# Copy application code
COPY . .

# Create directory for LND credentials
RUN mkdir -p /app/lnd

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/api/health || exit 1

# Run the server
CMD ["node", "server.js"]
