#!/usr/bin/env bash
#
# Local MinIO backing the eval archive (s3://opencouncil-eval-archive).
#
# Usage:
#   scripts/archive-minio.sh start   # start in the background, create the bucket
#   scripts/archive-minio.sh stop
#   eval "$(scripts/archive-minio.sh env)"
#
# Prerequisites: nix develop shell (provides minio, mc)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="$PROJECT_DIR/.minio-eval"
PID_FILE="$DATA_DIR/minio.pid"
API_PORT=9200
CONSOLE_PORT=9201
ROOT_USER=evalarchive
ROOT_PASSWORD=evalarchive-secret
BUCKET=opencouncil-eval-archive
ENDPOINT="http://127.0.0.1:$API_PORT"

is_running() {
    [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

healthy() {
    curl -sf "$ENDPOINT/minio/health/live" >/dev/null 2>&1
}

start() {
    for cmd in minio mc; do
        if ! command -v "$cmd" &>/dev/null; then
            echo "Error: $cmd is not installed. Run 'nix develop' first." >&2
            exit 1
        fi
    done

    if is_running; then
        echo "MinIO already running (pid $(cat "$PID_FILE"))."
    else
        # The pid file lives inside the data dir, so MinIO's own data goes in a subdirectory.
        mkdir -p "$DATA_DIR/data"
        MINIO_ROOT_USER="$ROOT_USER" MINIO_ROOT_PASSWORD="$ROOT_PASSWORD" \
            nohup minio server "$DATA_DIR/data" \
            --address "127.0.0.1:$API_PORT" \
            --console-address "127.0.0.1:$CONSOLE_PORT" \
            --quiet >"$DATA_DIR/minio.log" 2>&1 &
        echo $! >"$PID_FILE"
        echo "Started MinIO (pid $!) on $ENDPOINT (console: http://127.0.0.1:$CONSOLE_PORT)."
    fi

    for _ in $(seq 1 40); do
        healthy && break
        if ! is_running; then
            echo "Error: MinIO exited unexpectedly; see $DATA_DIR/minio.log" >&2
            exit 1
        fi
        sleep 0.25
    done
    if ! healthy; then
        echo "Error: MinIO did not become healthy after 10s." >&2
        exit 1
    fi

    mc alias set evalarchive "$ENDPOINT" "$ROOT_USER" "$ROOT_PASSWORD" >/dev/null
    mc mb --ignore-existing "evalarchive/$BUCKET" >/dev/null
    mc anonymous set none "evalarchive/$BUCKET" >/dev/null
    echo "Bucket '$BUCKET' ready (private)."
}

stop() {
    if is_running; then
        local pid
        pid="$(cat "$PID_FILE")"
        kill "$pid"
        for _ in $(seq 1 40); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.25
        done
        echo "Stopped MinIO (pid $pid)."
    else
        echo "MinIO is not running."
    fi
    rm -f "$PID_FILE"
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    env)
        echo "export ARCHIVE_URL=s3://$BUCKET ARCHIVE_S3_ENDPOINT=$ENDPOINT ARCHIVE_S3_KEY=$ROOT_USER ARCHIVE_S3_SECRET=$ROOT_PASSWORD"
        ;;
    *)
        echo "Usage: $0 start|stop|env" >&2
        exit 1
        ;;
esac
