# CLAUDE.md

Refer to [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing conventions, project structure, and commit guidelines. That file is the source of truth for both humans and AI agents.

## Project

opencouncil-tasks — TypeScript service that orchestrates media processing pipelines: YouTube download, audio extraction (ffmpeg), speaker diarization (Pyannote), transcription (Gladia), and video hosting (Mux). Express server with a CLI interface.

## Quick reference

```bash
nix develop                           # enter dev shell (node, npm, minio, ngrok)
npm install                           # install dependencies
npm run typecheck                     # tsc --noEmit (catches errors vitest misses)
npm test                              # unit tests (vitest)
./scripts/smoke.sh                    # end-to-end smoke test (needs ngrok auth + .env)
```

**Before committing, always run:** `npm run typecheck && npm test`

## Code conventions

- TypeScript strict mode, ESM (`"type": "module"`)
- **Always use `.js` extensions in imports** (ESM requirement, even for .ts files)
- Colocated tests: `foo.ts` → `foo.test.ts`
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`
- **Do NOT add `Co-Authored-By` lines to commits**

## Architecture

- **`src/tasks/*.ts`** — Each file exports a `Task<Args, Ret>` function (the unit of work)
- **`src/tasks/pipeline.ts`** — Orchestrates tasks via `createPipeline(deps)` factory (dependency injection)
- **`src/tasks/utils/`** — Pure helper functions (parsing, formatting, filters)
- **`src/lib/`** — Service clients (Gladia, Pyannote, Mux, S3/MinIO, callback server)
- **`src/types.ts`** — Shared type definitions
- **`src/server.ts`** — Express API server
- **`src/cli.ts`** — CLI interface (pipeline, individual tasks, smoke test)

## Key types

- `Task<Args, Ret>` — `(args, onProgress) => Promise<Ret>` — defined in `src/tasks/pipeline.ts`
- `PipelineDeps` — all injectable dependencies for the pipeline — defined in `src/tasks/pipeline.ts`
- `TranscribeRequest` / `TranscribeResult` — pipeline input/output — defined in `src/types.ts`

## External services

- **Pyannote** — speaker diarization (async, posts result to callback URL)
- **Gladia** — speech-to-text transcription (async, posts result to callback URL)
- **Mux** — video hosting and playback
- **S3-compatible storage** — DigitalOcean Spaces (production) or MinIO (development)

The callback server (`src/lib/CallbackServer.ts`) receives async results from Pyannote and Gladia. It requires `PUBLIC_URL` to be set to a publicly reachable address (e.g. via ngrok for local dev).
