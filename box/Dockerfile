FROM node:16-alpine

# Install dependencies
RUN apk add --no-cache \
    chromium \
    openvpn \
    curl \
    iproute2 \
    bind-tools \
    dnsmasq \
    busybox-extras \
    iputils \
    ca-certificates \
    tzdata

# Create app directory
WORKDIR /app

# Skip Chromium download since we installed it via apk
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true 
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Set proper DNS settings
RUN echo "options single-request-reopen" > /etc/resolv.conf && \
    echo "options timeout:2 attempts:5 rotate" >> /etc/resolv.conf && \
    echo "search kick-watchers.svc.cluster.local svc.cluster.local cluster.local" >> /etc/resolv.conf && \
    echo "nameserver 10.96.0.10    # Kubernetes cluster DNS" >> /etc/resolv.conf && \
    echo "nameserver 8.8.8.8       # Google DNS as backup" >> /etc/resolv.conf && \
    echo "nameserver 1.1.1.1       # Cloudflare DNS as backup" >> /etc/resolv.conf

# Set up hosts file to ensure fingerprint service resolution
RUN echo "127.0.0.1 localhost" > /etc/hosts && \
    echo "::1 localhost ip6-localhost ip6-loopback" >> /etc/hosts && \
    echo "# Will resolve fingerprint-service at runtime" >> /etc/hosts

# Copy package.json and install dependencies
COPY package.json .
RUN npm install

# Copy source code
COPY stream-viewer.js .
COPY test-dns.sh /app/test-dns.sh
RUN chmod +x /app/test-dns.sh

# Create DNS test script properly
RUN echo '#!/bin/sh\necho "Current hosts file:"\ncat /etc/hosts\necho "\nCurrent resolv.conf:"\ncat /etc/resolv.conf\necho "\nTesting DNS resolution..."\nfor HOST in fingerprint-service fingerprint-service.kick-watchers fingerprint-service.kick-watchers.svc.cluster.local kubernetes.default.svc.cluster.local; do\n  echo "Looking up $HOST:"\n  nslookup $HOST || echo "Failed to resolve $HOST"\ndone\necho "\nTesting connectivity..."\nping -c 2 1.1.1.1 || echo "Ping failed"\necho "\nTesting internet access:"\ncurl -v --max-time 5 https://api.ipify.org?format=json || echo "Curl failed"\n' > /app/test-dns.sh && \
    chmod +x /app/test-dns.sh

# Create startup script properly (using multiple RUN commands to avoid newline issues)
RUN echo '#!/bin/sh' > /app/start.sh
RUN echo '' >> /app/start.sh
RUN echo '# Update hosts file with current DNS resolution for fingerprint service' >> /app/start.sh
RUN echo 'IP=$(getent hosts fingerprint-service.kick-watchers.svc.cluster.local | awk "{ print \$1 }")' >> /app/start.sh
RUN echo 'if [ ! -z "$IP" ]; then' >> /app/start.sh
RUN echo '  echo "$IP fingerprint-service" >> /etc/hosts' >> /app/start.sh
RUN echo '  echo "Added fingerprint-service to hosts with IP $IP"' >> /app/start.sh
RUN echo 'else' >> /app/start.sh
RUN echo '  echo "Could not resolve fingerprint-service.kick-watchers.svc.cluster.local"' >> /app/start.sh
RUN echo 'fi' >> /app/start.sh
RUN echo '' >> /app/start.sh
RUN echo '# Run the application' >> /app/start.sh
RUN echo 'exec node stream-viewer.js' >> /app/start.sh
RUN chmod +x /app/start.sh

# Create directories for data
RUN mkdir -p /screenshots /logs /vpn /etc/openvpn

# Set proper permissions
RUN chmod -R 777 /screenshots /logs /vpn /etc/openvpn

# Expose the port
EXPOSE 3000

# Start the box
CMD ["/app/start.sh"]