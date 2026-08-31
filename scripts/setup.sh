#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "→ [1/2] Installing JS dependencies (bun)..."
bun install

echo "→ [2/2] Installing Python dependencies (uv)..."
if ! command -v uv >/dev/null 2>&1; then
  echo "✗ uv not found."
  echo "  Install uv first: curl -LsSf https://astral.sh/uv/install.sh | sh"
  echo "  Docs: https://docs.astral.sh/uv/getting-started/installation/"
  exit 1
fi

# uv sync is idempotent and fast if already synced; uses frozen lock for reproducibility
(
  cd apps/serve
  uv sync --frozen
)

echo "✓ Setup complete."
echo "  Run 'bun run dev' to start both services (or 'bun run dev:quick' to skip this check)."
