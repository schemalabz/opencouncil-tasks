# PGSync Setup Guide

This guide covers setting up [PGSync](https://github.com/toluaina/pgsync) for real-time PostgreSQL to Elasticsearch synchronization in the opencouncil-tasks infrastructure.

## Table of Contents

- [Quick Reference](#quick-reference)
- [Overview](#overview)
- [Prerequisites](#prerequisites)
  - [1. PostgreSQL Configuration](#1-postgresql-configuration)
  - [2. Grant Replication Privileges](#2-grant-replication-privileges)
  - [3. PostgreSQL Views](#3-postgresql-views)
  - [4. PGSync Schema](#4-pgsync-schema)
- [Environment Variables](#environment-variables)
  - [Extracting Elasticsearch API Key](#extracting-elasticsearch-api-key)
- [Running PGSync](#running-pgsync)
  - [First-Time Setup / Re-indexing](#first-time-setup--re-indexing)
  - [Normal Operation](#normal-operation)
  - [Elasticsearch Timeout Issues](#elasticsearch-timeout-issues)
- [Post-Bootstrap: Grant App Access](#post-bootstrap-grant-app-access)
- [Monitoring and Maintenance](#monitoring-and-maintenance)
- [How PGSync Uses Triggers](#how-pgsync-uses-triggers)
- [WAL Monitoring Setup](#wal-monitoring-setup)
- [Troubleshooting](#troubleshooting)
- [How WAL and Replication Slots Work](#how-wal-and-replication-slots-work)

## Quick Reference

### Key Points
- ✅ Set `max_slot_wal_keep_size` to 15-25% of your disk (e.g., 15GB for 60GB disk)
- ✅ Set up automated WAL monitoring with Discord alerts (see [WAL Monitoring](#wal-monitoring-setup))
- ✅ A **"lost"** WAL status means the slot must be reset and data re-synced
- ✅ Inactive slots are **normal** for PGSync's polling model - only worry if WAL is growing
- ⚠️ **After every bootstrap/re-index**: Grant app access to `_view` (see [Post-Bootstrap](#post-bootstrap-grant-app-access))


### Health Check Commands
```bash
# Check replication slot status (run this manually anytime)
psql "$PG_URL" -c "SELECT slot_name, slot_type, active, wal_status FROM pg_replication_slots;"

# Run WAL monitoring script manually
./scripts/check-wal.sh

# View PGSync logs
docker compose logs -f pgsync

# View WAL monitoring logs (after cron is set up)
tail -f logs/wal-check.log
```

## Overview

PGSync uses PostgreSQL's logical replication (WAL) to sync data to Elasticsearch in real-time. It runs as a Docker service with Redis-based checkpointing for fault tolerance.

**Key Features:**
- Real-time change data capture via logical decoding
- Automatic handling of INSERT, UPDATE, DELETE, TRUNCATE
- Redis checkpointing for resumable sync
- Complex relationship mapping with nested documents

## Prerequisites

### 1. PostgreSQL Configuration

Enable logical decoding (for managed databases like DigitalOcean, AWS RDS, this is typically enabled by default or via a parameter group):

```sql
-- Verify settings
SHOW wal_level;  -- Should return 'logical'
SHOW max_replication_slots;  -- Should be >= 1
```

See [PostgreSQL Logical Replication docs](https://www.postgresql.org/docs/current/logical-replication.html) for detailed setup.

### 2. Grant Replication Privileges

The PostgreSQL user used by PGSync needs specific permissions to read data and manage replication slots. **Note**: PGSync only reads data; it does not write to your tables.

**Option A: Grant replication to an existing user**
```sql
ALTER ROLE your_username WITH REPLICATION;
```

**Option B: Create a dedicated PGSync user**
```sql
-- Create user with replication privilege
CREATE ROLE pgsync WITH LOGIN REPLICATION PASSWORD 'secure_password';

-- Database access
GRANT CONNECT ON DATABASE your_database TO pgsync;

-- Schema access
GRANT USAGE ON SCHEMA public TO pgsync;
GRANT CREATE ON SCHEMA public TO pgsync;  -- For internal triggers/functions

-- Read access to tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgsync;

-- Trigger privilege (required for creating change capture triggers)
GRANT TRIGGER ON ALL TABLES IN SCHEMA public TO pgsync;

-- Grant SELECT and TRIGGER on future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO pgsync;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRIGGER ON TABLES TO pgsync;

-- Sequence access (for serial/auto-increment columns)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pgsync;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO pgsync;
```

**Important: Grant table owner role for re-indexing**

PGSync needs to DROP triggers during re-indexing, which requires table ownership. If you get permission errors like `must be owner of relation TableName`, the PGSync user doesn't have sufficient privileges. Grant the table owner role to pgsync:
```sql
-- Replace 'table_owner_role' with the role that owns your tables
-- (e.g., 'readandwrite', 'admin', etc.)
GRANT table_owner_role TO pgsync;
```

To find the table owner:
```sql
SELECT tableowner FROM pg_tables WHERE tablename = 'YourTableName';
```

Without this grant, re-indexing will fail with `must be owner of relation` errors. You can revoke this after bootstrap if you want minimal permissions during normal operation:
```sql
REVOKE table_owner_role FROM pgsync;
```

**For multiple schemas:** Repeat the `GRANT USAGE`, `GRANT CREATE`, `GRANT SELECT`, and `ALTER DEFAULT PRIVILEGES` statements for each schema.

**Verify permissions:**
```sql
SELECT rolname, rolreplication FROM pg_roles WHERE rolname = 'pgsync';
-- rolreplication should be 't' (true)
```

**For managed databases (DigitalOcean, AWS RDS, etc.):** The default admin user typically has replication privileges. If creating a new user, check your provider's documentation for enabling replication.

### 3. PostgreSQL Views

Create the required helper views defined in the [main opencouncil repository](https://github.com/schemalabz/opencouncil/blob/main/docs/elasticsearch.md#configure-postgresql-views).

### 4. PGSync Schema

The PGSync schema defines table relationships, field mappings, and transformations. Host it remotely (e.g., GitHub Gist) and reference via `SCHEMA_URL`.

- [PGSync Schema Documentation](https://pgsync.com/schema/)
- [Example Schemas](https://github.com/toluaina/pgsync/tree/main/examples)

> **Note**: Schema changes require re-indexing Elasticsearch (see [Re-indexing](https://pgsync.com/advanced/re-indexing/)).

## Environment Variables

Configure in your `.env` file:

```bash
# PostgreSQL
PG_URL=postgresql://user:password@host:port/database

# Elasticsearch
ELASTICSEARCH_URL=https://your-cluster.es.region.aws.elastic.cloud:443
ELASTICSEARCH_API_KEY_ID=<api_key_id>
ELASTICSEARCH_API_KEY=<api_key_secret>

# PGSync Schema
SCHEMA_URL=https://gist.githubusercontent.com/user/gist-id/raw/schema.json
```

> **Note**: Redis runs internally in the Docker network and doesn't require configuration.

### Extracting Elasticsearch API Key

Elasticsearch provides a base64-encoded API key by default. Decode it to get the ID and secret:

```bash
# Decode the base64 key
echo 'YOUR_BASE64_API_KEY' | base64 -d
# Output: <id>:<secret>
```

Use the parts:
- `ELASTICSEARCH_API_KEY_ID=<id>` (before the colon)
- `ELASTICSEARCH_API_KEY=<secret>` (after the colon)

## Running PGSync

PGSync requires a **two-step process**: bootstrap (one-time initial sync) followed by daemon mode (continuous sync).

### First-Time Setup / Re-indexing

```bash
# 1. Start Redis (required for checkpointing)
docker compose up -d redis

# 2. Clear any previous checkpoints
docker compose exec redis redis-cli FLUSHALL

# 3. Run bootstrap (creates replication slot + initial sync)
#    Use longer timeout and smaller chunks if you have semantic_text fields
docker compose run --rm -e ELASTICSEARCH_TIMEOUT=120 -e ELASTICSEARCH_CHUNK_SIZE=50 pgsync --bootstrap

# 4. CRITICAL: Grant app access to _view (required after every bootstrap!)
#    Replace 'your_app_user' with your app's database user
psql "$PG_URL" -c "GRANT SELECT ON public._view TO your_app_user;"

# 5. Start the daemon for continuous sync
docker compose up -d pgsync

# 6. Verify it's running
docker compose logs -f pgsync
```

> ⚠️ **Don't skip step 4!** Bootstrap creates a `_view` materialized view that PGSync's triggers reference. Your app's database user needs SELECT permission on it, otherwise you'll get `permission denied for materialized view _view` errors when modifying data.

**Note:** If bootstrap times out but documents are being indexed, just re-run the bootstrap command - it resumes from the Redis checkpoint.

### Normal Operation

```bash
# View logs
docker compose logs -f pgsync

# Restart pgsync only
docker compose restart pgsync
```

The service configuration:
- Runs in daemon mode (`-d`)
- Depends on Redis for checkpointing
- Automatically restarts on failure
- Stores state in Redis (no filesystem checkpoints)

### Elasticsearch Timeout Issues

If you see `ConnectionTimeout` errors during bootstrap, your Elasticsearch cluster is slow to respond (common with `semantic_text` fields that require ML inference). Solutions:

```bash
# Increase timeout and reduce chunk size
docker compose run --rm \
  -e ELASTICSEARCH_TIMEOUT=180 \
  -e ELASTICSEARCH_CHUNK_SIZE=20 \
  pgsync --bootstrap
```

You can also add these to your `docker-compose.yml` environment section for the daemon.

## Post-Bootstrap: Grant App Access

After bootstrapping PGSync, your application's database user needs access to PGSync's internal objects. PGSync creates triggers that reference an internal `_view` materialized view.

Connect as admin and grant permissions:

```sql
-- Grant SELECT on PGSync's internal view to your app's user
GRANT SELECT ON public._view TO your_app_user;
```

Replace `your_app_user` with the username your application uses (check your app's `DATABASE_URL` to find it).

Without this grant, your app will get `permission denied for materialized view _view` errors when modifying data.

## Monitoring and Maintenance

This section is a short **runbook** for keeping PGSync healthy and avoiding WAL surprises.

### Quick health checks

```bash
# Is PGSync running?
docker compose ps pgsync
docker compose logs --tail=200 pgsync

# Run the WAL monitor (recommended)
./scripts/check-wal.sh
```

If you want to inspect slots manually:

```sql
SELECT
  slot_name,
  slot_type,
  active,
  wal_status,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
  restart_lsn,
  confirmed_flush_lsn
FROM pg_replication_slots
ORDER BY slot_name;
```

### How to interpret `wal_status`

- **`reserved`**: OK
- **`extended`**: growing beyond `max_wal_size` (watch it)
- **`unreserved`**: near `max_slot_wal_keep_size` (action needed)
- **`lost`**: WAL was purged; the slot cannot recover (reset required)

### Common incidents

#### Slot is inactive (`active=false`)

- **What it means**: This is **often normal**. PGSync uses a polling model - it connects briefly to read changes, then disconnects. The slot appears "inactive" most of the time.
- **When to worry**: If WAL retention is growing significantly while the slot is inactive, PGSync may be stuck or down.
- **What to do**: Check `docker compose logs pgsync` for errors. If PGSync is running and showing sync activity (`Xlog: [0] => Db: [X]...`), the inactive status is normal.

#### Retained WAL is climbing (warnings/critical)

- **What it means**: PGSync can’t keep up, or is stuck retrying.
- **What to do**: check PGSync logs and Elasticsearch health; look for repeated bulk failures or auth issues. Also confirm the host has disk headroom (`df -h`).

#### Slot is `lost` (reset required)

If a slot becomes `lost`, it is unrecoverable. Reset it and re-bootstrap:

```sql
-- Drop the broken slot (replace slot name)
SELECT pg_drop_replication_slot('production_subjects');
```

```bash
# Clear PGSync checkpoint (Redis)
docker compose exec redis redis-cli FLUSHALL

# Delete the Elasticsearch index (replace index name)
curl -X DELETE "$ELASTICSEARCH_URL/subjects" \
  -H "Authorization: ApiKey $(echo -n $ELASTICSEARCH_API_KEY_ID:$ELASTICSEARCH_API_KEY | base64)"

# Run bootstrap to recreate slot and re-index
docker compose run --rm -e ELASTICSEARCH_TIMEOUT=120 -e ELASTICSEARCH_CHUNK_SIZE=50 pgsync --bootstrap

# CRITICAL: Re-grant app access to _view (bootstrap recreates it)
psql "$PG_URL" -c "GRANT SELECT ON public._view TO your_app_user;"

# Then start the daemon
docker compose up -d pgsync
```

## How PGSync Uses Triggers

PGSync uses **two mechanisms** for change detection:

### 1. Logical Replication Slot (Primary)
PostgreSQL's WAL logical decoding captures all changes to monitored tables. This is the main mechanism for real-time sync.

### 2. Database Triggers (Supplementary)
During bootstrap, PGSync creates triggers on each monitored table:
- Trigger names follow the pattern: `public_TableName_notify`
- These triggers call `pg_notify()` when rows change
- They reference an internal `_view` materialized view

### What Bootstrap Does

1. **Drops existing triggers** (cleanup from previous runs)
2. Creates the `_view` materialized view
3. Creates new triggers on all monitored tables
4. Creates the replication slot
5. Does initial full sync to Elasticsearch
```

### Preventing WAL blowups (recommended)

- **Set `max_slot_wal_keep_size`**: rule of thumb is **15–25% of disk** (enough buffer to investigate without filling the volume).
- **Keep PGSync always-on**: stopped containers = inactive slot = WAL growth.
- **Add alerts**: use the cron-based monitor in [WAL Monitoring Setup](#wal-monitoring-setup).

## WAL Monitoring Setup

This repo includes `scripts/check-wal.sh`, a small cron-friendly monitor that:
- computes **retained WAL** per replication slot,
- warns when a slot is **inactive** or approaching limits,
- sends alerts to `ALERT_WEBHOOK_URL` (Discord/Slack-compatible JSON).

### 1) Install dependencies


```bash
# Install standard tools (jq, bc, curl, tar)
sudo apt update && sudo apt install -y jq bc curl tar

# pgmetrics is auto-downloaded by scripts/check-wal.sh (Linux amd64) into scripts/.bin/
# the first time you run it (no sudo required).
#
# To disable auto-install:
#   PGMETRICS_AUTO_INSTALL=0 ./scripts/check-wal.sh
```

### 2) Configure environment

`scripts/check-wal.sh` loads `.env` automatically if present.

```bash
# Required
PG_URL=postgresql://user:password@host:port/database
# (also supported: postgresql://...)

# Optional (recommended): where alerts go
ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_TOKEN

# Optional: override thresholds (GB). If unset, the script derives them from
# Postgres max_slot_wal_keep_size (warn=80%, critical=95%).
WAL_WARNING_THRESHOLD_GB=12
WAL_CRITICAL_THRESHOLD_GB=15
```

### 3) Run it manually

```bash
./scripts/check-wal.sh
```

### 4) Install as a cron job

```bash
mkdir -p logs
crontab -e
```

Add (adjust path):

```bash
*/30 * * * * cd /root/opencouncil-tasks && ./scripts/check-wal.sh >> logs/wal-check.log 2>&1
```

This runs every 30 minutes. For higher-traffic production systems, you can use `*/5` (every 5 minutes).

### 5) Set up log rotation

The log file will grow indefinitely. Set up logrotate to manage it:

```bash
sudo tee /etc/logrotate.d/wal-check << 'EOF'
/root/opencouncil-tasks/logs/wal-check.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
EOF
```

This keeps 7 days of logs, compressed.

### 6) Verify cron is working

```bash
# Check cron job exists
crontab -l | grep check-wal

# Check when log was last updated (after 30+ minutes)
ls -la logs/wal-check.log

# Check system cron logs
grep check-wal /var/log/syslog | tail -5
```

### 7) Read output

```bash
tail -f logs/wal-check.log
grep -E "WARNING|CRITICAL|INFO" logs/wal-check.log
```

### 6) Test alerts (safe)

On a **non-production** DB, create a temporary slot and generate WAL:

```sql
-- 1) Create a test table and generate some WAL
CREATE TABLE IF NOT EXISTS wal_monitor_test (id bigserial primary key, payload text, created_at timestamptz default now());
INSERT INTO wal_monitor_test (payload) SELECT md5(random()::text) FROM generate_series(1, 20000);

-- 2) Create a logical slot (requires a plugin; pgoutput is available on PG 10+)
SELECT * FROM pg_create_logical_replication_slot('test_wal_monitor', 'pgoutput');

-- 3) Generate more WAL (slot stays inactive, WAL retained grows)
INSERT INTO wal_monitor_test (payload) SELECT md5(random()::text) FROM generate_series(1, 20000);
```

Run the check:

```bash
./scripts/check-wal.sh
```

Cleanup:

```sql
SELECT pg_drop_replication_slot('test_wal_monitor');
DROP TABLE IF EXISTS wal_monitor_test;
```


## Troubleshooting

### "permission denied for materialized view _view" error

```
PostgresError { code: "42501", message: "permission denied for materialized view _view" }
```

**Cause:** Your app's database user doesn't have SELECT permission on PGSync's internal `_view` materialized view. This happens after bootstrap/re-indexing because PGSync drops and recreates `_view`.

**Fix:**
```sql
-- Grant SELECT on _view to your app's database user
GRANT SELECT ON public._view TO your_app_user;
```

This must be done **after every bootstrap/re-index**.

### "Replication slot does not exist" error

```
RuntimeError: Replication slot "production_subjects" does not exist.
Make sure you have run the "bootstrap" command.
```

**Cause:** The daemon (`-d`) expects the slot to exist, but it was dropped or never created.

**Fix:** Run bootstrap first:
```bash
docker compose run --rm pgsync --bootstrap
psql "$PG_URL" -c "GRANT SELECT ON public._view TO your_app_user;"
docker compose up -d pgsync
```

### "must be owner of relation" error

```
psycopg2.errors.InsufficientPrivilege: must be owner of relation TableName
```

**Cause:** PGSync needs to drop triggers from a previous run, but the pgsync user doesn't own the tables.

**Fix:** Grant the table owner role to pgsync:
```sql
-- Find the table owner
SELECT tableowner FROM pg_tables WHERE tablename = 'TableName';

-- Grant that role to pgsync (replace 'owner_role')
GRANT owner_role TO pgsync;
```

Then retry bootstrap.

### "permission denied for schema aiven_extras" error

**Cause:** Older PGSync versions tried to use `aiven_extras` schema on DigitalOcean/Aiven databases.

**Fix:** Pull the latest PGSync image:
```bash
docker pull toluaina1/pgsync:latest
docker compose run --rm pgsync --bootstrap
psql "$PG_URL" -c "GRANT SELECT ON public._view TO your_app_user;"
```

### Elasticsearch timeout during bootstrap

```
elasticsearch.exceptions.ConnectionTimeout: ConnectionTimeout caused by - ReadTimeoutError
```

**Cause:** Bulk indexing is slow, often due to `semantic_text` fields requiring ML inference.

**Fix:** Increase timeout and reduce chunk size:
```bash
docker compose run --rm \
  -e ELASTICSEARCH_TIMEOUT=180 \
  -e ELASTICSEARCH_CHUNK_SIZE=20 \
  pgsync --bootstrap
```

Documents are still being indexed even when it times out - just re-run the command until it completes.

### PGSync daemon keeps restarting

Check logs for the actual error:
```bash
docker compose logs --tail=100 pgsync
```

Common causes:
- Elasticsearch auth issues (check API key)
- Database connection issues (check PG_URL)
- Missing replication slot (run bootstrap first)

---

## How WAL and Replication Slots Work

**Understanding Write-Ahead Logs (WAL):**

PostgreSQL doesn't directly notify PGSync of changes. Instead:

1. **Every database change** (INSERT, UPDATE, DELETE, DDL) is first written to WAL files
2. WAL is PostgreSQL's transaction log - it records EVERYTHING happening in your database
3. WAL files are sequential and cannot be skipped - they must be processed in order
4. By default, PostgreSQL deletes old WAL files after they're no longer needed for crash recovery

**What Replication Slots Do:**

A replication slot is like a **bookmark** that tells PostgreSQL:
> "Don't delete WAL files from this position forward - someone is still reading them"

When PGSync creates a replication slot:
- PostgreSQL marks the current WAL position
- PGSync reads changes from that position forward
- PostgreSQL **cannot delete WAL files** until PGSync has consumed them
- Even if PGSync syncs instantly, the WAL files still exist until PostgreSQL's checkpoint process removes them

**Why WAL Space Accumulates:**

Normal operation (PGSync running):
```
1. You make a change to the database
2. PostgreSQL writes it to WAL (~immediately)
3. PGSync reads from WAL and syncs to Elasticsearch (seconds to minutes)
4. PostgreSQL marks that WAL position as "consumed" by PGSync
5. PostgreSQL eventually deletes old WAL files (after ALL slots consume them)
```

When PGSync is down or lagging:
```
1. You make changes to the database
2. PostgreSQL writes them to WAL
3. PGSync is NOT reading/consuming the WAL
4. PostgreSQL CANNOT delete WAL files (slot bookmark hasn't moved)
5. WAL files accumulate on disk
```

**Important - Understanding Logical vs Physical WAL:**

PGSync uses **logical replication slots**, which behave differently from physical replication:

- **Logical slots filter changes**: PGSync's slot only decodes and accumulates changes for tables defined in its schema. Changes to unrelated tables (like a `wal_test` table) are **not** accumulated in the slot's pending changes.
- **But WAL files are retained**: PostgreSQL cannot delete WAL files until the slot's bookmark (`restart_lsn`) advances past them. The WAL files themselves contain ALL database changes.

**Example:**

Your database has:
- Tables A, B, C (synced by PGSync)
- Tables X, Y, Z (not synced by PGSync)

You run 1000 updates on table X (not synced):
- These updates are written to physical WAL files
- PGSync's logical slot **ignores** these changes (they won't appear in `Xlog:` count)
- **However**, if PGSync is stopped, the slot's bookmark doesn't advance
- PostgreSQL retains the WAL files containing those updates until PGSync resumes and advances the bookmark

**The real risk**: When PGSync stops, ALL database activity (synced or not) generates WAL files that cannot be cleaned up. A busy database with lots of unrelated writes will fill disk even though PGSync only cares about a few tables.

This is why `max_slot_wal_keep_size` is critical - it prevents runaway disk usage when PGSync can't keep up.

**What Affects WAL Size:**

Your WAL growth rate depends on:
- Total write volume (ALL tables, not just synced ones)
- Transaction frequency
- Large updates (e.g., bulk operations)
- DDL changes (CREATE, ALTER, DROP statements)
---

For detailed usage, troubleshooting, and advanced configuration, see the [PGSync Documentation](https://pgsync.com/).
