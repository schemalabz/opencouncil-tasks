# CLAUDE.md

Refer to [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing conventions, project structure, and commit guidelines. That file is the source of truth for both humans and AI agents.

## Project

opencouncil-tasks — TypeScript service that orchestrates media processing pipelines: YouTube download, audio extraction (ffmpeg), speaker diarization (Pyannote), transcription (ElevenLabs Scribe), and video hosting (Mux). Express server with a CLI interface.

## Development Environment

This project uses [Nix](https://nixos.org/) to manage development dependencies. All shell commands (`npm`, `npx`, `node`, etc.) must be run inside the Nix development shell.

**Prefix all commands with `nix develop --command`**, for example:
```bash
nix develop --command npm run typecheck
nix develop --command npm test
```

If you open an interactive shell session first (`nix develop`), subsequent commands in that session don't need the prefix.

## Quick reference

```bash
nix develop                           # enter dev shell (node, npm, minio, ngrok)
npm install                           # install dependencies
npm run typecheck                     # tsc --noEmit (catches errors vitest misses)
npm test                              # unit tests (vitest)
./scripts/smoke.sh                    # end-to-end smoke test (needs ngrok auth + .env)
```

**Before committing, always run:** `npm run typecheck && npm test`

## Debugging LLM calls (Langfuse)

Task runs are traced to Langfuse (needs `LANGFUSE_*` env vars — see [docs/observability.md](./docs/observability.md)): verbatim prompts, outputs, token usage, and cost for every call. Debug LLM behavior from the trace, not from logs.

```bash
npm run cli -- runs list --task summarize --meeting <cityId/meetingId>  # find runs
npm run cli -- runs show <traceId>                                      # phase/call tree with usage & cost
npm run cli -- runs compare --meeting <cityId/meetingId>                # diff two summarize runs
```

Full prompt/output text of a call: `curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" "$LANGFUSE_BASEURL/api/public/traces/<traceId>"`

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
- **`src/lib/`** — Service clients (ElevenLabs Scribe, Pyannote, Mux, S3/MinIO, callback server)
- **`src/types.ts`** — Shared type definitions
- **`src/server.ts`** — Express API server
- **`src/cli.ts`** — CLI interface (pipeline, individual tasks, smoke test)

## Key types

- `Task<Args, Ret>` — `(args, onProgress) => Promise<Ret>` — defined in `src/tasks/pipeline.ts`
- `PipelineDeps` — all injectable dependencies for the pipeline — defined in `src/tasks/pipeline.ts`
- `TranscribeRequest` / `TranscribeResult` — pipeline input/output — defined in `src/types.ts`

## Task versioning

Tasks in `src/server.ts` have a `version` field in their `registerTask()` metadata. This version is sent with callbacks and stored on `TaskStatus` in the opencouncil database. Bump when consumers need to know results are different.

## External services

- **Pyannote** — speaker diarization (async, posts result to callback URL)
- **ElevenLabs Scribe** — speech-to-text transcription (synchronous API, ~12s per audio-minute)
- **Mux** — video hosting and playback
- **S3-compatible storage** — DigitalOcean Spaces (production) or MinIO (development)

The callback server (`src/lib/CallbackServer.ts`) receives async results from Pyannote. It requires `PUBLIC_URL` to be set to a publicly reachable address (e.g. via ngrok for local dev).

## Deployment

Both environments run via Docker Compose on `134.122.74.255`:

| Environment | Directory | Container | Logs |
|---|---|---|---|
| **Production** | `/root/opencouncil-tasks/` | `opencouncil-tasks-app-1` | `/root/opencouncil-tasks/logs/app.log` |
| **Staging** | `/root/staging-opencouncil-tasks/` | `staging-opencouncil-tasks-app-1` | `/root/staging-opencouncil-tasks/logs/app.log` |

Access via `ssh root@134.122.74.255`. Use the `/logs` skill for quick log access from your local machine.
