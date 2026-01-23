# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenCouncil Tasks is a backend task processing service that handles audio, video, and content processing tasks for the OpenCouncil platform. It provides both a REST API and CLI interface for processing municipal council meeting recordings.

The service orchestrates complex media processing workflows including YouTube downloads, transcription, speaker diarization, summarization, and highlight generation.

## Development Commands

### Local Development
```bash
# Install dependencies
npm install

# Run development server (hot reload)
npm run dev

# Build TypeScript
npm run build

# Run production server
npm start
```

### Docker Development (Recommended)
```bash
# Development mode with hot reload and MinIO (local S3)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up app

# Production-like mode
docker compose up app

# Run CLI commands
docker compose run --rm app npm run cli -- <command> [options]

# Build and run CLI locally
npm run cli:dev -- <command> [options]
```

**Important**: The CLI runs pre-built code from `dist/cli.js`. After making code changes, you must rebuild with `npm run build` or use `npm run cli:dev` which rebuilds automatically.

### Testing
```bash
# Test upload pipeline (development only)
curl -X POST http://localhost:3005/dev/test-upload
```

## Architecture

### Core Components

**Task Manager (`src/lib/TaskManager.ts`)**
- Central orchestrator for all async task execution
- Manages task queue with configurable parallelism (`MAX_PARALLEL_TASKS`)
- Tracks task progress and sends HTTP callbacks to report status
- Provides automatic Swagger documentation generation via task metadata
- Tasks are registered with `registerTask()` which auto-derives route paths from Express

**Callback Server (`src/lib/CallbackServer.ts`)**
- Singleton pattern for managing async task callbacks
- Creates unique callback URLs with timeout management
- Used by both API server and CLI for handling long-running external service responses
- Essential for tasks that depend on external services (transcription, diarization)

**Task Type Signature**
```typescript
export type Task<Args, Ret> = (
  args: Args,
  onProgress: (stage: string, progressPercent: number) => void
) => Promise<Ret>;
```
All tasks follow this signature for consistent progress reporting and type safety.

### Server Architecture

**Entry Points**
- `src/server.ts` - REST API server with Express
- `src/cli.ts` - CLI interface (both start their own callback servers)

**Request Flow**
1. Request arrives at Express endpoint
2. Authentication middleware validates API token (unless `NO_AUTH=true`)
3. `TaskManager.registerTask()` handler queues/executes task
4. Task reports progress via `onProgress` callback
5. TaskManager sends HTTP callbacks to `callbackUrl` with status updates
6. Final result or error sent via callback

**Progress Reporting Pattern**
Tasks use throttled progress handlers to avoid overwhelming callback endpoints:
```typescript
const createProgressHandler = (stage: string) => {
  return _.throttle(
    (subStage: string, perc: number) => onProgress(`${stage}:${subStage}`, perc),
    10000,
    { leading: true, trailing: false }
  );
};
```

### Task Categories

**Media Processing Tasks**
- `downloadYTV` - YouTube download with yt-dlp (default) or Cobalt (optional)
- `splitMediaFile` - FFmpeg-based media splitting with precise timestamps
- `generateHighlight` - Creates highlight clips with captions/overlays (see `docs/generateHighlight.md`)
- `uploadToSpaces` - S3-compatible upload to DigitalOcean Spaces or MinIO

**Audio Processing Tasks**
- `transcribe` - Gladia API integration for speech-to-text
- `diarize` - Pyannote API for speaker identification
- `splitAudioDiarization` - Splits audio at speaker boundaries
- `applyDiarization` - Merges diarization with transcript
- `generateVoiceprint` - Creates speaker embeddings for identification

**Content Processing Tasks**
- `summarize` - Claude AI summarization with subject extraction
- `fixTranscript` - Claude AI transcript correction
- `processAgenda` - Extract subjects from agendas
- `generatePodcastSpec` - Creates podcast specifications from meetings

**Pipeline Task**
- `pipeline` (`src/tasks/pipeline.ts`) - Orchestrates full transcription workflow:
  1. Download YouTube video (or use CDN URL if already uploaded)
  2. Upload audio to Spaces
  3. Diarize audio (identify speakers)
  4. Split audio into segments by speaker
  5. Transcribe segments via Gladia
  6. Apply diarization to transcript
  7. Return video URL, audio URL, Mux playback ID, and diarized transcript

### Key Libraries and Patterns

**AI Integration (`src/lib/ai.ts`)**
- `aiChat<T>()` - Generic Claude API wrapper with retry logic, rate limit handling, and JSON parsing
- `aiWithAdaline<T>()` - Adaline prompt management integration
- Automatic continuation for responses exceeding max tokens
- Comprehensive logging to `LOG_DIR/ai.log`

**External Service Integrations**
- `GladiaTranscribe.ts` - Transcription API with callback-based completion
- `PyannoteDiarize.ts` - Diarization API with job polling
- `DiarizationManager.ts` - Manages speaker identification with voiceprints
- `adaline.ts` - Prompt deployment and logging
- `mux.ts` - Video playback ID fetching (with MinIO mock support)
- `geocode.ts` - Google Maps geocoding for locations

**Authentication (`src/lib/auth.ts`)**
- Token-based authentication using `API_TOKENS` env var or `./secrets/apiTokens.json`
- Public endpoints: `/health`, `/docs`, `/dev/*` (in development)
- Configurable additional public endpoints via `PUBLIC_ENDPOINTS` env var
- Set `NO_AUTH=true` for local development

**Swagger Documentation**
- `swaggerConfig.ts` + `swaggerGenerator.ts` - Auto-generates OpenAPI docs at `/docs`
- Task metadata (summary, description, security) drives schema generation
- TypeScript type introspection creates request/response schemas
- Paths auto-resolved from Express routes via `TaskManager.resolvePathsFromApp()`

