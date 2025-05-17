#!/bin/bash
set -e

# Get current timestamp for versioning
TIMESTAMP=$(date +%Y%m%d%H%M%S)

echo "Building Viewer Box"
cd box

# Build with both latest and timestamped tags
docker build -t cursedscropio/viewer-box:latest -t cursedscropio/viewer-box:v${TIMESTAMP} .

echo "Pushing images to registry"
docker push cursedscropio/viewer-box:latest
docker push cursedscropio/viewer-box:v${TIMESTAMP}

echo "Finished building and pushing Viewer Box"
echo "Latest tag: cursedscropio/viewer-box:latest"
echo "Version tag: cursedscropio/viewer-box:v${TIMESTAMP}"
