#!/usr/bin/env bash
# Installs all components of the Money Machine monorepo and runs a health check.
# Usage: scripts/bootstrap.sh   (run from anywhere inside the repo)
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund
npm run install-all
npm run doctor
echo "done. next: npm run once   (or: npm start, or docker compose -f deploy/docker-compose.yml up -d --build)"
