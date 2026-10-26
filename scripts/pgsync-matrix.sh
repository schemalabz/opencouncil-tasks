#!/usr/bin/env bash
#
# pgsync-matrix.sh - Measure what PGSync syncs live, field by field
#
# For every indexed field and every table that feeds it, the matrix changes the
# source in PostgreSQL while the PGSync daemon runs, and reports whether the
# search document followed. Compare the report with the section "What syncs
# live" in opencouncil/elasticsearch/README.md after any change to schema.json,
# views.sql or the PGSync image.
#
# The probes write rows and change names, release flags and roles. Run the
# matrix only against a disposable, seeded local database: it refuses any host
# other than localhost and any index named like the production ones.
#
# Usage:
#   ./scripts/pgsync-matrix.sh --write             # from a database with no PGSync objects
#   ./scripts/pgsync-matrix.sh --write --upgrade   # over the PGSync objects already there
#
# --upgrade keeps the triggers and _view that an earlier image or schema made, as a
# release does. Set up that earlier state first, for example with the `bootstrap`
# command of the old image against the old schema.json and views.sql.
#
# Environment variables (set in .env or export), as for pgsync-test.sh:
#   PG_URL, ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY_ID, ELASTICSEARCH_API_KEY
#   OPENCOUNCIL_REPO   - Path to the opencouncil repo (default: ../opencouncil)
#   TEST_INDEX         - Test index (default: subjects_test)
#   PGSYNC_IMAGE       - PGSync image (default: the production image)
#   MATRIX_OUT         - Report path (default: ./pgsync-matrix.json); the daemon log
#                        goes next to it, as <report>.daemon.log
#   MATRIX_WAIT        - Seconds a probe waits for the document (default: 25)
#
# Requires docker, psql, jq and python3.
set -euo pipefail
export PGOPTIONS='--client-min-messages=warning'

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ "${1:-}" = "--write" ] || die "the matrix changes rows in PG_URL; pass --write to confirm the database is disposable"
UPGRADE=false
case "${2:-}" in "") ;; --upgrade) UPGRADE=true ;; *) die "unknown option ${2}" ;; esac

if [ -f .env ]; then set -a; . ./.env; set +a; fi
OPENCOUNCIL_REPO="${OPENCOUNCIL_REPO:-../opencouncil}"
TEST_INDEX="${TEST_INDEX:-subjects_test}"
PRODUCTION_PGSYNC_IMAGE="opencouncil/pgsync:7.3.0-columns"
PGSYNC_IMAGE="${PGSYNC_IMAGE:-$PRODUCTION_PGSYNC_IMAGE}"
MATRIX_OUT="${MATRIX_OUT:-$PWD/pgsync-matrix.json}"
for v in PG_URL ELASTICSEARCH_URL ELASTICSEARCH_API_KEY_ID ELASTICSEARCH_API_KEY; do
  [ -n "${!v:-}" ] || die "$v is not set"
done

# --- guards ---------------------------------------------------------------------
PSQL_URL="${PG_URL//host.docker.internal/localhost}"
PSQL_URL="${PSQL_URL//172.17.0.1/localhost}"
host=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$PSQL_URL")
case "$host" in localhost|127.0.0.1|::1) ;; *) die "PG_URL host is '$host'; the matrix runs only against a local database" ;; esac
# libpq lets the query string and the environment replace the host of the URL.
case "$PSQL_URL" in *\?*host*=*|*\?*service=*) die "PG_URL sets the host in its parameters; give it in the URL only" ;; esac
[ -z "${PGHOST:-}${PGHOSTADDR:-}${PGSERVICE:-}" ] || die "unset PGHOST, PGHOSTADDR and PGSERVICE: they can redirect psql"
# psql reports the address it reached after every parameter and variable took effect.
conninfo=$(psql "$PSQL_URL" -At -c '\conninfo') || die "cannot connect to PG_URL"
case "$conninfo" in
  *"via socket"*) target=socket ;;
  *'(address "'*) target=$(sed -E 's/.*\(address "([^"]+)"\).*/\1/' <<<"$conninfo") ;;
  *) target=$(sed -E 's/.* on host "([^"]+)".*/\1/' <<<"$conninfo") ;;
esac
case "$target" in 127.0.0.1|::1|socket) ;; *) die "psql reaches the database at '$target', not on this machine" ;; esac
# One plain index name: a comma or a wildcard would make the DELETE below reach other indices.
[[ "$TEST_INDEX" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "TEST_INDEX '$TEST_INDEX' is not one plain index name"
case "$TEST_INDEX" in subjects|subjects-*) die "TEST_INDEX '$TEST_INDEX' is named like a production index" ;; esac
DB_NAME=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).path.lstrip("/"))' "$PSQL_URL")
[ "$(psql "$PSQL_URL" -At -c 'SELECT count(*) FROM "Subject"')" -gt 0 ] || die "the database has no subjects; seed it first"

