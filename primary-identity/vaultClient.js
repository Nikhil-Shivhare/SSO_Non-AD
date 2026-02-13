/**
 * Vault Client - HTTP Client for Vault Service
 * 
 * Communicates with the Vault Service at http://localhost:5000
 * All methods use POST requests with JSON bodies (internal API design)
 * 
 * Error handling:
 *   - 404 from Vault → { success: false, status: 404, error: '...' }
 *   - Network error  → { success: false, status: 503, error: 'Vault service unavailable' }
 *   - 500 from Vault → { success: false, status: 502, error: 'Vault internal error' }
 * 
 * No automatic retries. 5-second timeout on all requests.
 * Does NOT log credential fields (username, password, etc.)
 */

const VAULT_URL = process.env.VAULT_URL || 'http://localhost:5000';
const TIMEOUT_MS = 5000;

/**
 * Make a request to Vault Service with timeout
 * @param {string} endpoint - e.g. '/internal/vault/read'
 * @param {object} body - Request payload
 * @returns {Promise<{success: boolean, status: number, data?: any, error?: string}>}
 */
async function vaultRequest(endpoint, body) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    try {
        const response = await fetch(`${VAULT_URL}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        const data = await response.json();
        
        if (response.ok) {
            return { success: true, status: response.status, data };
        }
        
        // Handle Vault errors
        if (response.status === 404) {
            return { success: false, status: 404, error: data.error || 'Not found' };
        }
        
        if (response.status >= 500) {
            console.error(`[VAULT CLIENT] Vault error ${response.status}:`, data.error);
            return { success: false, status: 502, error: 'Vault internal error' };
        }
        
        // Other errors (400, etc.)
        return { success: false, status: response.status, error: data.error || 'Vault request failed' };
        
    } catch (err) {
        clearTimeout(timeoutId);
        
        if (err.name === 'AbortError') {
            console.error('[VAULT CLIENT] Request timeout');
            return { success: false, status: 503, error: 'Vault service timeout' };
        }
        
        console.error('[VAULT CLIENT] Network error:', err.message);
        return { success: false, status: 503, error: 'Vault service unavailable' };
    }
}

/**
 * Read credentials from Vault
 * @param {string} vaultId - e.g. "vault_1"
 * @param {string} appId - e.g. "app_a"
 * @returns {Promise<{success: boolean, status: number, fields?: object, error?: string}>}
 */
async function read(vaultId, appId) {
    console.log(`[VAULT CLIENT] read(vaultId=${vaultId}, appId=${appId})`);
    const result = await vaultRequest('/internal/vault/read', { vaultId, appId });
    
    if (result.success) {
        return { success: true, status: result.status, fields: result.data.fields };
    }
    
    return result;
}

/**
 * Write credentials to Vault
 * @param {string} vaultId
 * @param {string} appId
 * @param {object} fields - { username, password, ... }
 * @returns {Promise<{success: boolean, status: number, error?: string}>}
 */
async function write(vaultId, appId, fields) {
    console.log(`[VAULT CLIENT] write(vaultId=${vaultId}, appId=${appId}) [fields not logged]`);
    return await vaultRequest('/internal/vault/write', { vaultId, appId, fields });
}

/**
 * Update password only (merges into existing fields)
 * @param {string} vaultId
 * @param {string} appId
 * @param {string} newPassword
 * @returns {Promise<{success: boolean, status: number, error?: string}>}
 */
async function updatePassword(vaultId, appId, newPassword) {
    console.log(`[VAULT CLIENT] updatePassword(vaultId=${vaultId}, appId=${appId}) [password not logged]`);
    return await vaultRequest('/internal/vault/update-password', { vaultId, appId, newPassword });
}

/**
 * Delete single credential
 * @param {string} vaultId
 * @param {string} appId
 * @returns {Promise<{success: boolean, status: number, error?: string}>}
 */
async function deleteCredential(vaultId, appId) {
    console.log(`[VAULT CLIENT] delete(vaultId=${vaultId}, appId=${appId})`);
    return await vaultRequest('/internal/vault/delete', { vaultId, appId });
}

/**
 * Delete all credentials for a vault (cascade on user deletion)
 * @param {string} vaultId
 * @returns {Promise<{success: boolean, status: number, error?: string}>}
 */
async function deleteVault(vaultId) {
    console.log(`[VAULT CLIENT] deleteVault(vaultId=${vaultId})`);
    return await vaultRequest('/internal/vault/delete-vault', { vaultId });
}

/**
 * Health check
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    try {
        const response = await fetch(`${VAULT_URL}/health`, {
            method: 'GET',
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return response.ok;
    } catch (err) {
        clearTimeout(timeoutId);
        return false;
    }
}

module.exports = {
    read,
    write,
    updatePassword,
    delete: deleteCredential,
    deleteVault,
    healthCheck
};