### Data Flow Patterns

**Temporary Files**
- All temporary files stored in `DATA_DIR` (default: `./data`)
- Tasks clean up temp files after completion
- MinIO/Spaces uploads happen from temp file paths

**Progress Tracking**
- Tasks report progress as `stage:substage` strings with percentage
- TaskManager throttles progress callbacks to avoid overwhelming client
- Status includes: `processing`, `success`, `error`
- Queue status exposed: running tasks, queued tasks, longest running duration

**Voiceprint Matching**
- Voiceprints are base64-encoded embedding vectors
- `DiarizationManager` handles cosine similarity matching
- Confidence scores returned per person ID
- Used for speaker identification across meetings

## Development Environment

### Docker Development Setup

**MinIO (Local S3)**
- Runs when using `docker-compose.dev.yml`
- Console: `http://localhost:9001` (minioadmin/minioadmin)
- API: `http://localhost:9000`
- Bucket auto-created: `opencouncil-dev`
- CDN_BASE_URL serves files via `/dev/files/:bucket/*`
- Mux playback IDs are mocked when MinIO detected

**Proxy Setup**
- Squid proxy (`proxy-forwarder`) forwards requests to residential proxy
- Required for YouTube downloads to avoid rate limiting
- Default: `http://proxy-forwarder:3128`
- Configure residential proxy endpoint in `squid.conf`

**Cobalt API (Optional)**
- Alternative YouTube downloader (disabled by default)
- Enable with `COBALT_ENABLED=true` and `--profile cobalt`
- Uses same proxy infrastructure as yt-dlp

**PGSync (Optional)**
- Real-time PostgreSQL to Elasticsearch sync via change data capture
- Requires Redis for checkpointing
- Schema fetched from remote URL (`SCHEMA_URL`)
- See `docs/pgsync-setup.md` for configuration

### Environment Configuration

**Critical Settings**
- `PORT` - Server port (default: 3000)
- `DATA_DIR` - Temporary file storage (default: `./data`)
- `PUBLIC_URL` - Public URL for callbacks (required for external services)
- `MAX_PARALLEL_TASKS` - Concurrent task limit (default: 10)

**External Service Keys**
- `ANTHROPIC_API_KEY` - Claude AI (summarization, content generation)
- `GLADIA_API_KEY` - Transcription
- `PYANNOTE_API_TOKEN` - Speaker diarization
- `MUX_TOKEN_ID` + `MUX_TOKEN_SECRET` - Video processing

**Storage Configuration**
- `DO_SPACES_*` - DigitalOcean Spaces (or MinIO) credentials
- `CDN_BASE_URL` - Public CDN base URL for uploaded files

**Authentication**
- `NO_AUTH=true` - Disable auth for local dev
- `API_TOKENS` - JSON array of valid tokens or path to `./secrets/apiTokens.json`

### Development Routes (`/dev/*`)

**Only available when `NODE_ENV=development`**
- `/dev/test-upload` - Test upload pipeline with MinIO
- `/dev/files/:bucket/*` - Serve files from MinIO (CDN_BASE_URL target)
- `/dev/test-task/:taskType` - Test any task with payload capture/overrides
- `/dev/test-video-resolution` - Verify ffprobe resolution detection

### Callback Server Setup

For local development with external services, expose your local server:
```bash
# Using ngrok
ngrok http 3005

# Then set in .env
PUBLIC_URL=https://your-ngrok-url.ngrok.io
```

The CLI automatically starts its own callback server on the configured `PORT`.

## TypeScript Configuration

- Module system: ESM (`type: "module"` in package.json)
- Module resolution: `NodeNext` (requires `.js` extensions in imports)
- Output: `./dist` directory
- All imports must use `.js` extension even for `.ts` files
- Node.js 20.11.1+ required

## Common Workflows

### Adding a New Task

1. Create task file in `src/tasks/` following the `Task<Args, Ret>` signature
2. Define request/response types in `src/types.ts`
3. Register endpoint in `src/server.ts`:
   ```typescript
   app.post('/your-task', taskManager.registerTask(yourTask, {
     summary: 'Short description',
     description: 'Detailed description for API docs'
   }));
   ```
4. Add CLI command in `src/cli.ts` if needed
5. Swagger docs auto-generate from types

### Testing a Task

**Via API:**
```bash
curl -X POST http://localhost:3000/your-task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"callbackUrl": "http://your-callback", ...}'
```

**Via CLI:**
```bash
npm run cli:dev -- your-task [options]
```

### Working with FFmpeg

- FFmpeg binary: Bundled via `ffmpeg-static`
- ffprobe: Available in Docker at `/usr/bin/ffprobe`
- Resolution detection: Use `getVideoResolution()` from `src/tasks/utils/mediaOperations.ts`
- Filter composition: See `generateHighlight.ts` for complex filter chains
- Always use absolute paths with FFmpeg commands

### Networking Between Services

- Docker services communicate via network names (e.g., `proxy-forwarder:3128`)
- Development mode uses `opencouncil-net` external network to connect with main app
- Create network if missing: `docker network create opencouncil-net || true`

## Important Notes

- Task progress handlers should be throttled to avoid overwhelming callback endpoints
- All tasks must clean up temporary files in `DATA_DIR` after completion
- When using MinIO, Mux playback IDs are automatically mocked
- CLI commands require rebuild after code changes unless using `cli:dev`
- Voiceprints are base64-encoded embedding vectors from speaker audio segments
- The `pipeline` task handles full end-to-end transcription workflow
- Gap bridging in `generateHighlight` merges utterances ≤2 seconds apart for smooth video cuts
