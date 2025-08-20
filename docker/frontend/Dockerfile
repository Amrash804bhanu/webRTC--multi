# Use a lightweight Node.js image
FROM node:18-alpine

WORKDIR /app

# Copy package.json and install dependencies (if any, though not strictly needed for basic static serving)
COPY src/frontend/package.json ./src/package.json
WORKDIR /app/src
RUN npm install

# Expose the port the frontend will run on
EXPOSE 3000

# Set the entrypoint to run the simple http-server
CMD ["npx", "http-server", "-p", "3000", "."]