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

**DO NOT test:**

- Anything that touches the filesystem, network, or spawns processes (e.g. ffmpeg)
- Express routes, external API calls, database queries
- Pipeline orchestration (`pipeline.ts`)

**When adding a new pure function** that is file-private, export it so it can be tested.

### Conventions

- **Test runner:** Vitest
- **File location:** Colocated — `foo.ts` → `foo.test.ts`
- **Imports:** Use `.js` extensions (ESM requirement)
- **Structure:**
  ```ts
  describe('functionName', () => {
    it('describes expected behavior', () => {
      expect(myFn(input)).toEqual(expected);
    });
  });
  ```
- **Parameterized tests:** Use `it.each` for input/output tables
- **Commands:**
  ```bash
  npm test                              # single run
  npm run test:watch                    # watch mode
  npx vitest run --reporter=verbose     # verbose output
  ```

### What's Currently Tested

These files serve as reference for style and scope:

- **`src/utils.test.ts`** — `IdCompressor`, `validateUrl`, `validateYoutubeUrl`, `formatTime`
- **`src/tasks/downloadYTV.test.ts`** — `getVideoIdAndUrl`, `formatBytes`
- **`src/tasks/generateHighlight.test.ts`** — `mergeConsecutiveSegments`, `bridgeUtteranceGaps`
- **`src/tasks/utils/mediaOperations.test.ts`** — `normalizeUtteranceTimestamps`, `escapeTextForFFmpeg`, `wrapTextByPixelWidth`, `calculateOptimalFontSizeWithStartAndCap`, `getPresetConfig`, `generateSocialFilter`, `generateBlurredMarginFilter`, `generateSolidMarginFilter`, `calculateSpeakerDisplaySegments`, `wrapSpeakerText`, `formatSpeakerInfo`

### What We Explicitly Skip

- **FFmpeg execution** — requires binaries and real media files
- **HTTP downloads** — network-dependent, flaky
- **Express routes** — integration-level concern
- **External API calls** — requires credentials and live services
- **Pipeline orchestration** — wiring logic that changes with requirements

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