ES_AUTH="Authorization: ApiKey $(echo -n "$ELASTICSEARCH_API_KEY_ID:$ELASTICSEARCH_API_KEY" | base64 -w0)"
RUN=$(mktemp -d); chmod 777 "$RUN"
# The daemon holds the replication slot, so drop the slot after the containers:
# a slot left behind keeps WAL on the database forever.
cleanup() {
  docker logs pgsync-matrix-daemon > "${MATRIX_OUT%.json}.daemon.log" 2>&1 || true
  docker rm -f pgsync-matrix-daemon pgsync-matrix-redis >/dev/null 2>&1 || true
  psql "$PSQL_URL" -q -c "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = current_database() AND NOT active" >/dev/null 2>&1 || true
  rm -rf "$RUN"
}
# The containers have fixed names, so a second run would remove the first run's
# containers on exit. Stop before the cleanup handler exists.
if [ -n "$(docker ps -aq --filter name=pgsync-matrix-)" ]; then
  rm -rf "$RUN"
  die "another matrix run is using pgsync-matrix-daemon or pgsync-matrix-redis; if none runs, remove them with: docker rm -f pgsync-matrix-daemon pgsync-matrix-redis"
fi
trap cleanup EXIT

if ! docker image inspect "$PGSYNC_IMAGE" >/dev/null 2>&1; then
  [ "$PGSYNC_IMAGE" = "$PRODUCTION_PGSYNC_IMAGE" ] || die "image $PGSYNC_IMAGE not found locally"
  log "building $PGSYNC_IMAGE"
  docker build -q -t "$PGSYNC_IMAGE" "$(dirname "$0")/../docker/pgsync" >/dev/null
fi
log "image $PGSYNC_IMAGE ($(docker run --rm --entrypoint pip "$PGSYNC_IMAGE" show pgsync 2>/dev/null | sed -n 's/^Version: //p')), database $DB_NAME on $host, index $TEST_INDEX"

# --- a clean start ----------------------------------------------------------------
# PGSync's trigger table _view decides which columns notify. A bootstrap keeps the
# columns that an existing _view holds, so drop it: the image under test then
# builds _view from its own columns only.
psql "$PSQL_URL" -q -v ON_ERROR_STOP=1 \
  -c "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = current_database() AND NOT active" >/dev/null
if [ "$UPGRADE" = false ]; then
  psql "$PSQL_URL" -q -v ON_ERROR_STOP=1 \
    -c "DROP FUNCTION IF EXISTS public.table_notify() CASCADE" \
    -c "DROP MATERIALIZED VIEW IF EXISTS public._view" >/dev/null
else
  log "upgrade: keeping the existing triggers and _view"
fi
psql "$PSQL_URL" -q -v ON_ERROR_STOP=1 -f "$OPENCOUNCIL_REPO/elasticsearch/views.sql" >/dev/null
jq --arg db "$DB_NAME" --arg idx "$TEST_INDEX" '.[0].database = $db | .[0].index = $idx' \
  "$OPENCOUNCIL_REPO/elasticsearch/schema.json" > "$RUN/schema.json"
curl -s -o /dev/null -X DELETE -H "$ES_AUTH" "$ELASTICSEARCH_URL/$TEST_INDEX"

docker run -d --name pgsync-matrix-redis --network=host redis:7-alpine redis-server --port 16380 >/dev/null
# pgsync <docker options> -- <pgsync arguments>
pgsync() {
  local docker_args=()
  while [ "$1" != "--" ]; do docker_args+=("$1"); shift; done
  shift
  docker run "${docker_args[@]}" --network=host -w /data \
    -e "PG_URL=$PSQL_URL" -e "REDIS_URL=redis://127.0.0.1:16380/0" -e REDIS_CHECKPOINT=true \
    -e ELASTICSEARCH_TIMEOUT=120 -e ELASTICSEARCH_CHUNK_SIZE=50 -e "ELASTICSEARCH_URL=$ELASTICSEARCH_URL" \
    -e "ELASTICSEARCH_API_KEY=$ELASTICSEARCH_API_KEY" -e "ELASTICSEARCH_API_KEY_ID=$ELASTICSEARCH_API_KEY_ID" \
    -v "$RUN/schema.json:/tmp/schema.json:ro" -v "$RUN:/data" "$PGSYNC_IMAGE" --config /tmp/schema.json "$@"
}
log "bootstrap"
pgsync --rm -- --bootstrap > "$RUN/bootstrap.log" 2>&1 || { cat "$RUN/bootstrap.log"; die "bootstrap failed"; }
log "daemon"
docker rm -f pgsync-matrix-daemon >/dev/null 2>&1 || true
pgsync -d --name pgsync-matrix-daemon -- -d >/dev/null
for _ in $(seq 1 60); do docker logs pgsync-matrix-daemon 2>&1 | grep -q Xlog && break; sleep 2; done
sleep 8

PSQL_URL="$PSQL_URL" TEST_INDEX="$TEST_INDEX" OUT="$MATRIX_OUT" MATRIX_WAIT="${MATRIX_WAIT:-25}" \
  ELASTICSEARCH_URL="$ELASTICSEARCH_URL" ELASTICSEARCH_API_KEY_ID="$ELASTICSEARCH_API_KEY_ID" \
  ELASTICSEARCH_API_KEY="$ELASTICSEARCH_API_KEY" python3 "$(dirname "$0")/pgsync-matrix.py"

errors=$(docker logs pgsync-matrix-daemon 2>&1 | grep -ciE 'traceback|not subset' || true)
running=$(docker inspect -f '{{.State.Running}}' pgsync-matrix-daemon)
log "daemon running=$running, errors in its log: $errors"
[ "$running" = true ] && [ "$errors" = 0 ] || { docker logs pgsync-matrix-daemon 2>&1 | grep -iE 'error|traceback' | tail -5; exit 1; }
