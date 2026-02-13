/**
 * Vault Service — Request Validation Middleware
 * 
 * Validates request bodies for each endpoint.
 * Returns 400 with { error: "..." } on validation failure.
 */

/**
 * Validate that a value is a non-empty string.
 */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Factory: creates middleware that validates required string fields exist.
 * @param {string[]} requiredFields - Field names that must be non-empty strings
 * @param {Object} [extraValidators] - { fieldName: (value) => errorMsg | null }
 */
function validateBody(requiredFields, extraValidators = {}) {
    return (req, res, next) => {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Request body must be a JSON object' });
        }

        // Check required string fields
        for (const field of requiredFields) {
            if (!isNonEmptyString(req.body[field])) {
                return res.status(400).json({ error: `${field} is required and must be a non-empty string` });
            }
        }

        // Run extra validators
        for (const [field, validator] of Object.entries(extraValidators)) {
            const errorMsg = validator(req.body[field]);
            if (errorMsg) {
                return res.status(400).json({ error: errorMsg });
            }
        }

        next();
    };
}

// ──────────────────────────────────────────────────
// Pre-built validators for each endpoint
// ──────────────────────────────────────────────────

/**
 * POST /internal/vault/read
 * Requires: vaultId, appId
 */
const validateRead = validateBody(['vaultId', 'appId']);

/**
 * POST /internal/vault/write
 * Requires: vaultId, appId, fields (object)
 */
const validateWrite = validateBody(['vaultId', 'appId'], {
    fields: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return 'fields is required and must be a JSON object';
        }
        return null;
    }
});

/**
 * POST /internal/vault/update-password
 * Requires: vaultId, appId, newPassword
 */
const validateUpdatePassword = validateBody(['vaultId', 'appId', 'newPassword']);

/**
 * POST /internal/vault/delete
 * Requires: vaultId, appId
 */
const validateDelete = validateBody(['vaultId', 'appId']);

/**
 * POST /internal/vault/delete-vault
 * Requires: vaultId
 */
const validateDeleteVault = validateBody(['vaultId']);

module.exports = {
    validateRead,
    validateWrite,
    validateUpdatePassword,
    validateDelete,
    validateDeleteVault,
};
