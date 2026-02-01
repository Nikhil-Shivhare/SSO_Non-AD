/**
 * background.js - SSO Extension Background Script
 * 
 * SINGLE SOURCE OF TRUTH for all SSO decisions.
 * Handles Primary Identity API communication.
 * Never touches DOM.
 */

const PRIMARY_IDENTITY_BASE = 'http://localhost:4000';

// =============================================================================
// STATE (in-memory only, never persisted)
// =============================================================================

let state = {
  pluginToken: null,
  expiresAt: null,
  apps: [],  // [{ appId, origin, loginSchema }]
  currentUserId: null,
  currentUsername: null
};

// =============================================================================
// API FUNCTIONS
// =============================================================================

/**
 * Check if user is logged into Primary Identity
 * @returns {Promise<boolean>}
 */
async function checkSession() {
  try {
    const res = await fetch(`${PRIMARY_IDENTITY_BASE}/api/session/status`, {
      credentials: 'include'
    });
    return res.ok;
  } catch (e) {
    console.log('[SSO Background] Session check failed:', e.message);
    return false;
  }
}

/**
 * Bootstrap the extension - get plugin token and app list
 * @returns {Promise<boolean>}
 */
async function bootstrap() {
  try {
    const res = await fetch(`${PRIMARY_IDENTITY_BASE}/api/plugin/bootstrap`, {
      method: 'POST',
      credentials: 'include'
    });
    
    if (!res.ok) {
      console.log('[SSO Background] Bootstrap failed:', res.status);
      return false;
    }
    
    const data = await res.json();
    
    // USER SWITCH DETECTION: Check if the logged-in user has changed
    if (state.currentUserId !== null && state.currentUserId !== data.userId) {
      console.log('[SSO Background] User changed:', state.currentUsername, '->', data.username);
      console.log('[SSO Background] Clearing state to prevent credential leakage');
      
      // Clear all state when user changes
      state.pluginToken = null;
      state.expiresAt = null;
      state.apps = [];
      state.currentUserId = null;
      state.currentUsername = null;
      
      // Show notification about user change
      console.log('[SSO Background] Previous user logged out. Please reload legacy apps.');
    }
    
    // Update state with new user
    state.pluginToken = data.pluginToken;
    state.expiresAt = Date.now() + (data.expiresIn * 1000);
    state.apps = data.apps || [];
    state.currentUserId = data.userId;
    state.currentUsername = data.username;
    
    console.log('[SSO Background] Bootstrapped for', data.username, ':', state.apps.length, 'apps');
    return true;
  } catch (e) {
    console.log('[SSO Background] Bootstrap error:', e.message);
    return false;
  }
}

/**
 * Fetch credentials for an app
 * @param {string} appId
 * @returns {Promise<{username: string, password: string}|null>}
 */
async function fetchCredentials(appId) {
  if (!state.pluginToken) return null;
  
  try {
    const res = await fetch(
      `${PRIMARY_IDENTITY_BASE}/api/vault/credentials?appId=${appId}`,
      {
        headers: { 'Authorization': `Bearer ${state.pluginToken}` },
        credentials: 'include'
      }
    );
    
    if (res.status === 404) {
      console.log('[SSO Background] No credentials for', appId, '(first-time login)');
      return null;
    }
    
    if (!res.ok) {
      console.log('[SSO Background] Fetch credentials failed:', res.status);
      return null;
    }
    
    return await res.json();
  } catch (e) {
    console.log('[SSO Background] Fetch credentials error:', e.message);
    return null;
  }
}

/**
 * Save credentials after learning (extensible format)
 * @param {string} appId
 * @param {{ username, password, ... }} fields
 * @returns {Promise<boolean>}
 */
