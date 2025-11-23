/**
 * TALABAT TOKEN HARVESTER - COOKIE-BASED SESSION
 * 
 * This version uses SAVED COOKIES instead of manual login credentials.
 * 
 * TWO MODES:
 * 1. SETUP MODE: Run once to capture and save cookies from existing browser session
 * 2. AUTO MODE: Uses saved cookies for automatic token harvesting (runs hourly)
 * 
 * Architecture: Puppeteer + Google Sheets API + Cookie Persistence
 * Execution: GitHub Actions (Hourly Cron)
 * Cost: $0 (Free Tier)
 */

const puppeteer = require('puppeteer');
const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');

// ==================== CONFIGURATION ====================
const CONFIG = {
  portal: {
    url: 'https://portal.talabat.com/ae/',
    tokenEndpoint: 'https://portal.talabat.com/v5/token'
  },
  sheet: {
    id: process.env.SHEET_ID,
    range: 'Sheet1!A1:B1' // A1 for token, B1 for timestamp
  },
  cookies: {
    filePath: './session-cookies.json'
  },
  retry: {
    maxAttempts: 3,
    delayMs: 2000
  },
  timeouts: {
    navigation: 60000,
    networkIdle: 10000,
    tokenWait: 15000
  }
};

// Determine if we're in setup mode (for one-time cookie capture)
const SETUP_MODE = process.env.SETUP_MODE === 'true';

// ==================== UTILITY FUNCTIONS ====================

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

// ==================== COOKIE MANAGEMENT ====================

/**
 * Save cookies to file
 */
async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    const cookieJson = JSON.stringify(cookies, null, 2);
    await fs.writeFile(CONFIG.cookies.filePath, cookieJson);
    console.log(`[Cookies] Saved ${cookies.length} cookies to ${CONFIG.cookies.filePath}`);
    return true;
  } catch (error) {
    console.error('[Cookies] Failed to save:', error.message);
    return false;
  }
}

/**
 * Load cookies from file
 */
async function loadCookies(page) {
  try {
    // Check if cookie file exists
    try {
      await fs.access(CONFIG.cookies.filePath);
    } catch {
      console.warn('[Cookies] Cookie file not found, will need fresh login');
      return false;
    }
    
    const cookieJson = await fs.readFile(CONFIG.cookies.filePath, 'utf8');
    const cookies = JSON.parse(cookieJson);
    
    if (!cookies || cookies.length === 0) {
      console.warn('[Cookies] No cookies found in file');
      return false;
    }
    
    // Filter out expired cookies
    const now = Date.now() / 1000;
    const validCookies = cookies.filter(cookie => {
      if (cookie.expires && cookie.expires < now) {
        console.log(`[Cookies] Skipping expired cookie: ${cookie.name}`);
        return false;
      }
      return true;
    });
    
    if (validCookies.length === 0) {
      console.warn('[Cookies] All cookies are expired');
      return false;
    }
    
    await page.setCookie(...validCookies);
    console.log(`[Cookies] Loaded ${validCookies.length} valid cookies`);
    return true;
    
  } catch (error) {
    console.error('[Cookies] Failed to load:', error.message);
    return false;
  }
}

/**
 * Check if cookies are still valid by testing navigation
 */
async function verifyCookiesValid(page) {
  try {
    await page.goto(CONFIG.portal.url, {
      waitUntil: 'networkidle2',
      timeout: CONFIG.timeouts.navigation
    });
    
    await sleep(2000);
    
    // Check if we're on a login page or already logged in
    const isLoggedIn = await page.evaluate(() => {
      // Check for common logged-in indicators
      const hasLogoutButton = document.querySelector('[data-testid*="logout"], [class*="logout"], button[aria-label*="logout"], a[href*="logout"]');
      const hasUserMenu = document.querySelector('[data-testid*="user"], [class*="user-menu"], [class*="profile"]');
      const isLoginPage = document.querySelector('input[type="password"]');
      
      return !!(hasLogoutButton || hasUserMenu) && !isLoginPage;
    });
    
    console.log('[Cookies] Verification result - logged in:', isLoggedIn);
    return isLoggedIn;
    
  } catch (error) {
    console.error('[Cookies] Verification failed:', error.message);
    return false;
  }
}

