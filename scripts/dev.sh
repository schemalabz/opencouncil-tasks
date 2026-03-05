#!/usr/bin/env bash
#
# Local development script — starts MinIO + the app with hot reload.
#
# Usage:
#   npm run dev                    # starts MinIO + nodemon
#   npm run dev -- --real-spaces   # skip MinIO, use DO Spaces from .env
#
# Prerequisites:
#   - nix develop shell (provides minio, mc, node, npm)
#   - .env configured with API keys
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source .env for existing config (line-by-line to handle values with special chars)
if [[ -f "$PROJECT_DIR/.env" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip comments and blank lines
        [[ -z "$line" || "$line" == \#* ]] && continue
        export "$line" 2>/dev/null || true
    done < "$PROJECT_DIR/.env"
fi

# Ports
MINIO_PORT="${MINIO_PORT:-9100}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9101}"
MINIO_BUCKET="opencouncil-dev"
MINIO_DATA_DIR="${PROJECT_DIR}/.minio-data"
APP_PORT="${PORT:-3005}"

# Parse flags
USE_REAL_SPACES=false
for arg in "$@"; do
    if [[ "$arg" == "--real-spaces" ]]; then
        USE_REAL_SPACES=true
    fi
done

cleanup() {
    echo ""
    if [[ -n "${MINIO_PID:-}" ]]; then
        echo "Stopping MinIO (pid $MINIO_PID)..."
        kill "$MINIO_PID" 2>/dev/null || true
        wait "$MINIO_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

start_app() {
    cd "$PROJECT_DIR"
    exec npx nodemon --watch .env --watch src --exec "tsx" src/server.ts
}

if [[ "$USE_REAL_SPACES" == "true" ]]; then
    echo "Using real DigitalOcean Spaces (skipping MinIO)"
    start_app
fi

# ── Check prerequisites ─────────────────────────────────────────────────────

for cmd in minio mc; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: $cmd is not installed. Run 'nix develop' first."
        exit 1
    fi
done

# ── Start MinIO ──────────────────────────────────────────────────────────────

mkdir -p "$MINIO_DATA_DIR"

echo "Starting MinIO on port $MINIO_PORT (console: $MINIO_CONSOLE_PORT)..."
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
    minio server "$MINIO_DATA_DIR" \
    --address ":$MINIO_PORT" \
    --console-address ":$MINIO_CONSOLE_PORT" \
    --quiet 2>/dev/null &
MINIO_PID=$!

# Wait for MinIO to be ready
for i in $(seq 1 20); do
    if curl -sf "http://localhost:$MINIO_PORT/minio/health/live" >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$MINIO_PID" 2>/dev/null; then
        echo "Error: MinIO exited unexpectedly."
        exit 1
    fi
    sleep 0.5
done

if ! curl -sf "http://localhost:$MINIO_PORT/minio/health/live" >/dev/null 2>&1; then
    echo "Error: MinIO did not become healthy after 10s."
    exit 1
fi

echo "MinIO is ready."

# Create bucket if it doesn't exist
mc alias set dev-minio "http://localhost:$MINIO_PORT" minioadmin minioadmin --quiet 2>/dev/null
mc mb --ignore-existing "dev-minio/$MINIO_BUCKET" --quiet 2>/dev/null
echo "Bucket '$MINIO_BUCKET' ready."

# ── Start app with MinIO env overrides ───────────────────────────────────────

echo ""
echo "Starting dev server (http://localhost:$APP_PORT)..."
echo "MinIO console: http://localhost:$MINIO_CONSOLE_PORT (minioadmin/minioadmin)"
echo ""

cd "$PROJECT_DIR"
NODE_ENV=development \
DO_SPACES_ENDPOINT="http://localhost:$MINIO_PORT" \
DO_SPACES_KEY="minioadmin" \
DO_SPACES_SECRET="minioadmin" \
DO_SPACES_BUCKET="$MINIO_BUCKET" \
CDN_BASE_URL="http://localhost:$APP_PORT/dev/files/$MINIO_BUCKET" \
    start_app
