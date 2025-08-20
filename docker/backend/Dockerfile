FROM python:3.9-slim-buster

WORKDIR /app

# Step 1: Update the package list
RUN apt-get update

# Step 2: Install dependencies in a single layer to minimize image size
RUN apt-get install -y \
    ffmpeg \
    libopus-dev \
    libvpx-dev \
    libsrtp2-dev \
    libsndfile1-dev \
    pkg-config \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Copy requirements.txt and install Python dependencies
COPY src/backend/requirements.txt ./src/requirements.txt
WORKDIR /app/src
RUN pip install -r requirements.txt

# Expose the port the backend will run on
EXPOSE 8080

CMD ["python", "server.py"]