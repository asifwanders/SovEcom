#!/usr/bin/env bash
set -e

echo "Resetting SovEcom development environment..."
echo ""

# Stop and remove dev containers
echo "→ Stopping development services..."
docker compose -f docker-compose.dev.yml down -v

# Clear pnpm store and node_modules (optional, kept conservative)
echo "→ Cleaning build artifacts..."
rm -rf .turbo
pnpm -r exec rm -rf dist .next

echo ""
echo "✓ Environment reset. Run ./scripts/dev.sh to start fresh."
