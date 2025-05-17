const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { exec, execSync } = require('child_process');
const express = require('express');
const app = express();
const port = 3000;

// Add stealth plugin
puppeteer.use(StealthPlugin());

// Configuration from environment variables
const BOX_NAME = process.env.BOX_NAME || 'box-1';
const NUM_BROWSERS = parseInt(process.env.NUM_BROWSERS || '4');
const CONTEXTS_PER_BROWSER = parseInt(process.env.CONTEXTS_PER_BROWSER || '4');
const TABS_PER_CONTEXT = parseInt(process.env.TABS_PER_CONTEXT || '4');
const STREAM_URL = process.env.STREAM_URL || 'https://kick.com/abdelbare0';
const VPN_CONFIG = process.env.VPN_CONFIG || '';
const FINGERPRINT_SERVICE = process.env.FINGERPRINT_SERVICE || 'http://fingerprint-service.kick-watchers.svc.cluster.local:3001';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/screenshots';
const LOG_DIR = process.env.LOG_DIR || '/logs';

// Array to store pre-fetched fingerprints
const prefetchedFingerprints = [];

// Create directories if they don't exist
async function ensureDirectories() {
  try {
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    await fs.mkdir(LOG_DIR, { recursive: true });
    console.log(`Created directories: ${SCREENSHOT_DIR}, ${LOG_DIR}`);
  } catch (error) {
    console.error(`Error creating directories: ${error.message}`);
  }
}

// Simple logging function
async function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  
  try {
    await fs.appendFile(path.join(LOG_DIR, `${BOX_NAME}.log`), logMessage);
  } catch (error) {
    console.error(`Error writing to log: ${error.message}`);
  }
}

