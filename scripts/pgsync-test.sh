#!/usr/bin/env bash
#
# pgsync-test.sh - Test Elasticsearch schema changes with PGSync
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ What this tests:                                                        │
# │   1. views.sql creates valid PostgreSQL views                           │
# │   2. schema.json is valid and PGSync can parse it                       │
# │   3. The views output matches what schema.json expects                  │
# │   4. Documents are correctly indexed to Elasticsearch                   │
# │                                                                         │
# │ What this does NOT test:                                                │
# │   - Search query logic (tested in the app's test suite)                 │
# │   - Production data integrity                                           │
# └─────────────────────────────────────────────────────────────────────────┘
#
# Prerequisites:
#   - PostgreSQL database with:
#       - wal_level=logical (the Nix local DB has this enabled)
#       - Seed data loaded (run: nix run .#dev in opencouncil repo first)
#   - Elasticsearch instance accessible
#   - This script should live in opencouncil-tasks/scripts/
#   - opencouncil repo cloned alongside (or set OPENCOUNCIL_REPO)
#
# Usage:
#   ./scripts/pgsync-test.sh              # One-time bootstrap and exit
#   ./scripts/pgsync-test.sh --cleanup    # Delete test index after verification
#   ./scripts/pgsync-test.sh --daemon     # Run PGSync continuously for live sync testing
#
# Environment variables (set in .env or export):
#   PG_URL                    - PostgreSQL connection string (required)
#   ELASTICSEARCH_URL         - Elasticsearch URL (required)
#   ELASTICSEARCH_API_KEY_ID  - ES API key ID (required)
#   ELASTICSEARCH_API_KEY     - ES API key secret (required)
#   OPENCOUNCIL_REPO          - Path to opencouncil repo (default: ../opencouncil)
#   TEST_INDEX                - Elasticsearch test index name (default: subjects_test)
#
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}==>${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Load .env if present
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Configuration
OPENCOUNCIL_REPO="${OPENCOUNCIL_REPO:-../opencouncil}"
TEST_INDEX="${TEST_INDEX:-subjects_test}"
CLEANUP=false
DAEMON=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --cleanup)
      CLEANUP=true
      shift
      ;;
    --daemon)
      DAEMON=true
      shift
      ;;
  esac
done

# Validate required variables
missing_vars=()
[ -z "${PG_URL:-}" ] && missing_vars+=("PG_URL")
[ -z "${ELASTICSEARCH_URL:-}" ] && missing_vars+=("ELASTICSEARCH_URL")
[ -z "${ELASTICSEARCH_API_KEY_ID:-}" ] && missing_vars+=("ELASTICSEARCH_API_KEY_ID")
[ -z "${ELASTICSEARCH_API_KEY:-}" ] && missing_vars+=("ELASTICSEARCH_API_KEY")

