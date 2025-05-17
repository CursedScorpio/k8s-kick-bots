const express = require('express');
const crypto = require('crypto');
const prom = require('prom-client');

// Environment variables
const PORT = process.env.PORT || 3001;
const FINGERPRINT_POOL_SIZE = parseInt(process.env.FINGERPRINT_POOL_SIZE || '10000', 10);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Configure prometheus metrics
const register = new prom.Registry();
prom.collectDefaultMetrics({ register });

const fingerprintsGeneratedCounter = new prom.Counter({
  name: 'fingerprint_service_generated_total',
  help: 'Total number of fingerprints generated',
  registers: [register]
});

const fingerprintsServedCounter = new prom.Counter({
  name: 'fingerprint_service_served_total',
  help: 'Total number of fingerprints served',
  registers: [register]
});

// Logger setup
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const logger = {
  error: (message, meta = {}) => {
    if (logLevels[LOG_LEVEL] >= logLevels.error) {
      console.error(JSON.stringify({ level: 'error', message, timestamp: new Date().toISOString(), ...meta }));
    }
  },
  warn: (message, meta = {}) => {
    if (logLevels[LOG_LEVEL] >= logLevels.warn) {
      console.warn(JSON.stringify({ level: 'warn', message, timestamp: new Date().toISOString(), ...meta }));
    }
  },
  info: (message, meta = {}) => {
    if (logLevels[LOG_LEVEL] >= logLevels.info) {
      console.info(JSON.stringify({ level: 'info', message, timestamp: new Date().toISOString(), ...meta }));
    }
  },
  debug: (message, meta = {}) => {
    if (logLevels[LOG_LEVEL] >= logLevels.debug) {
      console.debug(JSON.stringify({ level: 'debug', message, timestamp: new Date().toISOString(), ...meta }));
    }
  }
};

// Fingerprint generator
class FingerprintGenerator {
  constructor() {
    this.fingerprintPool = [];
    this.currentIndex = 0;
    
    // Mobile OS distributions optimized for streaming platforms
    this.mobileDevices = [
      {
        name: 'Pixel 6',
        osFamily: 'Android',
        osVersions: ['12', '13'],
        browserName: 'Chrome',
        browserVersions: ['110.0.5481.177', '111.0.5563.64', '112.0.5615.49', '113.0.5672.93'],
        screenResolutions: [
          {width: 412, height: 915},
          {width: 915, height: 412} // Landscape mode
        ]
      },
      {
        name: 'Samsung Galaxy S22',
        osFamily: 'Android',
        osVersions: ['12', '13'],
        browserName: 'Chrome',
        browserVersions: ['110.0.5481.177', '111.0.5563.64', '112.0.5615.49', '113.0.5672.93'],
        screenResolutions: [
          {width: 360, height: 800},
          {width: 800, height: 360} // Landscape mode
        ]
      },
      {
        name: 'OnePlus 9',
        osFamily: 'Android',
        osVersions: ['12', '13'],
        browserName: 'Chrome',
        browserVersions: ['110.0.5481.177', '111.0.5563.64', '112.0.5615.49'],
        screenResolutions: [
          {width: 414, height: 896},
          {width: 896, height: 414} // Landscape mode
        ]
      },
      {
        name: 'iPhone 13',
        osFamily: 'iOS',
        osVersions: ['15.4', '16.0', '16.3', '16.5'],
        browserName: 'Safari',
        browserVersions: ['15.4', '16.0', '16.1', '16.3'],
        screenResolutions: [
          {width: 390, height: 844},
          {width: 844, height: 390} // Landscape mode
        ]
      },
      {
        name: 'iPhone 13 Pro Max',
        osFamily: 'iOS',
        osVersions: ['15.4', '16.0', '16.3', '16.5'],
        browserName: 'Safari',
        browserVersions: ['15.4', '16.0', '16.1', '16.3'],
        screenResolutions: [
          {width: 428, height: 926},
          {width: 926, height: 428} // Landscape mode
        ]
      }
    ];
    
    this.languages = [
      'en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 
      'it-IT', 'pt-BR', 'ja-JP', 'ko-KR', 'zh-CN'
    ];
    
    this.timezones = [
      'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
      'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo'
    ];
    
    this.webGLVendors = {
      'Android': ['Google Inc.', 'Qualcomm', 'ARM'],
      'iOS': ['Apple GPU']
    };
    
    this.webGLRenderers = {
      'Android': ['ANGLE (Google, Vulkan 1.3.0)', 'Adreno (TM) 650', 'Mali-G78'],
      'iOS': ['Apple GPU', 'Apple A15 GPU']
    };
  }
  
