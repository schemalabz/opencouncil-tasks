#!/usr/bin/env bash
#
# End-to-end smoke test with automatic MinIO + ngrok setup (via dev-stack.sh).
#
# Usage:
#   ./scripts/smoke.sh                              # default test video
#   ./scripts/smoke.sh "https://youtube.com/..."    # custom video
#   ./scripts/smoke.sh -O result.json               # save output
#
# Prerequisites:
#   - nix develop shell (provides minio, mc, ngrok, node, npm)
#   - ngrok authenticated (ngrok config add-authtoken <token>)
#   - .env configured with API keys for ElevenLabs, Pyannote, etc.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SMOKE_DATA_DIR="${PROJECT_DIR}/data/smoke-test"
rm -rf "$SMOKE_DATA_DIR"
mkdir -p "$SMOKE_DATA_DIR"
echo "Using clean data directory: data/smoke-test/"

DATA_DIR="$SMOKE_DATA_DIR" exec "$SCRIPT_DIR/dev-stack.sh" npm run smoke -- "$@"
