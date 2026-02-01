# Contributing to opencouncil-tasks

## Development Setup

**Nix (recommended):**

```bash
nix develop
npm install
npm test
```

**Docker:** See [README.md](./README.md) for container-based setup.

**Manual:**

```bash
npm install
npm run dev
```

## Project Structure

```
src/
├── tasks/*.ts          # Each file exports a Task<Args, Ret>
├── tasks/utils/        # Shared pure logic (parsing, formatting, filters)
├── lib/                # Service clients (database, APIs, external tools)
├── types.ts            # Shared type definitions
├── utils.ts            # General-purpose pure utilities
└── pipeline.ts         # End-to-end task orchestration
```

## Testing

### Philosophy

Test contracts, not wiring. Pure functions that parse, format, transform, or compute have stable input→output contracts worth verifying. Orchestration code that glues services together changes often and is better validated by integration or manual testing.

### Decision Rules

**DO test:**

- Stateless pure functions: parsing, formatting, string construction, math, data transforms
- Any function whose correctness can be verified with `f(input) === expectedOutput`
- Pipeline orchestration — via dependency injection with stubbed tasks (see pattern below)

**DO NOT test (in unit tests):**

- Anything that touches the filesystem, network, or spawns processes (e.g. ffmpeg)
- Express routes, external API calls, database queries
- These are covered by the smoke test instead (see below)

**When adding a new pure function** that is file-private, export it so it can be tested.

### Conventions

- **Test runner:** Vitest
- **File location:** Colocated — `foo.ts` → `foo.test.ts`
- **Imports:** Use `.js` extensions (ESM requirement)
- **Type checking:** Run `npm run typecheck` — Vitest skips type checking for speed, so `tsc --noEmit` catches errors that tests won't
- **Structure:**
  ```ts
  describe('functionName', () => {
    it('describes expected behavior', () => {
      expect(myFn(input)).toEqual(expected);
    });
  });
  ```
- **Pipeline / orchestration tests:** Use the `createPipeline(deps)` factory to inject stub tasks. Each stub is a `vi.fn(async () => cannedData)`. This lets you test ordering, data flow, and error propagation without real I/O. Follow this pattern for any future pipeline or orchestration function.
- **Parameterized tests:** Use `it.each` for input/output tables
- **Commands:**
  ```bash
  npm test                              # unit tests (single run)
  npm run test:watch                    # unit tests (watch mode)
  npm run typecheck                     # type checking (catches errors vitest misses)
  npx vitest run --reporter=verbose     # verbose output
  ```

### Smoke Test (End-to-End)

The smoke test runs the full pipeline against a real YouTube video, exercising downloads, external AI services (Gladia, Pyannote), storage (MinIO), and the callback server.

```bash
# Fully automated — starts MinIO + ngrok, runs pipeline, validates result, cleans up
./scripts/smoke.sh

# Custom video
./scripts/smoke.sh "https://youtube.com/watch?v=..."

# Save full output
./scripts/smoke.sh -O result.json
```

**Prerequisites:**
- Nix dev shell (`nix develop`) — provides MinIO, ngrok, node, npm
- ngrok authenticated (`ngrok config add-authtoken <token>`)
- `.env` with API keys for Gladia, Pyannote

The script handles everything else: starts MinIO with a fresh data directory, opens an ngrok tunnel, configures env vars, runs the pipeline, validates the result shape, and tears down services on exit.

Run this after significant pipeline changes or when onboarding to verify the full stack works.

### What's Currently Tested

**Unit tests** (fast, no network, run in CI):

- **`src/utils.test.ts`** — `IdCompressor`, `validateUrl`, `validateYoutubeUrl`, `formatTime`
- **`src/tasks/downloadYTV.test.ts`** — `getVideoIdAndUrl`, `formatBytes`
- **`src/tasks/generateHighlight.test.ts`** — `mergeConsecutiveSegments`, `bridgeUtteranceGaps`
- **`src/tasks/utils/mediaOperations.test.ts`** — `normalizeUtteranceTimestamps`, `escapeTextForFFmpeg`, `wrapTextByPixelWidth`, `calculateOptimalFontSizeWithStartAndCap`, `getPresetConfig`, `generateSocialFilter`, `generateBlurredMarginFilter`, `generateSolidMarginFilter`, `calculateSpeakerDisplaySegments`, `wrapSpeakerText`, `formatSpeakerInfo`
- **`src/tasks/pipeline.test.ts`** — pipeline orchestration via `createPipeline(deps)` with stubbed tasks (happy path, CDN skip, progress stages, error propagation, data flow)

**Smoke test** (slow, requires network + API keys, run manually):

- **`scripts/smoke.sh`** — full pipeline end-to-end: YouTube download → ffmpeg → MinIO upload → Pyannote diarization → Gladia transcription → result validation

### What We Explicitly Skip (in Unit Tests)

- **FFmpeg execution** — requires binaries and real media files
- **HTTP downloads** — network-dependent, flaky
- **Express routes** — integration-level concern
- **External API calls** — requires credentials and live services

## Commits & PRs

- Atomic commits — each one builds and passes tests on its own
- Conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`
- Short subject line, blank line, explanatory body when non-trivial
- Rebase onto `main`, no merge commits
- **Fixing a previous commit** (e.g. after code review): use `git commit --fixup <sha>` then `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <sha>~1` to squash the fix into the original commit cleanly. Set `git config --global rebase.autoSquash true` to make this the default for interactive rebases.
- For the broader contributor workflow (PRDs, issue creation), see the main [opencouncil CONTRIBUTING.md](https://github.com/opencouncil/opencouncil/blob/main/CONTRIBUTING.md)

## Code Style

- TypeScript strict mode, ESM (`"type": "module"` in `package.json`)
- `.js` extensions in all imports
- No implicit `any` (configured in `tsconfig.json`)
