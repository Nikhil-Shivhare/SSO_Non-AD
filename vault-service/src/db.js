/**
 * Vault Service — Database Connection Module
 * 
 * Manages a Postgres connection pool using the 'pg' library.
 * All queries use parameterized statements to prevent SQL injection.
 * 
 * Configuration via environment variables:
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGPOOL_MAX
 */

const { Pool } = require('pg');

const pool = new Pool({
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'vault_db',
    user:     process.env.PGUSER     || 'vault_user',
    password: process.env.PGPASSWORD || 'vault_secret',
    max:      parseInt(process.env.PGPOOL_MAX || '10', 10),

    // Connection timeouts
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis:       30000,
});

// Connection event handlers for visibility
pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
    console.error('[DB] Connection lost to postgres-primary');
});

pool.on('connect', () => {
    console.log('[DB] Connected to postgres-primary');
});

pool.on('remove', () => {
    console.log('[DB] Connection removed from pool');
});

/**
 * Execute a parameterized query.
 * @param {string} text - SQL query with $1, $2, ... placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = []) {
    const start = Date.now();
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (duration > 200) {
        console.warn(`[DB] Slow query (${duration}ms):`, text.substring(0, 80));
    }

    return result;
}

/**
 * Get a client from the pool (for transactions).
 * Caller MUST call client.release() when done.
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
    return pool.connect();
}

/**
 * Check if the database is reachable.
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
    try {
        await pool.query('SELECT 1');
        return true;
    } catch (err) {
        console.error('[DB] Health check failed:', err.message);
        return false;
    }
}

/**
 * Gracefully close all pool connections.
 */
async function close() {
    await pool.end();
    console.log('[DB] Connection pool closed');
}

module.exports = { query, getClient, healthCheck, close };