// Get fingerprint from service
async function getFingerprint() {
  try {
    // Try multiple service URLs in sequence
    const serviceUrls = [
      FINGERPRINT_SERVICE,
      'http://fingerprint-service:3001',
      'http://fingerprint-service.kick-watchers:3001',
      'http://fingerprint-service.kick-watchers.svc.cluster.local:3001',
      'http://10.108.176.229:3001' // Direct IP of fingerprint service
    ];
    
    // Try each URL with multiple retries
    let lastError = null;
    for (const url of serviceUrls) {
      // Try up to 3 times per URL
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await log(`Trying fingerprint service at URL: ${url} (attempt ${attempt}/3)`);
          const response = await axios.get(`${url}/next`, { 
            timeout: 10000, // Longer timeout
            headers: {
              'User-Agent': 'Viewer-Box/1.0',
              'Accept': 'application/json'
            }
          });
          
          if (response?.data?.id) {
            await log(`Successfully connected to fingerprint service at ${url}`);
            await log(`Got fingerprint: ${response.data.id}`);
            return response.data;
          }
        } catch (err) {
          lastError = err;
          await log(`Failed attempt ${attempt} to get fingerprint from ${url}: ${err.message}`);
          
          // Don't wait on last attempt or last URL
          if (attempt < 3 && url !== serviceUrls[serviceUrls.length - 1]) {
            await log(`Waiting 2 seconds before next attempt...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
    }
    
    // If we get here, all attempts failed
    throw new Error(`All fingerprint service URLs failed after multiple attempts. Last error: ${lastError?.message}`);
  } catch (error) {
    await log(`CRITICAL ERROR: Cannot continue without fingerprint service: ${error.message}`);
    throw error; // Rethrow to allow for proper handling in the calling function
  }
}

// Pre-fetch all required fingerprints
async function prefetchFingerprints() {
  const totalNeeded = NUM_BROWSERS * (CONTEXTS_PER_BROWSER + 1) + 5; // Browsers + contexts + buffer
  await log(`Pre-fetching ${totalNeeded} fingerprints before starting VPN...`);
  
  try {
    for (let i = 0; i < totalNeeded; i++) {
      const fingerprint = await getFingerprint();
      prefetchedFingerprints.push(fingerprint);
      await log(`Pre-fetched fingerprint ${i+1}/${totalNeeded}: ${fingerprint.id}`);
      
      // Small delay to avoid overwhelming the service
      if (i < totalNeeded - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    await log(`Successfully pre-fetched all ${prefetchedFingerprints.length} fingerprints!`);
    return true;
  } catch (error) {
    await log(`Failed to pre-fetch fingerprints: ${error.message}`);
    return false;
  }
}

// Get a pre-fetched fingerprint
function getNextFingerprint() {
  if (prefetchedFingerprints.length === 0) {
    throw new Error('No pre-fetched fingerprints available!');
  }
  return prefetchedFingerprints.shift();
}

// Connect to VPN if configured
async function connectToVpn() {
  if (!VPN_CONFIG) {
    await log('No VPN configuration provided, running without VPN');
    return true;
  }
  
  try {
    await log(`Connecting to VPN using config: ${VPN_CONFIG}`);
    
    // Check if the VPN config file exists
    const vpnPath = `/vpn/${VPN_CONFIG}.ovpn`;
    try {
      await fs.access(vpnPath);
    } catch (error) {
      await log(`VPN config file not found: ${vpnPath}`);
      return false;
    }
    
    // Start OpenVPN in the background
    exec(`openvpn --config ${vpnPath} --daemon --log /tmp/vpn.log`);
    
    // Wait for VPN connection
    await log('Waiting for VPN connection...');
    
    // Simple wait loop checking if tun0 interface appears
    for (let i = 0; i < 30; i++) {
      try {
        const output = execSync('ip addr show tun0').toString();
        if (output.includes('inet ')) {
          const ipMatch = output.match(/inet ([0-9.]+)/);
          if (ipMatch && ipMatch[1]) {
            const vpnIp = ipMatch[1];
            await log(`VPN tunnel interface connected with IP: ${vpnIp}`);
            
            // Now get the actual external IP to verify VPN is working
            try {
              const externalResponse = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
              const externalIp = externalResponse.data.ip;
              await log(`VPN external IP: ${externalIp}`);
              
              // Get country information for the external IP
              try {
                const geoResponse = await axios.get(`https://ipapi.co/${externalIp}/json/`);
                const country = geoResponse.data.country_name || 'Unknown';
                const countryCode = geoResponse.data.country_code || 'Unknown';
                await log(`VPN location: ${country} (${countryCode})`);
              } catch (geoError) {
                await log(`Couldn't determine VPN country: ${geoError.message}`);
              }
              
              return true;
            } catch (externalIpError) {
              await log(`Failed to get external IP: ${externalIpError.message}`);
              // Continue anyway as tunnel is established
              return true;
            }
          }
        }
      } catch (error) {
        // Interface not found yet
      }
      
      // Wait a second before checking again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    await log('VPN connection failed: timeout');
    return false;
  } catch (error) {
    await log(`Error connecting to VPN: ${error.message}`);
    return false;
  }
}

// Browser launch options specifically optimized for memory constraints and stability
const getBrowserOptions = () => ({
  headless: "new",
  executablePath: '/usr/bin/chromium-browser',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-extensions',
    '--mute-audio',
    '--no-default-browser-check',
    // Reduce memory usage significantly
    '--js-flags="--max-old-space-size=128"',
    '--disable-translate',
    '--disable-background-networking',
    '--disable-features=site-per-process',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--touch-events=enabled',
    // Critical memory-saving flags
    '--single-process',
    '--renderer-process-limit=1',
    '--memory-pressure-thresholds=conservative',
    '--enable-low-end-device-mode',
    // Allow fewer tabs per process
    '--optimum-number-of-renderer-processes=1',
    // Allow insecure content for streaming sites
    '--allow-running-insecure-content'
  ],
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
  ignoreHTTPSErrors: true,
  // Adding these memory optimization settings for puppeteer
  protocolTimeout: 180000, // Extend protocol timeout to 3 minutes
  timeout: 180000, // General timeout to 3 minutes
  defaultViewport: {
    width: 375,
    height: 667,
    deviceScaleFactor: 1, // Reduced from 2 to save memory
    isMobile: true,
    hasTouch: true
  }
});

