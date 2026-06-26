#!/bin/sh
set -e

echo "Running database migrations..."
# TODO: Add migration runner here
# pnpm --filter @sovecom/api migrate:up

echo "Starting application..."
exec "$@"
