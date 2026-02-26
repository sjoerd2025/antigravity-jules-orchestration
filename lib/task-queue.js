/**
 * Task Queue Module — PostgreSQL-backed
 *
 * GitHub label-based task queue for Gemini sessions.
 * Adapted from iHildy/jules-task-queue patterns:
 *   - Webhook handler for `issues.labeled` events
 *   - 60s delay → capacity detection via bot comment scanning
 *   - Label swapping (gemini → gemini-queue) when at capacity
 *   - 30-minute cron retry cycle
 *
 * Stores all tasks in PostgreSQL `gemini_tasks` table.
 * Falls back to in-memory Map if DATABASE_URL is not set.
 *
 * @module lib/task-queue
 */

import { EventEmitter } from 'events';
import { query } from './db.js';

// ─── Configuration ────────────────────────────────────────────

const LABELS = {
  TRIGGER: 'gemini',
  QUEUE: 'gemini-queue',
  HUMAN: 'Human',
};

const CAPACITY_CHECK_DELAY_MS = 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 30 * 60 * 1000;
const MAX_RETRIES = 10;

const CAPACITY_PATTERNS = [
  'concurrent task limit',
  'at your concurrent',
  'task limit reached',
  'rate limit',
  'too many requests',
  'capacity',
];

const WORKING_PATTERNS = [
  'when finished, you will see another comment',
  'started working',
  'analyzing',
  'generating a plan',
  'i\'ll start',
];

// ─── In-Memory Fallback ───────────────────────────────────────

class MemoryStore {
  constructor() { this.tasks = new Map(); }

  async create(task) {
    this.tasks.set(task.id, task);
    return task;
  }
  async getById(id) {
    return this.tasks.get(id) || null;
  }
  async findByIssue(owner, repo, issueNumber) {
    for (const t of this.tasks.values()) {
      if (t.owner === owner && t.repo === repo && t.issue_number === issueNumber) return t;
    }
    return null;
  }
  async update(id, fields) {
    const t = this.tasks.get(id);
    if (!t) return null;
    Object.assign(t, fields, { updated_at: new Date().toISOString() });
    return t;
  }
  async listAll(filters = {}) {
    let tasks = Array.from(this.tasks.values());
    if (filters.status) tasks = tasks.filter(t => t.status === filters.status);
    if (filters.flagged_for_retry !== undefined) tasks = tasks.filter(t => t.flagged_for_retry === filters.flagged_for_retry);
    return tasks;
  }
  async getFlaggedForRetry() {
    return Array.from(this.tasks.values()).filter(t => t.flagged_for_retry && t.retry_count < MAX_RETRIES);
  }
  async clearFinished() {
    let cleared = 0;
    for (const [id, t] of this.tasks) {
      if (t.status === 'completed' || t.status === 'failed') { this.tasks.delete(id); cleared++; }
    }
    return cleared;
  }
  async getStats() {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      processing: tasks.filter(t => t.status === 'processing').length,
      queued: tasks.filter(t => t.status === 'queued').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      flagged_for_retry: tasks.filter(t => t.flagged_for_retry).length,
    };
  }
}

// ─── PostgreSQL Store ─────────────────────────────────────────