// Set up API server
function setupServer(browsers) {
  // Serve screenshots
  app.use('/screenshots', express.static(SCREENSHOT_DIR));
  app.use('/logs', express.static(LOG_DIR));
  
  // Homepage with status
  app.get('/', async (req, res) => {
    const browserStatus = browsers.map(browser => ({
      id: browser.id,
      fingerprintId: browser.fingerprint?.id || 'unknown',
      contexts: browser.contexts.map(context => ({
        id: context.id,
        fingerprintId: context.fingerprint?.id || 'unknown',
        tabs: context.tabs.map(tab => ({
          id: tab.id,
          url: tab.url || STREAM_URL,
          status: tab.status || 'unknown',
          lastScreenshot: tab.lastScreenshot || null
        }))
      }))
    }));
    
    // Get latest screenshots
    let screenshots = [];
    try {
      const files = await fs.readdir(SCREENSHOT_DIR);
      screenshots = files
        .filter(file => file.endsWith('.png') || file.endsWith('.jpg'))
        .map(file => ({
          name: file,
          path: `/screenshots/${file}`,
          timestamp: file.split('_').pop().replace('.png', '').replace('.jpg', '')
        }))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 10);
    } catch (error) {
      console.error(`Error reading screenshots: ${error.message}`);
    }
    
    res.send(`
      <html>
        <head>
          <title>Box Viewer: ${BOX_NAME}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            h1, h2, h3 { color: #333; }
            .status { margin-bottom: 30px; }
            .browser { margin-bottom: 20px; border: 1px solid #ddd; padding: 10px; border-radius: 5px; }
            .context { margin: 10px 0; padding: 10px; background: #f5f5f5; border-radius: 5px; }
            .tab { margin: 5px 0; padding: 5px; background: #fff; border: 1px solid #eee; }
            .screenshots { display: flex; flex-wrap: wrap; gap: 15px; }
            .screenshot { width: 300px; }
            .screenshot img { max-width: 100%; border: 1px solid #ddd; }
            .refresh { margin: 20px 0; }
          </style>
          <meta http-equiv="refresh" content="30">
        </head>
        <body>
          <h1>Box Viewer: ${BOX_NAME}</h1>
          <div class="status">
            <h2>Status</h2>
            <p>Stream URL: ${STREAM_URL}</p>
            <p>VPN Config: ${VPN_CONFIG || 'None'}</p>
            <p>Browsers: ${NUM_BROWSERS}, Contexts per browser: ${CONTEXTS_PER_BROWSER}, Tabs per context: ${TABS_PER_CONTEXT}</p>
          </div>
          
          <h2>Browsers</h2>
          ${browserStatus.map(browser => `
            <div class="browser">
              <h3>Browser ${browser.id} (Fingerprint: ${browser.fingerprintId})</h3>
              ${browser.contexts.map(context => `
                <div class="context">
                  <h4>Context ${context.id} (Fingerprint: ${context.fingerprintId})</h4>
                  ${context.tabs.map(tab => `
                    <div class="tab">
                      <p>Tab ${tab.id} - Status: ${tab.status}</p>
                      <p>URL: ${tab.url}</p>
                      ${tab.lastScreenshot ? `<p>Last Screenshot: <a href="/screenshots/${tab.lastScreenshot}">${tab.lastScreenshot}</a></p>` : ''}
                    </div>
                  `).join('')}
                </div>
              `).join('')}
            </div>
          `).join('')}
          
          <h2>Recent Screenshots</h2>
          <div class="screenshots">
            ${screenshots.map(screenshot => `
              <div class="screenshot">
                <h4>${screenshot.name}</h4>
                <a href="${screenshot.path}" target="_blank">
                  <img src="${screenshot.path}" alt="${screenshot.name}" />
                </a>
              </div>
            `).join('')}
          </div>
          
          <div class="refresh">
            <p>Page refreshes automatically every 30 seconds. <a href="/">Refresh now</a></p>
          </div>
        </body>
      </html>
    `);
  });
  
  // API endpoint for screenshots
  app.get('/api/screenshots', async (req, res) => {
    try {
      const files = await fs.readdir(SCREENSHOT_DIR);
      const screenshots = files
        .filter(file => file.endsWith('.png') || file.endsWith('.jpg'))
        .map(file => ({
          name: file,
          path: `/screenshots/${file}`
        }));
      
      res.json({ screenshots });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Status update API
  app.get('/api/status', (req, res) => {
    const browserStatus = browsers.map(browser => ({
      id: browser.id,
      fingerprintId: browser.fingerprint?.id || 'unknown',
      contexts: browser.contexts.map(context => ({
        id: context.id,
        fingerprintId: context.fingerprint?.id || 'unknown',
        tabs: context.tabs.map(tab => ({
          id: tab.id,
          url: tab.url || STREAM_URL,
          status: tab.status || 'unknown',
          lastScreenshot: tab.lastScreenshot || null
        }))
      }))
    }));
    
    res.json({ 
      boxName: BOX_NAME,
      streamUrl: STREAM_URL,
      vpnConfig: VPN_CONFIG,
      browsers: browserStatus 
    });
  });
  
  // Health check endpoint
  app.get('/healthz', (req, res) => {
    res.send('OK');
  });
  
  // Start the server
  app.listen(port, '0.0.0.0', () => {
    log(`Box viewer server listening on port ${port}`);
  });
}

// Check stream status in a tab
async function checkStreamStatus(page) {
  try {
    return await page.evaluate(() => {
      // Check for video element
      const video = document.querySelector('video');
      if (!video) return { isLive: false, error: 'No video element found' };
      
      // Check for live indicators
      const hasLiveIndicator = !!document.querySelector('[class*="live"], [class*="status-live"], [data-status="live"], .stream-status-live, .live-indicator');
      
      // Check video properties
      const videoActive = video && !video.paused && video.readyState > 2;
      
      // Check for offline message
      const hasOfflineMessage = !!document.querySelector('[class*="offline"], .offline-message, .channel-offline');
      
      // Get stream title
      const titleEl = document.querySelector('.stream-title, .info h3, .video-title, h1.font-bold, [class*="title"]');
      const title = titleEl ? titleEl.textContent.trim() : null;
      
      // Get streamer name
      const streamerEl = document.querySelector('.username, .streamer-name, .channel-name, .creator-name');
      const streamer = streamerEl ? streamerEl.textContent.trim() : null;
      
      // Get viewer count
      const viewerEl = document.querySelector('.viewer-count, .viewers, [class*="viewer-count"], [class*="viewers"]');
      let viewers = null;
      if (viewerEl) {
        const viewerMatch = viewerEl.textContent.match(/(\d+(?:,\d+)*)/);
        viewers = viewerMatch ? parseInt(viewerMatch[1].replace(/,/g, ''), 10) : null;
      }
      
      // Evaluate stream status
      const isLive = (hasLiveIndicator || videoActive) && !hasOfflineMessage;
      
      return {
        isLive,
        title,
        streamer,
        viewers,
        videoActive,
        hasLiveIndicator,
        hasOfflineMessage
      };
    });
  } catch (error) {
    return { isLive: false, error: error.message };
  }
}

// Force lowest quality (160p) for a specific tab
async function forceLowestQuality(page) {
  try {
    const result = await page.evaluate(() => {
      try {
        // Find quality selector button
        const qualityButton = document.querySelector('.quality-selector-button, .vjs-quality-selector button, .vjs-resolution-button button');
        if (!qualityButton) {
          console.log('Quality button not found');
          return { success: false, error: 'Quality button not found' };
        }
        
        // Click the quality button to open menu
        qualityButton.click();
        
        // Small delay to let menu open
        return new Promise(resolve => {
          setTimeout(() => {
            try {
              // Find all quality options and select the lowest
              const qualityOptions = document.querySelectorAll('.quality-selector-menu .quality-selector-option, .vjs-menu-item, .vjs-resolution-option');
              
              if (!qualityOptions || qualityOptions.length === 0) {
                console.log('No quality options found');
                resolve({ success: false, error: 'No quality options found' });
                return;
              }
              
              // Look for 160p first, then lowest available
              let targetOption = null;
              
              // First pass: look for 160p or Auto
              for (const option of qualityOptions) {
                const text = option.textContent.trim().toLowerCase();
                if (text.includes('160p') || text.includes('lowest')) {
                  targetOption = option;
                  break;
                }
              }
              
              // Second pass: if 160p not found, get lowest resolution
              if (!targetOption) {
                // Convert to array, sort by resolution
                const optionsArray = Array.from(qualityOptions);
                
                // Extract resolution from text
                const getResValue = (text) => {
                  const match = text.match(/(\d+)p/);
                  return match ? parseInt(match[1], 10) : 9999;
                };
                
                // Sort by resolution (lowest first)
                optionsArray.sort((a, b) => {
                  return getResValue(a.textContent) - getResValue(b.textContent);
                });
                
                // Get lowest resolution option
                targetOption = optionsArray[0];
              }
              
              if (targetOption) {
                console.log(`Selecting quality: ${targetOption.textContent.trim()}`);
                targetOption.click();
                resolve({ 
                  success: true, 
                  quality: targetOption.textContent.trim(),
                  message: `Set quality to ${targetOption.textContent.trim()}`
                });
              } else {
                console.log('Could not determine which quality option to select');
                resolve({ success: false, error: 'Could not determine which quality option to select' });
              }
            } catch (e) {
              console.error('Error selecting quality:', e);
              resolve({ success: false, error: e.message });
            }
          }, 500);
        });
      } catch (e) {
        console.error('Error in quality selection:', e);
        return { success: false, error: e.message };
      }
    });
    
    return result;
  } catch (error) {
    console.error(`Error forcing lowest quality: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Restart video playback if needed
async function restartVideoPlayback(page) {
  try {
    return await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) return { success: false, error: 'No video element found' };
      
      // Check if video is paused or errored
      if (video.paused || video.ended || video.error) {
        // Try to play
        try {
          // First reset any error state
          if (video.error) {
            // Reload the video element
            video.load();
          }
          
          // Ensure not muted
          video.muted = false;
          video.volume = 0.5;
          
          const playPromise = video.play();
          if (playPromise) {
            playPromise.catch(e => {
              console.error('Error playing video:', e);
              
              // If autoplay was blocked, try with muted first
              video.muted = true;
              video.play().then(() => {
                // Unmute after successful play
                setTimeout(() => {
                  video.muted = false;
                  video.volume = 0.5;
                }, 1000);
              }).catch(e => {
                console.error('Failed to play even with muted:', e);
              });
            });
          }
          return { success: true, message: 'Video restart initiated' };
        } catch (e) {
          console.error('Error restarting playback:', e);
          return { success: false, error: e.message };
        }
      }
      return { success: true, message: 'Video already playing' }; // Already playing
    });
  } catch (error) {
    console.error(`Error restarting video playback: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Set up optimized request interception for Kick.com
async function setupKickRequestInterception(page) {
  await page.setRequestInterception(true);
  
  // Create fast lookup sets for request filtering
  const criticalDomains = new Set(['kick.com', 'media.kick.com', 'video.kick.com', 
                               'akamaihd.net', 'cloudfront.net', 'fastly.net']);
  
  const criticalMediaTypes = new Set(['hls', 'm3u8', '.ts', 'video', 'media', 'stream']);
  
  const blockedDomains = new Set(['google-analytics', 'googletagmanager', 'doubleclick', 'facebook',
                             'hotjar', 'amplitude', 'segment.io', 'mixpanel', 'fingerprint', 
                             'clarity.ms', 'recaptcha', 'perimeterx', 'cloudflare-insights', 
                             'omtrdc.net', 'evidon', 'stickyadstv', 'moatads', 'adroll', 
                             'hcaptcha.com', 'quantserve', 'pendo.io', 'cdndex.io']);
  
  const essentialResourceTypes = new Set(['websocket', 'xhr', 'fetch', 'script', 'stylesheet', 'document']);
  
  // Remove previous request listeners to prevent memory leaks
  page.removeAllListeners('request');
  
  // Add optimized request handler
  page.on('request', (request) => {
    const url = request.url().toLowerCase();
    const resourceType = request.resourceType();
    
    // Fast path for allowed resource types
    if (essentialResourceTypes.has(resourceType)) {
      request.continue();
      return;
    }
    
    // Block known tracking and ad domains
    const domain = url.split('/')[2] || '';
    if ([...blockedDomains].some(blocked => domain.includes(blocked))) {
      request.abort();
      return;
    }
    
    // Fast path for critical domains
    if (criticalDomains.has(domain)) {
      // Allow critical domains but block images and other non-essential resources
      if (resourceType === 'image' || resourceType === 'font') {
        // Allow only player-related images
        if (url.includes('player') || url.includes('logo')) {
          request.continue();
        } else {
          request.abort();
        }
      } else {
        request.continue();
      }
      return;
    }
    
    // Allow critical media content
    if ([...criticalMediaTypes].some(mediaType => url.includes(mediaType))) {
      request.continue();
      return;
    }
    
    // Special case for websocket connections
    if (url.startsWith('wss://') || url.startsWith('ws://')) {
      request.continue();
      return;
    }
    
    // Block most images, fonts and media from non-critical sources
    if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media') {
      request.abort();
      return;
    }
    
    // Default: allow the request
    request.continue();
  });
  
  // Clean up response listeners to prevent memory leaks
  page.removeAllListeners('response');
}

// Main function to run the box
async function runBox() {
  await ensureDirectories();
  await log(`Starting box ${BOX_NAME} with ${NUM_BROWSERS} browsers, ${CONTEXTS_PER_BROWSER} contexts per browser, ${TABS_PER_CONTEXT} tabs per context`);

  // Set up the API server early to show status
  const browsers = [];
  setupServer(browsers);
  
  // Pre-fetch fingerprints before connecting to VPN
  try {
    await log('Pre-fetching all required fingerprints before connecting to VPN...');
    const fingerprintsSuccess = await prefetchFingerprints();
    
    if (!fingerprintsSuccess) {
      await log('Failed to pre-fetch required fingerprints. Cannot continue.');
      process.exit(1);
    }
    
    await log(`Successfully pre-fetched ${prefetchedFingerprints.length} fingerprints!`);
  } catch (error) {
    await log(`Failed to pre-fetch fingerprints: ${error.message}`);
    process.exit(1);
  }
  
  // Connect to VPN after fingerprints are fetched
  if (VPN_CONFIG) {
    const vpnConnected = await connectToVpn();
    if (!vpnConnected) {
      await log('Failed to connect to VPN, continuing without VPN');
    } else {
      // Critical: Wait for VPN connection to stabilize before launching browsers
      await log("VPN connected. Waiting for connection to stabilize before proceeding...");
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }
  
  // Set up global error handler
  process.on('uncaughtException', async (error) => {
    await log(`UNCAUGHT EXCEPTION: ${error.message}`);
  });
  
  process.on('unhandledRejection', async (reason) => {
    await log(`UNHANDLED REJECTION: ${reason}`);
  });
  
  // CRITICAL FIX: Launch browsers sequentially - one at a time
  for (let b = 0; b < NUM_BROWSERS; b++) {
    await launchBrowserAndCreateViewers(b, browsers);
  }
  
  await log(`All browsers, contexts, and tabs have been set up. Box ${BOX_NAME} is running.`);
  
  // Set up status reporting
  setInterval(async () => {
    try {
      const statusCounts = {};
      let totalTabs = 0;
      
      for (const browserData of browsers) {
        for (const contextData of browserData.contexts) {
          for (const tabData of contextData.tabs) {
            statusCounts[tabData.status] = (statusCounts[tabData.status] || 0) + 1;
            totalTabs++;
          }
        }
      }
      
      await log(`Status report: ${JSON.stringify(statusCounts)} (total: ${totalTabs} tabs)`);
    } catch (error) {
      await log(`Error in status reporting: ${error.message}`);
    }
  }, 300000);
  
  // Set up SIGTERM handler
  process.on('SIGTERM', async () => {
    await log('Received SIGTERM, shutting down...');
    
    for (const browserData of browsers) {
      try {
        await browserData.browser.close();
      } catch (error) {
        await log(`Error closing browser: ${error.message}`);
      }
    }
    
    if (VPN_CONFIG) {
      try {
        exec('pkill openvpn');
        await log('Terminated OpenVPN process');
      } catch (error) {
        await log(`Error terminating OpenVPN: ${error.message}`);
      }
    }
    
    await log('Shutdown complete');
    process.exit(0);
  });
}

// NEW FUNCTION: Launch browser and create all contexts and tabs
async function launchBrowserAndCreateViewers(browserIndex, browsers) {
  try {
    await log(`Launching browser ${browserIndex}...`);
    
    // Launch browser with retries
    let browser = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        browser = await puppeteer.launch({
          ...getBrowserOptions(),
          // CRITICAL FIX: Don't use single-process mode - causes tab creation issues with VPN
          args: getBrowserOptions().args.filter(arg => arg !== '--single-process')
        });
        break;
      } catch (err) {
        await log(`Browser launch attempt ${attempt} failed: ${err.message}`);
        if (attempt === 3) throw err;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    if (!browser) {
      throw new Error(`Failed to launch browser ${browserIndex}`);
    }
    
    // Use a pre-fetched fingerprint
    const browserFingerprint = getNextFingerprint();
    
    // Store browser info
    browsers.push({
      id: browserIndex,
      browser,
      fingerprint: browserFingerprint,
      contexts: []
    });
    
    await log(`Browser ${browserIndex} launched successfully with fingerprint ${browserFingerprint.id}`);
    
    // IMPORTANT: Create one context at a time and don't wait for tabs to initialize
    // before creating the next context - this way browser stays responsive
    for (let c = 0; c < CONTEXTS_PER_BROWSER; c++) {
      await createContext(browserIndex, c, browser, browsers);
    }
    
    return true;
  } catch (error) {
    await log(`Error with browser ${browserIndex}: ${error.message}`);
    return false;
  }
}

// NEW FUNCTION: Create a browser context
async function createContext(browserIndex, contextIndex, browser, browsers) {
  try {
    await log(`Creating context ${contextIndex} in browser ${browserIndex}...`);
    
    // Get fingerprint
    const contextFingerprint = getNextFingerprint();
    await log(`Context ${contextIndex} assigned fingerprint ID: ${contextFingerprint.id}`);
    
    // Create the context with error handling
    const context = await browser.createIncognitoBrowserContext();
    
    // Store context
    const contextData = {
      id: contextIndex,
      context,
      fingerprint: contextFingerprint,
      tabs: []
    };
    
    browsers[browserIndex].contexts.push(contextData);
    
    // Wait between context creation
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Initialize tabs for this context after a delay
    setTimeout(async () => {
      await createTabsForContext(browserIndex, contextIndex, browsers);
    }, 10000);
    
    return true;
  } catch (error) {
    await log(`Error creating context ${contextIndex} in browser ${browserIndex}: ${error.message}`);
    return false;
  }
}

// NEW FUNCTION: Create tabs for a context
async function createTabsForContext(browserIndex, contextIndex, browsers) {
  try {
    const browserData = browsers[browserIndex];
    if (!browserData) {
      await log(`Browser ${browserIndex} not found`);
      return false;
    }
    
    const contextData = browserData.contexts.find(c => c.id === contextIndex);
    if (!contextData) {
      await log(`Context ${contextIndex} not found in browser ${browserIndex}`);
      return false;
    }
    
    const context = contextData.context;
    if (!context) {
      await log(`Context object not found for context ${contextIndex} in browser ${browserIndex}`);
      return false;
    }
    
    // Create tabs one at a time
    for (let t = 0; t < TABS_PER_CONTEXT; t++) {
      await createTab(browserIndex, contextIndex, t, contextData, browsers);
    }
    
    return true;
  } catch (error) {
    await log(`Error creating tabs for context ${contextIndex} in browser ${browserIndex}: ${error.message}`);
    return false;
  }
}

// NEW FUNCTION: Create a single tab
async function createTab(browserIndex, contextIndex, tabIndex, contextData, browsers) {
  try {
    await log(`Creating tab ${tabIndex} in context ${contextIndex} of browser ${browserIndex}...`);
    
    let page = null;
    let attempt = 0;
    let maxAttempts = 5; // Try more times than before
    
    // CRITICAL FIX: Use a more resilient tab creation approach
    while (attempt < maxAttempts && !page) {
      attempt++;
      try {
        // IMPORTANT: Check if context is still valid
        if (!contextData || !contextData.context) {
          throw new Error("Context is no longer valid");
        }
        
        // Create a new tab with timeout safety
        page = await Promise.race([
          contextData.context.newPage(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Tab creation timeout")), 30000))
        ]);
        
        // Verify page is responsive
        await page.evaluate(() => true);
        
      } catch (err) {
        await log(`Tab creation attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
        
        if (page) {
          try { await page.close(); } catch (e) { /* ignore */ }
          page = null;
        }
        
        // On failure, wait longer between attempts
        await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
        
        // If it's a Target closed error, we need to wait longer
        if (err.message.includes("Target closed")) {
          await log("Target closed error detected, waiting longer before retry...");
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }
    }
    
    if (!page) {
      await log(`Failed to create tab ${tabIndex} after ${maxAttempts} attempts`);
      return false;
    }
    
    // Create tab data
    const tabData = {
      id: tabIndex,
      page,
      url: STREAM_URL,
      status: 'initializing',
      lastScreenshot: null
    };
    
    // Add to context
    contextData.tabs.push(tabData);
    
    // Configure tab
    try {
      // CRITICAL FIX: Simplify the tab setup process to reduce chances of failure
      await page.setUserAgent(contextData.fingerprint.userAgent);
      
      // Set up request interception (simplified)
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url().toLowerCase();
        const resourceType = request.resourceType();
        
        // Block only the most resource-intensive content
        if ((resourceType === 'image' || resourceType === 'font') && 
            !url.includes('video') && !url.includes('player')) {
          request.abort();
        } else {
          request.continue();
        }
      });
      
      // Navigate to stream
      tabData.status = 'navigating';
      await log(`Tab ${tabIndex} navigating to ${STREAM_URL}...`);
      
      // Navigate with timeout
      await page.goto(STREAM_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      
      tabData.status = 'loaded';
      await log(`Tab ${tabIndex} loaded ${STREAM_URL}`);
      
      // Simplify video initialization
      const playbackStarted = await page.evaluate(() => {
        try {
          const video = document.querySelector('video');
          if (!video) return false;
          
          // Basic setup
          video.muted = false;
          video.volume = 0.5;
          video.controls = true;
          video.autoplay = true;
          
          // Click the video to help start playback
          video.click();
          
          // Try to play
          video.play().catch(e => {
            console.warn("Play failed, trying muted", e);
            video.muted = true;
            video.play();
          });
          
          return true;
        } catch (e) {
          console.error("Video initialization failed:", e);
          return false;
        }
      });
      
      await log(`Video playback initialization for tab ${tabIndex}: ${playbackStarted ? "success" : "failed"}`);
      
      // Take screenshot
      try {
        const screenshotPath = `${browserIndex}_${contextIndex}_${tabIndex}_initial_${Date.now()}.jpg`;
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, screenshotPath),
          type: 'jpeg',
          quality: 70
        });
        
        tabData.lastScreenshot = screenshotPath;
        await log(`Screenshot saved to ${screenshotPath}`);
      } catch (ssErr) {
        await log(`Screenshot error: ${ssErr.message}`);
      }
      
      // Set up periodic check (less frequent to save resources)
      const checkInterval = setInterval(async () => {
        try {
          // Check if page is still connected
          const isConnected = await page.evaluate(() => document.readyState).catch(() => null);
          
          if (!isConnected) {
            await log(`Tab ${tabIndex} is no longer connected`);
            clearInterval(checkInterval);
            return;
          }
          
          // Simple keep-alive action
          await page.evaluate(() => {
            const video = document.querySelector('video');
            if (video && video.paused) {
              video.play().catch(() => {});
            }
          });
          
        } catch (error) {
          await log(`Error in periodic check for tab ${tabIndex}: ${error.message}`);
        }
      }, 120000); // Check every 2 minutes
      
      return true;
    } catch (error) {
      tabData.status = 'error';
      await log(`Error setting up tab ${tabIndex}: ${error.message}`);
      return false;
    }
  } catch (error) {
    await log(`Error creating tab ${tabIndex}: ${error.message}`);
    return false;
  }
}

// Run the box
runBox().catch(async error => {
  console.error(`Fatal error in box: ${error.message}`);
  process.exit(1);
});