/**
 * Vault Service — Main Application Entry Point
 * 
 * Stateless credential storage service.
 * Port: 5000 (configurable via PORT env var)
 * 
 * This service:
 *   - Stores credentials per (vault_id, app_id)
 *   - Does NOT authenticate requests (PID handles that)
 *   - Does NOT manage sessions or tokens
 *   - Does NOT know about users or login_schema
 *   - Only accepts internal requests from PID
 * 
 * Endpoints:
 *   GET  /health                        → Health check
 *   POST /internal/vault/read           → Read credentials
 *   POST /internal/vault/write          → Upsert credentials
 *   POST /internal/vault/update-password → Merge password update
 *   POST /internal/vault/delete         → Delete single credential
 *   POST /internal/vault/delete-vault   → Delete all credentials for a vault
 */

const express = require('express');
const db = require('./db');
const vaultRoutes = require('./routes/vault');

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);
const INSTANCE = process.env.INSTANCE_NAME || 'vault';

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Parse JSON bodies (limit to 1MB — credentials should be small)
app.use(express.json({ limit: '1mb' }));

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${INSTANCE}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// ============================================================================
// ROUTES
// ============================================================================

app.use('/', vaultRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('[ERROR] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function start() {
    // Verify database connectivity before accepting requests
    console.log(`[${INSTANCE}] Checking database connectivity...`);
    
    let retries = 5;
    while (retries > 0) {
        const healthy = await db.healthCheck();
        if (healthy) {
            console.log(`[${INSTANCE}] Database connected successfully`);
            break;
        }
        retries--;
        if (retries > 0) {
            console.log(`[${INSTANCE}] Database not ready, retrying... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
            console.error(`[${INSTANCE}] FATAL: Cannot connect to database after 5 attempts`);
            process.exit(1);
        }
    }

    app.listen(PORT, () => {
        console.log(`[${INSTANCE}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[${INSTANCE}] Vault Service running on port ${PORT}`);
        console.log(`[${INSTANCE}] Instance: ${INSTANCE}`);
        console.log(`[${INSTANCE}] Health: http://localhost:${PORT}/health`);
        console.log(`[${INSTANCE}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    });
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function shutdown(signal) {
    console.log(`\n[${INSTANCE}] ${signal} received, shutting down gracefully...`);
    await db.close();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Start the server
start();
