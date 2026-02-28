#!/usr/bin/env bash
#
# Cron script for automated Diavgeia decision polling.
#
# Calls the opencouncil poll-decisions endpoint on a schedule.
# See docs/pollDecisions.md for setup instructions.
#
# Required environment variables (set in .env alongside this script):
#   CRON_TARGET_URL  - Base URL of the opencouncil deployment (e.g., https://opencouncil.gr)
#   CRON_SECRET      - Shared secret for authenticating cron requests
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env from the project root
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
fi

if [[ -z "${CRON_TARGET_URL:-}" ]]; then
    echo "Error: CRON_TARGET_URL is not set"
    exit 1
fi

if [[ -z "${CRON_SECRET:-}" ]]; then
    echo "Error: CRON_SECRET is not set"
    exit 1
fi

ENDPOINT="${CRON_TARGET_URL}/api/cron/poll-decisions"

echo "[$(date -Iseconds)] Polling ${ENDPOINT}"
RESPONSE=$(curl -sf -H "Authorization: Bearer ${CRON_SECRET}" "${ENDPOINT}" 2>&1) || {
    echo "[$(date -Iseconds)] ERROR: curl failed (exit $?)"
    echo "$RESPONSE"
    exit 1
}

echo "[$(date -Iseconds)] OK: ${RESPONSE}"
