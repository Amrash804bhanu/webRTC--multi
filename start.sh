#!/bin/bash

# Default mode
MODE="wasm"

# Parse command line arguments
for i in "$@"; do
  case $i in
    --mode=*)
      MODE="${i#*=}"
      shift # past argument=value
      ;;
    --ngrok)
      USE_NGROK="true"
      shift # past argument
      ;;
    -*|--*)
      echo "Unknown option $i"
      exit 1
      ;;
    *)
      ;;
  esac
done

export MODE

if [ "$MODE" == "wasm" ]; then
  echo "Starting in WASM mode (browser-side inference)..."
  docker compose -f docker-compose.yml up --build frontend
elif [ "$MODE" == "server" ]; then
  echo "Starting in SERVER mode (server-side inference)..."
  # For server mode, ensure both frontend and backend services are active
  # You might need to adjust docker-compose.yml to conditionally include the backend service
  # For simplicity, if backend is always in docker-compose.yml, it will start but won't be used by frontend in WASM mode unless specified.
  # A better approach for conditional services is to use multiple docker-compose files.
  # For this guide, we assume 'backend' service is always defined in docker-compose.yml and only activated when MODE=server logic in app.js connects to it.
  docker compose -f docker-compose.yml up --build frontend backend
else
  echo "Invalid MODE: $MODE. Use 'wasm' or 'server'."
  exit 1
fi

if [ "$USE_NGROK" == "true" ]; then
  echo "Starting ngrok..."
  # Download ngrok from ngrok.com/download for Windows and put it in your project root.
  # Make sure ngrok executable is in your PATH or specify its full path.
  # For Windows, you'd run .\ngrok.exe http 3000
  # For simplicity, this script assumes ngrok is available in PATH or a similar setup.
  # You'll need to manually run ngrok in a separate terminal or integrate it better.
  echo "Please run 'ngrok http 3000' in a separate terminal and copy the public URL."
fi