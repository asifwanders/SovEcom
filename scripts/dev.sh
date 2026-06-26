#!/usr/bin/env bash
set -e

echo "Starting SovEcom development environment..."
echo ""

# Start infrastructure services
echo "→ Starting Postgres, Redis, and Meilisearch..."
docker compose -f docker-compose.dev.yml up -d

# Wait for services to be ready
echo "→ Waiting for services to be healthy..."
sleep 3

# Start all apps in parallel with turbo
echo "→ Starting all applications..."
pnpm dev
