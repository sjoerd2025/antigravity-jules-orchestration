/**
 * Database Connection Pool
 *
 * Shared PostgreSQL pool for the orchestrator.
 * Uses DATABASE_URL from environment, with graceful fallback to in-memory mode.
 *
 * @module lib/db
 */

import pg from 'pg';

const { Pool } = pg;

let pool = null;
let isConnected = false;

/**
 * Get or create the PostgreSQL connection pool.
 * Returns null if DATABASE_URL is not configured.
 */
export function getPool() {
  if (pool) return pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn('[DB] DATABASE_URL not set — PostgreSQL features disabled');
    return null;
  }

  pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
    isConnected = false;
  });

  pool.on('connect', () => {
    isConnected = true;
  });

  return pool;
}

/**
 * Execute a SQL query against the pool.
 * Returns { rows, rowCount } or throws on error.
 */
export async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('Database not configured (DATABASE_URL missing)');
  return p.query(text, params);
}

/**
 * Run the task queue migration if the table doesn't exist.
 */
export async function ensureTaskQueueSchema() {
  const p = getPool();
  if (!p) return false;

  try {
    // Check if gemini_tasks table exists
    const result = await p.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'gemini_tasks'
      );
    `);

    if (!result.rows[0].exists) {
      console.log('[DB] Creating gemini_tasks table...');
      await p.query(`
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

        CREATE TABLE IF NOT EXISTS gemini_tasks (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          owner VARCHAR(255) NOT NULL,
          repo VARCHAR(255) NOT NULL,
          issue_number INTEGER NOT NULL,
          issue_title TEXT,
          issue_body TEXT,
          issue_labels JSONB DEFAULT '[]',
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          flagged_for_retry BOOLEAN DEFAULT false,
          retry_count INTEGER DEFAULT 0,
          last_retry_at TIMESTAMP,
          session_id VARCHAR(255),
          error TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT valid_gemini_task_status CHECK (status IN (
            'pending', 'processing', 'queued', 'completed', 'failed'
          ))
        );
        CREATE INDEX IF NOT EXISTS idx_gemini_tasks_status ON gemini_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_gemini_tasks_retry ON gemini_tasks(flagged_for_retry) WHERE flagged_for_retry = true;
        CREATE INDEX IF NOT EXISTS idx_gemini_tasks_issue ON gemini_tasks(owner, repo, issue_number);
        CREATE INDEX IF NOT EXISTS idx_gemini_tasks_created ON gemini_tasks(created_at DESC);
      `);
      console.log('[DB] gemini_tasks table created');
    }

    isConnected = true;
    return true;
  } catch (error) {
    console.error('[DB] Failed to ensure schema:', error.message);
    return false;
  }
}

/**
 * Check if the database is connected and healthy.
 */
export async function isHealthy() {
  try {
    const p = getPool();
    if (!p) return false;
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully close the pool.
 */
export async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    isConnected = false;
    console.log('[DB] Pool closed');
  }
}

export default { getPool, query, ensureTaskQueueSchema, isHealthy, close };
