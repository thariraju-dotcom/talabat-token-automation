/**
 * TALABAT TOKEN HARVESTER - PRODUCTION GRADE
 * 
 * This script automates:
 * 1. Portal login/logout cycle
 * 2. Network traffic interception to capture JWT token
 * 3. Google Sheets synchronization
 * 
 * Architecture: Puppeteer + Google Sheets API
 * Execution: GitHub Actions (Hourly Cron)
 * Cost: $0 (Free Tier)
 */

const puppeteer = require('puppeteer');
const { google } = require('googleapis');

// ==================== CONFIGURATION ====================
const CONFIG = {
  portal: {
    url: 'https://portal.talabat.com/ae/',
    tokenEndpoint: 'https://portal.talabat.com/v5/token',
    email: process.env.PORTAL_EMAIL,
    password: process.env.PORTAL_PASSWORD
  },
  sheet: {
    id: process.env.SHEET_ID,
    range: 'Sheet1!A1:B1' // A1 for token, B1 for timestamp
  },
  retry: {
    maxAttempts: 3,
    delayMs: 2000
  },
  timeouts: {
    navigation: 60000,
    networkIdle: 10000
  }
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * Sleep utility for delays
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Retry wrapper with exponential backoff
 */
async function retryOperation(operation, context = 'Operation') {
  let lastError;
  
  for (let attempt = 1; attempt <= CONFIG.retry.maxAttempts; attempt++) {
    try {
      console.log(`[${context}] Attempt ${attempt}/${CONFIG.retry.maxAttempts}`);
      return await operation();
    } catch (error) {
      lastError = error;
      console.error(`[${context}] Attempt ${attempt} failed:`, error.message);
      
      if (attempt < CONFIG.retry.maxAttempts) {
        const delay = CONFIG.retry.delayMs * Math.pow(2, attempt - 1);
        console.log(`[${context}] Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  
  throw new Error(`${context} failed after ${CONFIG.retry.maxAttempts} attempts: ${lastError.message}`);
}

/**
 * Validate JWT token format
 */
function validateToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token is empty or not a string');
  }
  
  if (!token.startsWith('eyJ')) {
    throw new Error('Invalid JWT format (must start with "eyJ")');
  }
  
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT structure (must have 3 parts)');
  }
  
  return true;
}

// ==================== PUPPETEER AUTOMATION ====================

/**
 * Initialize browser with optimal settings
 */
async function initBrowser() {
  console.log('[Browser] Launching Puppeteer...');
  
  const browser = await puppeteer.launch({
    headless: 'new', // Use new headless mode
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
  });
  
  console.log('[Browser] Launched successfully');
  return browser;
}

/**
 * Main token capture logic
 */
async function captureToken(browser) {
  const page = await browser.newPage();
  
  // Set realistic viewport and user agent
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  let capturedToken = null;
  
  // Setup network interception BEFORE navigation
  console.log('[Network] Setting up response listener...');
  page.on('response', async (response) => {
    const url = response.url();
    
    // Check if this is the token endpoint
    if (url.includes('/v5/token')) {
      console.log('[Network] Token endpoint detected!');
      console.log('[Network] URL:', url);
      console.log('[Network] Status:', response.status());
      
      try {
        const contentType = response.headers()['content-type'];
        if (contentType && contentType.includes('application/json')) {
          const data = await response.json();
          
          if (data.access_token) {
            capturedToken = data.access_token;
            console.log('[Network] ✅ Token captured successfully');
            console.log('[Network] Token preview:', capturedToken.substring(0, 50) + '...');
          } else {
            console.warn('[Network] Response does not contain access_token:', JSON.stringify(data));
          }
        }
      } catch (error) {
        console.error('[Network] Failed to parse token response:', error.message);
      }
    }
  });
  
  try {
    // Step 1: Navigate to portal
    console.log('[Portal] Navigating to:', CONFIG.portal.url);
    await page.goto(CONFIG.portal.url, {
      waitUntil: 'networkidle2',
      timeout: CONFIG.timeouts.navigation
    });
    
    console.log('[Portal] Page loaded, current URL:', page.url());
    
    // Step 2: Wait for page to stabilize
    await sleep(3000);
    
    // Step 3: Check if already logged in
    const isLoggedIn = await page.evaluate(() => {
      // Check for common logged-in indicators
      const hasLogoutButton = document.querySelector('[data-testid*="logout"], [class*="logout"], button[aria-label*="logout"], a[href*="logout"]');
      const hasUserMenu = document.querySelector('[data-testid*="user"], [class*="user-menu"], [class*="profile"]');
      return !!(hasLogoutButton || hasUserMenu);
    });
    
    console.log('[Portal] Already logged in:', isLoggedIn);
    
    // Step 4: Perform logout if logged in
    if (isLoggedIn) {
      console.log('[Auth] Attempting logout...');
      
      // Try multiple logout strategies
      const logoutSuccess = await page.evaluate(() => {
        const selectors = [
          '[data-testid*="logout"]',
          '[class*="logout"]',
          'button[aria-label*="logout"]',
          'a[href*="logout"]',
          'button:has-text("Logout")',
          'button:has-text("Log out")',
          'a:has-text("Logout")',
          'a:has-text("Log out")'
        ];
        
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element) {
            element.click();
            return true;
          }
        }
        return false;
      });
      
      if (logoutSuccess) {
        console.log('[Auth] Logout clicked, waiting for redirect...');
        await sleep(3000);
      } else {
        console.warn('[Auth] Logout button not found, proceeding with login attempt');
      }
    }
    
    // Step 5: Perform login
    console.log('[Auth] Attempting login...');
    
    // Wait for login form
    await page.waitForSelector('input[type="email"], input[name*="email"], input[id*="email"]', {
      timeout: 30000
    });
    
    console.log('[Auth] Login form detected');
    
    // Fill credentials
    await page.type('input[type="email"], input[name*="email"], input[id*="email"]', CONFIG.portal.email, { delay: 100 });
    console.log('[Auth] Email entered');
    
    await page.type('input[type="password"], input[name*="password"], input[id*="password"]', CONFIG.portal.password, { delay: 100 });
    console.log('[Auth] Password entered');
    
    // Submit form
    await Promise.all([
      page.click('button[type="submit"], button[class*="submit"], button[class*="login"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.timeouts.navigation })
    ]);
    
    console.log('[Auth] ✅ Login successful');
    console.log('[Auth] Current URL:', page.url());
    
    // Step 6: Wait for token request (it should have been captured by now)
    console.log('[Network] Waiting for token to be captured...');
    
    // Wait up to 10 seconds for token to appear
    for (let i = 0; i < 20; i++) {
      if (capturedToken) break;
      await sleep(500);
    }
    
    if (!capturedToken) {
      throw new Error('Token was not captured from network traffic');
    }
    
    // Validate token
    validateToken(capturedToken);
    
    return capturedToken;
    
  } finally {
    await page.close();
  }
}

// ==================== GOOGLE SHEETS INTEGRATION ====================

/**
 * Authenticate with Google Sheets API
 */
function getGoogleAuth() {
  console.log('[Google] Authenticating with service account...');
  
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  
  const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  
  console.log('[Google] Authentication successful');
  return auth;
}

/**
 * Update Google Sheet with token
 */
async function updateSheet(token) {
  console.log('[Sheet] Updating Google Sheet...');
  
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  
  const timestamp = new Date().toISOString();
  const values = [[token, timestamp]];
  
  const response = await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.sheet.id,
    range: CONFIG.sheet.range,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  
  console.log('[Sheet] ✅ Update successful');
  console.log('[Sheet] Updated cells:', response.data.updatedCells);
  console.log('[Sheet] Token saved to A1');
  console.log('[Sheet] Timestamp saved to B1:', timestamp);
  
  return response.data;
}

// ==================== MAIN EXECUTION ====================

async function main() {
  const startTime = Date.now();
  console.log('========================================');
  console.log('TALABAT TOKEN HARVESTER - STARTING');
  console.log('Timestamp:', new Date().toISOString());
  console.log('========================================\n');
  
  let browser;
  
  try {
    // Validate environment variables
    if (!CONFIG.portal.email || !CONFIG.portal.password) {
      throw new Error('Missing PORTAL_EMAIL or PORTAL_PASSWORD environment variables');
    }
    
    if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
      throw new Error('Missing GOOGLE_SERVICE_ACCOUNT environment variable');
    }
    
    if (!CONFIG.sheet.id) {
      throw new Error('Missing SHEET_ID environment variable');
    }
    
    // Step 1: Initialize browser
    browser = await retryOperation(
      () => initBrowser(),
      'Browser Init'
    );
    
    // Step 2: Capture token with retry logic
    const token = await retryOperation(
      () => captureToken(browser),
      'Token Capture'
    );
    
    console.log('\n[Success] Token harvested successfully!');
    console.log('[Success] Token length:', token.length, 'characters');
    
    // Step 3: Update Google Sheet with retry logic
    await retryOperation(
      () => updateSheet(token),
      'Sheet Update'
    );
    
    // Calculate execution time
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n========================================');
    console.log('✅ EXECUTION COMPLETED SUCCESSFULLY');
    console.log('Duration:', duration, 'seconds');
    console.log('========================================');
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n========================================');
    console.error('❌ EXECUTION FAILED');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('========================================');
    
    process.exit(1);
    
  } finally {
    if (browser) {
      console.log('\n[Cleanup] Closing browser...');
      await browser.close();
      console.log('[Cleanup] Browser closed');
    }
  }
}

// Execute
main();
