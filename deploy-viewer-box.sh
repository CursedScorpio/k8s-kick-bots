#!/bin/bash
set -e

echo "Deploying Viewer Box Service to Kubernetes"

# Delete the existing deployment if it exists
echo "Deleting existing deployment (if any)..."
kubectl delete deployment viewer-box-deployment -n kick-watchers --ignore-not-found=true

# Apply the deployment configuration
echo "Applying new deployment configuration..."
kubectl apply -f viewer-box-deployment.yaml

# Wait for deployment to roll out
echo "Waiting for deployment to complete..."
kubectl rollout status deployment/viewer-box-deployment -n kick-watchers

# Check the status of the pods
echo "Checking pod status:"
kubectl get pods -n kick-watchers -l component=viewer-box

# Display the service details
echo "Service details:"
kubectl get svc -n kick-watchers -l component=viewer-box

echo "Deployment completed successfully!" 