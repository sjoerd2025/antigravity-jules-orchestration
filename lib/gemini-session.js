/**
 * Gemini Session Manager
 * 
 * Manages session state locally since Gemini doesn't have server-side sessions
 * Gemini does not maintain server-side sessions the way a REST API would.\n * Provides in-memory storage with optional PostgreSQL persistence.
 * 
 * @module lib/gemini-session
 */

import { randomUUID } from 'crypto';

// ============================================================================
// SESSION MODEL
// ============================================================================

/**
 * @typedef {object} GeminiSession
 * @property {string} id - Unique session ID
 * @property {'pending'|'running'|'completed'|'failed'|'awaiting_approval'} status
 * @property {string} prompt - Task description
 * @property {string} repository - GitHub repository (owner/repo)
 * @property {string} branch - Target branch
 * @property {string} model - Gemini model used
 * @property {boolean} autoApprove - Whether to auto-approve plans
 * @property {object|null} result - Gemini response data
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 */

// ============================================================================
// SESSION MANAGER
// ============================================================================

export class SessionManager {
  constructor() {
    /** @type {Map<string, GeminiSession>} */
    this.sessions = new Map();
  }

  /**
   * Create a new session.
   * @param {object} config
   * @returns {GeminiSession}
   */
  create(config) {
    const now = new Date().toISOString();
    const session = {
      id: randomUUID(),
      status: 'pending',
      prompt: config.prompt,
      repository: config.repository,
      branch: config.branch || 'main',
      model: config.model || 'gemini-2.0-flash',
      autoApprove: config.autoApprove || false,
      result: null,
      createdAt: now,
      updatedAt: now
    };

    this.sessions.set(session.id, session);
    return { ...session };
  }

  /**
   * Get a session by ID.
   * @param {string} id
   * @returns {GeminiSession|null}
   */
  get(id) {
    const session = this.sessions.get(id);
    return session ? { ...session } : null;
  }

  /**
   * List sessions, optionally filtered.
   * @param {object} [filters]
   * @param {string} [filters.status]
   * @param {string} [filters.repository]
   * @param {number} [filters.limit]
   * @returns {GeminiSession[]}
   */
  list(filters = {}) {
    let sessions = Array.from(this.sessions.values());

    if (filters.status) {
      sessions = sessions.filter(s => s.status === filters.status);
    }
    if (filters.repository) {
      sessions = sessions.filter(s => s.repository === filters.repository);
    }

    // Sort by most recently updated
    sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    if (filters.limit) {
      sessions = sessions.slice(0, filters.limit);
    }

    return sessions.map(s => ({ ...s }));
  }

  /**
   * Update session status.
   * @param {string} id
   * @param {'pending'|'running'|'completed'|'failed'|'awaiting_approval'} status
   */
  updateStatus(id, status) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    const validTransitions = {
      pending: ['running', 'failed'],
      running: ['completed', 'failed', 'awaiting_approval'],
      awaiting_approval: ['running', 'completed', 'failed'],
      completed: [],
      failed: ['pending', 'running'] // allow retry
    };

    if (!validTransitions[session.status]?.includes(status)) {
      throw new Error(
        `Invalid status transition: ${session.status} → ${status}`
      );
    }

    session.status = status;
    session.updatedAt = new Date().toISOString();
  }

  /**
   * Set the result data for a session.
   * @param {string} id
   * @param {object} result
   */
  setResult(id, result) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    session.result = result;
    session.updatedAt = new Date().toISOString();
  }

  /**
   * Delete a session.
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    return this.sessions.delete(id);
  }

  /**
   * Get aggregate statistics.
   * @returns {object}
   */
  getStats() {
    const sessions = Array.from(this.sessions.values());
    return {
      total: sessions.length,
      pending: sessions.filter(s => s.status === 'pending').length,
      running: sessions.filter(s => s.status === 'running').length,
      completed: sessions.filter(s => s.status === 'completed').length,
      failed: sessions.filter(s => s.status === 'failed').length,
      awaitingApproval: sessions.filter(s => s.status === 'awaiting_approval').length
    };
  }

  /**
   * Clear all sessions (useful for testing).
   */
  clear() {
    this.sessions.clear();
  }
}
