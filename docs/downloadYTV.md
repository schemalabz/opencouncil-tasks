# DownloadYTV Task

## Overview
Downloads a YouTube (or direct/CDN) video, saves it under `DATA_DIR`, and extracts an MP3. Supports two backends:

- **yt-dlp** (default) — resilient, resumable, proxy-friendly. Bundled in Docker image with proxy support out of the box.
- **Cobalt** (optional) — tunnel/redirect flow if explicitly enabled via `COBALT_ENABLED=true`. See [Proxy Setup Guide](./proxy-setup.md) for residential proxy configuration.

Output paths (under `DATA_DIR`, default `./data`):
- Video: `<videoId>.mp4`
- Audio-only: `<videoId>.mp3` (mono, 128k, highpass/lowpass filter)

## Backends
### yt-dlp path (default)
- Triggered for YouTube by default (unless you explicitly enable Cobalt).
- Format: `bestvideo[height<=${DEFAULT_VIDEO_QUALITY}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${DEFAULT_VIDEO_QUALITY}][ext=mp4]/best`, with `--merge-output-format mp4`.
- Uses `ytdlp-nodejs` with the binary baked into the Docker image at `/app/bin/yt-dlp` (set via `YTDLP_BIN_PATH`).
- Proxy defaults to `http://proxy-forwarder:3128` from docker-compose; falls back to `HTTP_PROXY`/`HTTPS_PROXY` if set.
- Progress logs emitted; `onProgress` is forwarded if provided.

### Cobalt path (optional)
- Used for YouTube only when `COBALT_ENABLED=true` (default is off).
- Resolves a tunnel/redirect URL from `COBALT_API_BASE_URL`, then streams to disk with fetch.
- Requires additional setup: residential proxy configuration and cobalt-api service. See [Proxy Setup Guide](./proxy-setup.md).

## Environment
- `DATA_DIR` — download/output directory (default `./data`).
- `DEFAULT_VIDEO_QUALITY` — max height for yt-dlp format selector (default 720).
- `COBALT_ENABLED` — set `true` to use Cobalt for YouTube instead of yt-dlp (default off).
- `YTDLP_BIN_PATH` — path to `yt-dlp` binary (Dockerfile sets `/app/bin/yt-dlp`).
- `YTDLP_PROXY` — proxy URL for yt-dlp (docker-compose sets `http://proxy-forwarder:3128`). Falls back to `HTTP_PROXY`/`HTTPS_PROXY`.
- `COBALT_API_BASE_URL` — Cobalt endpoint (default `http://cobalt-api:9000`).
- `CDN_BASE_URL` — treat matching URLs as direct CDN downloads (no Cobalt/yt-dlp).

## Notes & Recommendations
- Binary is bundled in Docker; override `YTDLP_BIN_PATH` only if you supply a different one.
- Proxy path: keep Squid/forwarder timeouts generous to avoid mid-stream aborts.
- Audio extraction uses `ffmpeg-static`; output is mono MP3 with highpass 200 Hz and lowpass 3000 Hz.
- Cobalt tunnels may expire; prefer yt-dlp for long downloads or raise Cobalt `TUNNEL_LIFESPAN` if you stay on Cobalt.