if [ ${#missing_vars[@]} -gt 0 ]; then
  log_error "Missing required environment variables: ${missing_vars[*]}"
  echo "Set them in .env or export them before running this script."
  exit 1
fi

# Validate opencouncil repo exists
SCHEMA_PATH="$OPENCOUNCIL_REPO/elasticsearch/schema.json"
VIEWS_PATH="$OPENCOUNCIL_REPO/elasticsearch/views.sql"
VALIDATE_PATH="$OPENCOUNCIL_REPO/elasticsearch/validate-views.sql"

if [ ! -f "$SCHEMA_PATH" ]; then
  log_error "schema.json not found at: $SCHEMA_PATH"
  echo "Set OPENCOUNCIL_REPO to the path of your opencouncil repository."
  exit 1
fi

if [ ! -f "$VIEWS_PATH" ]; then
  log_error "views.sql not found at: $VIEWS_PATH"
  exit 1
fi

# Build ES auth header
ES_AUTH="Authorization: ApiKey $(echo -n "$ELASTICSEARCH_API_KEY_ID:$ELASTICSEARCH_API_KEY" | base64)"

# Extract database name from PG_URL (format: postgresql://user:pass@host:port/dbname?params)
# Remove everything before the last / and everything after ?
DB_NAME=$(echo "$PG_URL" | sed -E 's|.*\/([^?]+).*|\1|')
if [ -z "$DB_NAME" ]; then
  log_error "Could not extract database name from PG_URL"
  exit 1
fi

# Convert PG_URL to use localhost for both psql (on host) and Docker (with --network=host)
# We use --network=host so Docker containers can reach localhost directly
PSQL_URL="$PG_URL"
PSQL_URL="${PSQL_URL//host.docker.internal/localhost}"
PSQL_URL="${PSQL_URL//172.17.0.1/localhost}"

# Create temporary schema with test database/index values
# PGSync reads these from the schema.json, so we need to modify them for testing
# The schema is an array with one object, so we modify .[0]
TEMP_SCHEMA=$(mktemp)

# Cleanup function
cleanup() {
  rm -f "$TEMP_SCHEMA"
  rm -rf "$CHECKPOINT_DIR" 2>/dev/null || true
  docker rm -f pgsync-test-redis 2>/dev/null || true
}
trap cleanup EXIT

# Will be set later
CHECKPOINT_DIR=""

jq --arg db "$DB_NAME" --arg idx "$TEST_INDEX" \
  '.[0].database = $db | .[0].index = $idx' \
  "$SCHEMA_PATH" > "$TEMP_SCHEMA"

echo ""
echo "==========================================="
echo "   PGSync Elasticsearch Schema Test"
echo "==========================================="
echo ""
echo "This tests that schema.json + views.sql"
echo "produce valid Elasticsearch documents."
echo ""
echo "Configuration:"
echo "  Schema:     $SCHEMA_PATH"
echo "  Views:      $VIEWS_PATH"
echo "  Test Index: $TEST_INDEX"
echo "  Database:   $DB_NAME (from PG_URL)"
echo ""

# Step 1: Create views
log_info "Step 1/4: Creating Elasticsearch views in database..."
if psql "$PSQL_URL" < "$VIEWS_PATH" > /dev/null 2>&1; then
  log_ok "Views created successfully"
else
  log_error "Failed to create views"
  echo "Run manually to see errors: psql \"$PSQL_URL\" < $VIEWS_PATH"
  exit 1
fi

# Step 2: Validate views (optional but helpful)
if [ -f "$VALIDATE_PATH" ]; then
  log_info "Step 2/4: Validating views..."
  validate_output=$(psql "$PSQL_URL" -q < "$VALIDATE_PATH" 2>&1) || {
    log_error "Failed to run validation query (psql error)"
    echo "$validate_output"
    exit 1
  }
  if echo "$validate_output" | grep -q "FAIL"; then
    log_warn "View validation found issues. Check output:"
    psql "$PSQL_URL" < "$VALIDATE_PATH"
    echo ""
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      exit 1
    fi
  else
    log_ok "Views validated"
  fi
else
  log_warn "Step 2/4: Skipping validation (validate-views.sql not found)"
fi

# Step 3: Delete existing test index
log_info "Step 3/4: Preparing test index..."
http_code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$ELASTICSEARCH_URL/$TEST_INDEX" \
  -H "$ES_AUTH" 2>/dev/null || echo "000")

if [ "$http_code" = "200" ]; then
  log_ok "Deleted existing test index"
elif [ "$http_code" = "404" ]; then
  log_ok "Test index doesn't exist (clean slate)"
else
  log_warn "Could not delete test index (HTTP $http_code) - continuing anyway"
fi

# Step 4: Run PGSync
SCHEMA_CONTAINER_PATH="/tmp/test-schema.json"

# Start a temporary Redis on host network for PGSync checkpointing
# We use host network so PGSync can reach both PostgreSQL and Redis on localhost
# Using port 16379 to avoid conflicts with any existing Redis
log_info "Starting temporary Redis..."
docker rm -f pgsync-test-redis 2>/dev/null || true
docker run -d --name pgsync-test-redis --network=host redis:7-alpine redis-server --port 16379 >/dev/null

# Create a temporary directory for PGSync checkpoint files
CHECKPOINT_DIR=$(mktemp -d)

if [ "$DAEMON" = true ]; then
  # Daemon mode: run PGSync continuously for live sync testing
  log_info "Step 4/4: Running PGSync in daemon mode..."
  echo "  PGSync will sync changes continuously. Press Ctrl+C to stop."
  echo ""
  echo "  To use with OpenCouncil app, start it with:"
  echo "    ELASTICSEARCH_INDEX=$TEST_INDEX nix run .#dev"
  echo ""
  
  # First do a bootstrap to ensure initial data is synced
  log_info "Bootstrapping initial data..."
  if ! docker run --rm \
    --network=host \
    -w /data \
    -e "PG_URL=$PSQL_URL" \
    -e "REDIS_URL=redis://127.0.0.1:16379/0" \
    -e "ELASTICSEARCH_URL=$ELASTICSEARCH_URL" \
    -e "ELASTICSEARCH_API_KEY=$ELASTICSEARCH_API_KEY" \
    -e "ELASTICSEARCH_API_KEY_ID=$ELASTICSEARCH_API_KEY_ID" \
    -v "$TEMP_SCHEMA:$SCHEMA_CONTAINER_PATH:ro" \
    -v "$CHECKPOINT_DIR:/data" \
    toluaina1/pgsync:latest \
    --config "$SCHEMA_CONTAINER_PATH" --bootstrap; then
    log_error "Bootstrap failed"
    exit 1
  fi
  log_ok "Bootstrap completed"
  
  echo ""
  log_info "Starting PGSync daemon (Ctrl+C to stop)..."
  echo ""
  
  # Run PGSync in daemon mode (foreground so we can see logs and Ctrl+C works)
  # Note: -d in pgsync means daemon mode (poll for changes), not detach
  docker run --rm \
    --name pgsync-test-daemon \
    --network=host \
    -w /data \
    -e "PG_URL=$PSQL_URL" \
    -e "REDIS_URL=redis://127.0.0.1:16379/0" \
    -e "ELASTICSEARCH_URL=$ELASTICSEARCH_URL" \
    -e "ELASTICSEARCH_API_KEY=$ELASTICSEARCH_API_KEY" \
    -e "ELASTICSEARCH_API_KEY_ID=$ELASTICSEARCH_API_KEY_ID" \
    -v "$TEMP_SCHEMA:$SCHEMA_CONTAINER_PATH:ro" \
    -v "$CHECKPOINT_DIR:/data" \
    toluaina1/pgsync:latest \
    --config "$SCHEMA_CONTAINER_PATH" -d
  
  # If we get here, PGSync exited (user pressed Ctrl+C or error)
  echo ""
  log_info "PGSync daemon stopped"
  exit 0
else
  # Bootstrap mode: one-time sync and exit
  log_info "Step 4/4: Running PGSync bootstrap..."
  echo "  This reads schema.json, queries views, and indexes to Elasticsearch."
  echo ""
  
  # Use --network=host so the container can reach localhost:5432 directly
  # This avoids firewall issues with Docker bridge networking on Linux/NixOS
  # Mount checkpoint dir as working directory so PGSync can write checkpoint files
  if docker run --rm \
    --network=host \
    -w /data \
    -e "PG_URL=$PSQL_URL" \
    -e "REDIS_URL=redis://127.0.0.1:16379/0" \
    -e "ELASTICSEARCH_URL=$ELASTICSEARCH_URL" \
    -e "ELASTICSEARCH_API_KEY=$ELASTICSEARCH_API_KEY" \
    -e "ELASTICSEARCH_API_KEY_ID=$ELASTICSEARCH_API_KEY_ID" \
    -v "$TEMP_SCHEMA:$SCHEMA_CONTAINER_PATH:ro" \
    -v "$CHECKPOINT_DIR:/data" \
    toluaina1/pgsync:latest \
    --config "$SCHEMA_CONTAINER_PATH" --bootstrap; then
    log_ok "PGSync bootstrap completed"
  else
    log_error "PGSync bootstrap failed"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Is the database running? Can PGSync reach it from Docker?"
    echo "     - For Nix local DB: use host.docker.internal or 172.17.0.1 instead of localhost"
    echo "  2. Check views exist: psql \"\$PG_URL\" -c \"SELECT viewname FROM pg_views WHERE schemaname='public'\""
    echo "  3. Check schema.json is valid JSON: jq . $SCHEMA_PATH"
    exit 1
  fi
fi

# Show results
echo ""
log_info "Results:"

# Get document count - try _count endpoint first, fall back to search
count_response=$(curl -s "$ELASTICSEARCH_URL/$TEST_INDEX/_count" \
  -H "$ES_AUTH" \
  -H "Content-Type: application/json" 2>/dev/null)

doc_count=$(echo "$count_response" | jq -r '.count // empty' 2>/dev/null)

# If _count didn't work, try getting count from search
if [ -z "$doc_count" ]; then
  search_response=$(curl -s "$ELASTICSEARCH_URL/$TEST_INDEX/_search?size=0" \
    -H "$ES_AUTH" \
    -H "Content-Type: application/json" 2>/dev/null)
  doc_count=$(echo "$search_response" | jq -r '.hits.total.value // .hits.total // 0' 2>/dev/null)
fi

# Default to 0 if still empty
doc_count="${doc_count:-0}"

echo "  Documents indexed: $doc_count"

if [ "$doc_count" = "0" ] || [ -z "$doc_count" ]; then
  # Double-check by trying to get a sample document
  sample=$(curl -s "$ELASTICSEARCH_URL/$TEST_INDEX/_search?size=1" \
    -H "$ES_AUTH" \
    -H "Content-Type: application/json" 2>/dev/null)
  sample_count=$(echo "$sample" | jq -r '.hits.hits | length' 2>/dev/null)
  
  if [ "$sample_count" -gt 0 ] 2>/dev/null; then
    log_ok "Documents successfully indexed to $TEST_INDEX"
    echo ""
    echo "Sample document fields:"
    echo "$sample" | jq '.hits.hits[0]._source | keys'
  else
    log_warn "No documents indexed - check if seed data exists in the database"
  fi
else
  log_ok "Documents successfully indexed to $TEST_INDEX"
  
  # Show sample document structure
  echo ""
  echo "Sample document fields:"
  curl -s "$ELASTICSEARCH_URL/$TEST_INDEX/_search?size=1" \
    -H "$ES_AUTH" \
    -H "Content-Type: application/json" \
    | jq '.hits.hits[0]._source | keys'
fi

# Cleanup if requested
if [ "$CLEANUP" = true ]; then
  echo ""
  log_info "Cleaning up test index..."
  curl -s -X DELETE "$ELASTICSEARCH_URL/$TEST_INDEX" -H "$ES_AUTH" > /dev/null
  log_ok "Test index deleted"
fi

echo ""
echo "==========================================="
echo "            Test Complete"
echo "==========================================="
echo ""
if [ "$CLEANUP" = false ]; then
  echo "The test index '$TEST_INDEX' is available for inspection."
  echo ""
  echo "Next steps:"
  echo "  - Query: curl \"\$ELASTICSEARCH_URL/$TEST_INDEX/_search?size=1\" -H \"Authorization: ApiKey ...\""
  echo "  - Delete: curl -X DELETE \"\$ELASTICSEARCH_URL/$TEST_INDEX\" -H \"Authorization: ApiKey ...\""
  echo "  - Or re-run with --cleanup to auto-delete"
fi
echo ""