  generateFingerprint() {
    try {
      // Select a random mobile device with 80% Android bias for better streaming
      const deviceIndex = Math.random() < 0.8 ? 
        Math.floor(Math.random() * 3) : // Android (first 3 devices)
        Math.floor(Math.random() * 2) + 3; // iOS (last 2 devices)
        
      const device = this.mobileDevices[deviceIndex];
      
      // Select OS version
      const osVersion = device.osVersions[Math.floor(Math.random() * device.osVersions.length)];
      
      // Select browser version
      const browserVersion = device.browserVersions[Math.floor(Math.random() * device.browserVersions.length)];
      
      // Select screen resolution (with 60% chance of landscape mode for better stream viewing)
      const isLandscape = Math.random() < 0.6;
      const screenResolutionIndex = isLandscape ? 1 : 0;
      const screenResolution = device.screenResolutions[screenResolutionIndex];
      
      // Select language
      const language = this.languages[Math.floor(Math.random() * this.languages.length)];
      
      // Select timezone
      const timezone = this.timezones[Math.floor(Math.random() * this.timezones.length)];
      
      // Generate User Agent
      let userAgent;
      if (device.osFamily === 'Android') {
        userAgent = `Mozilla/5.0 (Linux; Android ${osVersion}; ${device.name}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Mobile Safari/537.36`;
      } else { // iOS
        userAgent = `Mozilla/5.0 (iPhone; CPU iPhone OS ${osVersion.replace(/\./g, '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${browserVersion} Mobile/15E148 Safari/604.1`;
      }
      
      // Select WebGL vendor and renderer
      const webGLVendors = this.webGLVendors[device.osFamily];
      const webGLRenderers = this.webGLRenderers[device.osFamily];
      
      const webGLVendor = webGLVendors[Math.floor(Math.random() * webGLVendors.length)];
      const webGLRenderer = webGLRenderers[Math.floor(Math.random() * webGLRenderers.length)];
      
      // Generate a unique fingerprint
      return {
        id: crypto.randomUUID(),
        userAgent,
        viewportWidth: screenResolution.width,
        viewportHeight: screenResolution.height,
        deviceScaleFactor: device.osFamily === 'iOS' ? 3 : 2.75,
        deviceMemory: [2, 3, 4, 6][Math.floor(Math.random() * 4)],
        hardwareConcurrency: [4, 6, 8][Math.floor(Math.random() * 3)],
        platform: device.osFamily === 'Android' ? 'Android' : 'iPhone',
        isMobile: true,
        hasTouch: true,
        preferredLanguage: language,
        languages: [language, language.split('-')[0]],
        timezone,
        doNotTrack: Math.random() > 0.9 ? "1" : null,
        colorDepth: 24,
        screenHeight: screenResolution.height,
        screenWidth: screenResolution.width,
        deviceName: device.name,
        osFamily: device.osFamily,
        osVersion,
        browserName: device.browserName,
        browserVersion,
        webGL: {
          vendor: webGLVendor,
          renderer: webGLRenderer
        },
        isLandscape
      };
    } catch (error) {
      logger.error('Error generating fingerprint', { error: error.message, stack: error.stack });
      return { 
        id: crypto.randomUUID(),
        error: 'Failed to generate complete fingerprint'
      };
    }
  }
  
  // Generate the initial pool of fingerprints
  generateInitialPool() {
    try {
      logger.info(`Generating initial pool of ${FINGERPRINT_POOL_SIZE} fingerprints...`);
      
      this.fingerprintPool = [];
      for (let i = 0; i < FINGERPRINT_POOL_SIZE; i++) {
        const fingerprint = this.generateFingerprint();
        this.fingerprintPool.push(fingerprint);
        fingerprintsGeneratedCounter.inc();
        
        // Log progress every 1000 fingerprints
        if ((i + 1) % 1000 === 0) {
          logger.debug(`Generated ${i + 1} fingerprints so far...`);
        }
      }
      
      logger.info(`Initial fingerprint pool generated with ${this.fingerprintPool.length} fingerprints`);
    } catch (error) {
      logger.error('Error generating initial fingerprint pool', { error: error.message, stack: error.stack });
      throw error; // Re-throw to be caught by caller
    }
  }
  
  // Get the next fingerprint from the pool
  getNext() {
    try {
      if (this.fingerprintPool.length === 0) {
        this.generateInitialPool();
      }
      
      // Get the next fingerprint in a round-robin fashion
      const fingerprint = this.fingerprintPool[this.currentIndex];
      
      // Update the index for the next request
      this.currentIndex = (this.currentIndex + 1) % this.fingerprintPool.length;
      
      // Track metrics
      fingerprintsServedCounter.inc();
      
      return fingerprint;
    } catch (error) {
      logger.error('Error retrieving next fingerprint', { error: error.message, stack: error.stack });
      return this.generateFingerprint(); // Fallback to generating a new one
    }
  }
  
