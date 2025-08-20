#!/bin/bash

DURATION=30
MODE="wasm" # Default to WASM mode for benchmarking

# Parse arguments
for i in "$@"; do
  case $i in
    --duration=*)
      DURATION="${i#*=}"
      shift # past argument=value
      ;;
    --mode=*)
      MODE="${i#*=}"
      shift # past argument=value
      ;;
    -*|--*)
      echo "Unknown option $i"
      exit 1
      ;;
    *)
      ;;
  esac
done

echo "Running bench for ${DURATION} seconds in ${MODE} mode..."

# Start the application in the specified mode (detach in background)
./start.sh --mode=$MODE &
APP_PID=$! # Capture PID of start.sh

# Give some time for the app to start
sleep 10

# Instructions for user to manually connect phone and start video stream
echo "Please connect your phone to http://localhost:3000 (or ngrok URL) and start the stream NOW."
echo "Benchmarking will begin in 5 seconds..."
sleep 5

# --- BEGIN METRICS COLLECTION ---
# In a real setup, you'd trigger metric collection from the client
# (e.g., via a WebSocket message) or parse logs.
# For this basic setup, we'll rely on the client's internal logging
# and a placeholder for capturing 'metrics.json'.

# Simulate run duration
echo "Collecting data for ${DURATION} seconds..."
sleep ${DURATION}

echo "Benchmarking complete."

# --- END METRICS COLLECTION ---
# IMPORTANT: The client-side `collectFinalMetrics()` needs to save the data.
# For a full solution, you would send these metrics to the backend via WebSocket
# and have the backend write them to `metrics.json`.
# For a simpler approach, you might instruct the user to copy console output or
# use browser dev tools.

# Placeholder for creating metrics.json (you'd need to populate this)
# A simple way for a beginner is to modify app.js to send metrics to the server,
# and the server.py could have a /metrics endpoint to receive and save.
echo "{\"median_e2e_latency_ms\": \"N/A\", \"p95_e2e_latency_ms\": \"N/A\", \"processed_fps\": \"N/A\", \"uplink_kbps\": \"N/A\", \"downlink_kbps\": \"N/A\"}" > metrics.json
echo "metrics.json created (placeholder). You need to implement actual data collection."

# Stop the Docker containers
echo "Stopping containers..."
docker-compose down

echo "Benchmarking process finished."
echo "Inspect metrics.json and browser console/webrtc-internals for detailed metrics."