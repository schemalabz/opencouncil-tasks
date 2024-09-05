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
FROM node:20-alpine AS final

# Install Chromium and other necessary packages
RUN apk add --no-cache chromium ca-certificates

# Set Puppeteer environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true
ENV PUPPETEER_EXECUTABLE_PATH /usr/bin/chromium-browser

# Set the working directory
WORKDIR /app

# Copy built assets from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Install production dependencies
RUN npm ci --only=production

# Copy the .env file (make sure to use .env instead of .env.example if you have a specific .env file)
COPY .env ./

# Expose the port the app runs on
EXPOSE ${PORT}

# Start the application
CMD ["npm", "start"]