  // Get a randomly generated fingerprint (not from the pool)
  getRandom() {
    try {
      const fingerprint = this.generateFingerprint();
      fingerprintsGeneratedCounter.inc();
      fingerprintsServedCounter.inc();
      return fingerprint;
    } catch (error) {
      logger.error('Error generating random fingerprint', { error: error.message, stack: error.stack });
      return { 
        id: crypto.randomUUID(),
        error: 'Failed to generate random fingerprint'
      };
    }
  }
}

// Create Express app
const app = express();

// Add error handling middleware
app.use((err, req, res, next) => {
  logger.error('Uncaught error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Server error', message: err.message });
});

// Create the fingerprint generator
let fingerprintGenerator;

try {
  fingerprintGenerator = new FingerprintGenerator();
  
  // Generate initial pool with a fallback mechanism
  try {
    fingerprintGenerator.generateInitialPool();
  } catch (error) {
    logger.error('Failed to generate initial pool, will generate on demand', { error: error.message });
  }
} catch (error) {
  logger.error('Failed to initialize fingerprint generator', { error: error.message, stack: error.stack });
  process.exit(1); // Exit if we can't initialize - let Kubernetes restart us
}

// Health check endpoint
app.get('/healthz', (req, res) => {
  try {
    // Only consider healthy if we have the generator and either pool or ability to generate
    if (fingerprintGenerator && 
        (fingerprintGenerator.fingerprintPool.length > 0 || fingerprintGenerator.generateFingerprint())) {
      return res.status(200).json({ status: 'ok' });
    }
    logger.warn('Health check failed');
    return res.status(500).json({ status: 'error', message: 'Fingerprint generator not ready' });
  } catch (error) {
    logger.error('Health check error', { error: error.message });
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error('Metrics endpoint error', { error: error.message });
    res.status(500).send(error.message);
  }
});

// Get next fingerprint from pool
app.get('/next', (req, res) => {
  try {
    logger.debug('Received request for next fingerprint');
    const fingerprint = fingerprintGenerator.getNext();
    logger.debug('Returning fingerprint', { fingerprintId: fingerprint.id });
    res.json(fingerprint);
  } catch (error) {
    logger.error('Error in /next endpoint', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to retrieve fingerprint' });
  }
});

// Get random fingerprint (not from pool)
app.get('/random', (req, res) => {
  try {
    logger.debug('Received request for random fingerprint');
    const fingerprint = fingerprintGenerator.getRandom();
    logger.debug('Returning random fingerprint', { fingerprintId: fingerprint.id });
    res.json(fingerprint);
  } catch (error) {
    logger.error('Error in /random endpoint', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to generate random fingerprint' });
  }
});

// Get specific fingerprint by ID - kept for backward compatibility
app.get('/fingerprint/:id', (req, res) => {
  try {
    const id = req.params.id;
    logger.debug(`Received request for fingerprint ID: ${id}`);
    
    // For backward compatibility, generate a new fingerprint with the given ID
    const fingerprint = fingerprintGenerator.generateFingerprint();
    fingerprint.id = id;
    
    logger.debug('Returning fingerprint', { fingerprintId: id });
    res.json(fingerprint);
  } catch (error) {
    logger.error('Error in /fingerprint/:id endpoint', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to retrieve fingerprint' });
  }
});

// List all fingerprints endpoint - limited to first 100 for safety
app.get('/fingerprints', (req, res) => {
  try {
    logger.debug('Received request for fingerprint list');
    
    if (!fingerprintGenerator || !fingerprintGenerator.fingerprintPool) {
      return res.status(500).json({ error: 'Fingerprint pool not available' });
    }
    
    // Only return first 100 to avoid overwhelming response
    const limitedFingerprints = fingerprintGenerator.fingerprintPool.slice(0, 100);
    logger.debug(`Returning ${limitedFingerprints.length} fingerprints`);
    
    res.json(limitedFingerprints);
  } catch (error) {
    logger.error('Error in /fingerprints endpoint', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to retrieve fingerprints' });
  }
});

// Default route to catch all undefined routes
app.use('*', (req, res) => {
  logger.debug(`Received request for unknown route: ${req.originalUrl}`);
  res.status(404).send('Not found');
});

// Start the server with proper error handling
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Fingerprint service listening on port ${PORT}`);
})
.on('error', (error) => {
  logger.error('Server startup error', { error: error.message, stack: error.stack });
  process.exit(1); // Exit on fatal errors to let Kubernetes restart
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed, exiting process');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed, exiting process');
    process.exit(0);
  });
});

// Catch uncaught exceptions to prevent crashes
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  // Continue running but log the error
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason: reason?.message || String(reason) });
  // Continue running but log the error
});