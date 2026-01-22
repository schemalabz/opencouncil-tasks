#!/usr/bin/env bash
set -e

# WAL Monitoring Script for PGSync Replication Slots
# Uses pgmetrics to check PostgreSQL replication slot health and alerts on issues

# Find script dir (so we can store helper binaries locally)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# pgmetrics auto-install settings
# - PGMETRICS_AUTO_INSTALL=0 disables downloading pgmetrics automatically.
# - PGMETRICS_INSTALL_DIR overrides where the binary is stored (default: scripts/.bin).
PGMETRICS_AUTO_INSTALL="${PGMETRICS_AUTO_INSTALL:-1}"
PGMETRICS_INSTALL_DIR="${PGMETRICS_INSTALL_DIR:-$SCRIPT_DIR/.bin}"
PGMETRICS_BIN="${PGMETRICS_BIN:-pgmetrics}"

install_pgmetrics() {
    # Installs pgmetrics into $PGMETRICS_INSTALL_DIR and sets PGMETRICS_BIN to the installed binary.
    # This avoids needing sudo, which is useful for first-time setup and cron.
    mkdir -p "$PGMETRICS_INSTALL_DIR"

    local tmpdir
    tmpdir="$(mktemp -d)"
    local tarball="$tmpdir/pgmetrics_linux_amd64.tar.gz"

    # Get the latest release download URL (Linux amd64 tarball).
    # Release asset filenames include the version, so we discover it dynamically.
    # This matches the command that’s proven to work:
    # curl -s ... | grep "browser_download_url.*linux_amd64.tar.gz" | cut -d '"' -f 4
    local url
    url="$(curl -s https://api.github.com/repos/rapidloop/pgmetrics/releases/latest \
        | grep "browser_download_url.*linux_amd64.tar.gz" \
        | cut -d '"' -f 4 \
        | head -n 1)"

    if [[ -z "$url" ]]; then
        echo "Error: Could not find latest pgmetrics linux_amd64 tarball URL from GitHub releases."
        rm -rf "$tmpdir"
        return 1
    fi

    echo "pgmetrics not found; downloading latest release..."

    # Prefer curl (required by this script anyway). Fall back to wget if available.
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -L -o "$tarball" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$tarball" "$url"
    else
        echo "Error: Need curl or wget to download pgmetrics."
        rm -rf "$tmpdir"
        return 1
    fi

    tar -xzf "$tarball" -C "$tmpdir"

    # The archive usually contains a versioned directory like:
    # pgmetrics_1.19.0_linux_amd64/pgmetrics
    local extracted_bin
    extracted_bin="$(find "$tmpdir" -maxdepth 3 -type f -name pgmetrics -print -quit)"

    if [[ -z "$extracted_bin" ]] || [[ ! -f "$extracted_bin" ]]; then
        echo "Error: pgmetrics archive did not contain expected 'pgmetrics' binary."
        echo "Archive contents (first 50 lines):"
        tar -tzf "$tarball" | head -n 50 || true
        rm -rf "$tmpdir"
        return 1
    fi

    chmod +x "$extracted_bin"
    mv -f "$extracted_bin" "$PGMETRICS_INSTALL_DIR/pgmetrics"
    rm -rf "$tmpdir"

    PGMETRICS_BIN="$PGMETRICS_INSTALL_DIR/pgmetrics"
    echo "pgmetrics installed to $PGMETRICS_BIN"
}

# Check for required dependencies
missing_deps=()
command -v jq >/dev/null 2>&1 || missing_deps+=("jq")
command -v bc >/dev/null 2>&1 || missing_deps+=("bc")
command -v curl >/dev/null 2>&1 || missing_deps+=("curl")
command -v tar >/dev/null 2>&1 || missing_deps+=("tar")