// ==================== PUPPETEER AUTOMATION ====================

/**
 * Initialize browser with optimal settings
 */
async function initBrowser() {
  console.log('[Browser] Launching Puppeteer...');
  
  const browser = await puppeteer.launch({
    headless: SETUP_MODE ? false : 'new', // Show browser in setup mode
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
 * SETUP MODE: Manual login to capture cookies
 */
async function setupCookies(browser) {
  console.log('\n========================================');
  console.log('SETUP MODE: MANUAL LOGIN REQUIRED');
  console.log('========================================');
  console.log('1. Browser will open automatically');
  console.log('2. Please LOG IN manually to the portal');
  console.log('3. Wait for 10 seconds after successful login');
  console.log('4. Cookies will be saved automatically');
  console.log('========================================\n');
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  try {
    // Navigate to portal
    console.log('[Setup] Opening portal...');
    await page.goto(CONFIG.portal.url, {
      waitUntil: 'networkidle2',
      timeout: CONFIG.timeouts.navigation
    });
    
    console.log('[Setup] Portal loaded');
    console.log('[Setup] Please log in manually now...');
    console.log('[Setup] Waiting for 60 seconds for you to complete login...');
    
    // Wait for user to login manually
    await sleep(60000);
    
    // Check if logged in
    const isLoggedIn = await page.evaluate(() => {
      const hasLogoutButton = document.querySelector('[data-testid*="logout"], [class*="logout"], button[aria-label*="logout"], a[href*="logout"]');
      const hasUserMenu = document.querySelector('[data-testid*="user"], [class*="user-menu"], [class*="profile"]');
      return !!(hasLogoutButton || hasUserMenu);
    });
    
    if (!isLoggedIn) {
      throw new Error('Login not detected. Please ensure you logged in successfully.');
    }
    
    console.log('[Setup] ✅ Login detected!');
    
    // Save cookies
    await saveCookies(page);
    
    console.log('\n========================================');
    console.log('✅ SETUP COMPLETE!');
    console.log('Cookies saved successfully');
    console.log('You can now run in AUTO mode');
    console.log('========================================\n');
    
  } finally {
    await page.close();
  }
}

/**
 * Main token capture logic with cookie-based session
 */
async function captureTokenWithCookies(browser) {
  const page = await browser.newPage();
  
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  let capturedToken = null;
  
  // Setup network interception
  console.log('[Network] Setting up response listener...');
  page.on('response', async (response) => {
    const url = response.url();
    
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
          }
        }
      } catch (error) {
        console.error('[Network] Failed to parse token response:', error.message);
      }
    }
  });
  
  try {
    // Step 1: Load saved cookies
    console.log('[Session] Loading saved cookies...');
    const cookiesLoaded = await loadCookies(page);
    
    if (!cookiesLoaded) {
      throw new Error('Failed to load cookies. Please run SETUP MODE first.');
    }
    
    // Step 2: Navigate to portal
    console.log('[Portal] Navigating to:', CONFIG.portal.url);
    await page.goto(CONFIG.portal.url, {
      waitUntil: 'networkidle2',
      timeout: CONFIG.timeouts.navigation
    });
    
    console.log('[Portal] Page loaded, current URL:', page.url());
    await sleep(3000);
    
    // Step 3: Verify we're logged in
    const isLoggedIn = await verifyCookiesValid(page);
    
    if (!isLoggedIn) {
      console.warn('[Session] Cookies appear invalid, attempting logout-login cycle...');
      
      // Try to find and click logout
      const logoutClicked = await page.evaluate(() => {
        const selectors = [
          '[data-testid*="logout"]',
          '[class*="logout"]',
          'button[aria-label*="logout"]',
          'a[href*="logout"]'
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
      
      if (logoutClicked) {
        console.log('[Session] Logout triggered, waiting...');
        await sleep(5000);
        
        // Cookies expired - need to re-run setup
        throw new Error('Session expired. Please run SETUP MODE again to refresh cookies.');
      }
    }
    
    // Step 4: Trigger logout-login to generate fresh token
    console.log('[Auth] Performing logout-login cycle to refresh token...');
    
    // Click logout
    const logoutSuccess = await page.evaluate(() => {
      const selectors = [
        '[data-testid*="logout"]',
        '[class*="logout"]',
        'button[aria-label*="logout"]',
        'a[href*="logout"]'
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
      console.log('[Auth] Logout clicked, waiting for page...');
      await sleep(5000);
      
      // Now the browser should show login form with saved credentials
      // Click on login form fields to trigger auto-fill
      console.log('[Auth] Triggering auto-fill...');
      
      try {
        // Click email field to trigger autofill
        await page.waitForSelector('input[type="email"], input[name*="email"], input[id*="email"]', {
          timeout: 10000
        });
        
        await page.click('input[type="email"], input[name*="email"], input[id*="email"]');
        await sleep(1000);
        
        // Browser should auto-fill credentials now
        console.log('[Auth] Credentials should be auto-filled by browser');
        
        // Submit the form
        await Promise.all([
          page.click('button[type="submit"], button[class*="submit"], button[class*="login"]'),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.timeouts.navigation })
        ]);
        
        console.log('[Auth] ✅ Login submitted');
        
      } catch (error) {
        console.error('[Auth] Auto-fill login failed:', error.message);
        throw new Error('Auto-fill login failed. Browser may not have saved credentials.');
      }
    }
    
    // Step 5: Wait for token to be captured
    console.log('[Network] Waiting for token...');
    
    for (let i = 0; i < 30; i++) {
      if (capturedToken) break;
      await sleep(500);
    }
    
    if (!capturedToken) {
      throw new Error('Token was not captured from network traffic');
    }
    
    // Step 6: Update cookies for next run
    console.log('[Session] Updating saved cookies...');
    await saveCookies(page);
    
    // Validate token
    validateToken(capturedToken);
    
    return capturedToken;
    
  } finally {
    await page.close();
  }
}

// ==================== GOOGLE SHEETS INTEGRATION ====================

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
  console.log('TALABAT TOKEN HARVESTER');
  console.log('Mode:', SETUP_MODE ? 'SETUP (Manual Login)' : 'AUTO (Cookie-based)');
  console.log('Timestamp:', new Date().toISOString());
  console.log('========================================\n');
  
  let browser;
  
  try {
    // Initialize browser
    browser = await retryOperation(() => initBrowser(), 'Browser Init');
    
    if (SETUP_MODE) {
      // Setup mode: Manual login to capture cookies
      await setupCookies(browser);
      
    } else {
      // Auto mode: Use saved cookies
      
      // Validate environment variables
      if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
        throw new Error('Missing GOOGLE_SERVICE_ACCOUNT environment variable');
      }
      
      if (!CONFIG.sheet.id) {
        throw new Error('Missing SHEET_ID environment variable');
      }
      
      // Capture token with retry logic
      const token = await retryOperation(
        () => captureTokenWithCookies(browser),
        'Token Capture'
      );
      
      console.log('\n[Success] Token harvested successfully!');
      console.log('[Success] Token length:', token.length, 'characters');
      
      // Update Google Sheet
      await retryOperation(
        () => updateSheet(token),
        'Sheet Update'
      );
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log('\n========================================');
      console.log('✅ EXECUTION COMPLETED SUCCESSFULLY');
      console.log('Duration:', duration, 'seconds');
      console.log('========================================');
    }
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n========================================');
    console.error('❌ EXECUTION FAILED');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('========================================');
    
    if (error.message.includes('cookies') || error.message.includes('Session expired')) {
      console.error('\n💡 SOLUTION: Run in SETUP MODE to refresh cookies');
      console.error('Set environment variable: SETUP_MODE=true');
    }
    
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
