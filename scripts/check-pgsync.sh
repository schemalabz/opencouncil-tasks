#!/usr/bin/env bash
#
# check-pgsync.sh - Alert when the PGSync daemon crashes or logs errors
#
# Docker's restart policy brings a crashed daemon back within seconds, so
# `docker ps` shows it running whatever happened. This check compares the
# container's restart count and start time with the previous run, and scans
# the log written since then. Run it from cron, next to check-wal.sh:
#
#   */10 * * * * cd /root/opencouncil-tasks && ./scripts/check-pgsync.sh >> logs/pgsync-check.log 2>&1
#
# The first run records the state and alerts on nothing.
#
# Environment variables (set in .env or export):
#   ALERT_WEBHOOK_URL   - Discord/Slack webhook, as for check-wal.sh (optional)
#   PGSYNC_CONTAINER    - Container name (default: opencouncil-tasks-pgsync-1)
#   PGSYNC_CHECK_STATE  - State file (default: logs/.pgsync-check.state)
#
# Exit status: 0 healthy, 1 errors in the log, 2 the daemon is down or restarted,
# 3 the alert could not be sent. After a failed send the state stays as it was,
# so the next run reports the same incident again.
set -euo pipefail

if [ -f .env ]; then set -a; . ./.env; set +a; fi
for dep in docker jq curl; do
  command -v "$dep" >/dev/null 2>&1 || { echo "check-pgsync.sh needs $dep"; exit 3; }
done
WEBHOOK_URL=${ALERT_WEBHOOK_URL:-}
CONTAINER=${PGSYNC_CONTAINER:-opencouncil-tasks-pgsync-1}
STATE=${PGSYNC_CHECK_STATE:-logs/.pgsync-check.state}
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

send_alert() {  # severity, title, message; fails when the webhook does not accept it
  [ -n "$WEBHOOK_URL" ] || return 0
  local color=16744448
  [ "$1" = critical ] && color=16711680
  local payload
  payload=$(jq -n --arg title "$2" --arg description "$3" --argjson color "$color" \
    --arg container "$CONTAINER" --arg host "$(hostname)" \
    '{embeds: [{title: $title, description: $description, color: $color,
       fields: [{name: "Container", value: ("`" + $container + "`"), inline: true},
                {name: "Host", value: ("`" + $host + "`"), inline: true}],
       footer: {text: "PGSync check"}}]}')
  curl -sf -o /dev/null --max-time 20 -X POST -H "Content-Type: application/json" -d "$payload" "$WEBHOOK_URL" \
    || { echo "[$NOW] could not send the alert to the webhook"; return 1; }
}

if ! info=$(docker inspect -f '{{.RestartCount}} {{.State.Running}} {{.State.StartedAt}}' "$CONTAINER" 2>/dev/null); then
  echo "[$NOW] CRITICAL: container $CONTAINER does not exist"
  send_alert critical "🚨 PGSync daemon missing" "Container \`$CONTAINER\` does not exist." || exit 3
  exit 2
fi
read -r restarts running started <<<"$info"

mkdir -p "$(dirname "$STATE")"
if [ ! -f "$STATE" ]; then
  echo "$restarts $started $NOW" > "$STATE"
  echo "[$NOW] first run: recorded restarts=$restarts started=$started"
  exit 0
fi
read -r last_restarts last_started last_check < "$STATE"

# PGSync logs `<time>:ERROR:pgsync...` and Python tracebacks; its status line
# ("Sync ... Xlog: [n] => Db: [n] ...") is not an error.
errors=$(docker logs --since "$last_check" "$CONTAINER" 2>&1 | grep -E ':ERROR:|Traceback|:CRITICAL:' || true)
error_count=$(printf '%s' "$errors" | grep -c . || true)
last_error=$(printf '%s' "$errors" | tail -1 | cut -c1-500)

status=0
sent=true
if [ "$running" != true ]; then
  echo "[$NOW] CRITICAL: $CONTAINER is not running"
  send_alert critical "🚨 PGSync daemon down" "\`$CONTAINER\` is not running. Last error: ${last_error:-none in the log since $last_check}" || sent=false
  status=2
elif [ "$restarts" -gt "$last_restarts" ] || [ "$started" != "$last_started" ]; then
  echo "[$NOW] CRITICAL: $CONTAINER restarted (restart count $last_restarts -> $restarts, started $started)"
  send_alert critical "🚨 PGSync daemon restarted" "\`$CONTAINER\` restarted since $last_check (restart count $last_restarts → $restarts). A crash-and-restart re-reads its checkpoint, and changes during the restart can be lost. Last error: ${last_error:-none in the log}" || sent=false
  status=2
fi
if [ "$error_count" -gt 0 ] && [ "$status" = 0 ]; then
  echo "[$NOW] WARNING: $error_count error lines since $last_check"
  send_alert warning "⚠️ PGSync errors" "$error_count error lines since $last_check. Last: $last_error" || sent=false
  status=1
fi
[ "$status" = 0 ] && echo "[$NOW] ok: running, restarts=$restarts, no errors since $last_check"
[ "$sent" = true ] || exit 3
echo "$restarts $started $NOW" > "$STATE"
exit "$status"
