const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { exec, execSync } = require('child_process');
const express = require('express');
const app = express();
const port = 3000;

// Add stealth plugin for better detection avoidance
puppeteer.use(StealthPlugin());

// Configuration from environment variables
const BOX_NAME = process.env.BOX_NAME || 'box-1';
const NUM_BROWSERS = parseInt(process.env.NUM_BROWSERS || '1');
const CONTEXTS_PER_BROWSER = parseInt(process.env.CONTEXTS_PER_BROWSER || '2');
const TABS_PER_CONTEXT = parseInt(process.env.TABS_PER_CONTEXT || '1');
const STREAM_URL = process.env.STREAM_URL || 'https://kick.com/abdelbare0';
const VPN_CONFIG = process.env.VPN_CONFIG || '';
const FINGERPRINT_SERVICE = process.env.FINGERPRINT_SERVICE || 'http://10.108.176.229:3001';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/screenshots';
const LOG_DIR = process.env.LOG_DIR || '/logs';

// Array to store pre-fetched fingerprints
const prefetchedFingerprints = [];

// Browser and context tracking
const activeBrowsers = [];

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

// Enhanced logging function
async function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  
  // Console output with color coding
  switch(level.toLowerCase()) {
    case 'error':
      console.error(`\x1b[31m${message}\x1b[0m`); // Red
      break;
    case 'warn':
      console.warn(`\x1b[33m${message}\x1b[0m`); // Yellow
      break;
    case 'success':
      console.log(`\x1b[32m${message}\x1b[0m`); // Green
      break;
    default:
      console.log(message);
  }
  
  try {
    await fs.appendFile(path.join(LOG_DIR, `${BOX_NAME}.log`), logMessage);
  } catch (error) {
    console.error(`Error writing to log: ${error.message}`);
  }
}

// Get fingerprint from service with enhanced reliability
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
            timeout: 15000, // Longer timeout
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
          await log(`Failed attempt ${attempt} to get fingerprint from ${url}: ${err.message}`, 'warn');
          
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
    await log(`CRITICAL ERROR: Cannot continue without fingerprint service: ${error.message}`, 'error');
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
    
    await log(`Successfully pre-fetched all ${prefetchedFingerprints.length} fingerprints!`, 'success');
    return true;
  } catch (error) {
    await log(`Failed to pre-fetch fingerprints: ${error.message}`, 'error');
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

// Connect to VPN if configured with improved error handling
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
      await log(`VPN config file not found: ${vpnPath}`, 'error');
      return false;
    }
    
    // Check if OpenVPN is already running
    try {
      const output = execSync('pgrep openvpn').toString();
      if (output) {
        await log('OpenVPN is already running, killing existing process...');
        execSync('pkill openvpn');
        // Wait for the process to terminate
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (err) {
      // No OpenVPN process running, which is good
    }
    
    // Start OpenVPN in the background
    exec(`openvpn --config ${vpnPath} --daemon --log /tmp/vpn.log`);
    
    // Wait for VPN connection
    await log('Waiting for VPN connection...');
    
    // Simple wait loop checking if tun0 interface appears
    let connected = false;
    for (let i = 0; i < 30; i++) {
      try {
        const output = execSync('ip addr show tun0').toString();
        if (output.includes('inet ')) {
          const ipMatch = output.match(/inet ([0-9.]+)/);
          if (ipMatch && ipMatch[1]) {
            const vpnIp = ipMatch[1];
            await log(`VPN tunnel interface connected with IP: ${vpnIp}`, 'success');
            connected = true;
            
            // Now get the actual external IP to verify VPN is working
            try {
              const externalResponse = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
              const externalIp = externalResponse.data.ip;
              await log(`VPN external IP: ${externalIp}`, 'success');
              
              // Get country information for the external IP
              try {
                const geoResponse = await axios.get(`https://ipapi.co/${externalIp}/json/`);
                const country = geoResponse.data.country_name || 'Unknown';
                const countryCode = geoResponse.data.country_code || 'Unknown';
                await log(`VPN location: ${country} (${countryCode})`, 'success');
              } catch (geoError) {
                await log(`Couldn't determine VPN country: ${geoError.message}`, 'warn');
              }
              
              break;
            } catch (externalIpError) {
              await log(`Failed to get external IP: ${externalIpError.message}`, 'warn');
              // Continue anyway as tunnel is established
              break;
            }
          }
        }
      } catch (error) {
        // Interface not found yet
        await log(`Waiting for VPN tunnel (${i+1}/30)...`);
      }
      
      // Wait a second before checking again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (!connected) {
      await log('VPN connection failed: timeout', 'error');
      return false;
    }
    
    return true;
  } catch (error) {
    await log(`Error connecting to VPN: ${error.message}`, 'error');
    return false;
  }
}

