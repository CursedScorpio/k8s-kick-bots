# 🚀 Kick Viewers Infrastructure (Educational bots)

This project sets up a scalable system for running multiple browser instances to watch streams, particularly on **Kick.com**. It's built on Kubernetes and designed to spin up independent viewers, each with a unique identity and network route.

---

**Note:** I also have a version of this system that runs directly on a single machine, without Kubernetes. That version works similarly and achieves close performance, but comes with a clean frontend and better puppeteer behavior (it interact with kick, accepting cookings, changing quality stream and so on) but here I wanted to learn and experiment with Kubernetes features—like automatic pod restarts, resource limits, and scheduling. This repo is a result of that exploration.

---

## 📚 Table of Contents

- [✨ Here's a basic flow](#-heres-a-basic-flow)
- [🛠️ Core Components](#️-core-components)
  - [🧬 Fingerprint Service](#-fingerprint-service)
  - [📺 Viewer Box](#-viewer-box)
- [🏁 Getting Started](#-getting-started)
  - [VPN Setup](#vpn-setup)
  - [🐳 Build the Docker Images](#-build-the-docker-images)
  - [🚀 Deploy the Services](#-deploy-the-services)
- [⚙️ Configuration](#-configuration)
  - [Python Deployment Script (`deploy_viewers.py`)](#python-deployment-script-deploy_viewerspy)
  - [Editing YAML Files](#editing-yaml-files)
- [How It Works](#how-it-works)
- [🩺 Troubleshooting](#-troubleshooting)
- [📁 Folder Structure](#-folder-structure)
- [📝  Notes](#-notes)

## ✨ Here's a basic flow:

1. The **fingerprint service** generates realistic browser fingerprints.
2. Each **viewer pod** requests one (or many, depending on browsers and context) and starts Chromium instances.
3. Browsers connect through their assigned **VPNs**.
4. They navigate to the `STREAM_URL` and begin viewing.
5. **Kubernetes** keeps everything running and balanced.

Resource use depends on how many browsers you're running. As a rough estimate:

- A pod of 32 Viewers is roughly **5GB RAM**. viewers number = browsers * context * tabs
- A pod running 2 browsers × 8 contexts × 8 tabs = **128 virtual viewers**.

It was originally built for Kick.com, but it can be adapted to **any streaming or content platform**—just change the target URL. (Some platforms have better anti-bot systems, so you might need to tweak Puppeteer behavior accordingly.)

Behind the scenes, it uses browser fingerprinting and VPN routing to make each viewer appear like a separate user. Kubernetes takes care of orchestration and scaling.

## 🛠️ Core Components

### 🧬 Fingerprint Service

Generates realistic browser fingerprints (pre-generates and stocks them to avoid overwhelming browser startup):

- Maintains a pool of user-like fingerprints.
- Mixes mobile profiles (they seem to work best for actually watching streams).
- Exposes an HTTP API for use by viewer pods.
- Built with Node.js and runs inside Kubernetes.

### 📺 Viewer Box

Handles browser automation:

- Picks up fingerprints from the API server, then connects to VPN.
- Launches headless Chromium instances with Puppeteer.
- Separates browsing into multiple isolated contexts.
- Routes all traffic through VPNs.
- Manages CPU and memory to avoid overload.
- Takes screenshots at lock and every 10 minutes.

## 🏁 Getting Started

### Prerequisites

- A working Kubernetes cluster (your own, minikube, or any cloud provider).
- Docker installed.
- `kubectl` set up for your cluster.
- OpenVPN config files (`.ovpn`) (not provided).

### VPN Setup

1. **Get your `.ovpn` files.**
2. **Create a namespace and load the VPN files into a ConfigMap:**

    ```bash
    kubectl create namespace stream-viewers
    kubectl create configmap vpn-configs -n stream-viewers --from-file=/path/to/your/vpnfiles/
    ```

3. **Add your VPN credentials (username/password):**

    ```bash
    echo "your_username
your_password" > auth.txt
    kubectl create configmap vpn-auth-config -n stream-viewers --from-file=auth.txt
    rm auth.txt # Clean up credentials file
    ```

### 🐳 Build the Docker Images

Update the registry name in the build scripts (`build-fingerprinter.sh` and `build-viewer-box.sh`) first:

```bash
./build-fingerprinter.sh
./build-viewer-box.sh
```

### 🚀 Deploy the Services

1. **Start with the fingerprint service:**

    ```bash
    ./deploy-fingerprinter.sh
    ```

2. **Then either deploy a single viewer:**

    ```bash
    ./deploy-viewer-box.sh
    ```
    
    **OR**

3. **Deploy multiple viewer sets using different VPNs:**

    ```bash
    python3 deploy_viewers.py --stream-url "https://kick.com/example_channel" --num-deployments 4 --replicas-per-deployment 3
    ```

## ⚙️ Configuration

### Python Deployment Script (`deploy_viewers.py`)

Run this to see all options:

```bash
python3 deploy_viewers.py --help
```

Key flags:

- `--stream-url`: Stream to watch (e.g., `https://kick.com/your_favorite_streamer`).
- `--num-deployments`: Number of separate viewer deployments (e.g., for different VPNs).
- `--replicas-per-deployment`: How many pods (viewers) per deployment.
- `--namespace`: Target Kubernetes namespace (default is `stream-viewers`).

### Editing YAML Files

Customize deployments directly via:

- `viewer-box-deployment.yaml`
- `fingerprint-deployment.yaml`

Environment variables you can tweak in the `viewer-box-deployment.yaml`:

- `NUM_BROWSERS`: Number of browser instances per pod.
- `CONTEXTS_PER_BROWSER`: Browser contexts per instance.
- `TABS_PER_CONTEXT`: Tabs per context.
- `STREAM_URL`: Where the browsers should go.

## How It Works

Here's a basic flow:

1. The **fingerprint service** generates realistic browser fingerprints.
2. Each **viewer pod** requests one (or many, depending on browsers and context) and starts Chromium instances.
3. Browsers connect through their assigned **VPNs**.
4. They navigate to the `STREAM_URL` and begin viewing.
5. **Kubernetes** keeps everything running and balanced.

Resource use depends on how many browsers you're running. As a rough estimate:

- Each tab instance uses about **100MB RAM**.
- A pod running 2 browsers × 8 contexts × 8 tabs ≈ **128 virtual viewers**.

## 🩺 Troubleshooting

If something goes wrong, here are a few things to check:

- **Pods keep restarting or crashlooping:**
  - This usually means the node is out of memory or the container hit a resource limit. Kubernetes will try to restart pods automatically. You can check pod status with:
    ```bash
    kubectl get pods -n stream-viewers
    kubectl describe pod <pod-name> -n stream-viewers
    ```
- **VPN not connecting:**
    ```bash
    kubectl logs -n stream-viewers -l component=viewer -c viewer-box | grep -i vpn
    ```
- **Chrome fails to start:**
    ```bash
    kubectl logs -n stream-viewers -l component=viewer -c viewer-box | grep -i chrome
    ```
- **Pods not being scheduled:**
  - Check if your cluster has enough resources. Kubernetes will hold pods in Pending state if there's not enough CPU or RAM. Use:
    ```bash
    kubectl get events -n stream-viewers --sort-by='.lastTimestamp'
    ```

Kubernetes will handle restarts and pod assignments for you, but if you see repeated failures, it's usually a sign to scale down or adjust your resource requests/limits in the YAML files.

## 📁 Folder Structure

```
.
├── box/                      # Viewer box logic
│   ├── Dockerfile
│   ├── stream-viewer.js      # Main browser automation code
│   └── package.json
├── fingerprinter/            # Fingerprint generator
│   ├── Dockerfile
│   ├── server.js             # Fingerprint generation logic
│   └── package.json
├── *.sh                      # Build and deployment shell scripts
├── *-deployment.yaml         # Kubernetes manifests (YAML config)
└── deploy_viewers.py         # Python script to launch multiple deployments
```

## 📝  Notes

This project is for educational and testing purposes. Please:

- Follow the **terms of service** of any platform you use this on.
- Monitor your **resource usage** when scaling.
- Keep in mind these browsers are very heavy on resources.

---