async function saveCredentials(appId, fields) {
  if (!state.pluginToken) return false;
  
  try {
    const res = await fetch(`${PRIMARY_IDENTITY_BASE}/api/vault/credentials`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.pluginToken}`,
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({ appId, fields })
    });
    
    console.log('[SSO Background] Save credentials:', res.ok ? 'success' : 'failed');
    return res.ok;
  } catch (e) {
    console.log('[SSO Background] Save credentials error:', e.message);
    return false;
  }
}

/**
 * Update password after password change
 * @param {string} appId
 * @param {string} newPassword
 * @returns {Promise<boolean>}
 */
async function updatePassword(appId, newPassword) {
  if (!state.pluginToken) return false;
  
  try {
    const res = await fetch(`${PRIMARY_IDENTITY_BASE}/api/vault/password`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${state.pluginToken}`,
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({ appId, newPassword })
    });
    
    console.log('[SSO Background] Update password:', res.ok ? 'success' : 'failed');
    return res.ok;
  } catch (e) {
    console.log('[SSO Background] Update password error:', e.message);
    return false;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Find appId by origin
 * @param {string} origin
 * @returns {string|null}
 */
function getAppIdByOrigin(origin) {
  const app = state.apps.find(a => a.origin === origin);
  return app ? app.appId : null;
}

/**
 * Get loginSchema for origin
 * @param {string} origin
 * @returns {object|null}
 */
function getLoginSchemaByOrigin(origin) {
  const app = state.apps.find(a => a.origin === origin);
  return app ? app.loginSchema : null;
}

/**
 * Check if origin is in allowlist
 * @param {string} origin
 * @returns {boolean}
 */
function isAllowedOrigin(origin) {
  return state.apps.some(a => a.origin === origin);
}

/**
 * Check if plugin token is still valid
 * @returns {boolean}
 */
function isTokenValid() {
  return state.pluginToken && state.expiresAt && Date.now() < state.expiresAt;
}

/**
 * Ensure we have a valid session and bootstrap
 * @returns {Promise<boolean>}
 */
async function ensureReady() {
  // Always check session first (ensures logout stops everything)
  const isLoggedIn = await checkSession();
  if (!isLoggedIn) {
    state.pluginToken = null;
    state.apps = [];
    console.log('[SSO Background] Not logged in - disabled');
    return false;
  }
  
  // Bootstrap if needed
  if (!isTokenValid()) {
    const success = await bootstrap();
    if (!success) return false;
  }
  
  return true;
}

// =============================================================================
// MESSAGE HANDLER
// =============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const origin = request.origin;
  console.log('[SSO Background] Message:', request.action, 'from', origin);
  
  // Handle async
  (async () => {
    switch (request.action) {
      
      case 'getCredentials': {
        // Step 1: Check session & bootstrap
        const ready = await ensureReady();
        if (!ready) {
          sendResponse({ success: false, error: 'Not authenticated' });
          return;
        }
        
        // Step 2: Check if origin is allowed
        if (!isAllowedOrigin(origin)) {
          sendResponse({ success: false, error: 'Origin not allowed' });
          return;
        }
        
        // Step 3: Get appId
        const appId = getAppIdByOrigin(origin);
        if (!appId) {
          sendResponse({ success: false, error: 'App not found' });
          return;
        }
        
        // Step 4: Fetch credentials
        const creds = await fetchCredentials(appId);
        if (!creds) {
          // No saved credentials - send loginSchema for learning mode
          const loginSchema = getLoginSchemaByOrigin(origin);
          sendResponse({ success: false, needsLearning: true, loginSchema: loginSchema });
          return;
        }
        
        // Include loginSchema with credentials for form filling
        const loginSchema = getLoginSchemaByOrigin(origin);
        sendResponse({ 
          success: true, 
          credentials: creds,
          loginSchema: loginSchema
        });
        break;
      }
      
      case 'saveCredentials': {
        const ready = await ensureReady();
        if (!ready) {
          sendResponse({ success: false, error: 'Not authenticated' });
          return;
        }
        
        const appId = getAppIdByOrigin(origin);
        if (!appId) {
          sendResponse({ success: false, error: 'App not found' });
          return;
        }
        
        // Use fields format (extensible)
        const fields = request.fields || { 
          username: request.username, 
          password: request.password 
        };
        const saved = await saveCredentials(appId, fields);
        sendResponse({ success: saved });
        break;
      }
      
      case 'updatePassword': {
        const ready = await ensureReady();
        if (!ready) {
          sendResponse({ success: false, error: 'Not authenticated' });
          return;
        }
        
        const appId = getAppIdByOrigin(origin);
        if (!appId) {
          sendResponse({ success: false, error: 'App not found' });
          return;
        }
        
        const updated = await updatePassword(appId, request.newPassword);
        sendResponse({ success: updated });
        break;
      }
      
      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  })();
  
  return true; // Keep channel open for async response
});

// =============================================================================
// STARTUP
// =============================================================================

console.log('[SSO Background] Extension loaded');

// Deferred to future hardening phase:
// - Retry logic
// - Rate limiting
// - Error classification
// - Token refresh scheduling
