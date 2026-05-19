---
name: deploy
description: Deploy a release to staging or production, or show current deployment status.
argument-hint: "[staging|production [<tag>]]"
---

# Deploy

Deploy a tagged release to the tasks server, or show what's currently running.

## Server

Host: `134.122.74.255` (SSH as `root`)

| Environment | Directory | Container | Port |
|---|---|---|---|
| **production** | `/root/opencouncil-tasks/` | `opencouncil-tasks-app-1` | 3005 |
| **staging** | `/root/staging-opencouncil-tasks/` | `staging-opencouncil-tasks-app-1` | 3006 |

## Arguments

- `$ARGUMENTS` — optional, space-separated tokens:
  - *(empty)* — show status of both environments
  - `staging` — deploy the latest release tag to staging
  - `production` — deploy the latest release tag to production
  - `staging <tag>` or `production <tag>` — deploy a specific tag
  - `status` — explicit status check (same as empty)

## Argument Parsing

1. If `$ARGUMENTS` is empty or `status`, set `ACTION=status`.
2. If `$ARGUMENTS` starts with `staging` or `production`, set `ACTION=deploy` and `TARGET` accordingly. If a second token is present, set `TAG` to that value; otherwise `TAG=latest`.

## Step 1: Gather Status

Always run this step regardless of action. SSH to the server and collect:

```bash
ssh root@134.122.74.255 bash -s <<'SCRIPT'
echo "=== Production ==="
cd /root/opencouncil-tasks
echo "version: $(git describe --tags --always 2>/dev/null)"
echo "container: $(docker compose ps app --format '{{.Status}}' 2>/dev/null)"

echo "=== Staging ==="
cd /root/staging-opencouncil-tasks
echo "version: $(git describe --tags --always 2>/dev/null)"
echo "container: $(docker compose ps app --format '{{.Status}}' 2>/dev/null)"
SCRIPT
```

Also fetch the list of available release tags locally:

```bash
git tag --list '20[0-9][0-9].[0-9]*' --sort=-version:refname | head -5
```

Present the status in a clear table:

```
Environment  | Version   | Container Status
-------------|-----------|------------------
production   | 2026.5.1  | Up 28 hours
staging      | 2026.5.1  | Up 2 hours
```

If `ACTION=status`, stop here.

## Step 2: Check for Running Tasks

Before deploying, check if there are tasks running on the target environment. The `/tasks` endpoint requires a bearer token from `secrets/apiTokens.json`:

```bash
ssh root@134.122.74.255 bash -s <<'SCRIPT'
TOKEN=$(cat <target-directory>/secrets/apiTokens.json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:<target-port>/tasks
SCRIPT
```

The response looks like:
```json
{"running":[...],"queued":0,"maxParallelTasks":10}
```

If there are running or queued tasks, **stop and warn the user**. Show what's running (task type, stage, duration, and the meeting context parsed from the callback URL — e.g. `https://opencouncil.gr/api/cities/zografou/meetings/dec11_2025/...` → `zografou / dec11_2025`). Ask whether to proceed or wait. Do not deploy without explicit confirmation that it's OK to interrupt running tasks.

If no tasks are running or queued, proceed.

## Step 3: Resolve Tag

If `TAG=latest`, determine the latest release tag:

```bash
DEPLOY_TAG=$(git tag --list '20[0-9][0-9].[0-9]*' --sort=-version:refname | head -1)
```

If a specific tag was given, verify it exists:

```bash
git rev-parse --verify "$TAG" >/dev/null 2>&1
```

If the tag doesn't exist, stop and tell the user.

Show what will be deployed: the tag, and a brief summary of what changed since what's currently running on the target environment. Use `git log --oneline <current>..<deploy_tag>` to show the commits.

## Step 4: Confirm and Deploy

**Always confirm with the user before deploying.** Show:
- Target environment
- Tag being deployed
- What's currently running

After confirmation, deploy:

```bash
ssh root@134.122.74.255 bash -s <<SCRIPT
cd <target-directory>
git fetch --tags
git checkout $DEPLOY_TAG
docker compose up app -d --build
SCRIPT
```

## Step 5: Verify

Wait a few seconds, then check the container came up healthy:

```bash
ssh root@134.122.74.255 bash -s <<SCRIPT
cd <target-directory>
echo "version: $(git describe --tags --always)"
docker compose ps app
SCRIPT
```

Report the result. If the container didn't start, show the last 20 lines of logs:

```bash
ssh root@134.122.74.255 "cd <target-directory> && docker compose logs app --tail 20"
```