// Optimized browser launch options for stability and memory usage
function getBrowserOptions() {
  return {
    headless: "new",
    executablePath: '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-extensions',
      
      // Memory optimization - increased from 256MB to 512MB per instance
      '--js-flags="--max-old-space-size=512"',
      '--disable-translate',
      '--disable-background-networking',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      
      // Critical for video streaming
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      
      // Mobile emulation
      '--touch-events=enabled',
      
      // Security settings needed for Kick.com
      '--allow-running-insecure-content',
      '--disable-web-security',
      
      // Process model - further limit resource usage
      '--renderer-process-limit=1',
      '--disable-features=site-per-process',
      
      // Additional performance optimizations
      '--disable-sync',
      '--enable-low-end-device-mode',
      '--disable-prompt-on-repost',
      
      // Additional memory optimizations
      '--memory-pressure-off',
      '--disable-hang-monitor',
      '--disable-breakpad',
      '--disable-logging',
      '--no-first-run',
      '--disable-client-side-phishing-detection'
    ],
    ignoreHTTPSErrors: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    protocolTimeout: 180000, // 3 minutes
    timeout: 180000, // 3 minutes
    defaultViewport: {
      width: 375,
      height: 667, // Reduced height to save memory
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    }
  };
}

// Set up API server with enhanced UI
function setupServer(browsers) {
  // Serve screenshots
  app.use('/screenshots', express.static(SCREENSHOT_DIR));
  app.use('/logs', express.static(LOG_DIR));
  
  // Homepage with improved status display
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
          lastScreenshot: tab.lastScreenshot || null,
          isVideoPlaying: tab.isVideoPlaying || false,
          videoInfo: tab.videoInfo || {}
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
          <title>${BOX_NAME} - Kick Stream Viewer</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f8f9fa; }
            h1, h2, h3 { color: #333; }
            .header { background: #343a40; color: white; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
            .status { margin-bottom: 30px; background: white; padding: 15px; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
            .browser { margin-bottom: 20px; border: 1px solid #ddd; padding: 15px; border-radius: 5px; background: white; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
            .context { margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 5px; border: 1px solid #eee; }
            .tab { margin: 5px 0; padding: 10px; background: white; border: 1px solid #eee; border-radius: 5px; }
            .tab.error { border-left: 4px solid #dc3545; }
            .tab.success { border-left: 4px solid #28a745; }
            .tab.warning { border-left: 4px solid #ffc107; }
            .screenshots { display: flex; flex-wrap: wrap; gap: 15px; }
            .screenshot { width: 300px; background: white; padding: 10px; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
            .screenshot img { max-width: 100%; border: 1px solid #ddd; border-radius: 3px; }
            .refresh { margin: 20px 0; padding: 10px; background: white; border-radius: 5px; text-align: center; }
            .badge { display: inline-block; padding: 3px 8px; border-radius: 10px; font-size: 12px; font-weight: bold; }
            .badge-success { background: #d4edda; color: #155724; }
            .badge-warning { background: #fff3cd; color: #856404; }
            .badge-danger { background: #f8d7da; color: #721c24; }
            .badge-info { background: #d1ecf1; color: #0c5460; }
            .stream-info { margin-top: 5px; font-size: 13px; color: #666; }
            .video-status { margin-top: 8px; }
          </style>
          <meta http-equiv="refresh" content="30">
        </head>
        <body>
          <div class="header">
            <h1>Kick Stream Viewer: ${BOX_NAME}</h1>
            <p>Stream URL: ${STREAM_URL} | VPN: ${VPN_CONFIG || 'None'}</p>
          </div>
          
          <div class="status">
            <h2>System Status</h2>
            <p>Configuration: ${NUM_BROWSERS} browsers with ${CONTEXTS_PER_BROWSER} contexts per browser and ${TABS_PER_CONTEXT} tabs per context</p>
          </div>
          
          <h2>Browsers</h2>
          ${browserStatus.map(browser => `
            <div class="browser">
              <h3>Browser ${browser.id} <span class="badge badge-info">Fingerprint: ${browser.fingerprintId}</span></h3>
              ${browser.contexts.map(context => `
                <div class="context">
                  <h4>Context ${context.id} <span class="badge badge-info">Fingerprint: ${context.fingerprintId}</span></h4>
                  ${context.tabs.map(tab => `
                    <div class="tab ${tab.status === 'error' ? 'error' : tab.isVideoPlaying ? 'success' : 'warning'}">
                      <div>
                        <strong>Tab ${tab.id}</strong> 
                        <span class="badge ${tab.status === 'error' ? 'badge-danger' : tab.status === 'running' ? 'badge-success' : 'badge-warning'}">${tab.status}</span>
                      </div>
                      <div class="stream-info">URL: ${tab.url}</div>
                      <div class="video-status">
                        <span class="badge ${tab.isVideoPlaying ? 'badge-success' : 'badge-warning'}">
                          Video: ${tab.isVideoPlaying ? 'Playing' : 'Not playing'}
                        </span>
                        ${tab.videoInfo.quality ? `<span class="badge badge-info">Quality: ${tab.videoInfo.quality}</span>` : ''}
                      </div>
                      ${tab.lastScreenshot ? `
                        <div style="margin-top: 10px;">
                          <a href="/screenshots/${tab.lastScreenshot}" target="_blank">
                            <img src="/screenshots/${tab.lastScreenshot}" alt="Screenshot" style="max-width: 150px; max-height: 100px;"/>
                          </a>
                        </div>
                      ` : ''}
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
  
  // API endpoints for external monitoring
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
          lastScreenshot: tab.lastScreenshot || null,
          isVideoPlaying: tab.isVideoPlaying || false
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
  
  // API endpoint for screenshots
  app.get('/api/screenshots', async (req, res) => {
    try {
      const files = await fs.readdir(SCREENSHOT_DIR);
      const screenshots = files
        .filter(file => file.endsWith('.png') || file.endsWith('.jpg'))
        .map(file => ({
          name: file,
          path: `/screenshots/${file}`,
          url: `${req.protocol}://${req.get('host')}/screenshots/${file}`
        }))
        .sort((a, b) => {
          const timeA = a.name.split('_').pop().replace('.png', '').replace('.jpg', '');
          const timeB = b.name.split('_').pop().replace('.png', '').replace('.jpg', '');
          return timeB.localeCompare(timeA);
        });
      
      res.json({ screenshots });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Health check endpoint
  app.get('/healthz', (req, res) => {
    res.send('OK');
  });
  
  // Start the server
  app.listen(port, '0.0.0.0', () => {
    log(`Box viewer server listening on port ${port}`, 'success');
  });
}

// Check if the stream is playing successfully
async function checkStreamStatus(page) {
  try {
    return await page.evaluate(() => {
      // Enhanced detection of video playback
      const video = document.querySelector('video');
      if (!video) return { isLive: false, error: 'No video element found' };
      
      // Check for Kick.com specific live indicators
      const hasLiveIndicator = !!document.querySelector('[class*="live"], [class*="status-live"], [data-status="live"], .stream-status-live, .live-indicator');
      
      // Check if video is actually playing
      const videoActive = video && !video.paused && video.readyState > 2 && !video.ended;
      
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
      
      // Quality detection disabled
      let quality = 'default';
      
      // Evaluate stream status
      const isLive = (hasLiveIndicator || videoActive) && !hasOfflineMessage;
      
      return {
        isLive,
        title,
        streamer,
        viewers,
        videoActive,
        hasLiveIndicator,
        hasOfflineMessage,
        quality,
        videoInfo: {
          duration: video ? video.duration : 0,
          currentTime: video ? video.currentTime : 0,
          paused: video ? video.paused : true,
          muted: video ? video.muted : true,
          volume: video ? video.volume : 0,
          readyState: video ? video.readyState : 0
        }
      };
    });
  } catch (error) {
    return { isLive: false, error: error.message };
  }
}

// Force lowest quality (160p) with improved selection
async function forceLowestQuality(page) {
  try {
    const result = await page.evaluate(() => {
      return new Promise(resolve => {
        try {
          console.log('Attempting to set lowest video quality...');
          
          // Find and click the quality selector button
          const findAndClickQualityButton = () => {
            // Kick.com quality selectors
            const selectors = [
              '.quality-selector-button', 
              '.vjs-quality-selector button', 
              '.vjs-resolution-button button',
              '.video-player-controls [aria-label*="quality"]',
              '.video-js [aria-label*="quality"]',
              '.vjs-menu-button-popup button'
            ];
            
            for (const selector of selectors) {
              const qualityButton = document.querySelector(selector);
              if (qualityButton) {
                console.log(`Found quality button with selector: ${selector}`);
                qualityButton.click();
                return true;
              }
            }
            
            console.log('No quality button found with standard selectors');
            
            // Try finding buttons by content
            const buttons = document.querySelectorAll('button');
            for (const button of buttons) {
              const text = button.textContent.trim().toLowerCase();
              if (text.includes('quality') || text.includes('resolution') || text.includes('p')) {
                console.log('Found quality button by text content');
                button.click();
                return true;
              }
            }
            
            return false;
          };
          
          // Find and click lowest quality option
          const findAndClickLowestQuality = () => {
            // Wait a bit for menu to appear
            setTimeout(() => {
              try {
                console.log('Looking for quality options...');
                // Kick.com quality menu item selectors
                const menuSelectors = [
                  '.quality-selector-menu .quality-selector-option',
                  '.vjs-menu-item',
                  '.vjs-resolution-option',
                  '[role="menuitem"]',
                  '.video-player-controls .quality-menu-item',
                  '.video-quality-option'
                ];
                
                let qualityOptions = null;
                
                // Try each selector until we find quality options
                for (const selector of menuSelectors) {
                  const options = document.querySelectorAll(selector);
                  if (options && options.length > 0) {
                    console.log(`Found ${options.length} quality options with selector: ${selector}`);
                    qualityOptions = options;
                    break;
                  }
                }
                
                if (!qualityOptions || qualityOptions.length === 0) {
                  console.log('No quality options found');
                  resolve({ success: false, error: 'No quality options found' });
                  return;
                }
                
                // Convert to array for easier manipulation
                const optionsArray = Array.from(qualityOptions);
                
                // First try to find 160p specifically
                let targetOption = optionsArray.find(option => {
                  const text = option.textContent.trim().toLowerCase();
                  return text.includes('160p') || text.includes('lowest');
                });
                
                // If 160p not found, sort by resolution and pick lowest
                if (!targetOption) {
                  // Extract resolution value from text
                  const getResValue = (text) => {
                    const match = text.match(/(\d+)p/);
                    return match ? parseInt(match[1], 10) : 9999;
                  };
                  
                  // Sort by resolution (lowest first)
                  optionsArray.sort((a, b) => {
                    return getResValue(a.textContent) - getResValue(b.textContent);
                  });
                  
                  // Get the lowest resolution option
                  targetOption = optionsArray[0];
                }
                
                if (targetOption) {
                  const qualityText = targetOption.textContent.trim();
                  console.log(`Selecting quality: ${qualityText}`);
                  targetOption.click();
                  
                  // Verify the selection worked
                  setTimeout(() => {
                    // Click on the page body to close any open menus
                    document.body.click();
                    
                    resolve({ 
                      success: true, 
                      quality: qualityText,
                      message: `Set quality to ${qualityText}`
                    });
                  }, 500);
                } else {
                  console.log('Could not determine which quality option to select');
                  resolve({ success: false, error: 'Could not determine which quality option to select' });
                }
              } catch (e) {
                console.error('Error selecting quality:', e);
                resolve({ success: false, error: e.message });
              }
            }, 1000); // Wait 1 second for menu to appear
          };
          
          // Execute the quality selection
          if (findAndClickQualityButton()) {
            findAndClickLowestQuality();
          } else {
            resolve({ success: false, error: 'Quality button not found' });
          }
        } catch (e) {
          console.error('Error in quality selection:', e);
          resolve({ success: false, error: e.message });
        }
      });
    });
    
    return result;
  } catch (error) {
    console.error(`Error forcing lowest quality: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Enhanced function to restart video playback with multiple methods
async function restartVideoPlayback(page) {
  try {
    return await page.evaluate(() => {
      return new Promise(resolve => {
        try {
          console.log('Attempting to restart video playback...');
          
          // Find video element
          const video = document.querySelector('video');
          if (!video) {
            console.error('No video element found');
            resolve({ success: false, error: 'No video element found' });
            return;
          }
          
          // Define touch event helper function for mobile emulation
          function createAndDispatchTouchEvent(element, eventType) {
            if (!element) return false;
            
            try {
              const touchObj = new Touch({
                identifier: Date.now(),
                target: element,
                clientX: element.getBoundingClientRect().width / 2,
                clientY: element.getBoundingClientRect().height / 2,
                radiusX: 2,
                radiusY: 2,
                rotationAngle: 0,
                force: 0.5
              });
              
              const touchEvent = new TouchEvent(eventType, {
                cancelable: true,
                bubbles: true,
                touches: [touchObj],
                targetTouches: [touchObj],
                changedTouches: [touchObj]
              });
              
              element.dispatchEvent(touchEvent);
              return true;
            } catch (err) {
              console.error('Error creating touch event:', err);
              return false;
            }
          }
          
          // Function to attempt video playback with multiple approaches
          const attemptPlayback = async () => {
            // Reset any error state
            if (video.error) {
              console.log('Video had error, attempting to reload');
              video.load();
            }
            
            // Ensure volume is set
            video.volume = 0.5;
            
            // Configure video element for optimal playback
            video.playsInline = true;
            video.controls = true;
            video.autoplay = true;
            
            // First attempt: Try clicking the video and play buttons
            console.log('Attempt 1: Clicking video and play buttons');
            
            // Click the video element itself
            video.focus();
            video.click();
            createAndDispatchTouchEvent(video, 'touchstart');
            setTimeout(() => createAndDispatchTouchEvent(video, 'touchend'), 100);
            
            // Look for and click any play buttons
            const playButtons = document.querySelectorAll('button[class*="play"], .vjs-play-button, [aria-label*="Play"]');
            if (playButtons.length > 0) {
              console.log(`Found ${playButtons.length} play buttons`);
              for (const button of playButtons) {
                button.click();
              }
            }
            
            // Second attempt: Try direct play() with muted fallback
            console.log('Attempt 2: Using play() method with muted fallback');
            const playPromise = video.play();
            
            if (playPromise !== undefined) {
              playPromise.then(() => {
                console.log('Video playback started successfully');
                checkPlaybackStatus();
              }).catch(e => {
                console.warn('Normal play failed, trying muted play:', e);
                
                // If autoplay was blocked, try with muted first
                video.muted = true;
                video.play().then(() => {
                  console.log('Muted playback started, will unmute shortly');
                  // Unmute after successful play
                  setTimeout(() => {
                    video.muted = false;
                    video.volume = 0.5;
                    console.log('Video unmuted');
                    checkPlaybackStatus();
                  }, 1000);
                }).catch(e => {
                  console.error('Failed to play even with muted:', e);
                  
                  // Third attempt: Try removing and recreating the video element
                  console.log('Attempt 3: Last resort - tweaking video element');
                  
                  // Final check
                  setTimeout(checkPlaybackStatus, 2000);
                });
              });
            } else {
              // Older browsers might not return a promise
              setTimeout(checkPlaybackStatus, 2000);
            }
          };
          
          // Function to check if playback actually started
          const checkPlaybackStatus = () => {
            // Check if video is now playing
            const isPlaying = !video.paused && !video.ended && video.readyState > 2;
            
            if (isPlaying) {
              console.log('Video is playing!');
              resolve({ 
                success: true, 
                message: 'Video playback started successfully',
                videoInfo: {
                  duration: video.duration,
                  currentTime: video.currentTime,
                  paused: video.paused,
                  muted: video.muted,
                  volume: video.volume,
                  readyState: video.readyState
                }
              });
            } else {
              console.warn('Video still not playing after all attempts');
              resolve({ 
                success: false, 
                error: 'Video still not playing after multiple attempts',
                videoInfo: {
                  duration: video.duration,
                  currentTime: video.currentTime,
                  paused: video.paused,
                  muted: video.muted,
                  volume: video.volume,
                  readyState: video.readyState
                }
              });
            }
          };
          
          // Start the playback attempts
          attemptPlayback();
          
        } catch (e) {
          console.error('Error in video playback restart:', e);
          resolve({ success: false, error: e.message });
        }
      });
    });
  } catch (error) {
    console.error(`Error restarting video playback: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Optimized request interception specifically for Kick.com
async function setupKickRequestInterception(page) {
  await page.setRequestInterception(true);
  
  // Create fast lookup sets for request filtering
  const criticalDomains = new Set([
    'kick.com', 
    'media.kick.com', 
    'video.kick.com', 
    'stream.kick.com',
    'akamaihd.net', 
    'cloudfront.net', 
    'fastly.net',
    'cdn.kick.com'
  ]);
  
  const criticalMediaTypes = new Set(['hls', 'm3u8', '.ts', 'video', 'media', 'stream']);
  
  const blockedDomains = new Set([
    'google-analytics', 'googletagmanager', 'doubleclick', 'facebook',
    'hotjar', 'amplitude', 'segment.io', 'mixpanel', 'fingerprint', 
    'clarity.ms', 'recaptcha', 'perimeterx', 'cloudflare-insights', 
    'omtrdc.net', 'evidon', 'stickyadstv', 'moatads', 'adroll', 
    'hcaptcha.com', 'quantserve', 'pendo.io', 'cdndex.io'
  ]);
  
  // Remove previous request listeners to prevent memory leaks
  page.removeAllListeners('request');
  
  // Add optimized request handler
  page.on('request', (request) => {
    const url = request.url().toLowerCase();
    const resourceType = request.resourceType();
    
    // Always allow these critical resource types
    if (['document', 'xhr', 'fetch', 'websocket'].includes(resourceType)) {
      request.continue();
      return;
    }
    
    // Block known tracking domains completely
    const domain = url.split('/')[2] || '';
    if ([...blockedDomains].some(blocked => domain.includes(blocked))) {
      request.abort();
      return;
    }
    
    // Always allow critical domains for video
    if (criticalDomains.has(domain) || [...criticalDomains].some(d => domain.includes(d))) {
      // For critical domains, only block images & fonts that aren't related to the player
      if ((resourceType === 'image' || resourceType === 'font') && 
          !url.includes('player') && !url.includes('video') && !url.includes('stream')) {
        request.abort();
      } else {
        request.continue();
      }
      return;
    }
    
    // Allow critical media content regardless of domain
    if ([...criticalMediaTypes].some(mediaType => url.includes(mediaType))) {
      request.continue();
      return;
    }
    
    // Block all images, fonts, and stylesheets from non-critical domains to save bandwidth
    if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
      request.abort();
      return;
    }
    
    // Allow everything else
    request.continue();
  });
}

// Enhanced browser and tab management
async function launchBrowsers() {
  // Launch browsers sequentially with memory management between each
  for (let b = 0; b < NUM_BROWSERS; b++) {
    await launchBrowser(b);
    
    // Since we can't use explicit GC, use alternative memory management approach
    await log(`Adding pause between browser launches to allow natural memory cleanup...`);
    await new Promise(resolve => setTimeout(resolve, 45000)); // 45 second pause
    
    // Log memory status
    try {
      const memoryUsage = process.memoryUsage();
      const memoryUsageMB = Math.round(memoryUsage.rss / 1024 / 1024);
      await log(`Current memory usage: ${memoryUsageMB}MB before launching next browser`);
    } catch (error) {
      await log(`Error checking memory: ${error.message}`, 'warn');
    }
  }
  
  await log(`All browsers, contexts, and tabs have been set up. Box ${BOX_NAME} is running.`, 'success');
}

// Launch a single browser with retries
async function launchBrowser(browserIndex) {
  try {
    await log(`Launching browser ${browserIndex}...`);
    
    // Log /dev/shm usage before launching a new browser
    try {
      const shmUsage = execSync('df -h /dev/shm').toString();
      await log(`/dev/shm usage before launching browser ${browserIndex}:\n${shmUsage}`);
    } catch (e) {
      await log(`Error checking /dev/shm usage: ${e.message}`, 'warn');
    }
    
    // Get fingerprint for browser
    const browserFingerprint = getNextFingerprint();
    
    // Launch browser with retries
    let browser = null;
    let browserOptions = getBrowserOptions();
    
    // CRITICAL FIX: Remove problematic arguments
    browserOptions.args = browserOptions.args.filter(arg => 
      arg !== '--single-process' && !arg.includes('--optimum-number-of-renderer-processes')
    );
    
    // Add critical memory-saving flags
    browserOptions.args.push('--disable-field-trial-config');
    browserOptions.args.push('--noerrdialogs');
    browserOptions.args.push('--disable-ipc-flooding-protection');
    browserOptions.args.push('--disable-notifications');
    
    // Add user agent from fingerprint
    if (browserFingerprint.userAgent) {
      browserOptions.userAgent = browserFingerprint.userAgent;
    }
    
    // Add delay between browser launches to prevent memory spikes
    if (browserIndex > 0) {
      await log(`Adding delay of 90 seconds before launching browser ${browserIndex} to allow system to stabilize...`);
      await new Promise(resolve => setTimeout(resolve, 90000)); // Increased to 90 seconds
    }
    
    // Always clean up before launching a new browser
    await cleanupMemory();
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        browser = await puppeteer.launch(browserOptions);
        break;
      } catch (err) {
        await log(`Browser launch attempt ${attempt} failed: ${err.message}`, 'error');
        if (attempt === 3) throw err;
        
        // Add delay between retries
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    if (!browser) {
      throw new Error(`Failed to launch browser ${browserIndex} after multiple attempts`);
    }
    
    // Create browser data structure
    const browserData = {
      id: browserIndex,
      browser,
      fingerprint: browserFingerprint,
      contexts: [],
      launchedAt: new Date()
    };
    
    // Add to active browsers
    activeBrowsers.push(browserData);
    
    await log(`Browser ${browserIndex} launched successfully with fingerprint ${browserFingerprint.id}`, 'success');
    
    // Reverted: Limit number of contexts based on browser index to reduce memory pressure
    // const maxContextsForBrowser = Math.max(1, CONTEXTS_PER_BROWSER - Math.floor(browserIndex / 2));
    const maxContextsForBrowser = CONTEXTS_PER_BROWSER; // Use configured value
    await log(`Will create ${maxContextsForBrowser} contexts for browser ${browserIndex}`);
    
    // Create contexts sequentially with added delays between each
    for (let c = 0; c < maxContextsForBrowser; c++) {
      await new Promise(resolve => setTimeout(resolve, 20000)); // Increased to 20s delay between contexts
      await createContext(browserIndex, c);
    }
    
    return true;
  } catch (error) {
    await log(`Error launching browser ${browserIndex}: ${error.message}`, 'error');
    return false;
  }
}

// Helper function to clean up memory
async function cleanupMemory() {
  await log('Attempting to clean up memory (explicit global.gc() is likely unavailable without --expose-gc). Relying on V8 heuristics and timed pauses.');
  
  try {
    // Log current memory state
    const memBefore = process.memoryUsage();
    const memBeforeMB = Math.round(memBefore.rss / 1024 / 1024);
    await log(`Memory before cleanup: ${memBeforeMB}MB`);
    
    await log('Simulating memory pressure to encourage garbage collection...');
    
    // Wait a short time for GC to potentially run
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check memory after cleanup
    const memAfter = process.memoryUsage();
    const memAfterMB = Math.round(memAfter.rss / 1024 / 1024);
    await log(`Memory after cleanup: ${memAfterMB}MB (${memBeforeMB - memAfterMB}MB freed)`);
  } catch (error) {
    await log(`Error during memory cleanup: ${error.message}`, 'warn');
  }
}

// Create a browser context with enhanced error handling
async function createContext(browserIndex, contextIndex) {
  try {
    const browserData = activeBrowsers.find(b => b.id === browserIndex);
    if (!browserData) {
      throw new Error(`Browser ${browserIndex} not found`);
    }
    
    await log(`Creating context ${contextIndex} in browser ${browserIndex}...`);
    
    // Get a new fingerprint for this context
    const contextFingerprint = getNextFingerprint();
    
    // Create incognito context
    let context = null;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        context = await browserData.browser.createIncognitoBrowserContext();
        break;
      } catch (err) {
        await log(`Context creation attempt ${attempt} failed: ${err.message}`, 'warn');
        if (attempt === 3) throw err;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    if (!context) {
      throw new Error(`Failed to create context ${contextIndex} after multiple attempts`);
    }
    
    // Create context data structure
    const contextData = {
      id: contextIndex,
      context,
      fingerprint: contextFingerprint,
      tabs: [],
      createdAt: new Date()
    };
    
    // Add to browser's contexts
    browserData.contexts.push(contextData);
    
    await log(`Context ${contextIndex} created successfully with fingerprint ${contextFingerprint.id}`, 'success');
    
    // Create tabs sequentially with delay between each
    // Reverted: Dynamically reduce tabs for later contexts to save memory
    // const tabsForThisContext = Math.max(1, TABS_PER_CONTEXT - contextIndex % 2);
    const tabsForThisContext = TABS_PER_CONTEXT; // Use configured value
    await log(`Will create ${tabsForThisContext} tabs for context ${contextIndex}`);
    
    for (let t = 0; t < tabsForThisContext; t++) {
      // Add delay between tab creation
      await new Promise(resolve => setTimeout(resolve, 10000)); // Increased to 10 seconds
      await createTab(browserIndex, contextIndex, t);
    }
    
    return true;
  } catch (error) {
    await log(`Error creating context ${contextIndex} in browser ${browserIndex}: ${error.message}`, 'error');
    return false;
  }
}

// Create a tab with robust error handling and retry logic
async function createTab(browserIndex, contextIndex, tabIndex) {
  try {
    await log(`Creating tab ${tabIndex} in context ${contextIndex} of browser ${browserIndex}...`);
    
    const browserData = activeBrowsers.find(b => b.id === browserIndex);
    if (!browserData) {
      throw new Error(`Browser ${browserIndex} not found`);
    }
    
    const contextData = browserData.contexts.find(c => c.id === contextIndex);
    if (!contextData) {
      throw new Error(`Context ${contextIndex} not found in browser ${browserIndex}`);
    }
    
    // Create tab with retry logic
    let page = null;
    let maxAttempts = 5;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Create new page with timeout safety
        page = await Promise.race([
          contextData.context.newPage(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Tab creation timed out")), 30000)
          )
        ]);
        
        // Verify page is responsive
        await page.evaluate(() => true);
        break;
      } catch (err) {
        await log(`Tab creation attempt ${attempt}/${maxAttempts} failed: ${err.message}`, 'warn');
        
        if (page) {
          try { 
            await page.close(); 
          } catch (e) { 
            // Ignore close errors
          }
          page = null;
        }
        
        if (attempt === maxAttempts) throw err;
        
        // Exponential backoff for retries
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    if (!page) {
      throw new Error(`Failed to create tab after ${maxAttempts} attempts`);
    }
    
    // Create tab data structure
    const tabData = {
      id: tabIndex,
      page,
      url: STREAM_URL,
      status: 'created',
      lastScreenshot: null,
      createdAt: new Date(),
      isVideoPlaying: false,
      videoInfo: {}
    };
    
    // Add to context's tabs
    contextData.tabs.push(tabData);
    
    // Configure page for optimal performance
    await page.setUserAgent(contextData.fingerprint.userAgent);
    await page.setDefaultNavigationTimeout(60000);
    
    // Set mobile viewport
    await page.setViewport({
      width: 375,
      height: 812,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    
    // Set up optimized request interception
    await setupKickRequestInterception(page);
    
    // Set up header/cookie monitoring for debugging
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache'
    });
    
    // Navigate to stream
    tabData.status = 'navigating';
    await log(`Tab ${tabIndex} navigating to ${STREAM_URL}...`);
    
    try {
      // Navigate with timeout and wait only for DOMContentLoaded for faster loading
      await page.goto(STREAM_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      
      tabData.status = 'loaded';
      await log(`Tab ${tabIndex} loaded ${STREAM_URL} successfully`);
      const memUsageAfterLoad = process.memoryUsage();
      await log(`Memory usage after tab ${tabIndex} load: ${Math.round(memUsageAfterLoad.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsageAfterLoad.heapUsed / 1024 / 1024)}MB Heap`);
      
      // Add a delay before initializing video playback
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Initialize video playback with our enhanced method
      const playbackResult = await restartVideoPlayback(page);
      
      if (playbackResult.success) {
        tabData.isVideoPlaying = true;
        tabData.videoInfo = playbackResult.videoInfo || {};
        tabData.status = 'playing';
        await log(`Video playback started for tab ${tabIndex}`);
        const memUsageAfterPlayback = process.memoryUsage();
        await log(`Memory usage after tab ${tabIndex} playback start: ${Math.round(memUsageAfterPlayback.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsageAfterPlayback.heapUsed / 1024 / 1024)}MB Heap`);
      } else {
        tabData.isVideoPlaying = false;
        tabData.videoInfo = playbackResult.videoInfo || {};
        tabData.status = 'playback-failed';
        await log(`Failed to start video playback for tab ${tabIndex}: ${playbackResult.error}`, 'warn');
      }
      
      // Quality changing has been disabled as requested
      await log(`Quality changing disabled for tab ${tabIndex}`, 'info');
      
      // Take screenshot after a delay
      setTimeout(async () => {
        try {
          const screenshotPath = `${browserIndex}_${contextIndex}_${tabIndex}_${Date.now()}.jpg`;
          await page.screenshot({
            path: path.join(SCREENSHOT_DIR, screenshotPath),
            type: 'jpeg',
            quality: 70,
            fullPage: false
          });
          
          tabData.lastScreenshot = screenshotPath;
          await log(`Screenshot taken for tab ${tabIndex}: ${screenshotPath}`, 'success');
        } catch (error) {
          await log(`Failed to take screenshot for tab ${tabIndex}: ${error.message}`, 'error');
        }
      }, 10000);
      
      // Set up periodic check to ensure video keeps playing
      const checkInterval = setInterval(async () => {
        try {
          // Check if page is still connected
          const isConnected = page.isClosed ? !page.isClosed() : true;
          
          if (!isConnected) {
            await log(`Tab ${tabIndex} is no longer connected, clearing interval`, 'warn');
            clearInterval(checkInterval);
            return;
          }
          
          // Check stream status
          const status = await checkStreamStatus(page);
          
          // Update tab data
          tabData.isVideoPlaying = status.videoActive || false;
          tabData.videoInfo = {
            ...tabData.videoInfo,
            ...status.videoInfo,
            quality: status.quality || tabData.videoInfo.quality
          };
          
          // If video is not playing, try to restart it
          if (!tabData.isVideoPlaying) {
            await log(`Video not playing for tab ${tabIndex}, attempting to restart...`, 'warn');
            const restartResult = await restartVideoPlayback(page);
            if (restartResult.success) {
              tabData.isVideoPlaying = true;
              tabData.status = 'playing';
              await log(`Successfully restarted video playback for tab ${tabIndex}`, 'success');
            }
          }
          
          // Take periodic screenshots (every ~10 minutes)
          if (Date.now() - (tabData.lastScreenshotTime || 0) > 600000) {
            try {
              const screenshotPath = `${browserIndex}_${contextIndex}_${tabIndex}_${Date.now()}.jpg`;
              await page.screenshot({
                path: path.join(SCREENSHOT_DIR, screenshotPath),
                type: 'jpeg',
                quality: 70,
                fullPage: false
              });
              
              tabData.lastScreenshot = screenshotPath;
              tabData.lastScreenshotTime = Date.now();
              await log(`Periodic screenshot taken for tab ${tabIndex}: ${screenshotPath}`);
            } catch (error) {
              await log(`Failed to take periodic screenshot for tab ${tabIndex}: ${error.message}`, 'warn');
            }
          }
        } catch (error) {
          await log(`Error in periodic check for tab ${tabIndex}: ${error.message}`, 'error');
        }
      }, 120000); // Check every 2 minutes
      
      return true;
    } catch (error) {
      tabData.status = 'error';
      await log(`Error navigating for tab ${tabIndex}: ${error.message}`, 'error');
      
      // Even if navigation fails, take a screenshot to see what happened
      try {
        const screenshotPath = `${browserIndex}_${contextIndex}_${tabIndex}_error_${Date.now()}.jpg`;
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, screenshotPath),
          type: 'jpeg',
          quality: 70,
          fullPage: false
        });
        
        tabData.lastScreenshot = screenshotPath;
        await log(`Error screenshot taken for tab ${tabIndex}: ${screenshotPath}`);
      } catch (ssError) {
        await log(`Failed to take error screenshot: ${ssError.message}`, 'error');
      }
      
      return false;
    }
  } catch (error) {
    await log(`Critical error creating tab ${tabIndex} in context ${contextIndex} of browser ${browserIndex}: ${error.message}`, 'error');
    return false;
  }
}

// Main function to run the system
async function runBox() {
  try {
    // Create directories
    await ensureDirectories();
    
    // Memory management approach (without expose-gc)
    try {
      await log(`Configuring memory management...`);
      // We'll use timeouts and browser staggering instead of explicit GC
    } catch (e) {
      await log(`Could not configure memory management: ${e.message}`, 'warn');
    }
    
    // Set up the API server
    setupServer(activeBrowsers);
    
    // Pre-fetch fingerprints
    await log(`Starting box ${BOX_NAME} with ${NUM_BROWSERS} browsers, ${CONTEXTS_PER_BROWSER} contexts per browser, ${TABS_PER_CONTEXT} tabs per context`);
    const fingerprintsSuccess = await prefetchFingerprints();
    
    if (!fingerprintsSuccess) {
      await log('Failed to pre-fetch required fingerprints. Cannot continue.', 'error');
      process.exit(1);
    }
    
    // Connect to VPN if configured
    if (VPN_CONFIG) {
      const vpnConnected = await connectToVpn();
      if (!vpnConnected) {
        await log('Failed to connect to VPN, continuing without VPN', 'warn');
      } else {
        // Wait for VPN connection to stabilize
        await log("VPN connected. Waiting for connection to stabilize before proceeding...");
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
    }
    
    // Launch browsers
    await launchBrowsers();
    
    // Set up process monitoring
    setInterval(async () => {
      try {
        // Count active tabs
        let totalTabs = 0;
        let playingTabs = 0;
        let errorTabs = 0;
        
        for (const browser of activeBrowsers) {
          for (const context of browser.contexts) {
            for (const tab of context.tabs) {
              totalTabs++;
              if (tab.isVideoPlaying) playingTabs++;
              if (tab.status === 'error') errorTabs++;
            }
          }
        }
        
        await log(`Status update: ${totalTabs} tabs total, ${playingTabs} playing, ${errorTabs} errors`);
        
        // Check for memory usage
        try {
          const memoryUsage = process.memoryUsage();
          const memoryUsageMB = Math.round(memoryUsage.rss / 1024 / 1024);
          await log(`Memory usage: ${memoryUsageMB}MB (${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB heap)`);
          
          // Alternative to GC for high memory usage
          if (memoryUsageMB > 12000) {
            await log(`Memory usage high (${memoryUsageMB}MB), attempting cleanup`, 'warn');
            // Suggest to the V8 engine that it's a good time to collect garbage
            // This is not as effective as explicit GC but can help
            const startMem = process.memoryUsage().heapUsed;
            global.performance?.gc?.(); // Use performance.gc() if available
            if (global.gc) {
              global.gc(); // Use global.gc if available (though we don't expect it)
            } else {
              // Create memory pressure to encourage GC
              const arr = [];
              for (let i = 0; i < 1000; i++) {
                arr.push(new Array(10000));
              }
              for (let i = 0; i < 1000; i++) {
                arr[i] = null;
              }
            }
            const endMem = process.memoryUsage().heapUsed;
            await log(`Memory cleanup attempt completed. Change: ${Math.round((startMem - endMem)/1024/1024)}MB`);
          }
        } catch (memError) {
          await log(`Error checking memory usage: ${memError.message}`, 'error');
        }
      } catch (error) {
        await log(`Error in status reporting: ${error.message}`, 'error');
      }
    }, 120000); // Every 2 minutes
    
    // Set up cleanup on exit
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    
    // Success message
    await log(`${BOX_NAME} is running successfully!`, 'success');
  } catch (error) {
    await log(`Critical error in runBox: ${error.message}`, 'error');
    process.exit(1);
  }
}

// Cleanup function for graceful shutdown
async function cleanup() {
  await log('Received shutdown signal, cleaning up...', 'warn');
  
  for (const browser of activeBrowsers) {
    try {
      if (browser.browser) {
        await browser.browser.close();
      }
    } catch (error) {
      await log(`Error closing browser ${browser.id}: ${error.message}`, 'error');
    }
  }
  
  if (VPN_CONFIG) {
    try {
      exec('pkill openvpn');
      await log('VPN connection terminated');
    } catch (error) {
      await log(`Error terminating VPN: ${error.message}`, 'error');
    }
  }
  
  await log('Cleanup complete, exiting');
  process.exit(0);
}

// Run the main function
runBox().catch(async error => {
  await log(`Fatal error: ${error.message}`, 'error');
  process.exit(1);
});