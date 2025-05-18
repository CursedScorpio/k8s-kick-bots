#!/bin/bash
set -e

echo "Deploying Viewer Box Service to Kubernetes"

# Delete the existing deployment if it exists
echo "Deleting existing deployment (if any)..."
kubectl delete deployment viewer-deployment -n stream-viewers --ignore-not-found=true

# Apply the deployment configuration
echo "Applying new deployment configuration..."
kubectl apply -f viewer-box-deployment.yaml

# Wait for deployment to roll out
echo "Waiting for deployment to complete..."
kubectl rollout status deployment/viewer-deployment -n stream-viewers

# Check the status of the pods
echo "Checking pod status:"
kubectl get pods -n stream-viewers -l component=viewer

# Display the service details
echo "Service details:"
kubectl get svc -n stream-viewers -l component=viewer

echo "Deployment completed successfully!" 