class PgStore {
  async create(task) {
    const result = await query(
      `INSERT INTO gemini_tasks (id, owner, repo, issue_number, issue_title, issue_body, issue_labels, status, flagged_for_retry, retry_count, session_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [task.id, task.owner, task.repo, task.issue_number, task.issue_title, task.issue_body,
       JSON.stringify(task.issue_labels || []), task.status || 'pending',
       task.flagged_for_retry || false, task.retry_count || 0,
       task.session_id || null, task.error || null]
    );
    return this._row(result.rows[0]);
  }

  async getById(id) {
    const result = await query('SELECT * FROM gemini_tasks WHERE id = $1', [id]);
    return result.rows[0] ? this._row(result.rows[0]) : null;
  }

  async findByIssue(owner, repo, issueNumber) {
    const result = await query(
      `SELECT * FROM gemini_tasks WHERE owner = $1 AND repo = $2 AND issue_number = $3
       ORDER BY created_at DESC LIMIT 1`,
      [owner, repo, issueNumber]
    );
    return result.rows[0] ? this._row(result.rows[0]) : null;
  }

  async update(id, fields) {
    const sets = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = $${idx}`);
      values.push(key === 'issue_labels' ? JSON.stringify(value) : value);
      idx++;
    }
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    const result = await query(
      `UPDATE gemini_tasks SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0] ? this._row(result.rows[0]) : null;
  }

  async listAll(filters = {}) {
    let where = [];
    let params = [];
    let idx = 1;
    if (filters.status) { where.push(`status = $${idx++}`); params.push(filters.status); }
    if (filters.flagged_for_retry !== undefined) { where.push(`flagged_for_retry = $${idx++}`); params.push(filters.flagged_for_retry); }
    if (filters.owner) { where.push(`owner = $${idx++}`); params.push(filters.owner); }
    if (filters.repo) { where.push(`repo = $${idx++}`); params.push(filters.repo); }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await query(`SELECT * FROM gemini_tasks ${clause} ORDER BY created_at DESC LIMIT 200`, params);
    return result.rows.map(r => this._row(r));
  }

  async getFlaggedForRetry() {
    const result = await query(
      `SELECT * FROM gemini_tasks WHERE flagged_for_retry = true AND retry_count < $1 ORDER BY created_at ASC`,
      [MAX_RETRIES]
    );
    return result.rows.map(r => this._row(r));
  }

  async clearFinished() {
    const result = await query(
      `DELETE FROM gemini_tasks WHERE status IN ('completed', 'failed') RETURNING id`
    );
    return result.rowCount;
  }

  async getStats() {
    const result = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE flagged_for_retry = true) AS flagged_for_retry
      FROM gemini_tasks
    `);
    const row = result.rows[0];
    return {
      total: parseInt(row.total),
      pending: parseInt(row.pending),
      processing: parseInt(row.processing),
      queued: parseInt(row.queued),
      completed: parseInt(row.completed),
      failed: parseInt(row.failed),
      flagged_for_retry: parseInt(row.flagged_for_retry),
    };
  }

  _row(r) {
    if (!r) return null;
    return {
      ...r,
      issue_labels: typeof r.issue_labels === 'string' ? JSON.parse(r.issue_labels) : (r.issue_labels || []),
    };
  }
}

// ─── TaskQueue Class ──────────────────────────────────────────

