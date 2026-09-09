# Use Node.js 20 as the base image
FROM node:20-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json package-lock.json ./

# Install dependencies
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline

# Copy the rest of the application code
COPY . .

# Generate version from git tag
RUN apk add --no-cache git \
    && git describe --tags --always > VERSION \
    || echo "dev" > VERSION

# Build the application
RUN --mount=type=cache,target=/root/.npm \
    npm run build

FROM node:20.11.1 AS runner
# python3 is a runtime dependency of the fusion provider, not a build tool: the
# fuse core (fusion/) is spawned as a subprocess by src/lib/fusion/fusePy.ts.
# Debian bookworm ships 3.11, which is the minimum fusion/__init__.py states.
# The fuse core is stdlib-only, so there is no pip step and no requirements file.
RUN apt-get update \
    && apt-get install -y tini ffmpeg curl gosu unzip python3 \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -c "import sys; assert sys.version_info >= (3, 11), sys.version" \
    && groupadd -r apify && useradd -rm -g apify -G audio,video apify

# Set the working directory
WORKDIR /app

# Copy package files first
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Install production dependencies
RUN --mount=type=cache,target=/root/.npm \
    npm ci --only=production

# Copy built assets and version
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/VERSION ./VERSION
COPY --from=builder /app/assets ./assets

# The fuse core. It is not TypeScript, so `npm run build` does not produce it
# and it has to be copied on its own; without it FUSION_MODE=on falls back to
# Scribe on every segment after paying all three providers. fusion/ holds only
# *.py, *.json and CONTRACT.md — no fixtures, no audio, no transcript text.
COPY --from=builder /app/fusion ./fusion

# Download latest yt-dlp binary. Own the whole /app/bin DIRECTORY (not just the
# file) by apify: yt-dlp's `--update-to` self-update writes a new binary into the
# directory, which fails if the dir stays root-owned while the app runs as apify.
RUN mkdir -p /app/bin \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /app/bin/yt-dlp \
    && test -s /app/bin/yt-dlp || (echo "Failed to download yt-dlp" && exit 1) \
    && chmod +x /app/bin/yt-dlp \
    && chown -R apify:apify /app/bin

# Install Deno — yt-dlp's default JavaScript runtime for YouTube extraction (EJS).
# yt-dlp needs a JS runtime to solve YouTube's player challenges; Node in this
# image is v20, below yt-dlp's Node>=22 EJS requirement, so Deno provides it.
# yt-dlp enables "deno" by default whenever it's found on PATH.
RUN DENO_ARCH="$(uname -m)" \
    && curl -fsSL "https://github.com/denoland/deno/releases/latest/download/deno-${DENO_ARCH}-unknown-linux-gnu.zip" -o /tmp/deno.zip \
    && unzip -o /tmp/deno.zip -d /usr/local/bin \
    && rm /tmp/deno.zip \
    && chmod +x /usr/local/bin/deno \
    && deno --version

# Deno caches compiled modules under DENO_DIR. The app runs as "apify" via gosu
# but HOME stays /root (not writable by apify), so point DENO_DIR at a dir the
# apify user owns instead of relying on ~/.cache/deno.
RUN mkdir -p /app/.deno \
    && chown apify:apify /app/.deno

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV YTDLP_BIN_PATH=/app/bin/yt-dlp
ENV DENO_DIR=/app/.deno

# Expose the port the app runs on
EXPOSE ${PORT}

# Use tini as init, entrypoint fixes volume permissions then drops to apify
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

# Start the application with Node.js
CMD ["node", "dist/server.js"]
