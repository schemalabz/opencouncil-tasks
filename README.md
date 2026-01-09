# OpenCouncil Tasks

Backend task processing service for the [OpenCouncil](https://github.com/schemalabz/opencouncil) platform. This service handles various audio, video, and content processing tasks through both a REST API and CLI interface.

## 🎯 Supported Tasks

The server supports the following processing tasks:

### Content Processing
- [`processAgenda`](src/tasks/processAgenda.ts) - Extracts and structures agenda information from documents
- [`fixTranscript`](src/tasks/fixTranscript.ts) - Cleans and corrects transcription output for improved accuracy
- [`summarize`](src/tasks/summarize.ts) - Generates comprehensive content summaries with subject extraction
- [`generatePodcastSpec`](src/tasks/generatePodcastSpec.ts) - Generates podcast specifications for content distribution

### Media Processing
- [`downloadYTV`](src/tasks/downloadYTV.ts) - Downloads YouTube videos and extracts audio with optimized quality settings
- [`splitMediaFile`](src/tasks/splitMediaFile.ts) - Splits media files into smaller segments with precise timestamp control
- [`uploadToSpaces`](src/tasks/uploadToSpaces.ts) - Handles secure file uploads to cloud storage with public access URLs
- [`generateHighlight`](docs/generateHighlight.md) - Produces short highlight clips from source videos with optional social media transforms, speaker overlays, and captions

### Transcription & Diarization
- [`diarize`](src/tasks/diarize.ts) - Identifies and separates different speakers in audio recordings
- [`splitAudioDiarization`](src/tasks/splitAudioDiarization.ts) - Splits audio files based on speaker segments with configurable duration limits
- [`transcribe`](src/tasks/transcribe.ts) - Converts audio to text with support for custom vocabulary and prompts
- [`applyDiarization`](src/tasks/applyDiarization.ts) - Applies speaker identification to existing transcripts
- [`generateVoiceprint`](src/tasks/generateVoiceprint.ts) - Creates unique speaker voice fingerprints for identification

### Data Synchronization
- [**PGSync**](docs/pgsync-setup.md) - Real-time change data capture that continuously syncs PostgreSQL to Elasticsearch

The [`pipeline`](src/tasks/pipeline.ts) task orchestrates multiple tasks above in sequence, providing a complete end-to-end processing workflow.

## 🛠️ Development Setup

### Prerequisites

- Node.js ^20.11.1
- FFmpeg
- Required API keys (see [Configuration](#configuration) section)

Clone the repository:
```bash
git clone https://github.com/schemalabz/opencouncil-tasks.git
cd opencouncil-tasks
```

Copy the example environment file:
```bash
cp .env.example .env
```

Then edit the file to include your specific [configuration values](#configuration).


### Docker Setup (Recommended)

#### Quick start (development)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up app
```

What this gives you:
- Hot reload (bind-mounted `./src` via `Dockerfile.dev`)
- Local S3 via MinIO: console `http://localhost:9001`, API `http://localhost:9000`
- Dev routes:
  - POST `/dev/test-upload` → tests the real upload pipeline
  - GET `/dev/files/:bucket/*` → serves files from MinIO (via `CDN_BASE_URL`)
- Mock Mux playback IDs when MinIO is detected

Notes:
- Ensure `.env` has `PORT` and `DO_SPACES_BUCKET`; optionally set `NO_AUTH=true` for local testing.
- Create the MinIO bucket (from `DO_SPACES_BUCKET`, e.g. `opencouncil-dev`) in the MinIO console if missing.
- When `DO_SPACES_ENDPOINT` includes `minio` or `localhost`, uploads go to MinIO and Mux playback IDs are mocked.
- Shared network with main app: if you run the main `opencouncil` app via `./run.sh`, it creates `opencouncil-net`. Otherwise, create it once: `docker network create opencouncil-net || true`. The `docker-compose.dev.yml` connects to this network.

#### Production-like run (no hot reload, no MinIO)

```bash
docker compose up app
```

### Manual Setup
```bash
npm install
npm run dev
```

**Additional requirements for manual setup:**

- **yt-dlp binary** (required for YouTube downloads): Install via `pip install yt-dlp` or download from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases). Set `YTDLP_BIN_PATH` to the binary location if not in PATH.

## 🔄 Callback Server

The service includes a callback server that handles asynchronous task completion notifications. This is particularly important when working with external services that need to notify our server about task completion.

For local development, you'll need to expose your local server to the internet. We recommend using [ngrok](https://ngrok.com/) for this purpose:

```bash
ngrok http 3005
```

Then, update your `.env` file with the ngrok URL:
```
PUBLIC_URL=https://your-ngrok-url.ngrok.io
```

## CLI Interface

The CLI interface provides direct access to individual tasks and starts its own server instance for handling callbacks.

### Using CLI with Docker (Recommended)

To see all available commands:

```bash
docker compose run --rm app npm run cli -- --help
```

Example - Download a YouTube video:

```bash
docker compose run --rm app npm run cli -- download-ytv "https://www.youtube.com/watch?v=VIDEO_ID"
```

**Note**: The `--` after `npm run cli` is required to pass arguments to the CLI script.

**Important**: The CLI runs pre-built code from `dist/cli.js`. After making code changes, you must rebuild.

### Using CLI Locally

If running outside Docker, you have two options:

```bash
# Use pre-built code (faster, but requires manual build after changes)
npm run cli -- --help

# Build and run (automatically compiles TypeScript first)
npm run cli:dev -- --help
```

**Tip**: Use `cli:dev` during development to ensure your changes are compiled.

## Configuration

The service uses environment variables for configuration. Not all variables are required for all tasks - you only need to configure the ones relevant to the tasks you plan to use.

### Server Configuration
- `PORT` (default: 3000) - The port the server will listen on
- `DATA_DIR` (default: ./data) - Directory for storing data files
- `NO_AUTH` (default: false) - Disable API authentication for development
- `CORS_ORIGINS_ALLOWED` - Comma-separated list of allowed CORS origins
- `PUBLIC_URL` - Public URL for callback server (required for external service callbacks)
- `MAX_PARALLEL_TASKS` (default: 10) - Maximum number of concurrent tasks

### Authentication
- `API_TOKENS` - JSON array of valid API tokens for authentication
  - Example: `API_TOKENS=["token1","token2","token3"]`
  - Falls back to `./secrets/apiTokens.json` file if not set in environment
- `NO_AUTH` - Set to `true` to disable authentication entirely (development only)
- `PUBLIC_ENDPOINTS` - Comma-separated list of additional public endpoints

### Storage
- `DO_SPACES_KEY` - Digital Ocean Spaces access key
- `DO_SPACES_SECRET` - Digital Ocean Spaces secret key
- `DO_SPACES_ENDPOINT` - Digital Ocean Spaces endpoint
- `DO_SPACES_BUCKET` - Digital Ocean Spaces bucket name
- `CDN_BASE_URL` - Base URL for CDN access

### External Services
- `ANTHROPIC_API_KEY` - Required for summarization and content generation
- `GLADIA_API_KEY` - Required for transcription
- `PERPLEXITY_API_KEY` - Required for agenda processing
- `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` - Required for video processing
- `GOOGLE_API_KEY` - Required for geocoding
- `ADALINE_SECRET` - Secret for Adaline service integration
- `PYANNOTE_API_TOKEN` - Required for speaker diarization
- `PYANNOTE_DIARIZE_API_URL` - Pyannote API endpoint
- `MOCK_PYANNOTE` - Enable mock mode for Pyannote (development only)

### PGSync / Elasticsearch Configuration
- `PG_URL` - PostgreSQL connection URL (format: `postgres://user:password@host:port/database`)
- `ELASTICSEARCH_URL` - Elasticsearch host URL (e.g., `https://your-cluster.es.region.aws.elastic.cloud:443`)
- `ELASTICSEARCH_API_KEY_ID` - Elasticsearch API key ID (first part before `:`)
- `ELASTICSEARCH_API_KEY` - Elasticsearch API key secret (second part after `:`)
- `SCHEMA_URL` - URL to remote PGSync schema.json file (e.g., GitHub Gist raw URL)

See [PGSync Setup Guide](docs/pgsync-setup.md) for detailed configuration.

### Task-Specific Configuration
- `GLADIA_MAX_CONCURRENT_TRANSCRIPTIONS` (default: 20) - Maximum concurrent transcription tasks
- `PYANNOTE_MAX_CONCURRENT_DIARIZATIONS` (default: 5) - Maximum concurrent diarization tasks
- `YTDLP_PROXY` (default: http://proxy-forwarder:3128) - Proxy for yt-dlp downloads (default downloader)
  - yt-dlp is the default YouTube downloader, bundled in the Docker image
  - See [Download Task Guide](docs/downloadYTV.md) for details
- `COBALT_ENABLED` (default: false) - Enable Cobalt as alternative YouTube downloader
  - Set to `true` to use Cobalt instead of yt-dlp
  - Requires `COBALT_API_BASE_URL` and the cobalt-api service
  - See [Proxy Setup Guide](docs/proxy-setup.md) for residential proxy configuration (works with both yt-dlp and Cobalt)
- `LOG_DIR` - Directory for log files
