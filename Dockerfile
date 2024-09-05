# Use Node.js 20 as the base image
FROM node:20-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the application
RUN npm run build

# Create the production image
FROM satantime/puppeteer-node:20.9.0-bookworm AS final

# Install Chromium and other necessary packages
RUN apk add --no-cache chromium ca-certificates

# Set the working directory
WORKDIR /app

# Copy built assets from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Install production dependencies
RUN npm install

# Expose the port the app runs on
EXPOSE ${PORT}

# Start the application
CMD ["npm", "start"]

