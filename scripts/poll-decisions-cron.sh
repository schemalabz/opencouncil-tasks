#!/usr/bin/env bash
#
# Cron script for automated Diavgeia decision polling.
#
# Calls the opencouncil poll-decisions endpoint on a schedule.
#
# Prerequisites:
#   1. The opencouncil deployment must have CRON_SECRET set in its environment
#   2. Add CRON_TARGET_URL and CRON_SECRET to this server's .env:
#        CRON_TARGET_URL=https://opencouncil.gr
#        CRON_SECRET=<same secret as the opencouncil deployment>
#
# Setup:
#   1. Test manually:  ./scripts/poll-decisions-cron.sh
#   2. Install cron (runs every 12 hours):
#        crontab -e
#        0 0,12 * * * /path/to/opencouncil-tasks/scripts/poll-decisions-cron.sh >> /path/to/opencouncil-tasks/logs/poll-decisions-cron.log 2>&1
#   3. Create logs dir:  mkdir -p logs
#
# Monitoring:
#   - Logs: tail -f logs/poll-decisions-cron.log
#   - Polling stats: opencouncil admin UI at /admin/diavgeia
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
