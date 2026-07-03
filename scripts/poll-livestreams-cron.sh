#!/usr/bin/env bash
#
# Cron script for automated livestream matching and transcription.
#
# Calls the opencouncil poll-livestreams endpoint on a schedule. Each run the
# endpoint finds council meetings scheduled within ±12h of now, matches each to a
# recent video on its administrative body's YouTube channel (via the YouTube Data
# API + Claude), and triggers transcription for confident single-meeting matches.
# Videos that appear to cover multiple meetings are left for manual handling and
# raise a one-time Discord alert.
#
# Prerequisites:
#   1. The opencouncil deployment must have set in its environment:
#        - CRON_SECRET       (same secret as below)
#        - YOUTUBE_API_KEY   (else the endpoint no-ops)
#        - CACHE_URL         (optional; without it the multi-meeting alert may repeat)
#      Each administrative body to poll must have youtubeChannelUrl set.
#   2. Add CRON_TARGET_URL and CRON_SECRET to this server's .env:
#        CRON_TARGET_URL=https://opencouncil.gr
#        CRON_SECRET=<same secret as the opencouncil deployment>
#
# Setup:
#   1. Test manually:  ./scripts/poll-livestreams-cron.sh
#      (append ?dryRun=1 to ENDPOINT below, or curl it by hand, to log decisions
#       without triggering transcription or posting alerts)
#   2. Install cron (runs every 15 minutes):
#        crontab -e
#        */15 * * * * /path/to/opencouncil-tasks/scripts/poll-livestreams-cron.sh >> /path/to/opencouncil-tasks/logs/poll-livestreams-cron.log 2>&1
#   3. Create logs dir:  mkdir -p logs
#
# Monitoring:
#   - Logs: tail -f logs/poll-livestreams-cron.log
#   - Auto-match and multi-meeting notifications are posted to the admin Discord
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

ENDPOINT="${CRON_TARGET_URL}/api/cron/poll-livestreams"

echo "[$(date -Iseconds)] Polling ${ENDPOINT}"
RESPONSE=$(curl -sf -H "Authorization: Bearer ${CRON_SECRET}" "${ENDPOINT}" 2>&1) || {
    echo "[$(date -Iseconds)] ERROR: curl failed (exit $?)"
    echo "$RESPONSE"
    exit 1
}

echo "[$(date -Iseconds)] OK: ${RESPONSE}"
