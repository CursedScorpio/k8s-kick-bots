FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install dependencies with production flag
RUN npm install --production

# Bundle app source
COPY . .

# Expose the service port
EXPOSE 3001

# Use non-root user for security
USER node

# Start the service with proper signal handling
CMD ["node", "server.js"]