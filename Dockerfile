# Use Node.js 20 as the base image
FROM --platform=linux/amd64 node:20-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json package-lock.json ./

# Install dependencies
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline

# Copy the rest of the application code
COPY . .

# Build the application
RUN --mount=type=cache,target=/root/.npm \
    npm run build

FROM --platform=linux/amd64 node:20.11.1 AS runner
# Install the latest Chrome dev package, necessary fonts and libraries
RUN apt-get update \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] https://dl-ssl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 dbus dbus-x11 \
      --no-install-recommends \
    && apt-get install -y tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r apify && useradd -rm -g apify -G audio,video apify

# Determine the path of the installed Google Chrome
RUN which google-chrome-stable || true

# Set the working directory
WORKDIR /app

# Copy package files first
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Install production dependencies
RUN --mount=type=cache,target=/root/.npm \
    npm ci --only=production

# Copy built assets
COPY --from=builder /app/dist ./dist

# Switch to the non-root user
USER apify

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Expose the port the app runs on
EXPOSE ${PORT}

# Use tini as the entrypoint
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the application with Node.js
CMD ["node", "dist/server.js"]
