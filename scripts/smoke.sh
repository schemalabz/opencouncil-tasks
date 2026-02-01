#!/usr/bin/env bash
#
# End-to-end smoke test with automatic MinIO + ngrok setup.
#
# Usage:
#   ./scripts/smoke.sh                              # default test video
#   ./scripts/smoke.sh "https://youtube.com/..."    # custom video
#   ./scripts/smoke.sh -O result.json               # save output
#
# Prerequisites:
#   - nix develop shell (provides minio, mc, ngrok, node, npm)
#   - ngrok authenticated (ngrok config add-authtoken <token>)
#   - .env configured with API keys for Gladia, Pyannote, etc.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Ports
CLI_PORT="${CLI_PORT:-9876}"
MINIO_PORT="${MINIO_PORT:-9100}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9101}"
MINIO_BUCKET="opencouncil-dev"
MINIO_DATA_DIR="${PROJECT_DIR}/.minio-data"

cleanup() {
    echo ""
    if [[ -n "${NGROK_PID:-}" ]]; then
        echo "Stopping ngrok (pid $NGROK_PID)..."
        kill "$NGROK_PID" 2>/dev/null || true
        wait "$NGROK_PID" 2>/dev/null || true
    fi
    if [[ -n "${MINIO_PID:-}" ]]; then
        echo "Stopping MinIO (pid $MINIO_PID)..."
        kill "$MINIO_PID" 2>/dev/null || true
        wait "$MINIO_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ── Check prerequisites ──────────────────────────────────────────────────────

for cmd in ngrok minio mc node npm; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: $cmd is not installed. Run 'nix develop' first."
        exit 1
    fi
done

# ── Start MinIO ──────────────────────────────────────────────────────────────

rm -rf "$MINIO_DATA_DIR"
mkdir -p "$MINIO_DATA_DIR"

echo "Starting MinIO on port $MINIO_PORT..."
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
mc alias set smoke-minio "http://localhost:$MINIO_PORT" minioadmin minioadmin --quiet 2>/dev/null
mc mb --ignore-existing "smoke-minio/$MINIO_BUCKET" --quiet 2>/dev/null
echo "Bucket '$MINIO_BUCKET' ready."

# ── Start ngrok ──────────────────────────────────────────────────────────────

NGROK_LOG=$(mktemp)
echo ""
echo "Starting ngrok tunnel on port $CLI_PORT..."
ngrok http "$CLI_PORT" --log="$NGROK_LOG" --log-level=info >/dev/null 2>&1 &
NGROK_PID=$!

echo "Waiting for ngrok tunnel..."
NGROK_URL=""
for i in $(seq 1 30); do
    if ! kill -0 "$NGROK_PID" 2>/dev/null; then
        echo "Error: ngrok exited unexpectedly. Log output:"
        cat "$NGROK_LOG"
        rm -f "$NGROK_LOG"
        exit 1
    fi

    NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
        | grep -o '"public_url":"https://[^"]*"' \
        | head -1 \
        | cut -d'"' -f4) || true
    if [[ -n "$NGROK_URL" ]]; then
        break
    fi

    # Fallback: parse from ngrok log
    NGROK_URL=$(grep -o 'url=https://[^ ]*' "$NGROK_LOG" 2>/dev/null \
        | head -1 \
        | cut -d= -f2) || true
    if [[ -n "$NGROK_URL" ]]; then
        break
    fi

    sleep 0.5
done

rm -f "$NGROK_LOG"

if [[ -z "$NGROK_URL" ]]; then
    echo "Error: Could not get ngrok public URL after 15s."
    echo "Try running 'ngrok http $CLI_PORT' manually to diagnose."
    exit 1
fi

echo "Tunnel established: $NGROK_URL"

# ── Prepare isolated data directory for this smoke run ───────────────────────

SMOKE_DATA_DIR="${PROJECT_DIR}/data/smoke-test"
rm -rf "$SMOKE_DATA_DIR"
mkdir -p "$SMOKE_DATA_DIR"
echo "Using clean data directory: data/smoke-test/"

# ── Run smoke test ───────────────────────────────────────────────────────────

echo ""
cd "$PROJECT_DIR"

PUBLIC_URL="$NGROK_URL" \
CLI_PORT="$CLI_PORT" \
DATA_DIR="$SMOKE_DATA_DIR" \
DO_SPACES_ENDPOINT="http://localhost:$MINIO_PORT" \
DO_SPACES_KEY="minioadmin" \
DO_SPACES_SECRET="minioadmin" \
DO_SPACES_BUCKET="$MINIO_BUCKET" \
CDN_BASE_URL="$NGROK_URL/dev/files/$MINIO_BUCKET" \
    npm run smoke -- "$@"
