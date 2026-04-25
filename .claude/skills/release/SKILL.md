---
name: release
description: Tag a CalVer release on main, create a GitHub release, and generate a Discord announcement.
argument-hint: "[dry-run] | <ref>..<ref>"
---

# Release

Tag a CalVer release on main and generate release content. Single-branch workflow — no production branch, tags go directly on main.

## Arguments

- `$ARGUMENTS` — optional, space-separated tokens:
  - `dry-run` — generate content without tagging or publishing
  - `<ref>..<ref>` — generate content for an arbitrary git range. Implies dry-run. Examples:
    - `abc123..def456` — between two commits
    - `2026.4.1..2026.4.2` — between two tags
    - `2026.4.2..HEAD` — from a tag to current HEAD
  - *(empty)* — full release: tag main, create GitHub release, generate Discord announcement

Tokens can appear in any order.

## Argument Parsing

1. If `$ARGUMENTS` contains `..`, treat it as an **explicit range**. Validate both refs exist:
   ```bash
   git rev-parse --verify <left-ref>
   git rev-parse --verify <right-ref>
   ```
   Set `RANGE="<left-ref>..<right-ref>"` and `DRY_RUN=true`.

2. If `$ARGUMENTS` contains `dry-run`, set `DRY_RUN=true`.

3. If `$ARGUMENTS` is empty, set `DRY_RUN=false`.

For non-explicit ranges, `RANGE` is determined after finding the last tag in Step 2.

## Step 1: Pre-flight Checks

Skip this step if an explicit range was given.

Determine the upstream remote:

```bash
git remote | grep -q upstream && REMOTE=upstream || REMOTE=origin
```

Verify clean state and sync:

```bash
git status --porcelain
git fetch $REMOTE

# Must be on main, in sync with remote
git rev-parse --abbrev-ref HEAD  # should be main
git log --oneline $REMOTE/main..HEAD  # should be empty
git log --oneline HEAD..$REMOTE/main  # should be empty
```

If there are unpushed or unpulled commits, stop and tell the user.

## Step 2: Gather Context

Find the last release tag and set the range:

```bash
LAST_TAG=$(git tag --list '20[0-9][0-9].[0-9]*' --sort=-version:refname | head -1)
echo "Last release: ${LAST_TAG:-none}"
```

If no explicit range was given, set `RANGE="${LAST_TAG}..HEAD"`. If there is no previous tag, use `$(git rev-list --max-parents=0 HEAD)..HEAD` to cover all commits.

Check there are changes to release:

```bash
git log --oneline $RANGE
```

If there are no commits in the range, stop — nothing to release.

Collect the raw material:

```bash
git log --format="%H %s" $RANGE
git diff --stat $RANGE
git diff --name-only $RANGE
git diff $RANGE
```

**Important**: Commit messages are a signal, not the source of truth. Always cross-reference messages against the actual diff to understand what really changed.

## Step 3: Determine Version

CalVer format: `YYYY.MM.N` where N is a sequential counter starting at 1, resetting each month.

```bash
YEAR=$(date +%Y)
MONTH=$(date +%-m)
PREFIX="${YEAR}.${MONTH}"

LAST_N=$(git tag --list "${PREFIX}.*" --sort=-version:refname | head -1 | awk -F. '{print $3}')

if [ -z "$LAST_N" ]; then
  NEXT_VERSION="${PREFIX}.1"
else
  NEXT_VERSION="${PREFIX}.$((LAST_N + 1))"
fi

echo "Next version: $NEXT_VERSION"
```

## Step 4: Analyze and Generate

Analyze the changes — group by impact, not by commit type. Write for someone deciding whether to deploy this update.

Generate two outputs, each following its template. Read each template before generating:

1. **GitHub Release notes** — see [templates/github-release.md](templates/github-release.md)
2. **Discord announcement** — see [templates/discord.md](templates/discord.md)

Present both outputs to the user for review before proceeding.

## Step 5: Tag and Publish

**Skip this step if `DRY_RUN=true`.**

After the user approves:

1. **Tag the release** on main:
   ```bash
   git tag -a $NEXT_VERSION -m "Release $NEXT_VERSION"
   ```

2. **Push the tag**:
   ```bash
   git push $REMOTE $NEXT_VERSION
   ```

3. **Create the GitHub release**:
   ```bash
   gh release create $NEXT_VERSION --target main --title "$NEXT_VERSION" --notes-file <release-notes-file>
   ```

4. Print the Discord announcement for the user to copy.

**Always confirm with the user before pushing the tag and creating the GitHub release.**

## Notes

- If the commit history is messy, focus on the diff rather than the messages.
- **Omit empty sections** in all outputs — no "None" or "N/A".
- Group related commits into single bullets — don't list every commit.
