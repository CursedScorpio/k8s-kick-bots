#!/bin/bash
set -e

# Get current timestamp for versioning
TIMESTAMP=$(date +%Y%m%d%H%M%S)

# IMPORTANT: Change this to your Docker registry
REGISTRY="your-registry"
IMAGE_NAME="${REGISTRY}/viewer-box"

echo "Building Viewer Box"
cd box

# Build with both latest and timestamped tags
docker build -t ${IMAGE_NAME}:latest -t ${IMAGE_NAME}:v${TIMESTAMP} .

echo "Pushing images to registry"
docker push ${IMAGE_NAME}:latest
docker push ${IMAGE_NAME}:v${TIMESTAMP}

echo "Finished building and pushing Viewer Box"
echo "Latest tag: ${IMAGE_NAME}:latest"
echo "Version tag: ${IMAGE_NAME}:v${TIMESTAMP}"
