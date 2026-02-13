/**
 * Vault Service — Credential Routes
 * 
 * Internal-only API endpoints for credential CRUD.
 * These are called exclusively by PID — never by the browser extension.
 * 
 * All endpoints:
 *   - Accept JSON bodies
 *   - Use parameterized queries
 *   - Log to audit_log table
 *   - Return consistent JSON responses
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const INSTANCE = process.env.INSTANCE_NAME || 'vault';
const {
    validateRead,
    validateWrite,
    validateUpdatePassword,
    validateDelete,
    validateDeleteVault,
} = require('../middleware/validate');

// ============================================================================
// HEALTH CHECK
// ============================================================================

router.get('/health', async (req, res) => {
    try {
        const dbHealthy = await db.healthCheck();
        if (dbHealthy) {
            return res.json({
                status: 'ok',
                service: 'vault-service',
                instance: INSTANCE,
                timestamp: new Date().toISOString(),
            });
        }
        return res.status(503).json({
            status: 'unhealthy',
            service: 'vault-service',
            instance: INSTANCE,
            error: 'Database connection failed',
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        console.error('[HEALTH] Error:', err.message);
        return res.status(503).json({
            status: 'unhealthy',
            service: 'vault-service',
            instance: INSTANCE,
            error: 'Health check failed',
            timestamp: new Date().toISOString(),
        });
    }
});

// ============================================================================
// POST /internal/vault/read
// ============================================================================

router.post('/internal/vault/read', validateRead, async (req, res) => {
    const { vaultId, appId } = req.body;

    try {
        const result = await db.query(
            'SELECT fields FROM vault_credentials WHERE vault_id = $1 AND app_id = $2',
            [vaultId, appId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Credentials not found' });
        }

        // Audit log
        await db.query(
            'INSERT INTO audit_log (vault_id, app_id, action) VALUES ($1, $2, $3)',
            [vaultId, appId, 'read']
        );

        return res.json({ fields: result.rows[0].fields });

    } catch (err) {
        console.error(`[${INSTANCE}] Read error:`, err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================================
// POST /internal/vault/write
// ============================================================================

router.post('/internal/vault/write', validateWrite, async (req, res) => {
    const { vaultId, appId, fields } = req.body;

    try {
        await db.query(
            `INSERT INTO vault_credentials (vault_id, app_id, fields, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT (vault_id, app_id)
             DO UPDATE SET fields = $3, updated_at = NOW()`,
            [vaultId, appId, JSON.stringify(fields)]
        );

        // Audit log
        await db.query(
            'INSERT INTO audit_log (vault_id, app_id, action) VALUES ($1, $2, $3)',
            [vaultId, appId, 'write']
        );

        console.log(`[${INSTANCE}] Write: vault_id=${vaultId}, app_id=${appId}`);
        return res.json({ success: true });

    } catch (err) {
        console.error(`[${INSTANCE}] Write error:`, err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================================
// POST /internal/vault/update-password
// ============================================================================

router.post('/internal/vault/update-password', validateUpdatePassword, async (req, res) => {
    const { vaultId, appId, newPassword } = req.body;

    // Single transaction: read existing → merge password → upsert
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Read existing fields
        const existing = await client.query(
            'SELECT fields FROM vault_credentials WHERE vault_id = $1 AND app_id = $2 FOR UPDATE',
            [vaultId, appId]
        );

        if (existing.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Credentials not found' });
        }

        // Merge password into existing fields
        const updatedFields = {
            ...existing.rows[0].fields,
            password: newPassword,
        };

        // Upsert with merged fields
        await client.query(
            `UPDATE vault_credentials
             SET fields = $1, updated_at = NOW()
             WHERE vault_id = $2 AND app_id = $3`,
            [JSON.stringify(updatedFields), vaultId, appId]
        );

        // Audit log
        await client.query(
            'INSERT INTO audit_log (vault_id, app_id, action) VALUES ($1, $2, $3)',
            [vaultId, appId, 'update']
        );

        await client.query('COMMIT');

        console.log(`[${INSTANCE}] Password updated: vault_id=${vaultId}, app_id=${appId}`);
        return res.json({ success: true });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[${INSTANCE}] Update password error:`, err.message);
        return res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// ============================================================================
// POST /internal/vault/delete
// ============================================================================

router.post('/internal/vault/delete', validateDelete, async (req, res) => {
    const { vaultId, appId } = req.body;

    try {
        const result = await db.query(
            'DELETE FROM vault_credentials WHERE vault_id = $1 AND app_id = $2',
            [vaultId, appId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Credentials not found' });
        }

        // Audit log
        await db.query(
            'INSERT INTO audit_log (vault_id, app_id, action) VALUES ($1, $2, $3)',
            [vaultId, appId, 'delete']
        );

        console.log(`[${INSTANCE}] Deleted: vault_id=${vaultId}, app_id=${appId}`);
        return res.json({ success: true });

    } catch (err) {
        console.error(`[${INSTANCE}] Delete error:`, err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================================
// POST /internal/vault/delete-vault
// ============================================================================

router.post('/internal/vault/delete-vault', validateDeleteVault, async (req, res) => {
    const { vaultId } = req.body;

    try {
        const result = await db.query(
            'DELETE FROM vault_credentials WHERE vault_id = $1',
            [vaultId]
        );

        // Audit log (app_id = '*' indicates all apps for this vault)
        await db.query(
            'INSERT INTO audit_log (vault_id, app_id, action) VALUES ($1, $2, $3)',
            [vaultId, '*', 'delete-vault']
        );

        console.log(`[${INSTANCE}] Deleted all for vault_id=${vaultId} (${result.rowCount} rows)`);
        return res.json({ success: true, deletedCount: result.rowCount });

    } catch (err) {
        console.error(`[${INSTANCE}] Delete-vault error:`, err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
