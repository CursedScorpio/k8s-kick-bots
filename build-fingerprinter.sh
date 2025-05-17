#!/bin/bash
set -e

# Get current timestamp for versioning
TIMESTAMP=$(date +%Y%m%d%H%M%S)

echo "Building Fingerprinter Service"
cd fingerprinter

# Build with both latest and timestamped tags
docker build -t cursedscropio/fingerprint-service:latest -t cursedscropio/fingerprint-service:v${TIMESTAMP} .

echo "Pushing images to registry"
docker push cursedscropio/fingerprint-service:latest
docker push cursedscropio/fingerprint-service:v${TIMESTAMP}

echo "Finished building and pushing Fingerprinter Service"
echo "Latest tag: cursedscropio/fingerprint-service:latest"
echo "Version tag: cursedscropio/fingerprint-service:v${TIMESTAMP}"