# If pgmetrics is missing, try to auto-install it (default on).
if ! command -v "$PGMETRICS_BIN" >/dev/null 2>&1 && [[ ! -x "$PGMETRICS_INSTALL_DIR/pgmetrics" ]]; then
    if [[ "$PGMETRICS_AUTO_INSTALL" == "1" ]]; then
        # We need curl + tar for auto-install; if those are missing, fall through to the normal deps error.
        if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
            install_pgmetrics || missing_deps+=("pgmetrics")
        else
            missing_deps+=("pgmetrics")
        fi
    else
        missing_deps+=("pgmetrics")
    fi
elif [[ -x "$PGMETRICS_INSTALL_DIR/pgmetrics" ]]; then
    # Found previously installed pgmetrics in local dir
    PGMETRICS_BIN="$PGMETRICS_INSTALL_DIR/pgmetrics"
else
    # Use system pgmetrics by default if present
    PGMETRICS_BIN="pgmetrics"
fi

if [ ${#missing_deps[@]} -gt 0 ]; then
    echo "Error: Missing required dependencies: ${missing_deps[*]}"
    echo ""
    echo "To install on Ubuntu/Debian:"
    echo "  # Install standard tools"
    echo "  sudo apt update && sudo apt install -y jq bc curl tar"
    echo ""
    echo "  # Install pgmetrics (single binary)"
    echo "  # Option A (recommended): rerun this script with PGMETRICS_AUTO_INSTALL=1 (default)"
    echo "  # Option B: manual install"
    echo "  # Download the latest Linux amd64 tarball URL dynamically (asset filename includes the version):"
    echo "  curl -L -o pgmetrics.tar.gz \"\$(curl -s https://api.github.com/repos/rapidloop/pgmetrics/releases/latest \\"
    echo "    | grep \\\"browser_download_url.*linux_amd64.tar.gz\\\" \\"
    echo "    | cut -d '\"' -f 4 \\"
    echo "    | head -n 1)\""
    echo "  tar xzf pgmetrics.tar.gz"
    echo "  sudo mv pgmetrics_*_linux_amd64/pgmetrics /usr/local/bin/pgmetrics"
    echo "  rm -f pgmetrics.tar.gz"
    echo "  # Alternatively, visit: https://github.com/rapidloop/pgmetrics/releases/latest"
    echo ""

    exit 1
fi

# Load environment variables if .env exists
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Configuration
# ALERT_WEBHOOK_URL: Discord/Slack webhook for alerts (optional)
WEBHOOK_URL=${ALERT_WEBHOOK_URL:-}

# Optional threshold overrides (in GB)
# If set, these override the auto-derived thresholds from max_slot_wal_keep_size
# Useful for testing or custom configurations
INFO_THRESHOLD_OVERRIDE=${WAL_INFO_THRESHOLD_GB:-}
WARNING_THRESHOLD_OVERRIDE=${WAL_WARNING_THRESHOLD_GB:-}
CRITICAL_THRESHOLD_OVERRIDE=${WAL_CRITICAL_THRESHOLD_GB:-}

# Check if PG_URL is set
if [ -z "$PG_URL" ]; then
    echo "Error: PG_URL environment variable not set"
    exit 1
fi

# Parse PG_URL into standard PostgreSQL environment variables
# pgmetrics uses PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE
# Format: postgresql://user:password@host:port/database

# Extract components using parameter expansion and sed
# Supports both formats:
#   postgresql://user:password@host:port/database
#   postgresql://user@host:port/database (no password)
# Note: passwords containing @ must be URL-encoded in PG_URL (e.g. p@ss -> p%40ss)
if [[ "$PG_URL" =~ ^postgresql[s]?://([^:@]+):([^@]+)@([^:]+):([0-9]+)/([^?]+)(\?.*)? ]]; then
    # Format with password: postgresql://user:password@host:port/database
    export PGUSER="${BASH_REMATCH[1]}"
    # Decode URL-encoded password (e.g. %40 -> @)
    export PGPASSWORD="$(printf '%b' "${BASH_REMATCH[2]//%/\\x}")"
    export PGHOST="${BASH_REMATCH[3]}"
    export PGPORT="${BASH_REMATCH[4]}"
    export PGDATABASE="${BASH_REMATCH[5]}"
elif [[ "$PG_URL" =~ ^postgresql[s]?://([^:@]+)@([^:]+):([0-9]+)/([^?]+)(\?.*)? ]]; then
    # Format without password: postgresql://user@host:port/database
    export PGUSER="${BASH_REMATCH[1]}"
    export PGPASSWORD=""
    export PGHOST="${BASH_REMATCH[2]}"
    export PGPORT="${BASH_REMATCH[3]}"
    export PGDATABASE="${BASH_REMATCH[4]}"
else
    echo "Error: PG_URL format not recognized. Expected: postgresql://user[:password]@host:port/database"
    echo "Got: $PG_URL"
    exit 1
fi

# Set SSL mode: use PGSSLMODE env if set, otherwise auto-detect based on host
# - localhost/127.0.0.1 connections typically don't need SSL
# - Remote connections (cloud databases, etc.) should use SSL
if [[ -z "${PGSSLMODE:-}" ]]; then
    if [[ "$PGHOST" == "localhost" ]] || [[ "$PGHOST" == "127.0.0.1" ]] || [[ "$PGHOST" =~ ^host\.docker\.internal$ ]]; then
        export PGSSLMODE="disable"
    else
        export PGSSLMODE="require"
    fi
else
    export PGSSLMODE
fi

# Function to send webhook alert (Discord/Slack compatible)
# Parameters: severity, slot_name, slot_type, wal_retained, wal_status, is_active, message
send_alert() {
    local severity=$1
    local slot_name=$2
    local slot_type=$3
    local wal_retained=$4
    local wal_status=$5
    local is_active=$6
    local message=$7
    
    if [ -n "$WEBHOOK_URL" ]; then
        local color=16744448  # Orange for warning (0xFFA500 in decimal)
        local title="⚠️ WAL Monitor Warning"
        if [ "$severity" == "critical" ]; then
            color=16711680  # Red for critical (0xFF0000 in decimal)
            title="🚨 WAL Monitor Critical Alert"
        elif [ "$severity" == "info" ]; then
            color=3447003  # Blue for info (0x3498DB in decimal)
            title="ℹ️ WAL Monitor Info"
        fi
        
        # JSON-escape message safely (handles quotes, backslashes, and newlines)
        # jq -Rs returns a quoted JSON string, so we embed it without extra quotes below.
        local escaped_message
        escaped_message=$(printf '%s' "$message" | jq -Rs '.')
        
        # Build the JSON payload with embed fields for better readability
        local json_payload=$(cat <<EOF
{
  "embeds": [{
    "title": "$title",
    "description": $escaped_message,
    "color": $color,
    "fields": [
      {"name": "Slot Name", "value": "\`$slot_name\`", "inline": true},
      {"name": "Type", "value": "$slot_type", "inline": true},
      {"name": "Active", "value": "$is_active", "inline": true},
      {"name": "WAL Retained", "value": "$wal_retained", "inline": true},
      {"name": "WAL Status", "value": "$wal_status", "inline": true},
      {"name": "Limit", "value": "${MAX_SLOT_WAL_KEEP_SIZE_GB}$( [[ "$MAX_SLOT_WAL_KEEP_SIZE_GB" != "unlimited" ]] && echo GB )", "inline": true},
      {"name": "Server", "value": "\`$PGHOST\`", "inline": false},
      {"name": "Database", "value": "\`$PGDATABASE\`", "inline": true}
    ],
    "footer": {"text": "WAL Monitor • Thresholds: warn ${WARNING_THRESHOLD}GB / crit ${CRITICAL_THRESHOLD}GB"},
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  }]
}
EOF
)
        
        curl -X POST "$WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "$json_payload" \
            -s -o /dev/null || true
    fi
}

# Function to convert PostgreSQL LSN to bytes
# LSN format: "XXX/YYYYYYYY" where XXX is segment (hex) and YYYYYYYY is offset (hex)
# Each segment is 4GB (0x100000000 bytes)
lsn_to_bytes() {
    local lsn=$1
    if [[ -z "$lsn" ]] || [[ "$lsn" == "null" ]] || [[ "$lsn" == "" ]]; then
        echo "0"
        return
    fi
    
    # Split by / and convert hex to decimal
    local segment=$(echo "$lsn" | cut -d'/' -f1)
    local offset=$(echo "$lsn" | cut -d'/' -f2)
    
    # Convert hex to decimal (segment * 4GB + offset)
    # Using printf to handle hex conversion
    local seg_dec=$((16#$segment))
    local off_dec=$((16#$offset))
    
    # Each segment is 4GB = 4294967296 bytes
    echo $((seg_dec * 4294967296 + off_dec))
}

# Function to calculate LSN difference in bytes
lsn_diff_bytes() {
    local current_lsn=$1
    local restart_lsn=$2
    
    local current_bytes=$(lsn_to_bytes "$current_lsn")
    local restart_bytes=$(lsn_to_bytes "$restart_lsn")
    
    if [[ "$current_bytes" -gt 0 ]] && [[ "$restart_bytes" -gt 0 ]]; then
        echo $((current_bytes - restart_bytes))
    else
        echo "0"
    fi
}

# Collect metrics using pgmetrics
echo "--- WAL Monitor Check: $(date) ---"
echo ""

# Display connection info (without password)
echo "Connection: ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE} (SSL: ${PGSSLMODE})"

# pgmetrics will use PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE from environment
# Capture stdout (JSON) and stderr separately to avoid mixing warnings with JSON output
PGMETRICS_STDERR=$(mktemp)
if ! METRICS_JSON=$("$PGMETRICS_BIN" --no-password --format=json "$PGDATABASE" 2>"$PGMETRICS_STDERR"); then
    echo "❌ Error collecting metrics with pgmetrics:"
    cat "$PGMETRICS_STDERR"
    echo "$METRICS_JSON"
    rm -f "$PGMETRICS_STDERR"
    # Note: threshold variables are not yet initialized at this point, so we
    # skip send_alert here to avoid empty values in the webhook payload.
    echo "⚠️  Skipping webhook alert (thresholds not yet computed)."
    exit 1
fi

# Show any warnings from pgmetrics (but don't fail)
if [[ -s "$PGMETRICS_STDERR" ]]; then
    echo "pgmetrics warnings:"
    cat "$PGMETRICS_STDERR"
    echo ""
fi
rm -f "$PGMETRICS_STDERR"

# Validate that we got valid JSON
if ! echo "$METRICS_JSON" | jq empty 2>/dev/null; then
    echo "❌ Error: pgmetrics did not return valid JSON"
    echo "Raw output (first 500 chars): ${METRICS_JSON:0:500}"
    exit 1
fi

# Get max_slot_wal_keep_size from PostgreSQL settings (in MB)
# This is the maximum WAL that can be retained by replication slots before PostgreSQL purges it
MAX_SLOT_WAL_KEEP_SIZE_MB=$(echo "$METRICS_JSON" | jq -r '.settings.max_slot_wal_keep_size.setting // "-1"')

# Derive thresholds from max_slot_wal_keep_size (or use overrides if set)
# Thresholds: info=50%, warning=80%, critical=95%
if [[ "$MAX_SLOT_WAL_KEEP_SIZE_MB" != "-1" ]] && [[ "$MAX_SLOT_WAL_KEEP_SIZE_MB" -gt 0 ]]; then
    MAX_SLOT_WAL_KEEP_SIZE_GB=$(echo "scale=2; $MAX_SLOT_WAL_KEEP_SIZE_MB / 1024" | bc)
    # Use override if set, otherwise derive from max_slot_wal_keep_size
    if [[ -n "$INFO_THRESHOLD_OVERRIDE" ]]; then
        INFO_THRESHOLD="$INFO_THRESHOLD_OVERRIDE"
    else
        INFO_THRESHOLD=$(echo "scale=2; $MAX_SLOT_WAL_KEEP_SIZE_GB * 0.50" | bc)
    fi
    if [[ -n "$WARNING_THRESHOLD_OVERRIDE" ]]; then
        WARNING_THRESHOLD="$WARNING_THRESHOLD_OVERRIDE"
    else
        WARNING_THRESHOLD=$(echo "scale=2; $MAX_SLOT_WAL_KEEP_SIZE_GB * 0.80" | bc)
    fi
    if [[ -n "$CRITICAL_THRESHOLD_OVERRIDE" ]]; then
        CRITICAL_THRESHOLD="$CRITICAL_THRESHOLD_OVERRIDE"
    else
        CRITICAL_THRESHOLD=$(echo "scale=2; $MAX_SLOT_WAL_KEEP_SIZE_GB * 0.95" | bc)
    fi
else
    # Fallback if setting not available or unlimited (-1)
    MAX_SLOT_WAL_KEEP_SIZE_GB="unlimited"
    INFO_THRESHOLD=${INFO_THRESHOLD_OVERRIDE:-5}
    WARNING_THRESHOLD=${WARNING_THRESHOLD_OVERRIDE:-8}
    CRITICAL_THRESHOLD=${CRITICAL_THRESHOLD_OVERRIDE:-12}
fi

# Extract and display database metadata from pgmetrics
PG_VERSION=$(echo "$METRICS_JSON" | jq -r '.settings.server_version.setting // "unknown"')
PG_SERVER_START=$(echo "$METRICS_JSON" | jq -r '.start_time // 0')
COLLECTED_DBS=$(echo "$METRICS_JSON" | jq -r '.meta.collected_dbs | join(", ") // "unknown"')

# Convert server start time to human readable if available
if [[ "$PG_SERVER_START" -gt 0 ]]; then
    PG_SERVER_START_HUMAN=$(date -d "@$PG_SERVER_START" 2>/dev/null || echo "N/A")
else
    PG_SERVER_START_HUMAN="N/A"
fi

echo "PostgreSQL version: $PG_VERSION"
echo "Server started: $PG_SERVER_START_HUMAN"
echo "Database(s): $COLLECTED_DBS"

# Display threshold info
if [[ "$MAX_SLOT_WAL_KEEP_SIZE_GB" == "unlimited" ]]; then
    echo "max_slot_wal_keep_size: unlimited (using default thresholds)"
else
    echo "max_slot_wal_keep_size: ${MAX_SLOT_WAL_KEEP_SIZE_GB}GB"
fi
echo "Thresholds: info=${INFO_THRESHOLD}GB (50%), warning=${WARNING_THRESHOLD}GB (80%), critical=${CRITICAL_THRESHOLD}GB (95%)"
echo ""

# Get current WAL LSN for calculating retained WAL
# pgmetrics provides wal_lsn (current WAL position) - see https://pgmetrics.io/docs/metrics.html
CURRENT_WAL_LSN=$(echo "$METRICS_JSON" | jq -r '.wal_lsn // .wal_flush_lsn // .wal_insert_lsn // empty')

# Check if we have replication slots
SLOT_COUNT=$(echo "$METRICS_JSON" | jq '.replication_slots // [] | length')

if [ "$SLOT_COUNT" -eq 0 ]; then
    echo "⚠️  No replication slots found"
    exit 0
fi

# Process each replication slot
echo "$METRICS_JSON" | jq -c '.replication_slots[]? // empty' | while read -r slot; do
    slot_name=$(echo "$slot" | jq -r '.slot_name')
    slot_type=$(echo "$slot" | jq -r '.slot_type')
    active=$(echo "$slot" | jq -r '.active')
    wal_status=$(echo "$slot" | jq -r '.wal_status // "unknown"')
    restart_lsn=$(echo "$slot" | jq -r '.restart_lsn // empty')
    
    # Calculate WAL retention using LSN arithmetic
    # For lost/unreserved slots, restart_lsn may be invalid
    if [[ "$wal_status" == "lost" ]] || [[ -z "$restart_lsn" ]] || [[ "$restart_lsn" == "null" ]] || [[ "$restart_lsn" == "" ]]; then
        wal_display="N/A"
        wal_gb="0"
    elif [[ -z "$CURRENT_WAL_LSN" ]] || [[ "$CURRENT_WAL_LSN" == "null" ]]; then
        wal_display="N/A"
        wal_gb="0"
    else
        # Calculate the difference between current WAL position and slot's restart_lsn
        # This gives us the actual retained WAL in bytes
        wal_bytes=$(lsn_diff_bytes "$CURRENT_WAL_LSN" "$restart_lsn")
        
        if [[ "$wal_bytes" -gt 0 ]]; then
            # Format the display value with appropriate unit
            wal_mb=$(echo "scale=2; $wal_bytes / 1024 / 1024" | bc 2>/dev/null || echo "0")
            wal_gb=$(echo "scale=4; $wal_bytes / 1024 / 1024 / 1024" | bc 2>/dev/null || echo "0")
            
            # Show MB if less than 1GB, otherwise show GB
            if (( $(echo "$wal_gb < 1" | bc -l) )); then
                wal_display="${wal_mb}MB"
            else
                wal_display="$(echo "scale=2; $wal_gb" | bc)GB"
            fi
        else
            wal_display="0MB"
            wal_gb="0"
        fi
    fi
    
    # Skip empty slot names
    [[ -z "$slot_name" ]] && continue
    
    # Check for critical conditions
    # Note: We don't alert on inactive slots alone because PGSync uses a polling model -
    # it connects briefly to read changes, then disconnects. The slot appears "inactive"
    # most of the time, which is normal. We only alert on WAL accumulation or lost status.
    if [[ "$wal_status" == "lost" ]]; then
        msg="WAL files have been purged! The replication slot needs to be reset and data re-synced."
        echo "🚨 CRITICAL: Slot '$slot_name' ($slot_type) has LOST status! $msg"
        send_alert "critical" "$slot_name" "$slot_type" "$wal_display" "$wal_status" "$active" "$msg"
    elif [[ "$wal_status" == "unreserved" ]]; then
        msg="Slot is approaching max_slot_wal_keep_size limit. WAL may be purged soon if consumer doesn't catch up."
        echo "🚨 CRITICAL: Slot '$slot_name' ($slot_type) is UNRESERVED! $msg"
        send_alert "critical" "$slot_name" "$slot_type" "$wal_display" "$wal_status" "$active" "$msg"
    elif [[ "$wal_display" != "N/A" ]] && (( $(echo "$wal_gb >= $CRITICAL_THRESHOLD" | bc -l 2>/dev/null || echo 0) )); then
        msg="WAL retention has exceeded critical threshold. Consumer is falling behind significantly."
        echo "🚨 CRITICAL: Slot '$slot_name' ($slot_type) has ${wal_display} WAL retained (threshold: ${CRITICAL_THRESHOLD}GB)"
        send_alert "critical" "$slot_name" "$slot_type" "$wal_display" "$wal_status" "$active" "$msg"
    elif [[ "$wal_display" != "N/A" ]] && (( $(echo "$wal_gb >= $WARNING_THRESHOLD" | bc -l 2>/dev/null || echo 0) )); then
        msg="WAL retention is approaching the limit. Consumer may be falling behind."
        echo "⚠️  WARNING: Slot '$slot_name' ($slot_type) has ${wal_display} WAL retained (threshold: ${WARNING_THRESHOLD}GB)"
        send_alert "warning" "$slot_name" "$slot_type" "$wal_display" "$wal_status" "$active" "$msg"
    elif [[ "$wal_display" != "N/A" ]] && (( $(echo "$wal_gb >= $INFO_THRESHOLD" | bc -l 2>/dev/null || echo 0) )); then
        msg="WAL retention has reached 50% of the limit. Worth monitoring."
        echo "ℹ️  INFO: Slot '$slot_name' ($slot_type) has ${wal_display} WAL retained (threshold: ${INFO_THRESHOLD}GB)"
        send_alert "info" "$slot_name" "$slot_type" "$wal_display" "$wal_status" "$active" "$msg"
    else
        echo "✓ Slot '$slot_name' ($slot_type) healthy: ${wal_display} retained, status: $wal_status, active: $active"
    fi
done

echo "--- Check complete ---"

