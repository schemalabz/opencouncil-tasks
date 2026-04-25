---
name: logs
description: Read application logs from the production or staging server via SSH.
argument-hint: "[staging] [number|follow|search term]"
allowed-tools: Bash, Read
---

# SKILL: Read Server Logs

Read application logs from the opencouncil-tasks server at `134.122.74.255`.

## Server Layout

- **Production**: `/root/opencouncil-tasks/logs/app.log`
- **Staging**: `/root/staging-opencouncil-tasks/logs/app.log`

Rotated files exist as `app.log.1` through `app.log.5` (oldest).

## Parse Arguments

Parse `$ARGUMENTS` to determine:
1. **Environment**: If arguments contain `staging` or `stg`, use the staging path. Otherwise default to production.
2. **Mode** (first match wins):
   - No arguments or just environment: show last 100 lines
   - A number (e.g., `500`): show that many lines
   - `follow`, `-f`, or `tail`: run `tail -f` (warn user to Ctrl+C to stop)
   - `all`: show last 500 lines from current file plus `app.log.1` for broader history
   - Any other text: grep for that term across the current log file

## Execution

Construct and run the appropriate SSH command:

```bash
# Example: last 100 lines of production
ssh root@134.122.74.255 'tail -100 /root/opencouncil-tasks/logs/app.log'

# Example: grep for "error" in staging
ssh root@134.122.74.255 'grep -i "error" /root/staging-opencouncil-tasks/logs/app.log | tail -200'

# Example: follow production
ssh root@134.122.74.255 'tail -f /root/opencouncil-tasks/logs/app.log'
```

## Output

After showing the logs, give a brief one-line summary of what you see (e.g., "Logs look healthy — last task completed successfully" or "Task X failed with error Y at timestamp Z").
