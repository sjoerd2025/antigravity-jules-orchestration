/**
 * Task Queue REST API Router
 *
 * Express router providing HTTP endpoints for the Gemini task queue.
 * Mounts at /api/v1/queue in the main server.
 *
 * Endpoints:
 *   GET  /api/v1/queue/tasks          — List tasks (with optional filters)
 *   GET  /api/v1/queue/tasks/:id      — Get single task
 *   GET  /api/v1/queue/stats          — Queue statistics
 *   POST /api/v1/queue/tasks/:id/retry — Manually retry a task
 *   DELETE /api/v1/queue/tasks/finished — Clear completed/failed tasks
 *   POST /api/v1/queue/retry-cycle    — Manually trigger retry cycle
 *   POST /api/v1/queue/webhook/github — GitHub webhook receiver
 *
 * @module lib/task-queue-api
 */

import { Router } from 'express';
import crypto from 'crypto';

/**
 * Create the task queue API router.
 *
 * @param {import('./task-queue.js').TaskQueue} taskQueue - Initialized TaskQueue instance
 * @param {Object} [options]
 * @param {string} [options.webhookSecret] - GitHub webhook secret for signature verification
 * @returns {Router} Express router
 */
export function createTaskQueueRouter(taskQueue, options = {}) {
  const router = Router();
  const webhookSecret = options.webhookSecret || process.env.GITHUB_WEBHOOK_SECRET;

  // ─── List Tasks ─────────────────────────────────────────

  router.get('/tasks', async (req, res) => {
    try {
      const filters = {};
      if (req.query.status) filters.status = req.query.status;
      if (req.query.owner) filters.owner = req.query.owner;
      if (req.query.repo) filters.repo = req.query.repo;
      if (req.query.flagged_for_retry !== undefined) {
        filters.flagged_for_retry = req.query.flagged_for_retry === 'true';
      }
      const tasks = await taskQueue.listTasks(filters);
      res.json({ ok: true, count: tasks.length, tasks });
    } catch (error) {
      console.error('[TaskQueueAPI] Error listing tasks:', error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // ─── Get Single Task ───────────────────────────────────

  router.get('/tasks/:id', async (req, res) => {
    try {
      const task = await taskQueue.getTask(req.params.id);
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
      res.json({ ok: true, task });
    } catch (error) {
      console.error('[TaskQueueAPI] Error getting task:', error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // ─── Queue Stats ───────────────────────────────────────

  router.get('/stats', async (req, res) => {
    try {
      const stats = await taskQueue.getStats();
      res.json({ ok: true, stats });
    } catch (error) {
      console.error('[TaskQueueAPI] Error getting stats:', error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // ─── Manual Retry ──────────────────────────────────────

  router.post('/tasks/:id/retry', async (req, res) => {
    try {
      const task = await taskQueue.manualRetry(req.params.id);
      res.json({ ok: true, task });
    } catch (error) {
      const status = error.message.includes('not found') ? 404 : 400;
      res.status(status).json({ ok: false, error: error.message });
    }
  });

  // ─── Clear Finished ────────────────────────────────────

  router.delete('/tasks/finished', async (req, res) => {
    try {
      const cleared = await taskQueue.clearFinished();
      res.json({ ok: true, cleared });
    } catch (error) {
      console.error('[TaskQueueAPI] Error clearing tasks:', error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // ─── Manual Retry Cycle ────────────────────────────────

  router.post('/retry-cycle', async (req, res) => {
    try {
      const result = await taskQueue.processRetryQueue();
      res.json({ ok: true, ...result });
    } catch (error) {
      console.error('[TaskQueueAPI] Error processing retry cycle:', error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // ─── GitHub Webhook Receiver ───────────────────────────

  router.post('/webhook/github', async (req, res) => {
    try {
      const event = req.headers['x-github-event'];
      const delivery = req.headers['x-github-delivery'];
      const signature = req.headers['x-hub-signature-256'];

      // Signature verification (if secret is configured)
      if (webhookSecret && signature) {
        const body = JSON.stringify(req.body);
        const expected = 'sha256=' + crypto
          .createHmac('sha256', webhookSecret)
          .update(body)
          .digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          console.warn(`[TaskQueueAPI] Invalid webhook signature for delivery ${delivery}`);
          return res.status(401).json({ ok: false, error: 'Invalid signature' });
        }
      }

      console.log(`[TaskQueueAPI] Received webhook: event=${event}, delivery=${delivery}`);

      // Only handle issue label events
      if (event !== 'issues') {
        return res.json({ ok: true, action: 'ignored', reason: `event type '${event}' not handled` });
      }

      const payload = req.body;
      if (payload.action !== 'labeled') {
        return res.json({ ok: true, action: 'ignored', reason: `action '${payload.action}' not handled` });
      }

      const task = await taskQueue.handleIssueLabelEvent(payload);

      if (task) {
        res.json({ ok: true, action: 'task_created', taskId: task.id });
      } else {
        res.json({ ok: true, action: 'ignored', reason: 'label did not match trigger' });
      }

    } catch (error) {
      console.error('[TaskQueueAPI] Webhook error:', error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  return router;
}

export default { createTaskQueueRouter };
