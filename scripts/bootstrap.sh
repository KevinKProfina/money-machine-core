#!/usr/bin/env bash
# Clones (or updates) all Money Machine repos next to each other, installs
# dependencies and runs a health check. Usage: scripts/bootstrap.sh [parent-dir]
set -euo pipefail
OWNER="${MM_GITHUB_OWNER:-KevinKProfina}"
BRANCH="${MM_BRANCH:-main}"
PARENT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
REPOS=(money-machine-core solana-trading-agent liquidation-hunter capital-allocator orchestrator revenue-engine agent-marketplace)

mkdir -p "$PARENT"
for repo in "${REPOS[@]}"; do
  if [ -d "$PARENT/$repo/.git" ]; then
    echo "→ updating $repo"
    git -C "$PARENT/$repo" fetch --quiet origin "$BRANCH"
    git -C "$PARENT/$repo" checkout --quiet "$BRANCH"
    git -C "$PARENT/$repo" pull --quiet --ff-only origin "$BRANCH"
  else
    echo "→ cloning $repo"
    git clone --quiet --branch "$BRANCH" "https://github.com/$OWNER/$repo.git" "$PARENT/$repo"
  fi
done

cd "$PARENT/money-machine-core"
npm ci --no-audit --no-fund
npm run install-all
npm run doctor
echo "done. next: cd $PARENT/money-machine-core && npm run once   (or: npm start)"
