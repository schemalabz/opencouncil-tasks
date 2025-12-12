# PGSync Setup Guide

This guide covers setting up [PGSync](https://github.com/toluaina/pgsync) for real-time PostgreSQL to Elasticsearch synchronization in the opencouncil-tasks infrastructure.

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
PG_URL=postgres://user:password@host:port/database

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

PGSync runs automatically as part of the `docker-compose.yml` stack:

```bash
# Start all services (includes pgsync)
docker compose up -d app

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

## Post-Bootstrap: Grant App Access

After bootstrapping PGSync, your application's database user needs access to PGSync's internal objects. PGSync creates triggers that reference an internal `_view` materialized view.

Connect as admin and grant permissions:

```sql
-- Grant SELECT on PGSync's internal view to your app's user
GRANT SELECT ON public._view TO your_app_user;
```

Replace `your_app_user` with the username your application uses (check your app's `DATABASE_URL` to find it).

Without this grant, your app will get `permission denied for materialized view _view` errors when modifying data.

For detailed usage, troubleshooting, and advanced configuration, see the [PGSync Documentation](https://pgsync.com/).
