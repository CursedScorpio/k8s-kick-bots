# Fingerprint Service

A service that generates browser fingerprints optimized for streaming platforms.

## Features

- Pre-generates a pool of fingerprints for efficient serving
- Configurable pool size via environment variables
- Structured JSON logging
- Prometheus metrics for monitoring
- Health check endpoint for Kubernetes
- Mobile device fingerprints optimized for streaming (especially Android)
- Landscape mode support (60% of fingerprints)

## API Endpoints

- `/next`: Get the next fingerprint from the pool (round-robin)
- `/random`: Get a completely new random fingerprint (not from pool)
- `/fingerprint/:id`: Get a fingerprint with a specific ID (backward compatibility)
- `/fingerprints`: List fingerprints in the pool (limited to 100)
- `/healthz`: Health check endpoint
- `/metrics`: Prometheus metrics endpoint

## Environment Variables

- `PORT`: The port to listen on (default: 3001)
- `FINGERPRINT_POOL_SIZE`: Number of fingerprints to pre-generate (default: 10000)
- `LOG_LEVEL`: Logging level (error, warn, info, debug) (default: info)
- `NODE_ENV`: Node environment (development, production) (default: development)

## Deployment

The service is designed to be deployed in Kubernetes. See the `kubernetes/deployment.yaml` file for configuration.

### Building the Docker image

```bash
docker build -t fingerprint-service:latest .
```

### Running locally

```bash
npm install
npm start
```

## Performance Considerations

The service pre-generates a pool of fingerprints on startup, which can use significant memory temporarily. The Kubernetes configuration includes appropriate resource limits and readiness/liveness probes to ensure the service starts properly.

For production deployments, configure the `FINGERPRINT_POOL_SIZE` based on your memory constraints. The default of 5000 works well with the resource limits in the Kubernetes configuration. 