export class TaskQueue extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Object}   opts.githubHelpers - { addLabel, removeLabel, getIssueComments, getIssue }
   * @param {boolean}  [opts.usePostgres=true] - Use PostgreSQL if available
   * @param {Object}   [opts.config] - Override labels, delays, etc.
   */
  constructor({ githubHelpers, usePostgres = true, config = {} }) {
    super();
    this.github = githubHelpers;
    this.labels = { ...LABELS, ...config.labels };
    this.retryIntervalMs = config.retryIntervalMs || DEFAULT_RETRY_INTERVAL_MS;
    this.maxRetries = config.maxRetries || MAX_RETRIES;
    this.retryInterval = null;

    // Choose store based on DATABASE_URL availability
    if (usePostgres && process.env.DATABASE_URL) {
      this.store = new PgStore();
      console.log('[TaskQueue] Using PostgreSQL store');
    } else {
      this.store = new MemoryStore();
      console.log('[TaskQueue] Using in-memory store (DATABASE_URL not set)');
    }
  }

  // ─── Webhook Handler ─────────────────────────────────────

  async handleIssueLabelEvent(payload) {
    const { action, label, issue, repository } = payload;

    if (action !== 'labeled' || label?.name !== this.labels.TRIGGER) {
      return null;
    }

    const [owner, repo] = repository.full_name.split('/');
    const issueNumber = issue.number;

    // Dedup
    const existing = await this.store.findByIssue(owner, repo, issueNumber);
    if (existing && existing.status === 'processing') {
      console.log(`[TaskQueue] Task already processing for ${owner}/${repo}#${issueNumber}`);
      return existing;
    }

    const taskId = crypto.randomUUID();
    const task = await this.store.create({
      id: taskId,
      owner,
      repo,
      issue_number: issueNumber,
      issue_title: issue.title,
      issue_body: issue.body || '',
      issue_labels: issue.labels?.map(l => l.name) || [],
      status: 'pending',
      flagged_for_retry: false,
      retry_count: 0,
      session_id: null,
      error: null,
    });

    this.emit('task:created', { taskId, owner, repo, issueNumber });
    console.log(`[TaskQueue] Created task ${taskId} for ${owner}/${repo}#${issueNumber}: "${issue.title}"`);

    this._scheduleCapacityCheck(task);
    return task;
  }

  // ─── Capacity Detection ───────────────────────────────────

  _scheduleCapacityCheck(task) {
    this.store.update(task.id, { status: 'processing' });

    console.log(`[TaskQueue] Checking capacity for ${task.owner}/${task.repo}#${task.issue_number} in ${CAPACITY_CHECK_DELAY_MS / 1000}s`);

    setTimeout(async () => {
      try {
        await this._checkTaskCapacity(task);
      } catch (error) {
        console.error(`[TaskQueue] Capacity check failed for task ${task.id}:`, error.message);
        await this.store.update(task.id, { status: 'failed', error: error.message });
        this.emit('task:failed', { taskId: task.id, error: error.message });
      }
    }, CAPACITY_CHECK_DELAY_MS);
  }

  async _checkTaskCapacity(task) {
    const { owner, repo, issue_number } = task;

    let comments;
    try {
      comments = await this.github.getIssueComments(owner, repo, issue_number);
    } catch (error) {
      console.warn(`[TaskQueue] Could not fetch comments for ${owner}/${repo}#${issue_number}:`, error.message);
      await this.store.update(task.id, { status: 'completed' });
      return;
    }

    const recentComments = comments.filter(c => {
      const commentTime = new Date(c.created_at || c.createdAt).getTime();
      const taskTime = new Date(task.created_at).getTime();
      return commentTime > taskTime;
    });

    const atCapacity = recentComments.some(c => {
      const body = (c.body || '').toLowerCase();
      return CAPACITY_PATTERNS.some(p => body.includes(p));
    });

    if (atCapacity) {
      console.log(`[TaskQueue] Capacity limit detected for ${owner}/${repo}#${issue_number}`);
      await this._queueForRetry(task);
      return;
    }

    const isWorking = recentComments.some(c => {
      const body = (c.body || '').toLowerCase();
      return WORKING_PATTERNS.some(p => body.includes(p));
    });

    if (isWorking) {
      console.log(`[TaskQueue] Gemini is working on ${owner}/${repo}#${issue_number}`);
    } else {
      console.log(`[TaskQueue] No capacity message for ${owner}/${repo}#${issue_number} — assuming working`);
    }

    await this.store.update(task.id, { status: 'completed' });
    this.emit('task:working', { taskId: task.id });
  }

  async _queueForRetry(task) {
    const { owner, repo, issue_number } = task;

    try { await this.github.removeLabel(owner, repo, issue_number, this.labels.TRIGGER); } catch (e) {
      console.warn(`[TaskQueue] Could not remove '${this.labels.TRIGGER}':`, e.message);
    }
    try { await this.github.addLabel(owner, repo, issue_number, this.labels.QUEUE); } catch (e) {
      console.warn(`[TaskQueue] Could not add '${this.labels.QUEUE}':`, e.message);
    }

    await this.store.update(task.id, { status: 'queued', flagged_for_retry: true });
    this.emit('task:queued', { taskId: task.id, retryCount: task.retry_count });
    console.log(`[TaskQueue] Task ${task.id} queued for retry`);
  }

  // ─── Cron: Retry Processing ───────────────────────────────

  async processRetryQueue() {
    const flaggedTasks = await this.store.getFlaggedForRetry();

    if (flaggedTasks.length === 0) {
      console.log('[TaskQueue] No tasks flagged for retry');
      return { processed: 0, skipped: 0, failed: 0 };
    }

    console.log(`[TaskQueue] Processing ${flaggedTasks.length} retry tasks`);
    let processed = 0, skipped = 0, failed = 0;

    for (const task of flaggedTasks) {
      try {
        const issue = await this.github.getIssue(task.owner, task.repo, task.issue_number);
        const labels = issue.labels || [];
        const hasHumanLabel = labels.some(l => (typeof l === 'string' ? l : l.name) === this.labels.HUMAN);

        if (hasHumanLabel) {
          console.log(`[TaskQueue] Skipping ${task.owner}/${task.repo}#${task.issue_number} — Human label`);
          skipped++;
          continue;
        }

        try { await this.github.removeLabel(task.owner, task.repo, task.issue_number, this.labels.QUEUE); } catch (e) { /* ok */ }
        try { await this.github.addLabel(task.owner, task.repo, task.issue_number, this.labels.TRIGGER); } catch (e) { /* ok */ }

        await this.store.update(task.id, {
          flagged_for_retry: false,
          retry_count: task.retry_count + 1,
          last_retry_at: new Date().toISOString(),
          status: 'processing',
        });

        this._scheduleCapacityCheck({ ...task, retry_count: task.retry_count + 1 });
        processed++;
        this.emit('task:retried', { taskId: task.id, retryCount: task.retry_count + 1 });

      } catch (error) {
        console.error(`[TaskQueue] Failed to retry task ${task.id}:`, error.message);
        await this.store.update(task.id, { error: error.message });
        failed++;
      }
    }

    return { processed, skipped, failed };
  }

  // ─── Cron Lifecycle ───────────────────────────────────────

  startRetryInterval() {
    if (this.retryInterval) return;
    this.retryInterval = setInterval(async () => {
      try { await this.processRetryQueue(); } catch (e) { console.error('[TaskQueue] Cron error:', e.message); }
    }, this.retryIntervalMs);
    console.log(`[TaskQueue] Retry cron started (every ${this.retryIntervalMs / 60000} min)`);
  }

  stopRetryInterval() {
    if (this.retryInterval) { clearInterval(this.retryInterval); this.retryInterval = null; }
  }

  // ─── Query / Management ───────────────────────────────────

  async getTask(id) { return this.store.getById(id); }
  async listTasks(filters) { return this.store.listAll(filters); }
  async getStats() { return { ...(await this.store.getStats()), cronActive: !!this.retryInterval }; }
  async clearFinished() { return this.store.clearFinished(); }

  async manualRetry(taskId) {
    const task = await this.store.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== 'queued' && task.status !== 'failed') {
      throw new Error(`Task ${taskId} is "${task.status}", cannot retry`);
    }

    try { await this.github.removeLabel(task.owner, task.repo, task.issue_number, this.labels.QUEUE); } catch (e) { /* ok */ }
    try { await this.github.addLabel(task.owner, task.repo, task.issue_number, this.labels.TRIGGER); } catch (e) { /* ok */ }

    const updated = await this.store.update(taskId, {
      flagged_for_retry: false,
      retry_count: task.retry_count + 1,
      last_retry_at: new Date().toISOString(),
      status: 'processing',
    });

    this._scheduleCapacityCheck(updated || task);
    return updated;
  }
}

// ─── Factory ────────────────────────────────────────────────

export function createTaskQueue({ githubHelpers, config } = {}) {
  const queue = new TaskQueue({ githubHelpers, config });
  queue.startRetryInterval();
  return queue;
}

export default { TaskQueue, createTaskQueue };
